#!/bin/bash
# Run Hear-Me-Out on GPU server without docker compose.
# Builds and starts vc-api (CPU) and personaplex (GPU) containers.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NETWORK="hmo-net"

echo "=== Building and starting Hear-Me-Out (GPU mode) ==="

# Create network
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"

# Build vc-api (CPU)
echo "[1/2] Building vc-api..."
docker build \
  -t hmo-vc-api \
  -f "$SCRIPT_DIR/Dockerfile.api" \
  "$PROJECT_DIR"

# Build personaplex (GPU)
echo "[2/2] Building personaplex (GPU)..."
docker build \
  -t hmo-personaplex \
  -f "$SCRIPT_DIR/Dockerfile.personaplex" \
  "$PROJECT_DIR"

# Stop/remove old containers
docker rm -f hmo-vc-api hmo-personaplex 2>/dev/null || true

# Start vc-api
echo "Starting vc-api on port 5001..."
docker run -d --name hmo-vc-api \
  --network "$NETWORK" \
  --security-opt seccomp=unconfined \
  -p 5001:5001 \
  -v "$PROJECT_DIR/models/seed-vc:/app/models/seed-vc:ro" \
  -v "$PROJECT_DIR/models/hf-cache:/app/checkpoints/hf_cache:rw" \
  -e HF_HUB_CACHE=/app/checkpoints/hf_cache \
  -e VC_MODEL_CONFIG=configs/presets/config_dit_mel_seed_uvit_xlsr_tiny.yml \
  -e VC_CHECKPOINT_PATH=/app/models/seed-vc/DiT_uvit_tat_xlsr_ema.pth \
  hmo-vc-api

# Start personaplex
echo "Starting personaplex on port 8000..."
docker run -d --name hmo-personaplex \
  --network "$NETWORK" \
  --security-opt seccomp=unconfined \
  --gpus all \
  -p 8000:8000 \
  -v "$PROJECT_DIR/models/personaplex:/root/.cache/huggingface:rw" \
  --env-file "$PROJECT_DIR/.env" \
  -e HF_HUB_ENABLE_HF_TRANSFER=1 \
  hmo-personaplex

echo ""
echo "=== Done ==="
echo "  Frontend + API: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):5001"
echo "  PersonaPlex WebSocket: ws://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):8000/api/chat"
