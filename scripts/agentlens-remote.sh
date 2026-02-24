#!/usr/bin/env bash
set -euo pipefail

ZONE="${AGENTLENS_GCP_ZONE:-}"
INSTANCE="${AGENTLENS_GCP_INSTANCE:-}"
LOCAL_PORT="8787"
REMOTE_PORT="18787"
PROJECT=""
USE_IAP="0"
KILL_ONLY="0"
OPEN_LOCAL="1"
CONNECTION_MODE="${AGENTLENS_CONNECTION_MODE:-gcp}"
SSH_BASE="${AGENTLENS_SSH_BASE:-}"
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Start AgentLens on a remote host and forward it to localhost.

Options:
  --connection <mode>      Connection mode: gcp|ssh (default: ${CONNECTION_MODE})
  --ssh-base <command>     Base SSH command for --connection ssh
                           Example: "ssh user@host" or "ssh -J jump user@host"
  --zone <zone>            GCE zone (required for --connection gcp)
  --instance <name>        GCE login VM name (required for --connection gcp)
  --project <id>           GCP project (default: gcloud active project)
  --local-port <port>      Local forward port (default: ${LOCAL_PORT})
  --remote-port <port>     Remote AgentLens port (default: ${REMOTE_PORT})
  --tunnel-through-iap     Use IAP TCP tunnel
  --no-open                Do not open local browser
  --kill                   Stop remote AgentLens and exit
  -h, --help               Show help

Examples:
  $(basename "$0") --connection gcp --zone europe-west4-c --instance slurm0-login-001
  $(basename "$0") --connection ssh --ssh-base "ssh user@host"
  $(basename "$0") --kill
  $(basename "$0") --tunnel-through-iap --project my-project
EOF
}

die() {
  printf "error: %s\n" "$*" >&2
  exit 1
}

is_valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((1 <= $1 && $1 <= 65535))
}

is_local_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${port}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
    return $?
  fi
  return 1
}

find_available_local_port() {
  local start_port="$1"
  local end_port=$((start_port + 100))
  local p
  for ((p = start_port; p <= end_port; p += 1)); do
    if ! is_local_port_in_use "$p"; then
      printf "%s\n" "$p"
      return 0
    fi
  done
  return 1
}

while (($# > 0)); do
  case "$1" in
    --zone)
      [[ $# -ge 2 ]] || die "--zone requires a value"
      ZONE="$2"
      shift 2
      ;;
    --connection)
      [[ $# -ge 2 ]] || die "--connection requires a value"
      CONNECTION_MODE="$2"
      shift 2
      ;;
    --ssh-base | --ssh-cmd)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      SSH_BASE="$2"
      CONNECTION_MODE="ssh"
      shift 2
      ;;
    --instance)
      [[ $# -ge 2 ]] || die "--instance requires a value"
      INSTANCE="$2"
      shift 2
      ;;
    --project)
      [[ $# -ge 2 ]] || die "--project requires a value"
      PROJECT="$2"
      shift 2
      ;;
    --local-port)
      [[ $# -ge 2 ]] || die "--local-port requires a value"
      LOCAL_PORT="$2"
      shift 2
      ;;
    --remote-port)
      [[ $# -ge 2 ]] || die "--remote-port requires a value"
      REMOTE_PORT="$2"
      shift 2
      ;;
    --tunnel-through-iap)
      USE_IAP="1"
      shift
      ;;
    --no-open)
      OPEN_LOCAL="0"
      shift
      ;;
    --kill)
      KILL_ONLY="1"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

is_valid_port "$LOCAL_PORT" || die "invalid --local-port: ${LOCAL_PORT}"
is_valid_port "$REMOTE_PORT" || die "invalid --remote-port: ${REMOTE_PORT}"
case "$CONNECTION_MODE" in
  gcp | ssh) ;;
  *) die "invalid --connection: ${CONNECTION_MODE} (expected gcp or ssh)" ;;
esac

GCLOUD_ARGS=()
if [[ "$CONNECTION_MODE" == "gcp" ]]; then
  command -v "$GCLOUD_BIN" >/dev/null 2>&1 || die "gcloud not found"
  [[ -n "$ZONE" ]] || die "--zone is required when --connection gcp"
  [[ -n "$INSTANCE" ]] || die "--instance is required when --connection gcp"
  GCLOUD_ARGS+=("--zone=${ZONE}")
  if [[ -n "$PROJECT" ]]; then
    GCLOUD_ARGS+=("--project=${PROJECT}")
  fi
  if [[ "$USE_IAP" == "1" ]]; then
    GCLOUD_ARGS+=("--tunnel-through-iap")
  fi
else
  [[ -n "$SSH_BASE" ]] || die "--ssh-base is required when --connection ssh"
  SSH_BIN="${SSH_BASE%% *}"
  [[ -n "$SSH_BIN" ]] || die "invalid --ssh-base"
  command -v "$SSH_BIN" >/dev/null 2>&1 || die "command not found: ${SSH_BIN}"
fi

gcloud_ssh() {
  "$GCLOUD_BIN" compute ssh "${GCLOUD_ARGS[@]}" "$INSTANCE" "$@"
}

run_remote_bash_script() {
  local script="$1"
  if [[ "$CONNECTION_MODE" == "gcp" ]]; then
    gcloud_ssh --command 'bash -s' <<<"$script"
    return
  fi
  bash -lc "$SSH_BASE bash -s" <<<"$script"
}

open_tunnel_connection() {
  if [[ "$CONNECTION_MODE" == "gcp" ]]; then
    gcloud_ssh -- -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}"
    return
  fi
  bash -lc "$SSH_BASE -N -L ${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}"
}

remote_label() {
  if [[ "$CONNECTION_MODE" == "gcp" ]]; then
    printf "%s (%s)" "$INSTANCE" "$ZONE"
    return
  fi
  printf "%s" "$SSH_BASE"
}

open_local_url() {
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

kill_remote_agentlens() {
  local script
  script="$(cat <<EOF
set -euo pipefail
PORT="${REMOTE_PORT}"
RUNTIME_DIR="\${AGENTLENS_RUNTIME_DIR:-\$HOME/.agentlens}"
PID_FILE="\$RUNTIME_DIR/server.pid"
pid=""

if [[ -f "\$PID_FILE" ]] && command -v node >/dev/null 2>&1; then
  pid="\$(node -e 'const fs=require("fs");const f=process.argv[1];try{const j=JSON.parse(fs.readFileSync(f,"utf8"));if(Number.isInteger(j.pid))process.stdout.write(String(j.pid));}catch{}' "\$PID_FILE" || true)"
fi

if [[ -n "\$pid" ]] && kill -0 "\$pid" >/dev/null 2>&1; then
  kill "\$pid" >/dev/null 2>&1 || true
  for _ in {1..30}; do
    if ! kill -0 "\$pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "\$pid" >/dev/null 2>&1; then
    kill -9 "\$pid" >/dev/null 2>&1 || true
  fi
  echo "Killed AgentLens PID \$pid"
  exit 0
fi

if command -v lsof >/dev/null 2>&1; then
  pids="\$(lsof -ti tcp:\$PORT -sTCP:LISTEN || true)"
  if [[ -n "\$pids" ]]; then
    killed="0"
    while IFS= read -r candidate; do
      [[ -n "\$candidate" ]] || continue
      cmd="\$(ps -p "\$candidate" -o command= 2>/dev/null || true)"
      if [[ "\$cmd" == *"agentlens"* || "\$cmd" == *"@agentlens/server"* ]]; then
        kill "\$candidate" >/dev/null 2>&1 || true
        echo "Killed AgentLens listener PID \$candidate on port \$PORT"
        killed="1"
      fi
    done <<< "\$pids"
    if [[ "\$killed" == "1" ]]; then
      exit 0
    fi
  fi
fi

echo "No running AgentLens found"
EOF
)"
  run_remote_bash_script "$script"
}

start_remote_agentlens() {
  local script
  script="$(cat <<EOF
set -euo pipefail
PORT="${REMOTE_PORT}"
HOST="127.0.0.1"

ensure_node_18_plus() {
  if command -v node >/dev/null 2>&1; then
    NODE_RAW="\$(node -v || true)"
    NODE_MAJOR="\$(printf '%s' "\$NODE_RAW" | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ -n "\$NODE_MAJOR" && "\$NODE_MAJOR" -ge 18 ]]; then
      return 0
    fi
    echo "Remote Node.js is \$NODE_RAW; upgrading to LTS..." >&2
  else
    echo "Node.js missing; installing LTS..." >&2
  fi

  export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
  if [[ ! -s "\$NVM_DIR/nvm.sh" ]]; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    else
      echo "Need curl or wget to install nvm." >&2
      return 1
    fi
  fi

  # shellcheck disable=SC1090
  source "\$NVM_DIR/nvm.sh"
  set +u
  nvm install --lts
  nvm alias default 'lts/*' >/dev/null
  nvm use --lts >/dev/null
  set -u
  hash -r

  NODE_RAW="\$(node -v || true)"
  NODE_MAJOR="\$(printf '%s' "\$NODE_RAW" | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ -z "\$NODE_MAJOR" || "\$NODE_MAJOR" -lt 18 ]]; then
    echo "Node upgrade failed; current Node: \$NODE_RAW" >&2
    return 1
  fi
  echo "Using Node \$NODE_RAW" >&2
}

ensure_node_18_plus

if command -v agentlens >/dev/null 2>&1; then
  AGENTLENS_SKIP_OPEN=1 agentlens --browser --host "\$HOST" --port "\$PORT"
else
  INSTALL_DIR="\$HOME/.local/agentlens-cli"
  BIN_PATH="\$INSTALL_DIR/node_modules/.bin/agentlens"
  if command -v npm >/dev/null 2>&1; then
    if [[ ! -x "\$BIN_PATH" ]]; then
      mkdir -p "\$INSTALL_DIR"
      npm install --prefix "\$INSTALL_DIR" --no-audit --no-fund @roberttlange/agentlens
    fi
    if [[ -x "\$BIN_PATH" ]]; then
      AGENTLENS_SKIP_OPEN=1 "\$BIN_PATH" --browser --host "\$HOST" --port "\$PORT"
      exit 0
    fi
  fi

  if AGENTLENS_SKIP_OPEN=1 npx -y -p @roberttlange/agentlens agentlens --browser --host "\$HOST" --port "\$PORT"; then
    exit 0
  fi

  if AGENTLENS_SKIP_OPEN=1 npx -y @roberttlange/agentlens --browser --host "\$HOST" --port "\$PORT"; then
    exit 0
  fi

  echo "Failed to launch AgentLens via npx. Install once on remote:" >&2
  echo "  npm install -g @roberttlange/agentlens" >&2
  exit 1
fi
EOF
)"
  run_remote_bash_script "$script"
}

if [[ "$KILL_ONLY" == "1" ]]; then
  kill_remote_agentlens
  exit 0
fi

if is_local_port_in_use "$LOCAL_PORT"; then
  NEXT_LOCAL_PORT="$(find_available_local_port "$((LOCAL_PORT + 1))" || true)"
  [[ -n "$NEXT_LOCAL_PORT" ]] || die "local port ${LOCAL_PORT} in use and no free port found in range"
  printf "local port %s busy; using %s\n" "$LOCAL_PORT" "$NEXT_LOCAL_PORT" >&2
  LOCAL_PORT="$NEXT_LOCAL_PORT"
fi

start_remote_agentlens
URL="http://127.0.0.1:${LOCAL_PORT}"
printf "Tunnel: localhost:%s -> %s:%s\n" "$LOCAL_PORT" "$(remote_label)" "$REMOTE_PORT"
printf "Open: %s\n" "$URL"
if [[ "$OPEN_LOCAL" == "1" ]]; then
  open_local_url "$URL"
fi

open_tunnel_connection
