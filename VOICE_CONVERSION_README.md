# Voice Conversion Feature

This document explains how to use the new voice conversion feature added to the Hear Me Out project.

## Overview

The voice conversion feature allows you to:
1. Upload a source audio file (the voice to be converted)
2. Upload a target audio file (the reference voice style)
3. Run the Seed-VC voice conversion algorithm locally
4. Download and play the converted audio

## Setup Instructions

### 1. Install Seed-VC Dependencies

First, install the Seed-VC dependencies:

```bash
cd seed-vc

# For Mac (Apple Silicon/Intel)
pip3 install -r requirements-mac.txt

# For other systems (with CUDA support)
pip3 install -r requirements.txt
```

**Note**: This may take a while as it includes PyTorch and other ML libraries.

### 2. Install Local Server Dependencies

```bash
cd ..  # Back to project root
pip3 install -r local_server_requirements.txt
```

### 3. Start the Local Voice Conversion Server

Run the startup script (recommended) inside the conda environment moshi_modal:
```bash
./start_local_vc_server.sh
```

Or manually start the server inside the conda environment moshi_modal:
```bash
python local_vc_server.py
```

The server will start on `http://127.0.0.1:5001`

### 4. Access the Main Application

Start your main Modal application as usual. The voice conversion feature will be available in the web interface.

## How to Use

1. **Start the Local Server**: Run `./start_local_vc_server.sh` in your terminal
2. **Open the Web Interface**: Access your main Hear Me Out application
3. **Upload Audio Files**:
   - Select a **source audio file** (the voice you want to convert)
   - Select a **target audio file** (the reference voice style)
4. **Run Conversion**: Click the "Run Voice Conversion" button
5. **Listen to Results**: The converted audio will appear with a player and download link

## Supported Audio Formats

- WAV
- MP3
- FLAC
- M4A
- OGG

## Technical Details

- **Processing Location**: All voice conversion runs locally on your machine, not on Modal
- **Inference Script**: Uses `seed-vc/inference.py` with default parameters:
  - Diffusion steps: 30
  - Length adjust: 1.0
  - Inference CFG rate: 0.7
- **Timeout**: 5 minutes per conversion
- **Temporary Files**: Automatically cleaned up after processing

## Troubleshooting

### Server Won't Start
- Ensure Python 3 is installed
- Install requirements: `pip3 install -r local_server_requirements.txt`
- Check that `seed-vc/inference.py` exists

### Conversion Fails
- Check the terminal output for error messages
- Ensure audio files are valid and not corrupted
- Try with shorter audio files (< 30 seconds recommended)

### Frontend Can't Connect
- Ensure the local server is running on port 5001
- Check browser console for CORS or network errors
- Verify firewall settings allow local connections

## Security Note

The local server only accepts connections from localhost (127.0.0.1) for security. It automatically cleans up temporary files after each conversion.
