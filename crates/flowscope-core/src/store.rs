use crate::events::FsEvent;
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::Mutex;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("chrono: {0}")]
    Chrono(#[from] chrono::ParseError),
}

pub struct RunRow {
    pub id: String,
    pub workflow_id: String,
    pub status: String,
    pub params: serde_json::Value,
    pub started_at: String,
    pub ended_at: Option<String>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, yaml TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(name, version));
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), params_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT);
CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, node_id TEXT, session_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, seq));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT, agent_key TEXT, acp_session_id TEXT);
CREATE TABLE IF NOT EXISTS artifacts(run_id TEXT NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(run_id, node_id, name));
";

impl Store {
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open(path: &std::path::Path) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn upsert_workflow(
        &self,
        name: &str,
        version: u32,
        yaml: &str,
    ) -> Result<String, StoreError> {
        let id = format!("wf_{}", uuid::Uuid::new_v4().simple());
        self.conn.lock().unwrap().execute(
            "INSERT INTO workflows(id, name, version, yaml) VALUES(?1,?2,?3,?4) \
             ON CONFLICT(name, version) DO UPDATE SET yaml=excluded.yaml",
            params![id, name, version, yaml],
        )?;
        Ok(id)
    }

    pub fn create_run(
        &self,
        workflow_id: &str,
        params: &serde_json::Value,
    ) -> Result<String, StoreError> {
        let id = format!("run_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        self.conn.lock().unwrap().execute(
            "INSERT INTO runs(id, workflow_id, params_json) VALUES(?1,?2,?3)",
            params![id, workflow_id, params.to_string()],
        )?;
        Ok(id)
    }

    pub fn set_run_status(&self, run_id: &str, status: &str) -> Result<(), StoreError> {
        self.conn.lock().unwrap().execute(
            "UPDATE runs SET status=?2, ended_at=CASE WHEN ?2 IN ('finished','failed','cancelled','interrupted') THEN datetime('now') ELSE ended_at END WHERE id=?1",
            params![run_id, status],
        )?;
        Ok(())
    }

    pub fn running_runs(&self) -> Result<Vec<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM runs WHERE status='running'")?;
        Ok(stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn append_events(&self, events: &[FsEvent]) -> Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO events(run_id, seq, ts, node_id, session_id, kind, payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            )?;
            for e in events {
                stmt.execute(params![
                    e.run_id,
                    e.seq as i64,
                    e.ts.to_rfc3339(),
                    e.node_id,
                    e.session_id,
                    serde_json::to_string(&e.kind)?,
                    e.payload.to_string()
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn events_after(
        &self,
        run_id: &str,
        after: u64,
        limit: u64,
    ) -> Result<Vec<FsEvent>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, run_id, node_id, session_id, kind, payload_json FROM events \
             WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![run_id, after as i64, limit as i64], |r| {
            let seq: i64 = r.get(0)?;
            let ts: String = r.get(1)?;
            let kind: String = r.get(5)?;
            let payload: String = r.get(6)?;
            Ok((
                seq as u64,
                ts,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                kind,
                payload,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, ts, run_id, node_id, session_id, kind, payload) = row?;
            out.push(FsEvent {
                seq,
                ts: chrono::DateTime::parse_from_rfc3339(&ts)?.with_timezone(&chrono::Utc),
                run_id,
                node_id,
                session_id,
                kind: serde_json::from_str(&kind)?,
                payload: serde_json::from_str(&payload)?,
            });
        }
        Ok(out)
    }

    pub fn list_runs(&self) -> Result<Vec<RunRow>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workflow_id, status, params_json, started_at, ended_at FROM runs \
             ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, workflow_id, status, params_json, started_at, ended_at) = row?;
            out.push(RunRow {
                id,
                workflow_id,
                status,
                params: serde_json::from_str(&params_json)?,
                started_at,
                ended_at,
            });
        }
        Ok(out)
    }

    pub fn get_run(&self, run_id: &str) -> Result<Option<RunRow>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workflow_id, status, params_json, started_at, ended_at FROM runs WHERE id=?1",
        )?;
        let row = stmt
            .query_row(params![run_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .optional()?;
        match row {
            Some((id, workflow_id, status, params_json, started_at, ended_at)) => {
                Ok(Some(RunRow {
                    id,
                    workflow_id,
                    status,
                    params: serde_json::from_str(&params_json)?,
                    started_at,
                    ended_at,
                }))
            }
            None => Ok(None),
        }
    }

    pub fn put_artifact(
        &self,
        run_id: &str,
        node_id: &str,
        name: &str,
        content_type: &str,
        content: &str,
    ) -> Result<(), StoreError> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO artifacts(run_id, node_id, name, content_type, content) VALUES(?1,?2,?3,?4,?5) \
             ON CONFLICT(run_id, node_id, name) DO UPDATE SET content_type=excluded.content_type, content=excluded.content",
            params![run_id, node_id, name, content_type, content],
        )?;
        Ok(())
    }

    pub fn get_artifact(
        &self,
        run_id: &str,
        node_id: &str,
        name: &str,
    ) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT content FROM artifacts WHERE run_id=?1 AND node_id=?2 AND name=?3")?;
        let content = stmt
            .query_row(params![run_id, node_id, name], |r| r.get(0))
            .optional()?;
        Ok(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventKind, FsEvent};
    use chrono::Utc;

    fn ev(seq: u64, run: &str) -> FsEvent {
        FsEvent {
            seq,
            ts: Utc::now(),
            run_id: run.into(),
            node_id: None,
            session_id: None,
            kind: EventKind::RunStarted,
            payload: serde_json::json!({}),
        }
    }

    #[test]
    fn append_then_read_after() {
        let s = Store::open_in_memory().unwrap();
        let wf = s.upsert_workflow("demo", 1, "meta: {}").unwrap();
        let run = s
            .create_run(&wf, &serde_json::json!({"week":"W38"}))
            .unwrap();
        s.append_events(&[ev(1, &run), ev(2, &run), ev(3, &run)])
            .unwrap();
        let got = s.events_after(&run, 1, 100).unwrap();
        assert_eq!(got.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!(s.events_after(&run, 3, 100).unwrap().len(), 0);
        let row = s.get_run(&run).unwrap().unwrap();
        assert_eq!(row.params["week"], "W38");
    }

    #[test]
    fn artifact_roundtrip_and_status() {
        let s = Store::open_in_memory().unwrap();
        let wf = s.upsert_workflow("demo", 1, "x").unwrap();
        let run = s.create_run(&wf, &serde_json::json!({})).unwrap();
        s.set_run_status(&run, "finished").unwrap();
        s.put_artifact(&run, "n1", "output", "application/json", "{\"ok\":true}")
            .unwrap();
        assert_eq!(
            s.get_artifact(&run, "n1", "output").unwrap().unwrap(),
            "{\"ok\":true}"
        );
        assert_eq!(s.get_run(&run).unwrap().unwrap().status, "finished");
    }
}
