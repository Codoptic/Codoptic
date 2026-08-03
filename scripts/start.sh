#!/usr/bin/env bash
# Start Codoptic locally on port 4000.
# Installs dependencies and creates .env.local when needed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-4000}"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required but not found in PATH" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required but not found in PATH" >&2
  exit 1
fi

if [[ ! -f .env.local ]]; then
  if [[ -f .env.local.example ]]; then
    cp .env.local.example .env.local
    echo "Created .env.local from .env.local.example — add a provider API key before using AI features."
  else
    echo "warning: .env.local.example not found; continuing without .env.local" >&2
  fi
fi

if [[ ! -d node_modules ]] || [[ ! -f node_modules/.package-lock.json && ! -d node_modules/next ]]; then
  echo "Installing npm dependencies..."
  npm install
elif [[ package-lock.json -nt node_modules ]]; then
  echo "package-lock.json is newer than node_modules; running npm install..."
  npm install
fi

echo "Starting Codoptic at http://localhost:${PORT}"
exec npm run dev -- --port "$PORT"
