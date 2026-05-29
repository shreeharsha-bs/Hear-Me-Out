#!/bin/bash
# Download all models into /workspace/models/
# Uses the project venv Python - no Docker needed.
# Requires: venv at /workspace/hearmeout-venv
#           HF_TOKEN env var for PersonaPlex (gated model)
set -e

WORKSPACE="${WORKSPACE:-/workspace}"
VENV_DIR="$WORKSPACE/hearmeout-venv"
MODELS_DIR="$WORKSPACE/models"

source "$VENV_DIR/bin/activate" 2>/dev/null || {
    echo "ERROR: venv not found at $VENV_DIR. Run setup.sh first."
    exit 1
}

mkdir -p "$MODELS_DIR"/{seed-vc,meanvc,meanvc-sv}

echo "=== Downloading PersonaPlex model (nvidia/personaplex-7b-v1) ==="
if [ -z "$HF_TOKEN" ]; then
    echo "WARNING: HF_TOKEN not set. PersonaPlex model is gated."
    echo "  Accept license at: https://huggingface.co/nvidia/personaplex-7b-v1"
    echo "  Then: export HF_TOKEN=hf_yourtoken && bash infra/download-models.sh"
else
    python3 -c "
import os; os.environ['HF_TOKEN']='$HF_TOKEN'
from huggingface_hub import snapshot_download, hf_hub_download
print('Downloading PersonaPlex-7B (~14GB)...')
snapshot_download('nvidia/personaplex-7b-v1')
hf_hub_download('nvidia/personaplex-7b-v1','voices.tgz')
print('PersonaPlex model ready.')
"
fi

echo ""
echo "=== Downloading Seed-VC checkpoint ==="
SEEDVC_CKPT="$MODELS_DIR/seed-vc/DiT_uvit_tat_xlsr_ema.pth"
if [ -f "$SEEDVC_CKPT" ]; then
    echo "Seed-VC checkpoint already present."
else
    python3 -c "
from huggingface_hub import hf_hub_download; import shutil
shutil.copy(hf_hub_download('Plachta/Seed-VC','DiT_uvit_tat_xlsr_ema.pth'),'$SEEDVC_CKPT')
print('Seed-VC checkpoint ready.')
"
fi

echo ""
echo "=== Downloading MeanVC checkpoints ==="
for model in meanvc_200ms.pt fastu2++.pt model_200ms.safetensors vocos.pt; do
    if [ -f "$MODELS_DIR/meanvc/$model" ]; then
        echo "  $model - present"
    else
        echo "  $model - downloading..."
        python3 -c "
from huggingface_hub import hf_hub_download; import shutil
shutil.copy(hf_hub_download('ASLP-lab/MeanVC','$model'),'$MODELS_DIR/meanvc/$model')
"
    fi
done
echo "MeanVC checkpoints ready."

echo ""
echo "=== Downloading speaker verification model ==="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$SCRIPT_DIR/download-meanvc-sv.sh"

echo ""
echo "=== All models ready ==="
echo "  Seed-VC:     $MODELS_DIR/seed-vc"
echo "  MeanVC:      $MODELS_DIR/meanvc"
echo "  MeanVC-SV:   $MODELS_DIR/meanvc-sv"
echo "  PersonaPlex: cached in HF Hub (~/.cache/huggingface)"
