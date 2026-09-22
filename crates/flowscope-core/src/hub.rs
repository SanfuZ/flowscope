use crate::events::FsEvent;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

const RING_CAPACITY: usize = 4096;
const CHANNEL_CAPACITY: usize = 1024;

struct RunChannel {
    ring: VecDeque<Arc<FsEvent>>,
    tx: broadcast::Sender<Arc<FsEvent>>,
}

impl RunChannel {
    fn new() -> Self {
        Self {
            ring: VecDeque::new(),
            tx: broadcast::channel(CHANNEL_CAPACITY).0,
        }
    }
}

pub struct EventHub {
    runs: Mutex<HashMap<String, RunChannel>>,
}

impl EventHub {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
        }
    }

    pub fn publish(&self, ev: FsEvent) {
        let mut runs = self.runs.lock().unwrap();
        let ch = runs
            .entry(ev.run_id.clone())
            .or_insert_with(RunChannel::new);
        let arc = Arc::new(ev);
        ch.ring.push_back(Arc::clone(&arc));
        if ch.ring.len() > RING_CAPACITY {
            ch.ring.pop_front();
        }
        let _ = ch.tx.send(arc); // 无订阅者是常态，忽略 SendError
    }

    pub fn snapshot_after(&self, run_id: &str, after: u64) -> Vec<Arc<FsEvent>> {
        let runs = self.runs.lock().unwrap();
        match runs.get(run_id) {
            Some(ch) => ch.ring.iter().filter(|e| e.seq > after).cloned().collect(),
            None => Vec::new(),
        }
    }

    pub fn subscribe(&self, run_id: &str) -> broadcast::Receiver<Arc<FsEvent>> {
        let mut runs = self.runs.lock().unwrap();
        runs.entry(run_id.to_string())
            .or_insert_with(RunChannel::new)
            .tx
            .subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventKind, FsEvent};
    use chrono::Utc;
    use std::sync::Arc;

    fn ev(seq: u64) -> Arc<FsEvent> {
        Arc::new(FsEvent {
            seq,
            ts: Utc::now(),
            run_id: "r".into(),
            node_id: None,
            session_id: None,
            kind: EventKind::RunStarted,
            payload: serde_json::json!({}),
        })
    }

    #[tokio::test]
    async fn publish_snapshot_subscribe() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe("r");
        hub.publish((*ev(1)).clone());
        hub.publish((*ev(2)).clone());
        assert_eq!(hub.snapshot_after("r", 0).len(), 2);
        assert_eq!(hub.snapshot_after("r", 1).len(), 1);
        let got = rx.recv().await.unwrap();
        assert_eq!(got.seq, 1);
        assert_eq!(hub.snapshot_after("nope", 0).len(), 0);
    }
}
