#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${AGENTLENS_RUNTIME_DIR:-$HOME/.agentlens}"
PID_FILE="$RUNTIME_DIR/server.pid"

read_pid_from_file() {
  local pid_file="$1"
  node -e '
const fs = require("node:fs");
const file = process.argv[1];
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Number.isInteger(parsed.pid)) process.stdout.write(String(parsed.pid));
} catch {}
' "$pid_file"
}

stop_existing_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    return
  fi
  local pid
  pid="$(read_pid_from_file "$PID_FILE")"
  if [[ -z "$pid" ]]; then
    return
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return
  fi

  echo "Stopping existing AgentLens server (PID $pid)..."
  kill "$pid" >/dev/null 2>&1 || true
  for _ in {1..30}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done
  kill -9 "$pid" >/dev/null 2>&1 || true
}

resolve_host_port() {
  local host="${AGENTLENS_HOST:-127.0.0.1}"
  local port="${AGENTLENS_PORT:-8787}"
  local args=("$@")
  local i
  for ((i = 0; i < ${#args[@]}; i += 1)); do
    case "${args[$i]}" in
      --host)
        if ((i + 1 < ${#args[@]})); then
          host="${args[$((i + 1))]}"
        fi
        ;;
      --host=*)
        host="${args[$i]#--host=}"
        ;;
      --port)
        if ((i + 1 < ${#args[@]})); then
          port="${args[$((i + 1))]}"
        fi
        ;;
      --port=*)
        port="${args[$i]#--port=}"
        ;;
    esac
  done
  printf '%s %s\n' "$host" "$port"
}

normalize_url_host() {
  local host="$1"
  if [[ "$host" == *:* && "$host" != \[*\] ]]; then
    printf '[%s]\n' "$host"
    return
  fi
  printf '%s\n' "$host"
}

open_url() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
    return
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
    return
  fi
  if command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "" "$url" >/dev/null 2>&1 || true
  fi
}

cd "$ROOT_DIR"

echo "Removing conflicting global npm package (if present)..."
npm uninstall -g agentlens >/dev/null 2>&1 || true

stop_existing_server

echo "Building AgentLens workspace..."
npm run build

echo "Linking AgentLens CLI globally..."
cd "$ROOT_DIR/apps/cli"
npm link

echo "Launching AgentLens..."
if [[ "${AGENTLENS_SKIP_OPEN:-0}" == "1" ]]; then
  agentlens --browser "$@"
  exit 0
fi

AGENTLENS_SKIP_OPEN=1 agentlens --browser "$@"
read -r HOST PORT <<<"$(resolve_host_port "$@")"
URL_HOST="$(normalize_url_host "$HOST")"
CACHE_BUST_URL="http://${URL_HOST}:${PORT}/?reload=$(date +%s)"
open_url "$CACHE_BUST_URL"
