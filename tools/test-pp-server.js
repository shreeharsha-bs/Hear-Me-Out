// Dummy PersonaPlex server for testing — saves received Opus audio
// Usage: node tools/test-pp-server.mjs [--port PORT]

const { createServer } = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.argv[process.argv.indexOf("--port") + 1]) || 8001;
const OUT_DIR = path.join(__dirname, "test-recordings");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Dummy PersonaPlex — test server");
});

server.on("upgrade", (req, socket, head) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");

  const ts = new Date().toISOString().replace(/[:.T-]/g, "_").slice(0, 15);
  const rawFile = path.join(OUT_DIR, `session_${ts}_opus.raw`);
  const frames = [];

  // Send handshake (tag 0)
  const hs = Buffer.alloc(6);
  hs[0] = 0; hs.write("ready", 1);
  sendFrame(socket, hs);
  console.log(`[SERVER] Connection from ${req.socket.remoteAddress}, sent handshake`);

  socket.on("data", (buf) => {
    try { const msg = decodeFrame(buf); if (msg) {
      if (msg === "CLOSE") { socket.end(); return; }
      if (msg[0] === 1) { frames.push(msg.slice(1)); if (frames.length % 50 === 0) console.log(`[SERVER] ${frames.length} audio frames`); }
      else if (msg[0] === 2) console.log(`[SERVER] Text: ${Buffer.from(msg.slice(1)).toString().slice(0, 60)}...`);
    }} catch {}
  });

  function close() {
    const raw = Buffer.concat(frames);
    fs.writeFileSync(rawFile, raw);
    console.log(`[SERVER] Saved ${frames.length} frames (${raw.length} bytes) → ${rawFile}`);
    // Auto-convert to WAV
    const wavFile = rawFile.replace(".raw", ".wav");
    const { execSync } = require("child_process");
    try {
      execSync(`ffmpeg -y -f ogg -i "${rawFile}" -ar 16000 -ac 1 "${wavFile}" 2>/dev/null`);
      console.log(`[SERVER] WAV: ${wavFile}`);
    } catch {}
  }
  socket.on("end", close);
  socket.on("close", close);
  socket.on("error", () => { try { close(); } catch {} });
});

function sendFrame(socket, payload) {
  const buf = Buffer.alloc(2 + payload.length);
  buf[0] = 0x82; // text frame, final
  buf[1] = payload.length;
  payload.copy(buf, 2);
  socket.write(buf);
}

function decodeFrame(data) {
  const opcode = data[0] & 0x0f;
  if (opcode === 0x8) return "CLOSE";
  if (opcode === 0x9) return null; // ping
  const masked = (data[1] & 0x80) !== 0;
  let len = data[1] & 0x7f;
  let off = 2;
  if (len === 126) { len = data.readUInt16BE(2); off = 4; }
  else if (len === 127) { len = Number(data.readBigUInt64BE(2)); off = 10; }
  if (!masked) return data.slice(off, off + len);
  const mask = data.slice(off, off + 4);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = data[off + 4 + i] ^ mask[i % 4];
  return payload;
}


server.listen(PORT, () => {
  console.log(`\n=== Dummy PersonaPlex Server ===`);
  console.log(`Listening on ws://0.0.0.0:${PORT}/api/chat`);
  console.log(`Saving recordings to: ${OUT_DIR}/`);
  console.log(`\nOpen: http://localhost:3000/?personaplex_ws=ws://localhost:${PORT}/api/chat`);
  console.log();
});