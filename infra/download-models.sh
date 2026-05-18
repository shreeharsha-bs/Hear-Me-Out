#!/bin/bash
# Download all models using Docker containers.
# No host Python/pip needed - just Docker.
# Models saved to ../models/ which is bind-mounted into compose services.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/models"
SEEDVC_DIR="$MODELS_DIR/seed-vc"
HF_CACHE_DIR="$MODELS_DIR/hf-cache"
DOCKER="docker"

mkdir -p "$SEEDVC_DIR" "$HF_CACHE_DIR"

# --- PersonaPlex models ---
echo "=== Downloading PersonaPlex models (nvidia/personaplex-7b-v1) ==="
PERSONAPLEX_CACHE="$MODELS_DIR/personaplex"
mkdir -p "$PERSONAPLEX_CACHE"

if [ -z "$HF_TOKEN" ]; then
  echo "WARNING: HF_TOKEN not set. PersonaPlex model is gated - accept license at:"
  echo "  https://huggingface.co/nvidia/personaplex-7b-v1"
  echo "  Then set HF_TOKEN in .env file and rerun."
else
  "$DOCKER" run --rm \
    --security-opt seccomp=unconfined \
    -v "$PERSONAPLEX_CACHE:/cache" \
    -e HF_HUB_CACHE=/cache \
    -e HF_TOKEN="$HF_TOKEN" \
    python:3.11-slim \
    sh -c '
      pip install --no-cache-dir "huggingface_hub>=0.24,<0.25" 1>&2 && \
      python3 -c "
from huggingface_hub import hf_hub_download, snapshot_download
print(\"Downloading PersonaPlex-7B model (this may take a while)...\")
snapshot_download(\"nvidia/personaplex-7b-v1\")
print(\"  PersonaPlex model downloaded\")
print(\"Downloading voice prompts...\")
hf_hub_download(\"nvidia/personaplex-7b-v1\", \"voices.tgz\")
print(\"  Voice prompts downloaded\")
"
    '
  echo "  PersonaPlex models done."
fi
echo ""

# --- Seed-VC models ---
echo "=== Downloading Seed-VC models ==="
# Copy download_models.py into temp context and run in container
"$DOCKER" run --rm \
  --security-opt seccomp=unconfined \
  -v "$SEEDVC_DIR:/out-checkpoints" \
  -v "$HF_CACHE_DIR:/cache" \
  -e HF_HUB_CACHE=/cache \
  python:3.11-slim \
  sh -c '
    pip install --no-cache-dir "huggingface_hub==0.24.7" 1>&2 && \
    pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu 1>&2 && \
    pip install --no-cache-dir transformers sentence-transformers 1>&2 && \
    python3 -c "
import logging
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
echo "  PersonaPlex: $MODELS_DIR/personaplex"
echo "  Seed-VC:     $SEEDVC_DIR"
echo "  HF cache:    $HF_CACHE_DIR"
