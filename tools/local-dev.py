#!/usr/bin/env python3
"""Serve Hear-Me-Out frontend locally for development.
Usage: python3 tools/local-dev.py [--port PORT] [--server-ip IP]
Opens the frontend with API/WS endpoints pointed to the remote server.
"""

import http.server
import os
import sys
import webbrowser
from pathlib import Path
from urllib.parse import urlencode

SCRIPT_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = SCRIPT_DIR.parent / "src" / "frontend"

SERVER_IP = "<redacted>"
PORT = 3000

for i, arg in enumerate(sys.argv[1:], 1):
    if arg == "--port" and i < len(sys.argv) - 1:
        PORT = int(sys.argv[i + 1])
    elif arg == "--server-ip" and i < len(sys.argv) - 1:
        SERVER_IP = sys.argv[i + 1]


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


params = urlencode(
    {
        "api_base": f"https://{SERVER_IP}:5001",
        "personaplex_host": SERVER_IP,
        "meanvc_host": SERVER_IP,
    }
)
url = f"http://localhost:{PORT}/?{params}"

os.chdir(FRONTEND_DIR)
server = http.server.HTTPServer(("", PORT), DevHandler)
print(f"Serving frontend from {FRONTEND_DIR}")
print(f"API base:  https://{SERVER_IP}:5001")
print(f"PersonaPlex: wss://{SERVER_IP}:8000/api/chat")
print(f"MeanVC:    https://{SERVER_IP}:5002")
print(f"\nOpen: {url}\n")

try:
    webbrowser.open(url)
except Exception:
    pass

server.serve_forever()
