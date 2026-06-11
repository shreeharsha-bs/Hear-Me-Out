#!/bin/bash
# Build the Vite frontend
# Usage: bash infra/build-frontend.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_DIR/frontend"

cd "$FRONTEND_DIR"

echo "=== Building Vite frontend ==="

# Install when node_modules is missing OR deps changed (lockfile newer than
# the installed tree). Catches newly-added deps on a git pull, which a bare
# "[ ! -d node_modules ]" check would silently skip.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ] || [ package.json -nt node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

npm run build

echo "=== Build complete → $FRONTEND_DIR/dist ==="