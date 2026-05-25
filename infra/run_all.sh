#!/bin/bash
# Hear-Me-Out: Start all 3 services
# Works in both Docker containers (run_all.sh in CMD) and JupyterLab (/workspace/run_all.sh)

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
PROJECT_DIR="${SCRIPT_DIR}"
VENV_DIR=""

# Find venv: check /workspace first (persistent volume), then $HOME
if [ -d /workspace/hearmeout-venv/bin ]; then
    VENV_DIR=/workspace/hearmeout-venv
elif [ -d "$HOME/hearmeout-venv/bin" ]; then
    VENV_DIR="$HOME/hearmeout-venv"
fi

if [ -z "$VENV_DIR" ]; then
    echo "ERROR: No venv found at /workspace/hearmeout-venv or $HOME/hearmeout-venv"
    exit 1
fi

source "$VENV_DIR/bin/activate"

# Fix huggingface-hub if moshi-personaplex downgraded it
python3 -c "from packaging.version import parse; from importlib.metadata import version; v=version('huggingface-hub'); exit(0 if parse(v) >= parse('0.34') else 1)" 2>/dev/null || {
    echo "Fixing huggingface-hub version..."
    pip install --force-reinstall --no-deps "huggingface-hub>=0.34,<1.0" -q
}

export HF_HUB_ENABLE_HF_TRANSFER=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# Kill any stale services from previous runs
pkill -f "personaplex_entry" 2>/dev/null || true
pkill -f "src.app:create_app" 2>/dev/null || true
pkill -f "meanvc_server" 2>/dev/null || true
sleep 2

echo "=== Starting PersonaPlex (GPU) on port 8000 ==="
python3 "$SCRIPT_DIR/personaplex_entry.py" --host 0.0.0.0 --port 8000 --device cuda &
PID1=$!

# Find Hear-Me-Out directory
if [ -d /workspace/Hear-Me-Out ]; then
    HEARMEOUT_DIR=/workspace/Hear-Me-Out
elif [ -d "$HOME/Hear-Me-Out" ]; then
    HEARMEOUT_DIR="$HOME/Hear-Me-Out"
else
    HEARMEOUT_DIR="$SCRIPT_DIR"
fi

cd "$HEARMEOUT_DIR"

export SPEAKER_VERIFICATION_ROOT="$HEARMEOUT_DIR/.."

echo "=== Starting vc-api (seed-vc, GPU) on port 5001 ==="
python3 -m uvicorn src.app:create_app --factory --host 0.0.0.0 --port 5001 &
PID2=$!

echo "=== Starting MeanVC (CPU) on port 5002 ==="
python3 infra/meanvc_server.py &
PID3=$!

echo "All services: PersonaPlex PID=$PID1, vc-api PID=$PID2, MeanVC PID=$PID3"
wait