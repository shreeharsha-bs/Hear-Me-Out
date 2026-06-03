#!/usr/bin/env python3
"""Dummy PersonaPlex server to capture and save received Opus audio.
Usage: python3 tools/test-pp-server.py [--port PORT] [--out-dir DIR]

Start this, then open the frontend with:
  http://localhost:3000/?personaplex_ws=ws://localhost:8001/api/chat
"""

import asyncio
import json
import os
import struct
import sys
import time
from pathlib import Path

OUT_DIR = Path(
    sys.argv[sys.argv.index("--out-dir") + 1]
    if "--out-dir" in sys.argv
    else "tools/test-recordings"
)
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8001

OUT_DIR.mkdir(parents=True, exist_ok=True)


async def handle(websocket):
    """Handle a single PersonaPlex client connection."""
    session_id = time.strftime("%Y%m%d_%H%M%S")
    raw_path = OUT_DIR / f"session_{session_id}_opus.raw"
    print(f"\n[SERVER] Connection from {websocket.remote_address}")

    # Extract query params
    path = websocket.request.path if hasattr(websocket, "request") else "/"
    if "?" in path:
        params = dict(p.split("=") for p in path.split("?")[1].split("&") if "=" in p)
        print(f"[SERVER] Params: {params}")

    # Send PersonaPlex handshake (tag 0x00 followed by any data)
    handshake = bytearray([0])
    handshake.extend(b"ready")
    await websocket.send(bytes(handshake))
    print(f"[SERVER] Sent handshake")

    # Receive audio packets
    frames = []
    text_parts = []
    try:
        async for message in websocket:
            tag = message[0]
            payload = message[1:]
            if tag == 1:
                frames.append(bytes(payload))
                if len(frames) % 50 == 0:
                    print(f"[SERVER] Received {len(frames)} audio frames")
            elif tag == 2:
                text_parts.append(payload.decode("utf-8", errors="replace"))
                print(f"[SERVER] Text: {text_parts[-1][:60]}...")
    except Exception as e:
        print(f"[SERVER] Connection closed: {e}")

    # Save raw Opus data
    all_data = b"".join(frames)
    raw_path.write_bytes(all_data)
    print(f"[SERVER] Saved {len(frames)} frames ({len(all_data)} bytes) → {raw_path}")

    # Try to decode to WAV (requires opuslib or ffmpeg)
    wav_path = raw_path.with_suffix(".wav")
    try:
        import subprocess

        # Use ffmpeg to convert Opus → WAV
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "opus",
                "-i",
                str(raw_path),
                "-ar",
                "16000",
                "-ac",
                "1",
                str(wav_path),
            ],
            capture_output=True,
            timeout=10,
        )
        if wav_path.exists() and wav_path.stat().st_size > 100:
            print(f"[SERVER] Decoded WAV: {wav_path} ({wav_path.stat().st_size} bytes)")
    except Exception:
        print(f"[SERVER] ffmpeg not available — raw Opus saved to {raw_path}")

    if text_parts:
        txt_path = raw_path.with_suffix(".txt")
        txt_path.write_text("\n".join(text_parts))
        print(f"[SERVER] Transcript saved: {txt_path}")


async def main():
    try:
        import websockets
    except ImportError:
        print("Install websockets: pip install websockets")
        sys.exit(1)

    print(f"\n=== Dummy PersonaPlex Server ===")
    print(f"Listening on ws://0.0.0.0:{PORT}/api/chat")
    print(f"Saving recordings to: {OUT_DIR}/")
    print(f"\nUse this URL in the frontend:")
    print(f"  http://localhost:3000/?personaplex_ws=ws://localhost:{PORT}/api/chat")
    print()

    async with websockets.serve(handle, "0.0.0.0", PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
