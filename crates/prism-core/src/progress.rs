//! Progress reporting. The adapter emits NDJSON progress on its stderr; the core
//! parses it, merges it with its own batch counter, and pushes [`Event`]s to a
//! [`ProgressObserver`]. The CLI renders with indicatif; GUIs marshal to native bars.

use serde::Deserialize;

/// A progress event surfaced to a front-end.
#[derive(Debug, Clone)]
pub enum Event {
    /// Batch-level: starting item `index` of `total` (core-owned).
    BatchItem { index: u64, total: u64, name: String },
    /// A counter opened (intra-file, relayed from the adapter). `total == None` ⇒ indeterminate.
    CounterOpen { id: u64, label: String, unit: String, total: Option<f64> },
    /// Counter progressed to `count`.
    Progress { id: u64, count: f64 },
    /// A counter closed.
    CounterClose { id: u64 },
    /// A free-text status line.
    Message(String),
}

/// Implemented by front-ends to receive progress. `&self` so it can be shared.
pub trait ProgressObserver: Send + Sync {
    fn on_event(&self, ev: Event);
    /// Front-ends flip this to request cancellation; the core polls it.
    fn is_cancelled(&self) -> bool {
        false
    }
}

/// Discards all events; used by non-interactive callers.
pub struct NoopObserver;

impl ProgressObserver for NoopObserver {
    fn on_event(&self, _ev: Event) {}
}

/// Wire form of an adapter progress line (NDJSON on the adapter's stderr).
#[derive(Debug, Deserialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub(crate) enum AdapterEvent {
    CounterOpen {
        id: u64,
        #[serde(default)]
        label: String,
        #[serde(default)]
        unit: String,
        #[serde(default)]
        total: Option<f64>,
    },
    Progress {
        id: u64,
        count: f64,
    },
    CounterClose {
        id: u64,
    },
    #[serde(other)]
    Unknown,
}

impl AdapterEvent {
    pub(crate) fn into_event(self) -> Option<Event> {
        match self {
            AdapterEvent::CounterOpen { id, label, unit, total } => {
                Some(Event::CounterOpen { id, label, unit, total })
            }
            AdapterEvent::Progress { id, count } => Some(Event::Progress { id, count }),
            AdapterEvent::CounterClose { id } => Some(Event::CounterClose { id }),
            AdapterEvent::Unknown => None,
        }
    }
}
