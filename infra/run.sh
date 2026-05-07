#!/bin/bash
# Run Hear-Me-Out on GPU server without docker compose.
# Builds and starts vc-api (CPU) and moshi (GPU) containers.
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
  --security-opt seccomp=unconfined \
  -t hmo-vc-api \
  -f "$SCRIPT_DIR/Dockerfile.api" \
  "$PROJECT_DIR"

# Build moshi (GPU)
echo "[2/2] Building moshi (GPU)..."
docker build \
  --security-opt seccomp=unconfined \
  --build-arg PYTORCH_IMAGE=pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime \
  -t hmo-moshi \
  -f "$SCRIPT_DIR/Dockerfile.moshi" \
  "$PROJECT_DIR"

# Stop/remove old containers
docker rm -f hmo-vc-api hmo-moshi 2>/dev/null || true

# Start vc-api
echo "Starting vc-api on port 5001..."
docker run -d --name hmo-vc-api \
  --network "$NETWORK" \
  --security-opt seccomp=unconfined \
  -p 5001:5001 \
  -v "$PROJECT_DIR/models/seed-vc:/app/models/seed-vc:ro" \
  -v "$PROJECT_DIR/models/hf-cache:/app/checkpoints/hf_cache:ro" \
  -e HF_HUB_CACHE=/app/checkpoints/hf_cache \
  -e VC_MODEL_CONFIG=configs/presets/config_dit_mel_seed_uvit_xlsr_tiny.yml \
  hmo-vc-api

# Start moshi
echo "Starting moshi on port 8000..."
docker run -d --name hmo-moshi \
  --network "$NETWORK" \
  --security-opt seccomp=unconfined \
  --gpus all \
  -p 8000:8000 \
  -v "$PROJECT_DIR/models/moshi:/app/models/moshi:ro" \
  -e MOSHI_MODEL_DIR=/app/models/moshi \
  hmo-moshi

echo ""
echo "=== Done ==="
echo "  Frontend + API: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):5001"
echo "  Moshi WebSocket: ws://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):8000/ws"
