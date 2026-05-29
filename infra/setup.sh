#!/bin/bash
# ============================================================================
# Hear-Me-Out: One-click setup for fresh Ubuntu 22.04 GPU server
# Creates /workspace/ with all services (PersonaPlex, VC-API, MeanVC)
#
# Usage:  export HF_TOKEN=hf_yourtoken   # needed for PersonaPlex model
#         bash infra/setup.sh
#
# To only download models on existing setup:
#         bash infra/setup.sh --models-only
# ============================================================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

# --- Configurable paths ---
WORKSPACE="${WORKSPACE:-/workspace}"
REPO_DIR="$WORKSPACE/Hear-Me-Out"
VENV_DIR="$WORKSPACE/hearmeout-venv"
MODELS_DIR="$WORKSPACE/models"
PERSONAPLEX_DIR="$WORKSPACE/personaplex"
MEANVC_DIR="$WORKSPACE/MeanVC"

REPO_URL="${REPO_URL:-https://github.com/shreeharsha-bs/Hear-Me-Out.git}"
PERSONAPLEX_URL="https://github.com/NVIDIA/personaplex.git"
MEANVC_URL="https://github.com/ASLP-lab/MeanVC.git"
PERSONAPLEX_COMMIT="3428dfd95309a7f3c84fd93259ded0f810d1ff91"

MODELS_ONLY=false
[ "$1" = "--models-only" ] && MODELS_ONLY=true

if $MODELS_ONLY; then
    log "--models-only mode: skipping system/venv/repo setup"
    source "$VENV_DIR/bin/activate" 2>/dev/null || err "venv not found at $VENV_DIR"
    cd "$REPO_DIR"
else

# ============================================================================
# Phase 1: System packages
# ============================================================================
log "Phase 1/7: Installing system packages..."

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends \
    build-essential pkg-config git wget curl ca-certificates \
    python3 python3-dev python3-pip python3-venv \
    ffmpeg libsndfile1 libopus-dev libsoxr-dev openssl nodejs npm \
    2>&1 | tail -3

if command -v nvidia-smi &>/dev/null; then
    log "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
else
    warn "nvidia-smi not found - GPU may not be available"
fi

# ============================================================================
# Phase 2: Create workspace
# ============================================================================
log "Phase 2/7: Creating workspace at $WORKSPACE..."
sudo mkdir -p "$WORKSPACE"
sudo chown -R "$(whoami)" "$WORKSPACE"
mkdir -p "$MODELS_DIR"/{seed-vc,meanvc,meanvc-sv}

# ============================================================================
# Phase 3: Python virtual environment
# ============================================================================
log "Phase 3/7: Creating Python venv..."
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install --upgrade pip -q

log "Installing PyTorch 2.4.0 with CUDA 12.1..."
pip install --no-cache-dir \
    torch==2.4.0 torchaudio==2.4.0 \
    --index-url https://download.pytorch.org/whl/cu121

# ============================================================================
# Phase 4: Clone repos + install moshi
# ============================================================================
log "Phase 4/7: Cloning repositories..."

[ -d "$REPO_DIR" ] && log "Hear-Me-Out exists" || git clone "$REPO_URL" "$REPO_DIR"

if [ ! -d "$PERSONAPLEX_DIR" ]; then
    log "Cloning PersonaPlex (NVIDIA)..."
    git clone "$PERSONAPLEX_URL" "$PERSONAPLEX_DIR"
    (cd "$PERSONAPLEX_DIR" && git checkout "$PERSONAPLEX_COMMIT")
fi
log "Installing moshi from PersonaPlex..."
pip install --no-cache-dir -e "$PERSONAPLEX_DIR/moshi"

[ -d "$MEANVC_DIR" ] && log "MeanVC exists" || git clone "$MEANVC_URL" "$MEANVC_DIR"

# ============================================================================
# Phase 5: Python dependencies
# ============================================================================
log "Phase 5/7: Installing all Python dependencies..."

pip install --no-cache-dir \
    numpy==1.26.4 scipy==1.13.1 einops==0.7.0 \
    safetensors>=0.4.0 sentencepiece==0.2.0 \
    sounddevice==0.5.0 soundfile==0.12.1 "sphn>=0.1.4" \
    "huggingface-hub>=0.34" "hf-transfer>=0.1.8" \
    transformers sentence-transformers==3.3.1 accelerate \
    librosa==0.10.2 pydub==0.25.1 munch==4.0.0 \
    descript-audio-codec==1.0.0 bigvgan silero-vad \
    fastapi==0.115.5 "uvicorn[standard]==0.32.0" \
    python-multipart==0.0.18 starlette websockets \
    "aiohttp>=3.10" omegaconf matplotlib pyphen werkzeug gdown \
    2>&1 | tail -3

log "Installing seed-vc dependencies..."
pip install --no-cache-dir -r "$REPO_DIR/seed-vc/requirements.txt" 2>&1 | tail -3 || true

# Freeze for reproducibility
pip freeze > "$REPO_DIR/infra/requirements-frozen.txt"
log "Frozen requirements saved to infra/requirements-frozen.txt"

fi  # end of non-models-only block

# ============================================================================
# Phase 6: Download models
# ============================================================================
log "Phase 6/7: Downloading models..."

# PersonaPlex model (gated - needs HF_TOKEN)
if [ -n "$HF_TOKEN" ]; then
    log "Downloading PersonaPlex-7B model (10-20 min)..."
    python3 -c "
import os; os.environ['HF_TOKEN']='$HF_TOKEN'
from huggingface_hub import snapshot_download, hf_hub_download
snapshot_download('nvidia/personaplex-7b-v1')
hf_hub_download('nvidia/personaplex-7b-v1','voices.tgz')
print('PersonaPlex model ready.')
"
else
    warn "HF_TOKEN not set. PersonaPlex model is gated."
    warn "  Accept license at: https://huggingface.co/nvidia/personaplex-7b-v1"
    warn "  Then run: export HF_TOKEN=token && bash infra/setup.sh --models-only"
fi

# Seed-VC checkpoint
SEEDVC_CKPT="$MODELS_DIR/seed-vc/DiT_uvit_tat_xlsr_ema.pth"
if [ ! -f "$SEEDVC_CKPT" ]; then
    log "Downloading Seed-VC checkpoint..."
    python3 -c "
from huggingface_hub import hf_hub_download; import shutil
shutil.copy(hf_hub_download('Plachta/Seed-VC','DiT_uvit_tat_xlsr_ema.pth'),'$SEEDVC_CKPT')
print('Seed-VC checkpoint ready.')
"
else
    log "Seed-VC checkpoint present."
fi

# MeanVC checkpoints
for model in meanvc_200ms.pt fastu2++.pt model_200ms.safetensors vocos.pt; do
    if [ ! -f "$MODELS_DIR/meanvc/$model" ]; then
        log "Downloading MeanVC: $model..."
        python3 -c "
from huggingface_hub import hf_hub_download; import shutil
shutil.copy(hf_hub_download('ASLP-lab/MeanVC','$model'),'$MODELS_DIR/meanvc/$model')
"
    fi
done
log "MeanVC checkpoints ready."

# Speaker verification model
bash "$REPO_DIR/infra/download-meanvc-sv.sh" || {
    warn "Speaker verification model download failed."
    warn "  Place wavlm_large_finetune.pth at: $MODELS_DIR/meanvc-sv/"
}

# ============================================================================
# Phase 7: Runtime setup + finalize
# ============================================================================
log "Phase 7/7: Runtime setup..."

if ! $MODELS_ONLY; then
    mkdir -p "$WORKSPACE/src/runtime/speaker_verification"
    cp "$MEANVC_DIR/src/runtime/speaker_verification/"*.py \
       "$WORKSPACE/src/runtime/speaker_verification/" 2>/dev/null || true
    touch "$WORKSPACE/src/__init__.py" "$WORKSPACE/src/runtime/__init__.py"
fi

bash "$REPO_DIR/infra/generate-ssl.sh" || true

cp "$REPO_DIR/infra/personaplex_entrypoint.py" "$WORKSPACE/personaplex_entry.py"
chmod +x "$WORKSPACE/personaplex_entry.py"
cp "$REPO_DIR/infra/run_all.sh" "$WORKSPACE/run_all.sh"
chmod +x "$WORKSPACE/run_all.sh"

echo ""
echo "================================================"
echo -e "${GREEN}  Setup complete!${NC}"
echo "================================================"
echo ""
echo "  Workspace:   $WORKSPACE"
echo "  Python venv: $VENV_DIR"
echo "  Models:      $MODELS_DIR"
echo ""
echo "  Start:  cd $WORKSPACE && bash run_all.sh"
echo ""
echo "  PersonaPlex :8000   vc-api :5001   MeanVC :5002"
echo ""
