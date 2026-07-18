//! Prism CLI — thin binary over the shared `prism_cli` library (the same
//! command surface the GUI executables expose via `--cli`).

fn main() {
    std::process::exit(prism_cli::run(std::env::args().collect(), None));
}
