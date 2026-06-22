#!/usr/bin/env bash
# End-to-end demo: from nothing -> a running Curator web with the byte-shingle
# resemblance similarity tier populated and inspectable.
#
# Builds the CLI, sets up the adapter env, (re)creates the Postgres DB with the
# current schema, analyzes sample builds, exports + ingests them, then starts the
# Next.js dev server and prints URLs to inspect. Idempotent: safe to re-run.
#
# Usage:
#   ./e2e-demo.sh                  # deterministic synthetic resemblance pair (fast, ~1 min)
#   WITH_SAMPLES=1 ./e2e-demo.sh   # ALSO analyze the real Sonic CD prototypes (slow, multi-GB)
#   SKIP_EMBED=1   ./e2e-demo.sh   # skip the text-embedding model download (offline)
#   NO_SERVER=1    ./e2e-demo.sh   # do everything but don't start the dev server
#
# Env knobs: DB (curator)  PORT (3000)  DATADIR (/tmp/curator-e2e)
#
# macOS-only as written (uses hdiutil to synthesize ISOs).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DB="${DB:-curator}"
PORT="${PORT:-3000}"
DATADIR="${DATADIR:-/tmp/curator-e2e}"
DBURL="postgres:///$DB"
CAT="$DATADIR/library"                       # isolated local SQLite library
export CURATOR_ADAPTER_DIR="$ROOT/ps2exe-adapter"

log() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

trap 'die "failed on line $LINENO — see output above"' ERR

# ── prerequisites ─────────────────────────────────────────────────────────────
log "Checking prerequisites"
for t in cargo psql createdb dropdb npm npx uv python3 hdiutil curl; do need "$t"; done
pg_isready >/dev/null 2>&1 || die "Postgres is not accepting connections — start the server first"
ok "all tools present, Postgres reachable"

# ── build + envs ──────────────────────────────────────────────────────────────
log "Building the CLI"
cargo build -q -p curator-cli
RUN=( cargo run -q -p curator-cli -- --data-dir "$CAT" )
ok "curator-cli built"

log "Syncing the adapter env (uv)"
( cd "$ROOT/ps2exe-adapter" && uv sync )
ok "adapter ready: $CURATOR_ADAPTER_DIR"

log "Installing web deps"
( cd "$ROOT/web" && [ -d node_modules ] || npm install )
ok "web deps present"

# ── database ──────────────────────────────────────────────────────────────────
log "(Re)creating database '$DB' with the current schema"
dropdb --if-exists "$DB" >/dev/null
createdb "$DB"
psql -q -v ON_ERROR_STOP=1 "$DB" -f "$ROOT/web/db/schema.sql"
ok "schema applied (incl. build_resemblance — resemblance tier)"

log "Resetting workspace at $DATADIR"
rm -rf "$DATADIR"; mkdir -p "$CAT"
ok "clean workspace"

# ── synthetic deterministic resemblance pair ──────────────────────────────────────
# Two ISOs identical but for one 4 MB blob: 'b' has 300 single-byte edits scattered
# through it. That collapses chunk similarity but resemblance (shingles) stays high.
log "Synthesizing the resemblance pair (a 4 MB blob; b = a with 300 scattered 1-byte edits)"
mkdir -p "$DATADIR/a" "$DATADIR/b"
head -c 4194304 /dev/urandom > "$DATADIR/a/DATA.BIN"
printf 'BOOT=cdrom:\\MAIN.EXE\n' > "$DATADIR/a/SYSTEM.CNF"
cp "$DATADIR/a/DATA.BIN"   "$DATADIR/b/DATA.BIN"
cp "$DATADIR/a/SYSTEM.CNF" "$DATADIR/b/SYSTEM.CNF"
python3 - "$DATADIR/b/DATA.BIN" <<'PY'
import sys, random
p = sys.argv[1]; d = bytearray(open(p, "rb").read()); r = random.Random(0)
for _ in range(300):
    d[r.randrange(len(d))] ^= 0x5A
open(p, "wb").write(d)
PY
hdiutil makehybrid -quiet -iso -joliet -o "$DATADIR/a.iso" "$DATADIR/a"
hdiutil makehybrid -quiet -iso -joliet -o "$DATADIR/b.iso" "$DATADIR/b"
ok "synthetic ISOs: $DATADIR/a.iso, $DATADIR/b.iso"

log "Analyzing the synthetic pair"
"${RUN[@]}" analyze "$DATADIR/a.iso" >/dev/null
"${RUN[@]}" analyze "$DATADIR/b.iso" >/dev/null
ok "2 synthetic builds analyzed"

# ── optional: real Sonic CD lineage ────────────────────────────────────────────
if [ "${WITH_SAMPLES:-0}" = "1" ]; then
  log "Analyzing real Sonic CD prototypes (multi-GB; minutes each)"
  S="$ROOT/builds/Sonic the Hedgehog CD"
  for f in "$S (Dec 4, 1992 prototype).zip" \
           "$S (May 10, 1993 prototype) BIN+CUE.zip" \
           "$S (Oct 13, 1993 prerelease).zip"; do
    [ -f "$f" ] || { printf '    (skip, not found: %s)\n' "$(basename "$f")"; continue; }
    printf '    analyzing %s\n' "$(basename "$f")"
    "${RUN[@]}" analyze "$f" >/dev/null
  done
  ok "sample lineage analyzed"
fi

log "Library stats"; "${RUN[@]}" stats || true

# ── export + ingest ─────────────────────────────────────────────────────────────
log "Exporting library -> JSONL"
"${RUN[@]}" export -o "$DATADIR/builds.jsonl"
BUNDLE="$DATADIR/builds.jsonl"
ok "exported $(grep -c . "$BUNDLE") builds -> $BUNDLE"

if [ "${SKIP_EMBED:-0}" = "1" ]; then
  log "SKIP_EMBED=1 — stripping text_doc so ingest needs no model download"
  python3 - "$BUNDLE" > "$DATADIR/builds.noembed.jsonl" <<'PY'
import sys, json
for line in open(sys.argv[1]):
    line = line.strip()
    if line:
        o = json.loads(line); o["text_doc"] = ""; print(json.dumps(o))
PY
  BUNDLE="$DATADIR/builds.noembed.jsonl"
  ok "stripped bundle: $BUNDLE"
fi

log "Ingesting into Postgres (first run downloads the embedding model unless SKIP_EMBED=1)"
( cd "$ROOT/web" && DATABASE_URL="$DBURL" npx tsx scripts/ingest.ts "$BUNDLE" )
ok "ingested"

# ── verify the resemblance index is populated ───────────────────────────────────────
log "Builds in the corpus"
psql -q "$DB" -c "select substring(sha256,1,12) as build, name, system, file_count from builds order by ingested_at;"
log "resemblance signatures"
psql -q "$DB" -c "select substring(build_sha256,1,12) as build, array_length(minhash,1) as k from build_resemblance;"
ROWS=$(psql -tA "$DB" -c "select count(*) from build_resemblance;")
[ "${ROWS:-0}" -ge 2 ] && ok "build_resemblance has $ROWS rows" || die "no resemblance signatures ingested"

# ── start the web ────────────────────────────────────────────────────────────────
if [ "${NO_SERVER:-0}" = "1" ]; then
  log "NO_SERVER=1 — done. Start the web later with:"
  echo "    (cd web && DATABASE_URL=$DBURL npm run dev)   # then open http://localhost:$PORT"
  exit 0
fi

log "Starting the Next.js dev server on :$PORT"
LOG="$DATADIR/web.log"
( cd "$ROOT/web" && DATABASE_URL="$DBURL" PORT="$PORT" nohup npm run dev >"$LOG" 2>&1 & echo $! >"$DATADIR/web.pid" )
PID="$(cat "$DATADIR/web.pid")"

printf '    waiting for http://localhost:%s ' "$PORT"
READY=0
for _ in $(seq 1 90); do
  if curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then READY=1; break; fi
  printf '.'; sleep 1
done
printf '\n'
[ "$READY" = "1" ] || { tail -40 "$LOG"; die "server did not come up — see $LOG"; }
ok "web is up (pid $PID, logs: $LOG)"

log "Open these — look for the 'Resembling content' section"
psql -tA -F $'\t' "$DB" -c "select name, sha256 from builds order by ingested_at" \
  | while IFS=$'\t' read -r name sha; do
      printf '    %-44s http://localhost:%s/builds/%s\n' "$name" "$PORT" "$sha"
    done

cat <<EOF

  Inspect the fusion via the API (clearest view):
     curl -s localhost:$PORT/api/build/<sha256> | python3 -m json.tool | less
        .similar.resemblance     -> high jaccard to the sibling (scattered-edit tolerant)
        .similar.similar_chunks  -> low/empty for the synthetic pair (chunk hashes collapsed)
        .similar.shared_files    -> misses on the big file (its hash differs)

  Stop the server:  kill $PID        (or: pkill -f 'next dev')
  Re-run anytime:   ./$(basename "$0")     (idempotent; recreates DB '$DB')
EOF
