#!/usr/bin/env python3
"""Bridge a stdio MCP server to SSE over HTTP so OpenCode can connect remotely."""

import subprocess
import json
import threading
import queue
import uuid
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

MCP_CMD = ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"]

proc = subprocess.Popen(
    MCP_CMD,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)

pending = {}
pending_lock = threading.Lock()


def reader():
    buf = b""
    while True:
        chunk = proc.stdout.read(1)
        if not chunk:
            break
        buf += chunk
        try:
            msg = json.loads(buf.decode())
            rid = msg.get("id")
            with pending_lock:
                if rid is not None and rid in pending:
                    pending[rid] = msg
            buf = b""
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue


threading.Thread(target=reader, daemon=True).start()


def send_request(method, params=None):
    rid = str(uuid.uuid4())
    req = json.dumps(
        {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
    )
    with pending_lock:
        pending[rid] = None
    proc.stdin.write((req + "\n").encode())
    proc.stdin.flush()
    import time

    for _ in range(300):
        with pending_lock:
            if pending[rid] is not None:
                result = pending.pop(rid)
                return result
        time.sleep(0.01)
    with pending_lock:
        pending.pop(rid, None)
    return {"error": "timeout"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"event: endpoint\n")
            self.wfile.write(b"data: /message\n\n")
            self.wfile.flush()
            while True:
                pass  # keep-alive
        elif self.path == "/message":
            self.send_response(405)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/message":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            msg = json.loads(body)
            result = send_request(msg.get("method"), msg.get("params"))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


print("MCP SSE bridge starting on port 5001...", flush=True)
HTTPServer(("0.0.0.0", 5001), Handler).serve_forever()
