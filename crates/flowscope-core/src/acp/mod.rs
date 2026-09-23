//! ACP (Agent Client Protocol v1) access layer.
//!
//! - [`registry`]: `agents.toml` parsing ([`AgentRegistry`]/[`AgentConfig`]).
//! - [`session`]: [`run_agent_node`] — run one workflow agent node against a
//!   spawned ACP agent process, mapping `session/update` traffic, client-side
//!   callback decisions, and child stderr onto unified [`crate::events::FsEvent`]s.

pub mod registry;
pub mod session;

pub use registry::{AgentConfig, AgentRegistry};
pub use session::{NodeFailure, NodeRequest, run_agent_node};
