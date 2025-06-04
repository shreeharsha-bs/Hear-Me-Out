#!/bin/bash

echo "Starting Local Voice Conversion Server..."
echo "This server will handle voice conversion requests using the local Seed-VC inference.py script"
echo

# Check if Python is available
if ! command -v python &> /dev/null; then
    echo "Error: Python is required but not installed."
    exit 1
fi

# Check if pip is available
if ! command -v pip &> /dev/null; then
    echo "Error: pip is required but not installed."
    exit 1
fi

# Install local server requirements
echo "Installing local server requirements..."
pip install -r local_server_requirements.txt

# Check if seed-vc directory exists
if [ ! -d "seed-vc" ]; then
    echo "Error: seed-vc directory not found."
    echo "Please ensure the seed-vc directory is present in the project root."
    exit 1
fi

# Check if inference.py exists
if [ ! -f "seed-vc/inference.py" ]; then
    echo "Error: inference.py not found in seed-vc directory."
    exit 1
fi

echo "Checking Seed-VC dependencies..."

# Test if seed-vc dependencies are installed
cd seed-vc
python -c "
import sys
try:
    import torch
    import numpy as np
    import librosa
    print('✓ Core Seed-VC dependencies available')
except ImportError as e:
    print(f'⚠️  Missing Seed-VC dependencies: {e}')
    print('Please install Seed-VC requirements first:')
    print('  cd seed-vc')
    print('  pip install -r requirements-mac.txt  # For Mac')
    print('  # or')
    print('  pip install -r requirements.txt      # For other systems')
    sys.exit(1)
" || {
    echo "Please install Seed-VC dependencies before starting the server."
    echo "Run the following commands:"
    echo "  cd seed-vc"
    echo "  pip install -r requirements-mac.txt  # For Mac"
    echo "  # or"
    echo "  pip install -r requirements.txt      # For other systems"
    exit 1
}

cd ..

echo "Starting the local voice conversion server on http://127.0.0.1:5001"
echo "Press Ctrl+C to stop the server"
echo

# Start the server
python local_vc_server.py
