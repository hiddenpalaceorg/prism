//! Drives the 4-line loader with fake events so its look can be checked
//! without analyzing a real disc image:
//!
//!   cargo run -p prism-cli --example loader_demo [seconds]

use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use prism_cli::progress::LoaderObserver;
use prism_core::{Event, ProgressObserver};

fn main() {
    let secs: f32 = std::env::args()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(8.0);

    let obs = Arc::new(LoaderObserver::new());
    obs.batch(2, 12, "Ratchet - Deadlocked (Jul 20, 2005 prototype).iso");
    obs.on_event(Event::CounterOpen {
        id: 1,
        label: "Decompressing".into(),
        unit: "B".into(),
        total: Some(1000.0),
    });

    let (files, steps) = (7usize, 100usize);
    let total_steps = (files * steps) as f64;
    let mut n = 0f64;
    for f in 0..files {
        let id = 10 + f as u64;
        obs.on_event(Event::CounterOpen {
            id,
            label: format!("file{}.wav", f + 1),
            unit: "B".into(),
            total: Some(steps as f64),
        });
        for s in 0..steps {
            obs.on_event(Event::Progress { id, count: s as f64 });
            n += 1.0;
            obs.on_event(Event::Progress { id: 1, count: 1000.0 * n / total_steps });
            sleep(Duration::from_secs_f32(secs / total_steps as f32));
        }
        obs.on_event(Event::CounterClose { id });
        if f == 2 {
            obs.on_event(Event::Message("note: a scrolled status message".into()));
        }
    }
    obs.on_event(Event::CounterClose { id: 1 });
    obs.finish();
    eprintln!("done");
}
