#!/bin/bash
# Hear-Me-Out: Start all 3 services with SSL
# Works in both Docker containers and JupyterLab

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
VENV_DIR=""

# Find venv
if [ -d /workspace/hearmeout-venv/bin ]; then
    VENV_DIR=/workspace/hearmeout-venv
elif [ -d "$HOME/hearmeout-venv/bin" ]; then
    VENV_DIR="$HOME/hearmeout-venv"
else
    echo "ERROR: No venv found"
    exit 1
fi

source "$VENV_DIR/bin/activate"

# Auto-fix huggingface-hub
python3 -c "from packaging.version import parse; from importlib.metadata import version; v=version('huggingface-hub'); exit(0 if parse(v) >= parse('0.34') else 1)" 2>/dev/null || {
    pip install --force-reinstall --no-deps "huggingface-hub>=0.34,<1.0" -q
}

# Generate SSL certs if missing
SSL_DIR=""
for d in /workspace/ssl "$SCRIPT_DIR/ssl" "$HOME/ssl"; do
    if [ -f "$d/cert.pem" ] && [ -f "$d/key.pem" ]; then
        SSL_DIR="$d"
        break
    fi
done
if [ -z "$SSL_DIR" ]; then
    mkdir -p /workspace/ssl
    openssl req -x509 -newkey rsa:2048 -keyout /workspace/ssl/key.pem -out /workspace/ssl/cert.pem \
        -days 365 -nodes -subj "/CN=*" -addext "subjectAltName=IP:0.0.0.0" 2>/dev/null
    SSL_DIR=/workspace/ssl
    echo "Generated SSL certs in $SSL_DIR"
fi

export HF_HUB_ENABLE_HF_TRANSFER=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# Kill stale services
pkill -f "personaplex_entry" 2>/dev/null || true
pkill -f "src.app:create_app" 2>/dev/null || true
pkill -f "meanvc_server" 2>/dev/null || true
sleep 2

# Find Hear-Me-Out directory
if [ -d /workspace/Hear-Me-Out ]; then
    HEARMEOUT_DIR=/workspace/Hear-Me-Out
elif [ -d "$HOME/Hear-Me-Out" ]; then
    HEARMEOUT_DIR="$HOME/Hear-Me-Out"
else
    HEARMEOUT_DIR="$SCRIPT_DIR"
fi

# Prompt for frontend selection
if [ -z "$FRONTEND_CHOICE" ]; then
  echo ""
  echo "  Which frontend UI to serve?"
  echo "    1) New (Vite) [default]"
  echo "    2) Old (original)"
  read -t 60 -p "  Choice [1/2]: " choice < /dev/tty 2>/dev/tty || choice="1"
  case "$choice" in
    2) FRONTEND_PATH="$HEARMEOUT_DIR/src/frontend" ;;
    *) FRONTEND_PATH="$HEARMEOUT_DIR/frontend/dist" ;;
  esac
else
  case "$FRONTEND_CHOICE" in
    old) FRONTEND_PATH="$HEARMEOUT_DIR/src/frontend" ;;
    *)   FRONTEND_PATH="$HEARMEOUT_DIR/frontend/dist" ;;
  esac
fi

# Auto-build Vite if dist missing
if [ ! -d "$FRONTEND_PATH" ] && [[ "$FRONTEND_PATH" == */frontend/dist ]]; then
  echo "  Vite dist not found, building..."
  cd "$HEARMEOUT_DIR/frontend"
  [ ! -d node_modules ] && echo "  Installing frontend dependencies..." && npm install
  npm run build 2>/dev/null || {
    echo "  Build failed, falling back to old frontend"
    FRONTEND_PATH="$HEARMEOUT_DIR/src/frontend"
  }
  cd "$HEARMEOUT_DIR"
fi

echo "  Frontend: $FRONTEND_PATH"
export FRONTEND_PATH

echo "=== Starting PersonaPlex (GPU) on port 8000 (SSL) ==="
# Find personaPlex entrypoint (may be at /workspace/ or in Home)
PERSONAPLEX_ENTRY=""
for p in /workspace/personaplex_entry.py "$HOME/personaplex_entry.py" \
         "$SCRIPT_DIR/personaplex_entrypoint.py" "$SCRIPT_DIR/personaplex_entry.py"; do
    if [ -f "$p" ]; then PERSONAPLEX_ENTRY="$p"; break; fi
done
if [ -z "$PERSONAPLEX_ENTRY" ]; then
    echo "ERROR: personaplex_entry.py not found"; exit 1
fi
python3 "$PERSONAPLEX_ENTRY" --host 0.0.0.0 --port 8000 --device cuda --ssl "$SSL_DIR" &
PID1=$!

cd "$HEARMEOUT_DIR"

echo "=== Starting vc-api (seed-vc, GPU) on port 5001 (SSL) ==="
WHISPER_MODEL="${WHISPER_MODEL:-small}"
python3 -m uvicorn src.app:create_app --factory --host 0.0.0.0 --port 5001 \
    --ssl-keyfile "$SSL_DIR/key.pem" --ssl-certfile "$SSL_DIR/cert.pem" &
PID2=$!

echo "=== Starting MeanVC (CPU) on port 5002 (SSL) ==="
export SSL_DIR
export MEANVC_CKPT_DIR=/workspace/models/meanvc
export MEANVC_SV_CKPT=/workspace/models/meanvc-sv/wavlm_large_finetune.pth
export SPEAKER_VERIFICATION_ROOT=/workspace
python3 infra/meanvc_server.py &
PID3=$!

echo "All services: PersonaPlex PID=$PID1, vc-api PID=$PID2, MeanVC PID=$PID3"
wait