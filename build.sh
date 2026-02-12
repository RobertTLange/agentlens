#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR/apps/cli"

echo "Removing conflicting global npm package (if present)..."
npm uninstall -g agentlens >/dev/null 2>&1 || true

echo "Building AgentLens CLI..."
npm run build

echo "Linking AgentLens CLI globally..."
npm link

echo "Launching AgentLens..."
agentlens --browser "$@"
