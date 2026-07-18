//! Renders core progress events as a 4-line loader on stderr: a tumbling
//! braille tetrahedron beside the item being worked on, a blank line, and up
//! to two progress rows (the first counter still open and the most recently
//! opened one), each as a label column, a heavy-rule bar with a half-cell
//! head, and a percentage. Indeterminate counters get a bouncing comet on
//! the same rail. Falls back to plain line output when stderr is not a
//! terminal.

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use prism_core::{Event, ProgressObserver};

use crate::tetra;

const REGION_H: usize = tetra::H + 1; // loader lines: one blank, then the spinner rows
const BARW: usize = 30; // bar columns
const LABELW: usize = 14; // label column width; longer labels truncate
const BATCHW: usize = 58; // truncation budget for the item line
const FRAME_US: u64 = 16_667; // 60fps

struct Counter {
    id: u64,
    label: String,
    total: Option<f64>,
    count: f64,
}

#[derive(Default)]
struct State {
    batch: Option<String>,
    counters: Vec<Counter>,
    pending: Vec<String>, // messages to scroll out above the loader
}

pub struct LoaderObserver {
    tty: bool,
    state: Arc<Mutex<State>>,
    running: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl LoaderObserver {
    pub fn new() -> Self {
        let tty = std::io::stderr().is_terminal();
        let state = Arc::new(Mutex::new(State::default()));
        let running = Arc::new(AtomicBool::new(true));
        let thread = tty.then(|| {
            let (state, running) = (state.clone(), running.clone());
            std::thread::spawn(move || draw_loop(state, running))
        });
        LoaderObserver { tty, state, running, thread: Mutex::new(thread) }
    }

    pub fn batch(&self, index: u64, total: u64, name: &str) {
        if self.tty {
            let label = if total > 1 {
                format!("[{}/{}] {}", index + 1, total, name)
            } else {
                name.to_string()
            };
            self.state.lock().unwrap().batch = Some(label);
        } else if total > 1 {
            eprintln!("[{}/{}] {}", index + 1, total, name);
        }
    }

    pub fn finish(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.lock().unwrap().take() {
            let _ = t.join();
        }
    }
}

impl Drop for LoaderObserver {
    fn drop(&mut self) {
        self.finish();
    }
}

impl ProgressObserver for LoaderObserver {
    fn on_event(&self, ev: Event) {
        match ev {
            Event::CounterOpen { id, label, unit: _, total } => {
                if self.tty {
                    let mut st = self.state.lock().unwrap();
                    st.counters.push(Counter { id, label, total, count: 0.0 });
                }
            }
            Event::Progress { id, count } => {
                if self.tty {
                    let mut st = self.state.lock().unwrap();
                    if let Some(c) = st.counters.iter_mut().find(|c| c.id == id) {
                        c.count = count;
                    }
                }
            }
            Event::CounterClose { id } => {
                if self.tty {
                    self.state.lock().unwrap().counters.retain(|c| c.id != id);
                }
            }
            Event::Message(m) => {
                if self.tty {
                    self.state.lock().unwrap().pending.push(m);
                } else {
                    eprintln!("{m}");
                }
            }
            Event::BatchItem { index, total, name } => {
                self.batch(index, total, &name);
            }
        }
    }
}

fn draw_loop(state: Arc<Mutex<State>>, running: Arc<AtomicBool>) {
    let t0 = Instant::now();
    let frame_dt = Duration::from_micros(FRAME_US);
    let mut next = t0 + frame_dt;
    let mut drawn = false;
    let stderr = std::io::stderr();

    while running.load(Ordering::SeqCst) {
        let t = t0.elapsed().as_secs_f32();
        let mut buf = String::new();
        {
            let mut st = state.lock().unwrap();
            // hold the first frame briefly so instant (cached) items don't flash
            if !drawn && st.counters.is_empty() && t < 0.08 {
                drop(st);
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            if drawn {
                buf.push_str(&format!("\x1b[{REGION_H}F")); // top of the loader
            }
            for m in st.pending.drain(..) {
                buf.push_str("\x1b[2K");
                buf.push_str(&m);
                buf.push('\n');
            }
            compose(&st, t, &mut buf);
        }
        drawn = true;
        {
            let mut out = stderr.lock();
            let _ = out.write_all(buf.as_bytes());
            let _ = out.flush();
        }

        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now; // don't burst to catch up after the first-frame hold
        }
        next += frame_dt;
    }

    // scroll out any last messages and take the loader down
    let mut buf = String::new();
    if drawn {
        buf.push_str(&format!("\x1b[{REGION_H}F"));
    }
    for m in state.lock().unwrap().pending.drain(..) {
        buf.push_str("\x1b[2K");
        buf.push_str(&m);
        buf.push('\n');
    }
    if drawn {
        buf.push_str("\x1b[J");
    }
    if !buf.is_empty() {
        let mut out = stderr.lock();
        let _ = out.write_all(buf.as_bytes());
        let _ = out.flush();
    }
}

// The four loader lines: spinner cells, then title / current item / bars.
// Every line is \x1b[2K-cleared before writing, so no padding is needed.
fn compose(st: &State, t: f32, buf: &mut String) {
    let spin = tetra::frame(t);
    buf.push_str("\x1b[2K\n"); // blank line separating the loader from prior output
    let texts: [String; tetra::H] = [
        st.batch.as_deref().map(|s| truncate(s, BATCHW)).unwrap_or_default(),
        String::new(),
        st.counters.first().map(|c| counter_line(c, t)).unwrap_or_default(),
        if st.counters.len() > 1 {
            counter_line(st.counters.last().unwrap(), t)
        } else {
            String::new()
        },
    ];
    for (line, text) in spin.iter().zip(texts.iter()) {
        buf.push_str("\x1b[2K");
        buf.push_str(line);
        buf.push_str("  ");
        buf.push_str(text);
        buf.push('\n');
    }
}

fn counter_line(c: &Counter, t: f32) -> String {
    let label = truncate(&c.label, LABELW);
    match c.total {
        Some(total) if total > 0.0 => {
            let frac = (c.count / total).clamp(0.0, 1.0) as f32;
            format!("{label:<LABELW$} {} {:>3}%", bar(frac), (frac * 100.0) as u32)
        }
        _ => format!("{label:<LABELW$} {}", sweep(t)),
    }
}

// Heavy rule with a half-cell head, empty missing.
fn bar(frac: f32) -> String {
    let n = (frac * BARW as f32) as usize;
    let mut s = "━".repeat(n);
    if n < BARW {
        s.push('╸');
        s.push_str(&" ".repeat(BARW - n - 1));
    }
    s
}

// Indeterminate counters: a 3-cell comet bouncing along the same rail.
fn sweep(t: f32) -> String {
    let span = (BARW - 3) as f32;
    let phase = (t * 0.7).fract() * 2.0;
    let p = if phase < 1.0 { phase } else { 2.0 - phase };
    let p = (p * span) as usize;
    let mut s = " ".repeat(p);
    s.push_str("╺━╸");
    s.push_str(&" ".repeat(BARW - p - 3));
    s
}

// Middle truncation is not worth the fuss; keep the tail, which carries the
// filename.
fn truncate(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - (max - 1)).collect();
    format!("…{tail}")
}
