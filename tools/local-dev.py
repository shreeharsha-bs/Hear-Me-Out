#!/usr/bin/env python3
"""Serve Hear-Me-Out frontend locally for development.
Usage: python3 tools/local-dev.py [--port PORT]

Server IP and ports are read from .env file in the project root.
Copy .env.example to .env and fill in your server details.
"""

import http.server
import os
import sys
import webbrowser
from pathlib import Path
from urllib.parse import urlencode

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
FRONTEND_DIR = PROJECT_DIR / "frontend" / "dist"


# Check if dist exists
if not (FRONTEND_DIR / "index.html").exists():
    print("frontend/dist/ not found. Build the Vite frontend first:")
    print("  cd frontend && npm run build")
    print("\nOr for development with hot-reload:")
    print("  cd frontend && npm run dev")
    sys.exit(1)


def load_dotenv():
    """Load key=value pairs from .env file."""
    env_file = PROJECT_DIR / ".env"
    if not env_file.exists():
        return {}
    result = {}
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, val = line.partition("=")
                result[key.strip()] = val.strip().strip('"').strip("'")
    return result


env = load_dotenv()
SERVER_IP = env.get("SERVER_IP", "localhost")
API_PORT = env.get("API_PORT", "5001")
PERSONAPLEX_PORT = env.get("PERSONAPLEX_PORT", "8000")
MEANVC_PORT = env.get("MEANVC_PORT", "5002")
PORT = 3000

for i, arg in enumerate(sys.argv[1:], 1):
    if arg == "--port" and i < len(sys.argv) - 1:
        PORT = int(sys.argv[i + 1])


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


api_base = f"https://{SERVER_IP}:{API_PORT}"
params = urlencode(
    {
        "api_base": api_base,
        "personaplex_host": SERVER_IP,
        "meanvc_host": SERVER_IP,
    }
)
url = f"http://localhost:{PORT}/?{params}"

os.chdir(FRONTEND_DIR)
server = http.server.HTTPServer(("", PORT), DevHandler)
print(f"Serving frontend from {FRONTEND_DIR}")
print(f"Server:     {SERVER_IP}")
print(f"API base:   {api_base}")
print(f"PersonaPlex: wss://{SERVER_IP}:{PERSONAPLEX_PORT}/api/chat")
print(f"MeanVC:     https://{SERVER_IP}:{MEANVC_PORT}")
print(f"\nOpen: {url}\n")

try:
    webbrowser.open(url)
except Exception:
    pass

server.serve_forever()
