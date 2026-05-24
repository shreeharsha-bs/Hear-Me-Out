#!/bin/bash
# Download MeanVC speaker verification model (wavlm_large_finetune.pth)
# This model is on Google Drive and must be downloaded manually.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${PROJECT_DIR}/models/meanvc-sv"
OUTPUT_FILE="${OUTPUT_DIR}/wavlm_large_finetune.pth"
GDRIVE_ID="1-aE1NfzpRCLxA4GUxX9ITI3F9LlbtEGP"

mkdir -p "$OUTPUT_DIR"

if [ -f "$OUTPUT_FILE" ]; then
    echo "Speaker verification model already downloaded at $OUTPUT_FILE"
    exit 0
fi

echo "Downloading wavlm_large_finetune.pth from Google Drive..."
pip install gdown -q

# Try gdown first, then fall back to direct URL
gdown "https://drive.google.com/uc?id=${GDRIVE_ID}" -O "$OUTPUT_FILE" || {
    # Alternative: use wget with cookie approach
    echo "gdown failed, trying wget..."
    CONFIRM=$(wget --quiet --save-cookies /tmp/cookies.txt --keep-session-cookies --no-check-certificate \
        "https://docs.google.com/uc?export=download&id=${GDRIVE_ID}" -O- | \
        sed -rn 's/.*confirm=([0-9A-Za-z_]+).*/\1\n/p')
    wget --load-cookies /tmp/cookies.txt \
        "https://docs.google.com/uc?export=download&confirm=${CONFIRM}&id=${GDRIVE_ID}" \
        -O "$OUTPUT_FILE"
    rm -f /tmp/cookies.txt
}

echo "Speaker verification model downloaded to $OUTPUT_FILE"
ls -lh "$OUTPUT_FILE"