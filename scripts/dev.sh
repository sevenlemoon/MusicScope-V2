#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.logs"
WEB_PORT="${MUSICSCOPE_WEB_PORT:-3100}"
API_PORT="8100"
NETEASE_PORT="36531"
POSTGRES_PORT="55432"
NO_OPEN=0
SETUP_ONLY=0
STATUS_ONLY=0
CHILD_PIDS=()

say() { printf '[MusicScope] %s\n' "$*"; }
fail() { say "FAILED: $*"; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./scripts/dev.sh [--setup] [--status] [--no-open]

  (default)  Check, bootstrap what is missing, and start PostgreSQL, sidecar, API, and web.
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

version_number() {
  printf '%s' "$1" | sed -E 's/[^0-9]*([0-9]+\.[0-9]+(\.[0-9]+)?).*/\1/'
}

check_versions() {
  command -v node >/dev/null 2>&1 || fail "Node.js 24.21.x is required. Install Node.js 24 LTS, then rerun ./scripts/dev.sh."
  command -v npm >/dev/null 2>&1 || fail "npm is required with Node.js 24 LTS. Install Node.js 24 LTS, then rerun ./scripts/dev.sh."
  command -v uv >/dev/null 2>&1 || fail "uv is required for the Python environment. Install uv, then rerun ./scripts/dev.sh."
  command -v python3 >/dev/null 2>&1 || fail "Python 3.12 is required. Install a compatible Python, then rerun ./scripts/dev.sh."

  local node_version python_version node_major node_minor python_major python_minor
  node_version="$(node --version)"
  python_version="$(python3 --version 2>&1)"
  node_major="$(version_number "$node_version" | cut -d. -f1)"
  node_minor="$(version_number "$node_version" | cut -d. -f2)"
  python_major="$(version_number "$python_version" | cut -d. -f1)"
  python_minor="$(version_number "$python_version" | cut -d. -f2)"
  [[ "$node_major" == "24" ]] || fail "Incompatible Node.js version ($node_version). MusicScope requires Node.js 24.21.x."
  ((node_minor >= 21)) || fail "Incompatible Node.js version ($node_version). MusicScope requires Node.js 24.21.x."
  [[ "$python_major" == "3" && ("$python_minor" == "12" || "$python_minor" == "13") ]] || fail "Incompatible Python version ($python_version). MusicScope requires Python 3.12 or 3.13."
  say "READY system dependencies (Node $node_version; $python_version; uv $(uv --version | awk '{print $2}'))"
}

check_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required. Install Docker Desktop, start it, then rerun ./scripts/dev.sh."
  docker info >/dev/null 2>&1 || fail "Docker is installed but unavailable. Start Docker Desktop, then rerun ./scripts/dev.sh."
  say "READY Docker daemon"
}

hash_files() {
  shasum -a 256 "$@" | shasum -a 256 | awk '{print $1}'
}

dependency_marker_matches() {
  local marker="$1" expected="$2"
  [[ -f "$marker" ]] && [[ "$(cat "$marker")" == "$expected" ]]
}

ensure_python_dependencies() {
  local marker="$LOG_DIR/backend-dependencies.sha256" expected
  expected="$(hash_files "$ROOT_DIR/apps/api/pyproject.toml" "$ROOT_DIR/apps/api/uv.lock")"
  if [[ -x "$ROOT_DIR/apps/api/.venv/bin/python" ]] && dependency_marker_matches "$marker" "$expected"; then
    say "SKIPPED Python dependencies (lockfiles unchanged)"
    return
  fi
  if [[ -x "$ROOT_DIR/apps/api/.venv/bin/python" ]] && "$ROOT_DIR/apps/api/.venv/bin/python" -c 'import alembic, fastapi, sqlalchemy, uvicorn' >/dev/null 2>&1; then
    printf '%s\n' "$expected" > "$marker"
    say "SKIPPED Python installation (existing environment validated)"
    return
  fi
  say "INSTALLING Python dependencies with uv"
  (cd "$ROOT_DIR" && uv sync --project apps/api --extra dev)
  printf '%s\n' "$expected" > "$marker"
  say "INSTALLED Python dependencies"
}

ensure_node_dependencies() {
  local project="$1" marker="$2" label="$3" expected
  expected="$(hash_files "$ROOT_DIR/$project/package.json" "$ROOT_DIR/$project/package-lock.json")"
  if [[ -d "$ROOT_DIR/$project/node_modules" ]] && dependency_marker_matches "$marker" "$expected"; then
    say "SKIPPED $label dependencies (lockfile unchanged)"
    return
  fi
  if [[ -d "$ROOT_DIR/$project/node_modules" ]] && (cd "$ROOT_DIR/$project" && npm ls --depth=0 >/dev/null 2>&1); then
    printf '%s\n' "$expected" > "$marker"
    say "SKIPPED $label installation (existing dependencies validated)"
    return
  fi
  say "INSTALLING $label dependencies with npm ci"
  (cd "$ROOT_DIR/$project" && npm ci --no-audit --no-fund)
  printf '%s\n' "$expected" > "$marker"
  say "INSTALLED $label dependencies"
}

load_env() {
  if [[ ! -f "$ROOT_DIR/.env" ]]; then
    say "LOCAL ENVIRONMENT is absent; database safety will be checked before key generation"
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

compose() { (cd "$ROOT_DIR" && docker compose "$@"); }

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

ensure_local_env() {
  local table_count key_configured
  key_configured=0
  if [[ -f "$ROOT_DIR/.env" ]] && grep -Eq '^SECRET_ENCRYPTION_KEY=.+$' "$ROOT_DIR/.env"; then
    key_configured=1
  fi
  if ((key_configured)); then
    return
  fi
  table_count="$(database_user_tables || true)"
  [[ "$table_count" =~ ^[0-9]+$ ]] || fail "Could not safely determine whether the existing database is empty. No key was generated."
  ((table_count == 0)) || fail "The database already contains MusicScope tables, but SECRET_ENCRYPTION_KEY is missing. Restore the original .env/key before starting."
  if [[ -f "$ROOT_DIR/.env" ]]; then
    (cd "$ROOT_DIR" && python3 scripts/configure_local_env.py --allow-existing-empty >/dev/null)
  else
    (cd "$ROOT_DIR" && python3 scripts/configure_local_env.py >/dev/null)
  fi
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
  API_PORT="${API_PORT:-8100}"
  NETEASE_PORT="${MUSICSCOPE_NETEASE_PORT:-36531}"
  POSTGRES_PORT="${POSTGRES_PORT:-55432}"
  say "INITIALIZED local environment (generated local encryption key)"
}

ensure_postgres() {
  compose up -d postgres >/dev/null
  wait_postgres
}

apply_migrations() {
  local alembic="$ROOT_DIR/apps/api/.venv/bin/alembic"
  [[ -x "$alembic" ]] || fail "Alembic is unavailable in the project virtualenv. Run ./scripts/dev.sh --setup again."
  say "CHECKING database migration state"
  (cd "$ROOT_DIR/apps/api" && "$alembic" current >/dev/null)
  (cd "$ROOT_DIR/apps/api" && "$alembic" upgrade head)
  say "READY database migrations"
}

port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1; }
process_command() { ps -p "$1" -o command= 2>/dev/null || true; }

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
  local name="$1" port="$2" url="$3" pattern="$4" logfile="$5"; shift 5
  service_is_healthy "$name" "$port" "$url" "$pattern" && return
  [[ -z "$(port_pid "$port")" ]] || fail "Port $port is already in use by another process. Inspect with: lsof -nP -iTCP:$port -sTCP:LISTEN"
  say "STARTING $name"
  (cd "$ROOT_DIR" && "$@") >>"$LOG_DIR/$logfile" 2>&1 &
  CHILD_PIDS+=("$!")
  local attempt=1
  while ((attempt <= 30)); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      say "READY $name"
      return
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  fail "$name did not become ready. See $LOG_DIR/$logfile."
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
    API_PORT="${API_PORT:-8100}"
    NETEASE_PORT="${NETEASE_PORT:-36531}"
    POSTGRES_PORT="${POSTGRES_PORT:-55432}"
  fi
  if [[ -n "$(port_pid "$POSTGRES_PORT")" ]]; then say "PostgreSQL: LISTENING"; else say "PostgreSQL: NOT_LISTENING/UNKNOWN"; fi
  if [[ -x "$ROOT_DIR/apps/api/.venv/bin/alembic" ]]; then
    local current
    current="$(cd "$ROOT_DIR/apps/api" && "$ROOT_DIR/apps/api/.venv/bin/alembic" current 2>/dev/null || true)"
    [[ -n "$current" ]] && say "Migration: CURRENT (revision details withheld)" || say "Migration: NOT_CURRENT/UNKNOWN"
  else say "Migration: UNKNOWN (virtualenv absent)"; fi
  curl -fsS --max-time 3 "http://127.0.0.1:$NETEASE_PORT/health" >/dev/null 2>&1 && say "NetEase sidecar: READY" || say "NetEase sidecar: NOT_READY"
  curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && say "FastAPI: READY" || say "FastAPI: NOT_READY"
  curl -fsS --max-time 3 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && say "Web: READY" || say "Web: NOT_READY"
  if curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then app_state; fi
}

cleanup() {
  local pid
  for pid in "${CHILD_PIDS[@]-}"; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done
}

main() {
  parse_args "$@"
  if ((STATUS_ONLY)); then
    status_mode
    return
  fi
  mkdir -p "$LOG_DIR"
  trap cleanup EXIT INT TERM
  cd "$ROOT_DIR"
  check_versions
  check_docker
  load_env
  ensure_python_dependencies
  ensure_node_dependencies "apps/web" "$LOG_DIR/web-dependencies.sha256" "web"
  ensure_node_dependencies "services/netease-api" "$LOG_DIR/sidecar-dependencies.sha256" "NetEase sidecar"
  ensure_postgres
  ensure_local_env
  apply_migrations
  ((SETUP_ONLY)) && { say "SETUP complete; application processes were not started"; return; }
  start_service "NetEase sidecar" "$NETEASE_PORT" "http://127.0.0.1:$NETEASE_PORT/health" 'server\.cjs' "netease.log" npm --prefix services/netease-api start
  start_service "FastAPI" "$API_PORT" "http://127.0.0.1:$API_PORT/health" 'uvicorn app\.main:app' "api.log" "$ROOT_DIR/apps/api/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$API_PORT"
  start_service "Web" "$WEB_PORT" "http://127.0.0.1:$WEB_PORT/" 'next dev' "web.log" npm --prefix apps/web run dev -- --hostname 127.0.0.1 --port "$WEB_PORT"
  say "APPLICATION READY: http://127.0.0.1:$WEB_PORT"
  app_state
  if ((NO_OPEN == 0)) && [[ "$(uname -s)" == "Darwin" ]]; then
    open "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1 || say "Browser open skipped; visit http://127.0.0.1:$WEB_PORT"
  fi
  say "Press Ctrl+C to stop services started by this launcher. PostgreSQL remains running."
  while :; do
    local pid
    for pid in "${CHILD_PIDS[@]}"; do
      kill -0 "$pid" >/dev/null 2>&1 || fail "A launched application process exited. See $LOG_DIR."
    done
    sleep 2
  done
}

main "$@"
