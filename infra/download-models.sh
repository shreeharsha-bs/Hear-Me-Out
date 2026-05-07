#!/bin/bash
# Download all models using Docker containers.
# No host Python/pip needed - just Docker.
# Models saved to ../models/ which is bind-mounted into compose services.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/models"
MOSHI_DIR="$MODELS_DIR/moshi"
SEEDVC_DIR="$MODELS_DIR/seed-vc"
HF_CACHE_DIR="$MODELS_DIR/hf-cache"
DOCKER="${DOCKER:-/Applications/Docker.app/Contents/Resources/bin/docker}"

mkdir -p "$MOSHI_DIR" "$SEEDVC_DIR" "$HF_CACHE_DIR"

# --- Moshi models ---
echo "=== Downloading Moshi models (kyutai/moshika-pytorch-q8) ==="
"$DOCKER" run --rm \
  -v "$MOSHI_DIR:/out" \
  -v "$HF_CACHE_DIR:/cache" \
  -e HF_HUB_CACHE=/cache \
  python:3.11-slim \
  sh -c '
    pip install --no-cache-dir --progress-bar off huggingface_hub 1>&2 && \
    python3 -c "
import os, shutil
from huggingface_hub import hf_hub_download
files = [
    (\"kyutai/moshika-pytorch-q8\", \"model.q8.safetensors\"),
    (\"kyutai/moshika-pytorch-q8\", \"tokenizer-e351c8d8-checkpoint125.safetensors\"),
    (\"kyutai/moshika-pytorch-q8\", \"tokenizer_spm_32k_3.model\"),
]
for repo, fname in files:
    path = hf_hub_download(repo, fname)
    dst = f\"/out/{fname}\"
    if not os.path.exists(dst):
        shutil.copy2(path, dst)
    size_gb = os.path.getsize(dst) / 1e9
    print(f\"  {fname} ({size_gb:.2f} GB)\")
print(\"  Moshi models done.\")
"
'
echo ""

# --- Seed-VC models ---
echo "=== Downloading Seed-VC models ==="
# Copy download_models.py into temp context and run in container
"$DOCKER" run --rm \
  -v "$SEEDVC_DIR:/out-checkpoints" \
  -v "$HF_CACHE_DIR:/cache" \
  -e HF_HUB_CACHE=/cache \
  python:3.11-slim \
  sh -c '
    pip install --no-cache-dir --progress-bar off huggingface_hub 1>&2 && \
    pip install --no-cache-dir --progress-bar off torch --index-url https://download.pytorch.org/whl/cpu 1>&2 && \
    pip install --no-cache-dir --progress-bar off transformers sentence-transformers 1>&2 && \
    python3 -c "
import os, sys, logging
logging.basicConfig(level=logging.INFO)

# Download XLSR speech tokenizer
from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2Model
Wav2Vec2Model.from_pretrained(\"facebook/wav2vec2-xls-r-300m\")
Wav2Vec2FeatureExtractor.from_pretrained(\"facebook/wav2vec2-xls-r-300m\")
print(\"  Downloaded: facebook/wav2vec2-xls-r-300m\")

# Download Whisper (metrics)
from transformers import AutoFeatureExtractor, WhisperModel
WhisperModel.from_pretrained(\"openai/whisper-small\", torch_dtype=\"auto\")
AutoFeatureExtractor.from_pretrained(\"openai/whisper-small\")
print(\"  Downloaded: openai/whisper-small\")

# Download sentence-transformers (metrics)
from sentence_transformers import SentenceTransformer
SentenceTransformer(\"all-mpnet-base-v2\")
print(\"  Downloaded: all-mpnet-base-v2\")

# Download CAMPPlus speaker embedding
from huggingface_hub import hf_hub_download
hf_hub_download(\"funasr/campplus\", \"campplus_cn_common.bin\")
print(\"  Downloaded: funasr/campplus/campplus_cn_common.bin\")

# Download HiFiGAN vocoder (default config)
hf_hub_download(\"FunAudioLLM/CosyVoice-300M\", \"hift.pt\")
print(\"  Downloaded: FunAudioLLM/CosyVoice-300M/hift.pt\")

print(\"Seed-VC models done.\")
"
'

echo ""
echo "=== Done. Models saved to: ==="
echo "  Moshi:    $MOSHI_DIR"
echo "  Seed-VC:  $SEEDVC_DIR"
echo "  HF cache: $HF_CACHE_DIR"
