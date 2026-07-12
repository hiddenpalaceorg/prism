#!/usr/bin/env bash
# Build (or extend) a curator library from local dump-set directories, then
# export it as a single ingestable feed. Designed to run ON the dump server,
# where the multi-TB sets live, so only the small feed ever leaves the box.
#
# Parallelism without lock contention: the library is sharded into N
# independent `curator --data-dir` stores (each its own SQLite DB + sha256
# cache), one per worker, so parallel analysis never fights the SQLite writer
# lock. A file's shard is chosen by a stable hash of its path, so adding more
# dumps (or more consoles) later reuses every existing shard's cache instead of
# reshuffling work. Resume is cheap: completed files are recorded per shard and
# skipped without re-reading their bytes.
#
# Usage:
#   curator-build-set.sh analyze --bin BIN --adapter DIR --lib DIR \
#                                 [--jobs N] [--ext "zip chd cue iso bin img"] \
#                                 ( --list FILE | -- DUMP_DIR [DUMP_DIR ...] )
#   curator-build-set.sh export  --bin BIN --lib DIR --out FEED.jsonl
#   curator-build-set.sh status  --lib DIR
#
# Inputs: scan DUMP_DIRs (Redump mode) or take an explicit newline-delimited
# --list of file paths (wiki mode — the download paths resolved from the wiki
# mapping). Either way the rest (sharding, resume, export) is identical.
#
# `analyze` is safe to re-run and to run incrementally (point it at the same
# --lib with more --jobs-consistent dirs). Keep --jobs the SAME across runs of
# one library, or existing shards won't be reused.
set -euo pipefail

die() { printf '\n!! %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*" >&2; }

MODE="${1:-}"; shift || true
[ -n "$MODE" ] || die "usage: $0 {analyze|export|status} ..."

BIN="" ADAPTER="" LIB="" OUT="" JOBS=4 LIST=""
EXTS="zip 7z chd iso cue bin img gz"
DIRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --bin)     BIN="$2"; shift 2;;
    --adapter) ADAPTER="$2"; shift 2;;
    --lib)     LIB="$2"; shift 2;;
    --out)     OUT="$2"; shift 2;;
    --jobs)    JOBS="$2"; shift 2;;
    --ext)     EXTS="$2"; shift 2;;
    --list)    LIST="$2"; shift 2;;   # newline-delimited explicit file paths
    --)        shift; DIRS=("$@"); break;;
    *)         die "unknown arg: $1";;
  esac
done

[ -n "$LIB" ] || die "--lib is required"
SHARDS_FILE="$LIB/.shards"

shard_of() { # stable: hash the path to a bucket, independent of set ordering
  local n; n=$(cksum <<<"$1" | cut -d' ' -f1); echo $(( n % JOBS ))
}

# Count lines across an optional glob of state files, tolerating no-match
# (a bare `cat missing.*` errors, and pipefail would otherwise abort us).
count_lines() { { cat "$@" 2>/dev/null || true; } | wc -l | tr -d ' '; }

case "$MODE" in
# ──────────────────────────────────────────────────────────────────────────────
analyze)
  [ -x "$BIN" ] || die "--bin must point to the curator binary"
  [ -d "$ADAPTER" ] || die "--adapter must point to the ps2exe-adapter dir"
  [ -n "$LIST" ] || [ "${#DIRS[@]}" -gt 0 ] || die "give --list FILE or DUMP_DIR(s) after --"
  [ -z "$LIST" ] || [ -f "$LIST" ] || die "--list file not found: $LIST"
  mkdir -p "$LIB"

  # A library remembers its shard count; refuse to mix.
  if [ -f "$SHARDS_FILE" ]; then
    prev="$(cat "$SHARDS_FILE")"
    [ "$prev" = "$JOBS" ] || die "library was built with --jobs $prev; re-run with that value"
  else
    echo "$JOBS" >"$SHARDS_FILE"
  fi

  STATE="$LIB/.state"; mkdir -p "$STATE"
  # Partition the file list into per-shard NUL-delimited worklists. The source
  # is either an explicit --list (e.g. wiki download paths from the mapping) or
  # a recursive scan of the given DUMP_DIRs filtered to disc extensions.
  for w in $(seq 0 $((JOBS-1))); do : >"$STATE/work.$w"; done
  emit_paths() {
    if [ -n "$LIST" ]; then
      grep -v '^[[:space:]]*$' "$LIST" | sort -u | tr '\n' '\0'
    else
      # Build the find extension filter as an array so patterns never glob the CWD.
      local findexpr=(); local e
      for e in $EXTS; do findexpr+=( -iname "*.$e" -o ); done
      unset 'findexpr[${#findexpr[@]}-1]'   # drop trailing -o
      find "${DIRS[@]}" -maxdepth 1 -type f \( "${findexpr[@]}" \) -print0 | sort -z
    fi
  }
  total=0
  while IFS= read -r -d '' f; do
    w=$(shard_of "$f")
    printf '%s\0' "$f" >>"$STATE/work.$w"
    total=$((total+1))
  done < <(emit_paths)
  echo "$total" >"$STATE/total"
  log "queued $total files across $JOBS shards"

  # ── Hang watchdog ──────────────────────────────────────────────────────────
  # A malformed nested archive can wedge libarchive indefinitely (a non-advancing
  # ARCHIVE_WARN loop, or a frozen seek_func) — see ps2exe-consumed-entry-bug.md.
  # We can't fix libarchive, so we bound each analyze from outside: kill it if it
  # makes no read progress for STALL_LIMIT, or runs longer than HARD_LIMIT for any
  # reason. "Progress" is the input file's read offset in /proc — the only honest
  # signal (the rust binary doesn't forward the adapter's counter, and the warning
  # flood would otherwise grow the err log and masquerade as progress).
  STALL_LIMIT="${CURATOR_STALL_LIMIT:-900}"    # 15 min with no advance in read offset
  HARD_LIMIT="${CURATOR_HARD_LIMIT:-7200}"     # 120 min total, regardless

  # Largest read offset among all processes holding $1 open. The analyze tree
  # shares the input file (rust opens it; the python adapter streams it), so we
  # take the max across whichever process is actually reading. Empty if none.
  file_offset() {
    local target="$1" best="" fd pid n p
    for fd in /proc/[0-9]*/fd/*; do
      [ "$(readlink "$fd" 2>/dev/null)" = "$target" ] || continue
      pid=${fd#/proc/}; pid=${pid%%/*}; n=${fd##*/}
      p=$(awk '/^pos:/{print $2}' "/proc/$pid/fdinfo/$n" 2>/dev/null) || continue
      [ -n "$p" ] || continue
      if [ -z "$best" ] || [ "$p" -gt "$best" ]; then best="$p"; fi
    done
    printf '%s' "$best"
  }

  _kill_descendants() { local p="$1" k; for k in $(pgrep -P "$p" 2>/dev/null); do _kill_descendants "$k"; done; kill -KILL "$p" 2>/dev/null || true; }

  # Kill the analyze tree (rust → uv → python). Then, defensively, KILL anything
  # still holding the input file open: a frozen seek_func emits nothing, so the
  # child won't get a SIGPIPE from the parent's closing pipe and could orphan.
  kill_analyze() {
    local root="$1" target="$2" fd pid
    _kill_descendants "$root"
    for fd in /proc/[0-9]*/fd/*; do
      [ "$(readlink "$fd" 2>/dev/null)" = "$target" ] || continue
      pid=${fd#/proc/}; pid=${pid%%/*}; kill -KILL "$pid" 2>/dev/null || true
    done
  }

  # Side process to one analyze: poll its read offset and enforce the limits.
  watchdog() {
    local w="$1" f="$2" pid="$3" start now off last_off="" last_move
    start=$(date +%s); last_move=$start
    while kill -0 "$pid" 2>/dev/null; do
      sleep 30
      kill -0 "$pid" 2>/dev/null || break
      now=$(date +%s); off=$(file_offset "$f")
      # empty offset (file not open yet / closed during finalize) counts as alive,
      # so only a concretely-frozen offset trips the stall.
      if [ -z "$off" ] || [ "$off" != "$last_off" ]; then last_off="$off"; last_move="$now"; fi
      if [ $((now - last_move)) -ge "$STALL_LIMIT" ]; then
        printf '[shard %s] STALL-KILL (no read progress for %ss): %s\n' "$w" "$STALL_LIMIT" "$f" >&2
        kill_analyze "$pid" "$f"; return 0
      fi
      if [ $((now - start)) -ge "$HARD_LIMIT" ]; then
        printf '[shard %s] CAP-KILL (ran for %ss): %s\n' "$w" "$HARD_LIMIT" "$f" >&2
        kill_analyze "$pid" "$f"; return 0
      fi
    done
  }

  # Run one analyze under the watchdog. The analyze is foreground-waited so the
  # common case (a small file finishing in seconds) returns with no added latency;
  # the watchdog runs concurrently and only acts on a genuine hang.
  run_analyze_watched() {   # $1=shard  $2=data-dir  $3=file  $4=err-log
    local w="$1" lib="$2" f="$3" errf="$4" pid wd rc=0
    "$BIN" --data-dir "$lib" --adapter-dir "$ADAPTER" analyze "$f" >/dev/null 2>>"$errf" &
    pid=$!
    watchdog "$w" "$f" "$pid" & wd=$!
    wait "$pid" || rc=$?
    kill "$wd" 2>/dev/null || true
    wait "$wd" 2>/dev/null || true
    return "$rc"
  }

  worker() {
    local w="$1" lib="$LIB/shard$w" done="$STATE/done.$w" fail="$STATE/failed.$w"
    declare -A seen
    [ -f "$done" ] && while IFS= read -r p; do seen["$p"]=1; done <"$done"
    while IFS= read -r -d '' f; do
      [ -n "${seen[$f]:-}" ] && continue
      if run_analyze_watched "$w" "$lib" "$f" "$STATE/err.$w"; then
        printf '%s\n' "$f" >>"$done"
      else
        printf '%s\n' "$f" >>"$fail"
        printf '[shard %s] FAILED: %s\n' "$w" "$f" >&2
      fi
    done <"$STATE/work.$w"
  }

  pids=()
  for w in $(seq 0 $((JOBS-1))); do worker "$w" & pids+=($!); done
  rc=0
  for p in "${pids[@]}"; do wait "$p" || rc=1; done

  d=$(count_lines "$STATE"/done.*)
  fcount=$(count_lines "$STATE"/failed.*)
  log "analyze pass complete: $d/$total done, $fcount failed (logs: $STATE/err.*)"
  exit $rc
  ;;

# ──────────────────────────────────────────────────────────────────────────────
export)
  [ -x "$BIN" ] || die "--bin must point to the curator binary"
  [ -n "$OUT" ] || die "--out FEED.jsonl is required"
  [ -f "$SHARDS_FILE" ] || die "no library at $LIB (run analyze first)"
  n="$(cat "$SHARDS_FILE")"
  : >"$OUT"
  for w in $(seq 0 $((n-1))); do
    [ -d "$LIB/shard$w" ] || continue
    "$BIN" --data-dir "$LIB/shard$w" export >>"$OUT"
  done
  lines=$(wc -l <"$OUT" | tr -d ' ')
  log "exported $lines records -> $OUT"
  ;;

# ──────────────────────────────────────────────────────────────────────────────
status)
  STATE="$LIB/.state"
  total=$(cat "$STATE/total" 2>/dev/null || echo '?')
  d=$(count_lines "$STATE"/done.*)
  f=$(count_lines "$STATE"/failed.*)
  printf 'done %s / %s  (failed %s)\n' "$d" "$total" "$f"
  ;;

*) die "unknown mode: $MODE (use analyze|export|status)";;
esac
