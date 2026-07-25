#!/usr/bin/env bash
# Two app slots behind one port, so the site survives both deploys and crashes.
#
# Layout on the box:
#
#   nginx  :6800          deploy/nginx.conf, unprivileged, prefix ~/proxy
#     |- slot a  127.0.0.1:6801   .next-a   tmux app-a   ~/app-a.log
#     '- slot b  127.0.0.1:6802   .next-b   tmux app-b   ~/app-b.log
#
# Both slots run the same checkout (~/curator-web) out of their own build
# directory, and that is what makes a rolling deploy possible: `next build`
# rewrites its dist dir in place, so a shared one would pull the ground out
# from under a running server. (That is why the single-process deploy this
# replaces had to stop the site to build.) A deploy here builds into
# .next-stage while both slots keep serving, then swaps one slot at a time,
# checking after each that it came back before touching the other.
#
# This script is the only thing that starts or stops an app process. The
# self-hosted runner (.github/workflows/deploy-hpwiki.yml), the manual deploy
# script and the watchdog cron all call it, and every mutating subcommand holds
# ~/.hp-web-deploy.lock, so two of them can never restart the same slot at the
# same moment.
#
#   slots.sh status              what is up, and which build each slot serves
#   slots.sh build               build into .next-stage (slots keep serving)
#   slots.sh rolling             swap both slots onto the staged build
#   slots.sh deploy              build + rolling
#   slots.sh restart             restart both slots on the build they have
#   slots.sh start|stop <a|b>    one slot, as-is (no swap)
#   slots.sh restart-bot         the Discord bot (single instance by nature)
#   slots.sh proxy <cmd>         start|stop|reload|test the front door
#   slots.sh boot                post-reboot bring-up: db, slots, proxy, bot
#   slots.sh watchdog            cron: restart whatever is not answering
#   slots.sh bootstrap           first-time cutover from the old :6800 server
set -euo pipefail

# .../curator-web/deploy/slots.sh -> the app directory is one level up.
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$APP/deploy/slots.sh"
# node is user-local here; the sbin fallbacks are for ss and nginx, which a
# non-interactive ssh or cron shell does not always have on PATH.
export PATH="$HOME/node22/bin:$PATH:/usr/sbin:/sbin"

SLOTS="a b"
FRONT_PORT="${FRONT_PORT:-6800}"
PROXY_PREFIX="${PROXY_PREFIX:-$HOME/proxy}"
LOCK="${LOCK:-$HOME/.hp-web-deploy.lock}"
STAGE="$APP/.next-stage"
BOT_SESSION=bot
# Postgres lives in a user-local data dir on this box and is not
# reboot-persistent; overridable for a host that puts it elsewhere.
PGPORT="${PGPORT:-5432}"
PG_BIN="${PG_BIN:-/usr/bin}"
PGDATA_DIR="${PGDATA_DIR:-$HOME/pgdata}"

say() { printf '\n=== %s ===\n' "$*"; }
stamp() { date -Is; }

slot_port() {
  case "$1" in
    a) echo 6801 ;;
    b) echo 6802 ;;
    *) echo "unknown slot '$1' (want a or b)" >&2; return 2 ;;
  esac
}
other_slot() { case "$1" in a) echo b ;; b) echo a ;; esac; }
slot_dist() { echo "$APP/.next-$1"; }
slot_session() { echo "app-$1"; }
slot_log() { echo "$HOME/app-$1.log"; }

# ---- process plumbing -------------------------------------------------------

port_listening() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
listener_pid() { ss -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

wait_port_free() {
  local port="$1" secs="${2:-15}" i
  for ((i = 0; i < secs; i++)); do
    port_listening "$port" || return 0
    sleep 1
  done
  ! port_listening "$port"
}

# A slot is healthy when /api/health answers 200, which it only does after a
# real round trip to Postgres. `/` alone renders fine with the database down.
slot_healthy() {
  local port
  port="$(slot_port "$1")"
  curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null
}

wait_healthy() {
  local slot="$1" secs="${2:-60}" i
  for ((i = 0; i < secs; i++)); do
    slot_healthy "$slot" && return 0
    sleep 1
  done
  return 1
}

# The fuller check a deploy runs before it trusts a freshly swapped slot: the
# database probe, the home page, and a page that reads the corpus.
verify_slot() {
  local slot="$1" port path code
  port="$(slot_port "$slot")"
  for path in /api/health / /builds; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "http://127.0.0.1:$port$path" || true)"
    printf '  slot %s  %-12s -> %s\n' "$slot" "$path" "$code"
    [ "$code" = 200 ] || return 1
  done
}

slot_build_id() {
  curl -fsS --max-time 5 "http://127.0.0.1:$(slot_port "$1")/api/health" 2>/dev/null |
    grep -o '"build":"[^"]*"' | cut -d'"' -f4
}

start_slot() {
  local slot="$1" port peer sess dist
  port="$(slot_port "$slot")"
  peer="$(slot_port "$(other_slot "$slot")")"
  sess="$(slot_session "$slot")"
  dist=".next-$slot"
  if [ ! -d "$APP/$dist" ]; then
    echo "slot $slot: no $dist to run, build and swap first" >&2
    return 1
  fi
  tmux kill-session -t "$sess" 2>/dev/null || true
  wait_port_free "$port" 15 || { echo "slot $slot: :$port is still held" >&2; return 1; }
  say "start slot $slot on :$port ($dist)"
  tmux new-session -d -s "$sess"
  # PEER_ORIGIN points at the other slot: a cache bust on one has to reach the
  # other or the two disagree for an hour (see src/lib/revalidate.ts).
  tmux send-keys -t "$sess" \
    "export PATH=\$HOME/node22/bin:\$PATH NEXT_DIST_DIR=$dist APP_SLOT=$slot PEER_ORIGIN=http://127.0.0.1:$peer; cd $APP; npx next start -H 127.0.0.1 -p $port 2>&1 | tee $(slot_log "$slot")" C-m
  if ! wait_healthy "$slot" 90; then
    echo "slot $slot did not answer /api/health:" >&2
    tail -5 "$(slot_log "$slot")" >&2 || true
    return 1
  fi
}

stop_slot() {
  local slot="$1" port sess pid
  port="$(slot_port "$slot")"
  sess="$(slot_session "$slot")"
  pid="$(listener_pid "$port" || true)"
  if [ -n "$pid" ]; then
    # SIGTERM first so next stops accepting and finishes what it is already
    # serving; killing the tmux session outright would cut downloads in half.
    kill -TERM "$pid" 2>/dev/null || true
    wait_port_free "$port" 20 || true
  fi
  tmux kill-session -t "$sess" 2>/dev/null || true
  wait_port_free "$port" 10
}

# ---- postgres, bot ----------------------------------------------------------

ensure_db() {
  PATH="$PG_BIN:$PATH" pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1 && return 0
  echo "$(stamp) postgres is down, starting it"
  PATH="$PG_BIN:$PATH" pg_ctl -D "$PGDATA_DIR" -l "$PGDATA_DIR/server.log" -o "-p $PGPORT" start
}

# The Discord bot holds one gateway session, so unlike the app it must stay a
# single process: it gets restarted, never doubled.
restart_bot() {
  if ! grep -q '^DISCORD_TOKEN=' "$APP/.env.local" 2>/dev/null; then
    echo "bot: no DISCORD_TOKEN in .env.local, skipped"
    return 0
  fi
  say "(re)start the discord bot"
  tmux kill-session -t "$BOT_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$BOT_SESSION"
  tmux send-keys -t "$BOT_SESSION" \
    "export PATH=\$HOME/node22/bin:\$PATH; cd $APP; npm run bot 2>&1 | tee $HOME/bot.log" C-m
  local i
  for ((i = 0; i < 20; i++)); do
    grep -q 'logged in as' "$HOME/bot.log" 2>/dev/null && break
    sleep 1
  done
  grep -m1 'logged in as' "$HOME/bot.log" 2>/dev/null ||
    { echo "bot did not log in:"; tail -5 "$HOME/bot.log"; return 1; }
}

# ---- front door -------------------------------------------------------------

nginx_at() { nginx -p "$PROXY_PREFIX" -c "$APP/deploy/nginx.conf" -e logs/error.log "$@"; }
proxy_running() {
  local pidfile="$PROXY_PREFIX/run/nginx.pid"
  [ -s "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}
front_ok() { curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$FRONT_PORT/healthz" 2>/dev/null; }

proxy_start() {
  mkdir -p "$PROXY_PREFIX/logs" "$PROXY_PREFIX/run" "$PROXY_PREFIX/temp"
  if proxy_running; then echo "proxy: already running"; return 0; fi
  nginx_at -t
  nginx_at
  local i
  for ((i = 0; i < 10; i++)); do
    front_ok && { echo "proxy: up on :$FRONT_PORT"; return 0; }
    sleep 1
  done
  echo "proxy did not come up:" >&2
  tail -5 "$PROXY_PREFIX/logs/error.log" >&2 || true
  return 1
}

# A reload picks up a config change without dropping a connection: old workers
# finish what they are serving. Deploys run this so a shipped nginx.conf
# actually takes effect.
proxy_reload() {
  if ! proxy_running; then proxy_start; return; fi
  nginx_at -t
  nginx_at -s reload
  echo "proxy: reloaded"
}

proxy_stop() {
  proxy_running || { echo "proxy: not running"; return 0; }
  nginx_at -s quit
  wait_port_free "$FRONT_PORT" 15
  echo "proxy: stopped"
}

# ---- the rolling swap -------------------------------------------------------

# Give every slot the staged build's client assets before anything restarts.
# Halfway through a deploy the two slots serve different builds, and a browser
# holding a page from one asks for that build's /_next/static files, which the
# load balancer may well route to the other slot. The names are content
# hashed, so seeding only ever adds files, and both builds stay answerable
# whichever slot takes the request.
seed_static() {
  local slot dist
  for slot in $SLOTS; do
    dist="$(slot_dist "$slot")"
    [ -d "$dist/static" ] || continue
    cp -aln "$STAGE/static/." "$dist/static/" 2>/dev/null || true
  done
}

# Point one slot at the staged build and restart it, keeping the build it was
# running as .next-<slot>.prev so a slot that will not come back can be put
# back the way it was.
swap_slot() {
  local slot="$1" dist prev
  dist="$(slot_dist "$slot")"
  prev="$dist.prev"
  [ -d "$STAGE" ] || { echo "no $STAGE, run '$SELF build' first" >&2; return 1; }

  rm -rf "$prev"
  if [ -d "$dist" ]; then cp -al "$dist" "$prev"; fi

  stop_slot "$slot"
  rm -rf "$dist"
  # Hardlinks: a full build directory costs no extra disk this way.
  cp -al "$STAGE" "$dist"
  # The build cache belongs to the builder. Dropping the slot's copy also stops
  # its runtime ISR writes from landing on inodes shared with .next-stage.
  rm -rf "$dist/cache"
  mkdir -p "$dist/static"
  if [ -d "$prev/static" ]; then cp -aln "$prev/static/." "$dist/static/" 2>/dev/null || true; fi

  if start_slot "$slot" && verify_slot "$slot"; then return 0; fi

  echo "::error::slot $slot did not come up on the new build, restoring its previous one" >&2
  stop_slot "$slot"
  rm -rf "$dist"
  if [ -d "$prev" ]; then cp -al "$prev" "$dist"; fi
  if start_slot "$slot" && verify_slot "$slot"; then
    echo "slot $slot is back on its previous build" >&2
  else
    echo "::error::slot $slot is DOWN after the rollback, see $(slot_log "$slot")" >&2
  fi
  return 1
}

build() {
  say "build -> .next-stage (both slots keep serving)"
  (cd "$APP" && NEXT_DIST_DIR=.next-stage npm run build)
}

rolling() {
  local slot other
  ensure_db
  [ -d "$STAGE" ] || { echo "no $STAGE, run '$SELF build' first" >&2; exit 1; }
  seed_static
  for slot in $SLOTS; do
    other="$(other_slot "$slot")"
    # Never take a slot down while the other one is not serving.
    if ! slot_healthy "$other"; then
      echo "slot $other is not answering; bringing it up before touching slot $slot"
      start_slot "$other" || true
      if ! slot_healthy "$other"; then
        # Deploying is still the right move (the fix may be in this very
        # build), but say plainly that this one will be a hard restart.
        echo "::warning::slot $other is down, so swapping slot $slot briefly takes the site with it"
      fi
    fi
    say "swap slot $slot"
    swap_slot "$slot" || exit 1
  done
  # Picks up a shipped nginx.conf; starts the front door if it is not running.
  proxy_reload
}

deploy() {
  build
  rolling
}

# Restart both slots on the builds they already have, one at a time. What to
# reach for after an .env.local change or a wedged process, when nothing needs
# rebuilding.
restart_slots() {
  local slot other
  ensure_db
  for slot in $SLOTS; do
    other="$(other_slot "$slot")"
    slot_healthy "$other" ||
      echo "::warning::slot $other is down, so restarting slot $slot briefly takes the site with it"
    stop_slot "$slot"
    start_slot "$slot"
    verify_slot "$slot"
  done
  proxy_reload
}

# ---- watchdog, boot, bootstrap ---------------------------------------------

# Cron, once a minute. Silent unless it acts, so ~/watchdog.log stays readable.
# It takes the same lock as a deploy and simply skips a tick when one is
# running, rather than fighting it for a slot.
watchdog() {
  local slot
  ensure_db
  for slot in $SLOTS; do
    if ! slot_healthy "$slot"; then
      echo "$(stamp) slot $slot is not answering, restarting it"
      start_slot "$slot" || echo "$(stamp) slot $slot failed to restart"
    fi
  done
  if ! front_ok; then
    echo "$(stamp) front door :$FRONT_PORT is down, starting the proxy"
    proxy_start || echo "$(stamp) proxy failed to start"
  fi
  if ! tmux has-session -t "$BOT_SESSION" 2>/dev/null; then
    echo "$(stamp) discord bot session is gone, restarting it"
    restart_bot || echo "$(stamp) bot failed to restart"
  fi
}

# Everything, in dependency order. The @reboot crontab entry runs this.
boot() {
  local slot
  ensure_db
  for slot in $SLOTS; do
    slot_healthy "$slot" || start_slot "$slot" || echo "$(stamp) slot $slot failed to start"
  done
  proxy_start || true
  tmux has-session -t "$BOT_SESSION" 2>/dev/null || restart_bot || true
}

CRON_MARK="deploy/slots.sh"

install_cron() {
  say "crontab entries"
  local existing add=""
  existing="$(crontab -l 2>/dev/null || true)"
  # Append only. This box's crontab is managed by DirectAdmin and carries the
  # MediaWiki sitemap job and the Actions runner's own @reboot line.
  grep -qF "$CRON_MARK boot" <<<"$existing" ||
    add="$add@reboot $SELF boot >> \$HOME/watchdog.log 2>&1"$'\n'
  grep -qF "$CRON_MARK watchdog" <<<"$existing" ||
    add="$add*/1 * * * * $SELF watchdog >> \$HOME/watchdog.log 2>&1"$'\n'
  if [ -z "$add" ]; then echo "  already installed"; return 0; fi
  printf '%s\n%s' "$existing" "$add" | crontab -
  printf '  added:\n%s' "$add" | sed 's/^/  /'
}

# First-time cutover from the single :6800 server to the two-slot layout.
# Re-runnable. The only unavailable moment in the whole change is between
# stopping that old server and nginx taking the port, about a second.
bootstrap() {
  local slot dist
  ensure_db
  mkdir -p "$PROXY_PREFIX/logs" "$PROXY_PREFIX/run" "$PROXY_PREFIX/temp"

  [ -d "$STAGE" ] || build
  for slot in $SLOTS; do
    dist="$(slot_dist "$slot")"
    if [ ! -d "$dist" ]; then
      say "seed slot $slot from the staged build"
      cp -al "$STAGE" "$dist"
      rm -rf "$dist/cache"
    fi
    slot_healthy "$slot" || start_slot "$slot"
    verify_slot "$slot"
  done

  # Both slots are serving; now hand :6800 over to nginx.
  if tmux has-session -t deploy 2>/dev/null; then
    say "retire the old single-process server (tmux 'deploy')"
    tmux kill-session -t deploy
    wait_port_free "$FRONT_PORT" 20 || true
  fi
  proxy_start
  say "verify through the front door"
  local path code
  for path in /healthz / /builds; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "http://127.0.0.1:$FRONT_PORT$path" || true)"
    printf '  :%s  %-10s -> %s\n' "$FRONT_PORT" "$path" "$code"
    [ "$code" = 200 ] || { echo "front door is not serving $path" >&2; return 1; }
  done
  install_cron
}

status() {
  local slot port
  printf 'app dir     : %s\n' "$APP"
  printf 'front :%s  : %s\n' "$FRONT_PORT" "$(front_ok && echo UP || echo DOWN)"
  for slot in $SLOTS; do
    port="$(slot_port "$slot")"
    printf 'slot %s :%s  : %-4s  build %s\n' \
      "$slot" "$port" "$(slot_healthy "$slot" && echo UP || echo DOWN)" \
      "$(slot_build_id "$slot" || echo '?')"
  done
  printf 'staged build: %s\n' "$(cat "$STAGE/BUILD_ID" 2>/dev/null || echo '(none)')"
  printf 'postgres :%s: %s\n' "$PGPORT" "$(port_listening "$PGPORT" && echo UP || echo DOWN)"
  printf 'tmux        : %s\n' "$(tmux ls 2>/dev/null | cut -d: -f1 | tr '\n' ' ')"
}

CMD="${1:-status}"
shift || true

# One deploy at a time. The manual deploy, the runner and the watchdog all come
# through here, and the lock is what keeps two of them from restarting the same
# slot at the same moment. Read-only subcommands do not need it; the watchdog
# skips its tick instead of queueing behind a deploy (-E 0 = a busy lock is not
# an error).
#
# -o is load bearing: without it the lock's file descriptor is inherited by
# every process this script starts, and the daemons among them (nginx, and the
# tmux server when none is running yet) then hold the lock for as long as they
# live, which wedged the first deploy after the cutover until nginx was
# restarted. With -o the descriptor is closed before the command runs, so only
# flock itself holds it.
if [ "${HP_WEB_SLOTS_LOCKED:-}" != 1 ]; then
  case "$CMD" in
    status | help | -h | --help) ;;
    watchdog)
      exec flock -o -n -E 0 "$LOCK" env HP_WEB_SLOTS_LOCKED=1 "$SELF" "$CMD" "$@"
      ;;
    *)
      exec flock -o -w 1800 "$LOCK" env HP_WEB_SLOTS_LOCKED=1 "$SELF" "$CMD" "$@"
      ;;
  esac
fi

case "$CMD" in
  status) status ;;
  build) build ;;
  rolling) rolling ;;
  deploy) deploy ;;
  restart) restart_slots ;;
  start) start_slot "${1:?usage: start <a|b>}" ;;
  stop) stop_slot "${1:?usage: stop <a|b>}" ;;
  swap) swap_slot "${1:?usage: swap <a|b>}" ;;
  restart-bot) restart_bot ;;
  start-db) ensure_db ;;
  proxy)
    case "${1:-status}" in
      start) proxy_start ;;
      stop) proxy_stop ;;
      reload) proxy_reload ;;
      test) nginx_at -t ;;
      status) front_ok && echo "proxy: up" || { echo "proxy: down"; exit 1; } ;;
      *) echo "usage: $SELF proxy {start|stop|reload|test|status}" >&2; exit 2 ;;
    esac
    ;;
  boot) boot ;;
  watchdog) watchdog ;;
  bootstrap) bootstrap ;;
  install-cron) install_cron ;;
  *)
    echo "usage: $SELF {status|build|rolling|deploy|restart|start <a|b>|stop <a|b>|swap <a|b>|restart-bot|start-db|proxy <cmd>|boot|watchdog|bootstrap|install-cron}" >&2
    exit 2
    ;;
esac
