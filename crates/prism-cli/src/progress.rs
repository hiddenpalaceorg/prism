//! Renders core progress events as indicatif bars.

use std::collections::HashMap;
use std::sync::Mutex;

use prism_core::{Event, ProgressObserver};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

pub struct IndicatifObserver {
    mp: MultiProgress,
    bars: Mutex<HashMap<u64, ProgressBar>>,
}

impl IndicatifObserver {
    pub fn new() -> Self {
        IndicatifObserver { mp: MultiProgress::new(), bars: Mutex::new(HashMap::new()) }
    }

    pub fn batch(&self, index: u64, total: u64, name: &str) {
        if total > 1 {
            self.mp
                .println(format!("[{}/{}] {}", index + 1, total, name))
                .ok();
        }
    }

    pub fn finish(&self) {
        let mut bars = self.bars.lock().unwrap();
        for (_, bar) in bars.drain() {
            bar.finish_and_clear();
        }
    }
}

impl ProgressObserver for IndicatifObserver {
    fn on_event(&self, ev: Event) {
        match ev {
            Event::CounterOpen { id, label, unit, total } => {
                let bar = match total {
                    Some(t) => {
                        let pb = self.mp.add(ProgressBar::new(t as u64));
                        let style = if unit == "B" {
                            ProgressStyle::with_template(
                                "  {msg:30!} {bar:30} {bytes}/{total_bytes} ({eta})",
                            )
                        } else {
                            ProgressStyle::with_template("  {msg:30!} {bar:30} {pos}/{len}")
                        };
                        if let Ok(s) = style {
                            pb.set_style(s);
                        }
                        pb
                    }
                    None => {
                        let pb = self.mp.add(ProgressBar::new_spinner());
                        pb.enable_steady_tick(std::time::Duration::from_millis(120));
                        pb
                    }
                };
                bar.set_message(label);
                self.bars.lock().unwrap().insert(id, bar);
            }
            Event::Progress { id, count } => {
                if let Some(bar) = self.bars.lock().unwrap().get(&id) {
                    bar.set_position(count as u64);
                }
            }
            Event::CounterClose { id } => {
                if let Some(bar) = self.bars.lock().unwrap().remove(&id) {
                    bar.finish_and_clear();
                }
            }
            Event::Message(m) => {
                self.mp.println(m).ok();
            }
            Event::BatchItem { index, total, name } => {
                self.batch(index, total, &name);
            }
        }
    }
}
