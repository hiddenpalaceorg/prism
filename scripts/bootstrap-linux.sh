#!/usr/bin/env bash
# Bootstrap a bare Linux host into a working `curator` CLI, built from source.
#
# The supported server build path: turn a checked-out curator repo into a
# release `curator` binary plus the uv-managed adapter env it shells out to.
# Needs no root — rustup and uv install under $HOME, and uv supplies the
# adapter's pinned Python 3.10 and locked deps. The one system requirement is
# libarchive (libarchive.so), present on essentially every Linux base install.
#
# Assumes the repo is already present (this script lives in scripts/) with the
# lib/ps2exe submodule fetchable — `git clone --recurse-submodules`, or an rsync
# of a checked-out tree, satisfies this. Idempotent: re-running only does the
# work still missing.
#
# On success it prints the two paths the CLI needs at runtime:
#     CURATOR_BIN          — the built release binary
#     CURATOR_ADAPTER_DIR  — the uv-managed adapter project
set -euo pipefail

case "${1:-}" in
  -h|--help)
    printf 'Usage: %s\n\n' "${0##*/}"
    printf 'Build the curator CLI + adapter env from source on Linux.\n'
    printf 'No root; idempotent. Run from a checked-out repo (submodules fetched).\n'
    printf 'Prints CURATOR_BIN and CURATOR_ADAPTER_DIR on success.\n'
    exit 0 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"
command -v git  >/dev/null || die "git is required"
command -v cc   >/dev/null || die "a C compiler (cc) is required — install build-essential / base-devel"

# libarchive: the adapter's libarchive-c binds it via ctypes find_library('archive').
# Probe the shared object directly (robust across distros), including the Debian/
# Ubuntu multiarch dir for *this* machine's architecture (x86_64 or aarch64);
# fall back to the ldconfig cache. Avoid `ldconfig | grep -q` — grep closing the
# pipe early SIGPIPEs ldconfig, which `set -o pipefail` would read as a false miss.
has_libarchive() {
  local d f
  for d in /usr/lib64 /usr/lib /lib64 /lib \
           "/usr/lib/$(uname -m)-linux-gnu" /usr/local/lib /opt/lib; do
    for f in "$d"/libarchive.so*; do [ -e "$f" ] && return 0; done
  done
  case "$(ldconfig -p 2>/dev/null || true)" in *libarchive.so*) return 0;; esac
  return 1
}
has_libarchive || die "libarchive.so not found — install it (apt: libarchive13, dnf: libarchive, apk: libarchive, emerge: libarchive)."

# ── Rust — honors rust-toolchain.toml (stable). Reuse the system toolchain only
# if it's new enough for the repo's Cargo.lock (lockfile v4 needs cargo >= 1.78);
# otherwise install rustup's stable (user-local), which shadows system rust.
MIN_CARGO_MINOR=78
cargo_version() { command -v cargo >/dev/null 2>&1 && cargo --version 2>/dev/null | awk '{print $2}'; }
cargo_ok() {
  local v major minor
  v="$(cargo_version)" || return 1
  [ -n "$v" ] || return 1
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -ge "$MIN_CARGO_MINOR" ]; }
}
if ! cargo_ok; then
  if [ ! -f "$HOME/.cargo/env" ]; then
    log "Installing rustup (system cargo is $(cargo_version || echo absent); need >= 1.$MIN_CARGO_MINOR for Cargo.lock v4)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal
  fi
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
cargo_ok || die "need cargo >= 1.$MIN_CARGO_MINOR; have $(cargo_version || echo none) even after rustup"

# ── uv (user-local) — provides the adapter's pinned Python 3.10 + locked deps ──
if ! command -v uv >/dev/null 2>&1; then
  log "Installing uv (user-local)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || die "uv still missing after install (is $HOME/.local/bin on PATH?)"

# ── ps2exe submodule — the adapter imports it from lib/ps2exe at runtime ──────
if [ -z "$(ls -A lib/ps2exe 2>/dev/null)" ]; then
  log "Fetching the ps2exe submodule"
  git submodule update --init lib/ps2exe || die "could not fetch lib/ps2exe submodule"
fi

# ── adapter env (pinned Python 3.10 + locked deps) ────────────────────────────
log "Syncing the adapter env (uv)"
( cd ps2exe-adapter && uv sync )

# ── build the CLI (release) — resolves only curator-core + curator-cli ────────
log "Building curator-cli (release)"
cargo build --release -p curator-cli

BIN="$ROOT/target/release/curator"
[ -x "$BIN" ] || die "build reported success but $BIN is missing"
"$BIN" --version >/dev/null || die "built binary does not run"

log "Done — curator is built and the adapter env is ready."
printf 'CURATOR_BIN=%s\n' "$BIN"
printf 'CURATOR_ADAPTER_DIR=%s\n' "$ROOT/ps2exe-adapter"
