//! Agent registry: `agents.toml` loading and lookup (spec §3.1).
//!
//! Each `[agents.<key>]` entry describes how to spawn one ACP agent:
//!
//! ```toml
//! [agents.enterprise]
//! command = ["node", "enterprise-agent.js", "--acp"]
//! cwd = "D:/agents/enterprise"
//! env = { API_KEY_FILE = "secrets/api.key" }
//! default_mode = "plan"
//! permission_default = "allow_once"   # or "deny" (default)
//! name = "企业 Agent"
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

/// Catch-all error for registry and ACP-layer failures.
#[derive(Error, Debug)]
pub enum AcpError {
    #[error("{0}")]
    Other(String),
}

/// Automatic answer for agent-initiated `session/request_permission`
/// requests when no human is in the loop (spec §3.3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PermissionDefault {
    /// Auto-select the first `allow_once` option offered by the agent.
    AllowOnce,
    /// Auto-select a reject option offered by the agent.
    #[default]
    Deny,
}

/// One registered agent: how to spawn it and how to auto-answer its
/// client-directed requests.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub key: String,
    pub name: String,
    /// Spawn command; first element is the executable, the rest are args.
    pub command: Vec<String>,
    /// Working-directory scope for this agent. Used as the session cwd and as
    /// the whitelist root for `fs/read_text_file` requests.
    pub cwd: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    pub default_mode: Option<String>,
    pub permission_default: PermissionDefault,
}

/// All agents known to this FlowScope instance, keyed by agent key.
#[derive(Debug, Clone, Default)]
pub struct AgentRegistry {
    pub agents: BTreeMap<String, AgentConfig>,
}

/// Raw `agents.toml` shape (`[agents.<key>]` table).
#[derive(Debug, Deserialize)]
struct RegistryFile {
    agents: BTreeMap<String, AgentEntry>,
}

#[derive(Debug, Deserialize)]
struct AgentEntry {
    command: Vec<String>,
    cwd: Option<PathBuf>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    default_mode: Option<String>,
    permission_default: Option<String>,
    name: Option<String>,
}

impl AgentRegistry {
    /// Loads and validates `agents.toml` from `path`.
    pub fn load_toml(path: &Path) -> Result<Self, AcpError> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| AcpError::Other(format!("cannot read {}: {e}", path.display())))?;
        let file: RegistryFile = toml::from_str(&raw)
            .map_err(|e| AcpError::Other(format!("invalid agents.toml {}: {e}", path.display())))?;

        let mut agents = BTreeMap::new();
        for (key, entry) in file.agents {
            if entry.command.is_empty() {
                return Err(AcpError::Other(format!(
                    "agent {key:?}: command must be a non-empty array"
                )));
            }
            let permission_default = match entry.permission_default.as_deref() {
                None | Some("deny") => PermissionDefault::Deny,
                Some("allow_once") => PermissionDefault::AllowOnce,
                Some(other) => {
                    return Err(AcpError::Other(format!(
                        "agent {key:?}: invalid permission_default {other:?} \
                         (expected \"allow_once\" or \"deny\")"
                    )));
                }
            };
            let cfg = AgentConfig {
                name: entry.name.unwrap_or_else(|| key.clone()),
                key: key.clone(),
                command: entry.command,
                cwd: entry.cwd,
                env: entry.env,
                default_mode: entry.default_mode,
                permission_default,
            };
            agents.insert(key, cfg);
        }
        Ok(Self { agents })
    }

    /// Looks up an agent by key.
    pub fn get(&self, key: &str) -> Result<&AgentConfig, AcpError> {
        self.agents
            .get(key)
            .ok_or_else(|| AcpError::Other(format!("unknown agent {key:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp_toml(content: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("flowscope-agents-{}.toml", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn parses_full_entry() {
        let path = write_temp_toml(
            r#"
[agents.enterprise]
command = ["node", "enterprise-agent.js", "--acp"]
cwd = "D:/agents/enterprise"
env = { API_KEY_FILE = "secrets/api.key" }
default_mode = "plan"
permission_default = "allow_once"
name = "企业 Agent"
"#,
        );
        let reg = AgentRegistry::load_toml(&path).unwrap();
        let cfg = reg.get("enterprise").unwrap();
        assert_eq!(cfg.command, vec!["node", "enterprise-agent.js", "--acp"]);
        assert_eq!(cfg.cwd.as_deref(), Some(Path::new("D:/agents/enterprise")));
        assert_eq!(
            cfg.env.get("API_KEY_FILE").map(String::as_str),
            Some("secrets/api.key")
        );
        assert_eq!(cfg.default_mode.as_deref(), Some("plan"));
        assert_eq!(cfg.permission_default, PermissionDefault::AllowOnce);
        assert_eq!(cfg.name, "企业 Agent");
    }

    #[test]
    fn defaults_name_key_and_permission() {
        let path = write_temp_toml("[agents.mock]\ncommand = [\"mock\"]\n");
        let reg = AgentRegistry::load_toml(&path).unwrap();
        let cfg = reg.get("mock").unwrap();
        assert_eq!(cfg.name, "mock");
        assert_eq!(cfg.permission_default, PermissionDefault::Deny);
        assert!(cfg.cwd.is_none());
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn rejects_bad_permission_default_and_empty_command() {
        let path =
            write_temp_toml("[agents.a]\ncommand = [\"x\"]\npermission_default = \"yolo\"\n");
        let err = AgentRegistry::load_toml(&path).unwrap_err();
        assert!(err.to_string().contains("permission_default"), "{err}");

        let path = write_temp_toml("[agents.a]\ncommand = []\n");
        assert!(AgentRegistry::load_toml(&path).is_err());
    }

    #[test]
    fn unknown_agent_is_error() {
        let reg = AgentRegistry::default();
        let err = reg.get("nope").unwrap_err();
        assert!(err.to_string().contains("unknown agent"), "{err}");
    }
}
