#!/bin/bash
# Download MeanVC speaker verification model (wavlm_large_finetune.pth)
# Google Drive ID: 1-aE1NfzpRCLxA4GUxX9ITI3F9LlbtEGP

set -e

WORKSPACE="${WORKSPACE:-/workspace}"
OUTPUT_DIR="$WORKSPACE/models/meanvc-sv"
OUTPUT_FILE="${OUTPUT_DIR}/wavlm_large_finetune.pth"
GDRIVE_ID="1-aE1NfzpRCLxA4GUxX9ITI3F9LlbtEGP"

export PATH="$HOME/.local/bin:$PATH"

mkdir -p "$OUTPUT_DIR"

if [ -f "$OUTPUT_FILE" ]; then
    SIZE=$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || stat -f%z "$OUTPUT_FILE" 2>/dev/null)
    if [ "$SIZE" -gt 1048576 ]; then
        echo "Speaker verification model already downloaded ($SIZE bytes)"
        exit 0
    fi
    echo "Removing incomplete download ($SIZE bytes)"
    rm -f "$OUTPUT_FILE"
fi

echo "Downloading wavlm_large_finetune.pth (~320MB) from Google Drive..."
pip install gdown -q 2>/dev/null

gdown "https://drive.google.com/uc?id=${GDRIVE_ID}" -O "$OUTPUT_FILE" || {
    echo "gdown failed. Trying alternative method..."
    gdown "${GDRIVE_ID}" -O "$OUTPUT_FILE" || {
        echo "ERROR: Could not download the model."
        echo "Please download manually from:"
        echo "  https://drive.google.com/file/d/${GDRIVE_ID}/view"
        echo "And place it at: $OUTPUT_FILE"
        exit 1
    }
}

SIZE=$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || stat -f%z "$OUTPUT_FILE" 2>/dev/null)
echo "Downloaded: $OUTPUT_FILE ($SIZE bytes)"
