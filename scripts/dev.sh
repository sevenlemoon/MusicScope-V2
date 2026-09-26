#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOG_DIR="$ROOT_DIR/.logs"
SETUP_LOG="$LOG_DIR/setup.log"
AUDIO_WORKER_HEALTH="$LOG_DIR/audio-worker-health.json"
WEB_PORT="${MUSICSCOPE_WEB_PORT:-3100}"
API_PORT="8100"
NETEASE_PORT="36531"
POSTGRES_PORT="55432"
NODE_REQUIRED="$(tr -d '[:space:]' < "$ROOT_DIR/.node-version" 2>/dev/null || printf '24.21.0')"
NO_OPEN=0
SETUP_ONLY=0
STATUS_ONLY=0
CHILD_PIDS=()

say() { printf '[MusicScope] %s\n' "$*"; }

fail() {
  printf '\n[MusicScope] STARTUP STOPPED\n%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./scripts/dev.sh [--setup] [--status] [--no-open]

  (default)  Check, bootstrap what is missing, and start PostgreSQL, sidecar, API, audio worker, and web.
  --setup    Check/install dependencies, start PostgreSQL, and apply migrations; stop before app processes.
  --status   Report system, database, migration, and application state without changing anything.
  --no-open  Start normally without opening a browser.
  --help     Show this help.
EOF
}

parse_args() {
  while (($#)); do
    case "$1" in
      --setup) SETUP_ONLY=1 ;;
      --status) STATUS_ONLY=1 ;;
      --no-open) NO_OPEN=1 ;;
      --help|-h) usage; exit 0 ;;
      *) fail "Unknown option: $1 (use --help)" ;;
    esac
    shift
  done
}

node_is_compatible() {
  local version="${1:-}"
  [[ "$version" =~ ^v?24\.([0-9]+)\.([0-9]+)$ ]] || return 1
  (( BASH_REMATCH[1] > 21 || (BASH_REMATCH[1] == 21 && BASH_REMATCH[2] >= 0) ))
}

activate_node_runtime() {
  local current="not installed" nvm_script
  if command -v node >/dev/null 2>&1; then
    current="$(node --version 2>/dev/null || printf 'unavailable')"
  fi
  if node_is_compatible "$current"; then return; fi

  nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [[ -s "$nvm_script" ]]; then
    set +u
    # shellcheck disable=SC1090
    source "$nvm_script" --no-use >/dev/null 2>&1 || true
    set -u
    if command -v nvm >/dev/null 2>&1 && nvm use --silent "$NODE_REQUIRED" >/dev/null 2>&1; then
      current="$(node --version 2>/dev/null || printf 'unavailable')"
    fi
  fi
  node_is_compatible "$current" && return

  fail "MusicScope requires Node.js $NODE_REQUIRED (24.x); current Node.js: $current.
This project uses the pinned .nvmrc/.node-version runtime. Install nvm from https://github.com/nvm-sh/nvm, then run:
  cd \"$ROOT_DIR\" && nvm install && nvm use
Then run MusicScope.command again. No system-wide Node upgrade was attempted."
}

check_versions() {
  command -v uv >/dev/null 2>&1 || fail "uv is required for the Python environment. Install uv, then rerun ./scripts/dev.sh."
  activate_node_runtime
  command -v npm >/dev/null 2>&1 || fail "npm is required with Node.js $NODE_REQUIRED. Activate the pinned Node runtime, then rerun ./scripts/dev.sh."
  local node_version
  node_version="$(node --version)"
  say "READY system dependencies (Node $node_version; uv $(uv --version | awk '{print $2}'))"
}

check_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required. Install Docker Desktop, start it, then rerun ./scripts/dev.sh."
  docker info >/dev/null 2>&1 || fail "Docker is installed but unavailable. Start Docker Desktop, then rerun ./scripts/dev.sh."
  say "READY Docker daemon"
}

hash_files() { shasum -a 256 "$@" | shasum -a 256 | awk '{print $1}'; }

dependency_marker_matches() {
  local marker="$1" expected="$2"
  [[ -f "$marker" ]] && [[ "$(cat "$marker")" == "$expected" ]]
}

load_env() {
  if [[ ! -f "$ROOT_DIR/.env" ]]; then
    say "LOCAL ENVIRONMENT is absent; it will be initialized before PostgreSQL starts"
    return
  fi
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
  API_PORT="${API_PORT:-8100}"
  NETEASE_PORT="${MUSICSCOPE_NETEASE_PORT:-36531}"
  POSTGRES_PORT="${POSTGRES_PORT:-55432}"
  say "SKIPPED local environment (existing .env preserved)"
}

ensure_database_env() {
  local python
  if [[ -f "$ROOT_DIR/.env" ]] && grep -Eq '^POSTGRES_PASSWORD=.+$' "$ROOT_DIR/.env"; then
    say "SKIPPED local database credential (existing configuration preserved)"
    return
  fi
  if docker volume inspect musicscope_v2_postgres_data >/dev/null 2>&1; then
    fail "The PostgreSQL volume already exists but the local database credential is missing. Restore the original ignored .env before starting; no credential or database was changed."
  fi
  python="$(uv python find 3.12 2>/dev/null || true)"
  if [[ -z "$python" ]]; then
    uv python install 3.12 >>"$SETUP_LOG" 2>&1 || fail "Could not prepare Python 3.12 for local configuration. See $SETUP_LOG."
    python="$(uv python find 3.12 2>/dev/null || true)"
  fi
  [[ -x "$python" ]] || fail "Python 3.12 is unavailable for local configuration."
  if [[ -f "$ROOT_DIR/.env" ]]; then
    "$python" "$ROOT_DIR/scripts/configure_local_env.py" --allow-existing-empty >>"$SETUP_LOG" 2>&1 || fail "Local database configuration failed. See $SETUP_LOG."
  else
    "$python" "$ROOT_DIR/scripts/configure_local_env.py" >>"$SETUP_LOG" 2>&1 || fail "Local database configuration failed. See $SETUP_LOG."
  fi
  load_env
  say "READY unique local database credential (stored only in ignored .env)"
}

compose() { (cd "$ROOT_DIR" && docker compose "$@"); }
port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1; }
process_command() { ps -p "$1" -o command= 2>/dev/null || true; }

wait_postgres() {
  local attempt=1
  while ((attempt <= 30)); do
    if compose exec -T postgres pg_isready -U "${POSTGRES_USER:-musicscope_v2}" -d "${POSTGRES_DB:-musicscope_v2}" >/dev/null 2>&1; then
      say "READY PostgreSQL"
      return
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  fail "PostgreSQL did not become ready within 60 seconds. Inspect Docker Desktop and retry."
}

database_user_tables() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-musicscope_v2}" -d "${POSTGRES_DB:-musicscope_v2}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'alembic_version'" 2>/dev/null | tr -d '[:space:]'
}

ensure_postgres() {
  local container running=0
  container="$(compose ps -q postgres 2>/dev/null || true)"
  if [[ -n "$container" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]]; then running=1; fi
  if ((running == 0)) && [[ -n "$(port_pid "$POSTGRES_PORT")" ]]; then
    fail "PostgreSQL port $POSTGRES_PORT is occupied by an unrelated process. It was not changed; stop that process or choose a free project port."
  fi
  if ! compose up -d postgres >>"$SETUP_LOG" 2>&1; then
    fail "PostgreSQL could not be started. See $SETUP_LOG for Docker output."
  fi
  wait_postgres
}

python_env_valid() {
  local python="$ROOT_DIR/apps/api/.venv/bin/python"
  [[ -x "$python" ]] || return 1
  "$python" -c 'import sys; assert sys.version_info[:2] in ((3, 12), (3, 13)); import alembic, fastapi, sqlalchemy, uvicorn' >/dev/null 2>&1
}

audio_worker_env_valid() {
  local python="$ROOT_DIR/apps/audio-worker/.venv/bin/python"
  [[ -x "$python" ]] || return 1
  "$python" -c 'import sys; assert sys.version_info[:2] == (3, 12); import demucs, numpy, torch; assert numpy.__version__ == "1.26.4"' >/dev/null 2>&1
}

ensure_python_dependencies() {
  local marker="$LOG_DIR/backend-dependencies.sha256" expected
  expected="$(hash_files "$ROOT_DIR/apps/api/pyproject.toml" "$ROOT_DIR/apps/api/uv.lock")"
  if dependency_marker_matches "$marker" "$expected" && python_env_valid; then
    say "SKIPPED Python dependencies (lockfiles unchanged)"
    return
  fi
  if python_env_valid; then
    printf '%s\n' "$expected" >"$marker"
    say "SKIPPED Python installation (existing environment validated)"
    return
  fi
  say "INSTALLING Python dependencies (details in .logs/setup.log)"
  if ! (cd "$ROOT_DIR" && uv sync --project apps/api --extra dev --python 3.12) >>"$SETUP_LOG" 2>&1; then
    fail "Python dependency setup failed. See $SETUP_LOG."
  fi
  python_env_valid || fail "The API virtual environment is not Python 3.12/3.13 after setup. See $SETUP_LOG."
  printf '%s\n' "$expected" >"$marker"
  say "READY Python dependencies"
}

ensure_audio_worker_dependencies() {
  local marker="$LOG_DIR/audio-worker-dependencies.sha256" expected
  expected="$(hash_files "$ROOT_DIR/apps/audio-worker/pyproject.toml" "$ROOT_DIR/apps/audio-worker/uv.lock")"
  if dependency_marker_matches "$marker" "$expected" && audio_worker_env_valid; then
    say "SKIPPED audio worker dependencies (lockfiles unchanged)"
    return
  fi
  if audio_worker_env_valid; then
    printf '%s\n' "$expected" >"$marker"
    say "SKIPPED audio worker installation (existing isolated environment validated)"
    return
  fi
  say "INSTALLING isolated audio worker dependencies (first setup includes Torch; details in .logs/setup.log)"
  if ! (cd "$ROOT_DIR" && UV_HTTP_TIMEOUT=300 uv sync --project apps/audio-worker --extra dev --python 3.12) >>"$SETUP_LOG" 2>&1; then
    fail "Audio worker dependency setup failed. See $SETUP_LOG."
  fi
  audio_worker_env_valid || fail "The isolated audio worker environment failed validation. See $SETUP_LOG."
  printf '%s\n' "$expected" >"$marker"
  say "READY isolated audio worker dependencies"
}

ensure_node_dependencies() {
  local project="$1" marker="$2" label="$3" expected
  expected="$(hash_files "$ROOT_DIR/$project/package.json" "$ROOT_DIR/$project/package-lock.json")"
  if [[ -d "$ROOT_DIR/$project/node_modules" ]] && dependency_marker_matches "$marker" "$expected"; then
    say "SKIPPED $label dependencies (lockfiles unchanged)"
    return
  fi
  if [[ -d "$ROOT_DIR/$project/node_modules" ]] && (cd "$ROOT_DIR/$project" && npm ls --depth=0 >/dev/null 2>&1); then
    printf '%s\n' "$expected" >"$marker"
    say "SKIPPED $label installation (existing dependencies validated)"
    return
  fi
  say "INSTALLING $label dependencies (details in .logs/setup.log)"
  if ! (cd "$ROOT_DIR/$project" && npm ci --no-audit --no-fund) >>"$SETUP_LOG" 2>&1; then
    fail "$label dependency setup failed. See $SETUP_LOG."
  fi
  printf '%s\n' "$expected" >"$marker"
  say "READY $label dependencies"
}

ensure_local_env() {
  local table_count key_configured python="$ROOT_DIR/apps/api/.venv/bin/python"
  key_configured=0
  if [[ -f "$ROOT_DIR/.env" ]] && grep -Eq '^SECRET_ENCRYPTION_KEY=.+$' "$ROOT_DIR/.env"; then key_configured=1; fi
  ((key_configured)) && return
  table_count="$(database_user_tables || true)"
  [[ "$table_count" =~ ^[0-9]+$ ]] || fail "Could not safely determine whether the existing database is empty. No key was generated."
  ((table_count == 0)) || fail "The database already contains MusicScope tables, but SECRET_ENCRYPTION_KEY is missing. Restore the original .env/key before starting."
  [[ -x "$python" ]] || fail "The API virtualenv is unavailable; cannot safely initialize .env."
  if [[ -f "$ROOT_DIR/.env" ]]; then
    (cd "$ROOT_DIR" && "$python" scripts/configure_local_env.py --allow-existing-empty) >>"$SETUP_LOG" 2>&1 || fail "Local environment setup failed. See $SETUP_LOG."
  else
    (cd "$ROOT_DIR" && "$python" scripts/configure_local_env.py) >>"$SETUP_LOG" 2>&1 || fail "Local environment setup failed. See $SETUP_LOG."
  fi
  load_env
  say "INITIALIZED local environment (generated local encryption key for an empty database)"
}

rotate_legacy_database_credential() {
  local python="$ROOT_DIR/apps/api/.venv/bin/python"
  if ! "$python" "$ROOT_DIR/scripts/configure_local_env.py" --needs-db-rotation; then return; fi
  if [[ -n "$(port_pid "$API_PORT")" ]] || audio_worker_is_healthy; then
    fail "Close the existing MusicScope application before its one-time database credential rotation, then rerun the launcher. No credential was changed."
  fi
  "$python" "$ROOT_DIR/scripts/configure_local_env.py" --rotate-legacy-db-password >>"$SETUP_LOG" 2>&1 || fail "Local database credential rotation failed. See $SETUP_LOG."
  load_env
  say "READY local database credential (legacy default rotated once)"
}

apply_migrations() {
  local alembic="$ROOT_DIR/apps/api/.venv/bin/alembic"
  [[ -x "$alembic" ]] || fail "Alembic is unavailable in the project virtualenv. Run ./scripts/dev.sh --setup again."
  say "CHECKING database migration state"
  if ! (cd "$ROOT_DIR/apps/api" && "$alembic" current) >>"$SETUP_LOG" 2>&1; then fail "Could not inspect database migration state. See $SETUP_LOG."; fi
  if ! (cd "$ROOT_DIR/apps/api" && "$alembic" upgrade head) >>"$SETUP_LOG" 2>&1; then fail "Database migration failed. No reset or destructive operation was attempted. See $SETUP_LOG."; fi
  say "READY database migrations"
}

service_is_healthy() {
  local name="$1" port="$2" url="$3" pattern="$4" pid command
  pid="$(port_pid "$port")"
  [[ -n "$pid" ]] || return 1
  command="$(process_command "$pid")"
  [[ "$command" =~ $pattern ]] || fail "Port $port is already in use by another process (PID $pid). Inspect with: lsof -nP -iTCP:$port -sTCP:LISTEN"
  curl -fsS --max-time 3 "$url" >/dev/null 2>&1 || fail "$name is running on port $port but failed its health check. Inspect PID $pid before retrying."
  say "SKIPPED $name (already healthy, PID $pid)"
  return 0
}

start_service() {
  local name="$1" port="$2" url="$3" pattern="$4" logfile="$5" workdir="$6"; shift 6
  service_is_healthy "$name" "$port" "$url" "$pattern" && return
  [[ -z "$(port_pid "$port")" ]] || fail "Port $port is already in use by another process. Inspect with: lsof -nP -iTCP:$port -sTCP:LISTEN"
  say "STARTING $name"
  : >"$LOG_DIR/$logfile"
  (cd "$workdir" && exec "$@") >>"$LOG_DIR/$logfile" 2>&1 &
  CHILD_PIDS+=("$!")
  local attempt=1 last_pid
  last_pid="${CHILD_PIDS[$((${#CHILD_PIDS[@]} - 1))]}"
  while ((attempt <= 30)); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then say "READY $name"; return; fi
    kill -0 "$last_pid" >/dev/null 2>&1 || fail "$name exited during startup. See $LOG_DIR/$logfile."
    sleep 1
    attempt=$((attempt + 1))
  done
  fail "$name did not become ready within 30 seconds. See $LOG_DIR/$logfile."
}

audio_worker_pid() {
  [[ -f "$AUDIO_WORKER_HEALTH" ]] || return 1
  "$ROOT_DIR/apps/api/.venv/bin/python" - "$AUDIO_WORKER_HEALTH" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding="utf-8")).get("pid")
    if isinstance(value, int) and value > 1:
        print(value)
except (OSError, ValueError, TypeError):
    pass
PY
}

audio_worker_is_healthy() {
  local pid command cwd
  pid="$(audio_worker_pid || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  command="$(process_command "$pid")"
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [[ "$command" == *"-m audio_worker"* && "$cwd" == "$ROOT_DIR/apps/audio-worker" ]] || return 1
  return 0
}

start_audio_worker() {
  local existing attempt=1 pid
  if audio_worker_is_healthy; then
    say "SKIPPED audio worker (already healthy, PID $(audio_worker_pid))"
    return
  fi
  existing="$(pgrep -f -- '-m audio_worker' 2>/dev/null | head -n 1 || true)"
  [[ -z "$existing" ]] || fail "An untracked MusicScope audio worker is already running (PID $existing). Inspect it before retrying."
  rm -f "$AUDIO_WORKER_HEALTH"
  : >"$LOG_DIR/audio-worker.log"
  say "STARTING audio worker"
  (cd "$ROOT_DIR/apps/audio-worker" && exec "$ROOT_DIR/apps/audio-worker/.venv/bin/python" -m audio_worker --health-file "$AUDIO_WORKER_HEALTH") >>"$LOG_DIR/audio-worker.log" 2>&1 &
  pid="$!"
  CHILD_PIDS+=("$pid")
  while ((attempt <= 30)); do
    if audio_worker_is_healthy; then say "READY audio worker"; return; fi
    kill -0 "$pid" >/dev/null 2>&1 || fail "Audio worker exited during startup. See $LOG_DIR/audio-worker.log."
    sleep 1
    attempt=$((attempt + 1))
  done
  fail "Audio worker did not become ready within 30 seconds. See $LOG_DIR/audio-worker.log."
}

app_state() {
  local connections library profile
  connections="$(curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/api/v1/music-connections" 2>/dev/null || true)"
  library="$(curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/api/v1/library/summary" 2>/dev/null || true)"
  profile="$(curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/api/v1/recommendations/profile" 2>/dev/null || true)"
  if [[ "$connections" == *'"status":"CONNECTED"'* ]]; then say "NetEase: CONNECTED"; else say "NetEase: NOT_CONNECTED/UNKNOWN"; fi
  if [[ "$library" == *'"connection_state":"connected"'* && "$library" != *'"tracks":0'* ]]; then say "Library: READY"; elif [[ -n "$library" ]]; then say "Library: EMPTY"; else say "Library: UNKNOWN"; fi
  if [[ "$profile" == *'"profile_id"'* ]]; then say "Recommendations: READY"; elif [[ "$profile" == *'Recommendation profile has not been built'* ]]; then say "Recommendations: NOT_READY"; else say "Recommendations: UNKNOWN"; fi
}

status_mode() {
  say "STATUS"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then say "Docker: READY"; else say "Docker: UNAVAILABLE"; fi
  if [[ -f "$ROOT_DIR/.env" ]]; then say "Environment: PRESENT (preserved)"; else say "Environment: ABSENT"; fi
  if [[ -f "$ROOT_DIR/.env" ]]; then
    API_PORT="$(awk -F= '$1 == "API_PORT" { print $2; exit }' "$ROOT_DIR/.env")"
    NETEASE_PORT="$(awk -F= '$1 == "MUSICSCOPE_NETEASE_PORT" { print $2; exit }' "$ROOT_DIR/.env")"
    POSTGRES_PORT="$(awk -F= '$1 == "POSTGRES_PORT" { print $2; exit }' "$ROOT_DIR/.env")"
    API_PORT="${API_PORT:-8100}"; NETEASE_PORT="${NETEASE_PORT:-36531}"; POSTGRES_PORT="${POSTGRES_PORT:-55432}"
  fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && compose exec -T postgres pg_isready -U "${POSTGRES_USER:-musicscope_v2}" -d "${POSTGRES_DB:-musicscope_v2}" >/dev/null 2>&1; then say "PostgreSQL: READY"; elif [[ -n "$(port_pid "$POSTGRES_PORT")" ]]; then say "PostgreSQL: LISTENING"; else say "PostgreSQL: NOT_READY"; fi
  if [[ -x "$ROOT_DIR/apps/api/.venv/bin/alembic" ]] && (cd "$ROOT_DIR/apps/api" && "$ROOT_DIR/apps/api/.venv/bin/alembic" current >/dev/null 2>&1); then say "Migration: CURRENT"; else say "Migration: UNKNOWN/NOT_CURRENT"; fi
  curl -fsS --max-time 3 "http://127.0.0.1:$NETEASE_PORT/health" >/dev/null 2>&1 && say "NetEase sidecar: READY" || say "NetEase sidecar: NOT_READY"
  curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && say "FastAPI: READY" || say "FastAPI: NOT_READY"
  if audio_worker_is_healthy; then say "Audio worker: READY"; else say "Audio worker: NOT_READY"; fi
  curl -fsS --max-time 3 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && say "Web: READY" || say "Web: NOT_READY"
  if curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then app_state; fi
}

descendants_of() {
  local parent="$1" child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    descendants_of "$child"
    printf '%s\n' "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

cleanup() {
  local pid target
  ((${#CHILD_PIDS[@]})) || return 0
  say "STOPPING services started by this launcher (PostgreSQL remains running)"
  for pid in "${CHILD_PIDS[@]}"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    while IFS= read -r target; do [[ "$target" =~ ^[0-9]+$ ]] && kill -TERM "$target" >/dev/null 2>&1 || true; done < <(descendants_of "$pid")
    kill -TERM "$pid" >/dev/null 2>&1 || true
  done
  sleep 1
  for pid in "${CHILD_PIDS[@]}"; do kill -KILL "$pid" >/dev/null 2>&1 || true; done
}

handle_signal() { exit 130; }

main() {
  parse_args "$@"
  if ((STATUS_ONLY)); then status_mode; return; fi
  mkdir -p "$LOG_DIR"
  : >"$SETUP_LOG"
  trap cleanup EXIT
  trap handle_signal INT TERM
  cd "$ROOT_DIR"
  say "MusicScope"
  say "[1/7] Checking environment..."
  check_versions
  check_docker
  load_env
  ensure_database_env
  say "[2/7] Checking database..."
  ensure_postgres
  say "[3/7] Preparing project dependencies..."
  ensure_python_dependencies
  ensure_audio_worker_dependencies
  ensure_node_dependencies "apps/web" "$LOG_DIR/web-dependencies.sha256" "web"
  ensure_node_dependencies "services/netease-api" "$LOG_DIR/sidecar-dependencies.sha256" "NetEase sidecar"
  ensure_local_env
  rotate_legacy_database_credential
  say "[4/7] Applying safe forward-only migrations..."
  apply_migrations
  if ((SETUP_ONLY)); then say "SETUP complete; application processes were not started"; return; fi
  say "[5/7] Starting backend services..."
  start_service "NetEase sidecar" "$NETEASE_PORT" "http://127.0.0.1:$NETEASE_PORT/health" 'server\.cjs' "netease.log" "$ROOT_DIR/services/netease-api" node server.cjs
  start_service "FastAPI" "$API_PORT" "http://127.0.0.1:$API_PORT/health" 'uvicorn.*app\.main:app' "api.log" "$ROOT_DIR/apps/api" "$ROOT_DIR/apps/api/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$API_PORT"
  say "[6/7] Starting durable audio processing..."
  start_audio_worker
  say "[7/7] Waiting for MusicScope web app..."
  start_service "Web" "$WEB_PORT" "http://127.0.0.1:$WEB_PORT/" '(next-server|next dev)' "web.log" "$ROOT_DIR/apps/web" "$ROOT_DIR/apps/web/node_modules/.bin/next" dev --hostname 127.0.0.1 --port "$WEB_PORT"
  say "APPLICATION READY: http://127.0.0.1:$WEB_PORT"
  app_state
  if ((NO_OPEN == 0)) && [[ "$(uname -s)" == "Darwin" ]]; then open "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1 || say "Browser open skipped; visit http://127.0.0.1:$WEB_PORT"; fi
  if ((${#CHILD_PIDS[@]} == 0)); then say "MusicScope was already running; no duplicate processes were started."; return; fi
  say "Press Ctrl+C to stop services started by this launcher. PostgreSQL remains running."
  while :; do
    local pid
    for pid in "${CHILD_PIDS[@]}"; do kill -0 "$pid" >/dev/null 2>&1 || fail "A launched application process exited. See $LOG_DIR."; done
    sleep 2
  done
}

main "$@"
