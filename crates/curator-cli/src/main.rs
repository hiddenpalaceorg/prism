//! Curator CLI — thin binary over the shared `curator_cli` library (the same
//! command surface the GUI executables expose via `--cli`).

fn main() {
    std::process::exit(curator_cli::run(std::env::args().collect(), None));
}
