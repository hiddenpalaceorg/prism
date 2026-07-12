#!/usr/bin/env bash
# Resume/extend the Redump 'main' library on builds.internal. Re-runnable: the
# per-shard done-lists skip finished discs, so appending a console only analyzes
# the new files. --jobs must stay 6 (the library's fixed shard count).
set -uo pipefail
cd "$HOME/curator"
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/bin:$PATH"
R="$HOME/torrents/Minerva_Myrient/Redump"
exec scripts/curator-build-set.sh analyze \
  --bin "$PWD/target/release/curator" --adapter "$PWD/ps2exe-adapter" \
  --lib "$HOME/curator-lib/main" --jobs 6 -- \
  "$R/Sega - Mega CD & Sega CD" \
  "$R/Sega - Dreamcast" \
  "$R/Panasonic - 3DO Interactive Multiplayer" \
  "$R/Sony - PlayStation 2" \
  "$R/Sony - PlayStation 3"
