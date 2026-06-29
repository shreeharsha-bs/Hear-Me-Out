"""Hear-Me-Out MiniCPM-o bridge server (llama.cpp-omni / GGUF backend).

Drop-in alternative to PersonaPlex on :8000. The frontend speaks PersonaPlex's
binary-tag WebSocket protocol at /api/chat; this server speaks that same protocol
outward while driving the **llama.cpp-omni** C++ engine (tc-mb/llama.cpp-omni,
`feat/web-demo` branch) over its HTTP/SSE API. GGUF Q4_K_M ≈ 9GB VRAM and sub-second
TTFT — vs ~23GB and laggy for the bf16 transformers path it replaces.

Protocol on /api/chat (matches moshi/PersonaPlex):
  server -> browser : 0x00 handshake (once, on connect)
                      0x01 Ogg-Opus audio frame @24kHz (assistant speech)
                      0x02 UTF-8 text chunk (assistant transcript)
  browser -> server : 0x01 Ogg-Opus audio frame @24kHz (mic)

llama-omni-server HTTP API (localhost, from MiniCPM-o-Demo@Comni cpp_backend.py):
  POST /v1/stream/omni_init   {media_type,use_tts,duplex_mode,model_dir,tts_bin_dir,
                               tts_gpu_layers,token2wav_device,output_dir,voice_audio,
                               voice_clone_prompt,assistant_prompt}
  POST /v1/stream/prefill     {audio_path_prefix,img_path_prefix,cnt}
  POST /v1/stream/decode      {stream:true,length_penalty}  -> SSE: data:{is_listen,end_of_turn,text|content}
  POST /v1/stream/break       {reason}
TTS audio is NOT in the SSE — the C++ server writes 24kHz WAVs to <output_dir>/tts_wav/wav_N.wav;
we scan for new ones each chunk and forward them as Opus.

Audio rates: mic Opus@24k -> decode -> resample to 16k for prefill; reply WAVs are 24k = our Opus rate.
"""

import argparse
import asyncio
import json
import logging
import os
import queue
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
import requests
import soundfile as sf
import soxr
import sphn
from aiohttp import web

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("minicpm-o-server")

# Tag bytes (must match frontend/useWebSocket.ts and moshi's server).
TAG_HANDSHAKE = b"\x00"
TAG_AUDIO = b"\x01"
TAG_TEXT = b"\x02"

OPUS_SR = 24000          # browser Opus + llama-omni TTS WAV output rate
MODEL_IN_SR = 16000      # prefill audio rate (fixed by the model)
CHUNK_SAMPLES = MODEL_IN_SR   # duplex processes ~1s chunks (its 1Hz decision rate)
MIN_PREFILL_SAMPLES = 1600    # llama-omni pads shorter chunks
OPUS_FRAME = 1920        # 80ms @24k; sphn.append_pcm needs exact frame sizes

# --- llama.cpp-omni config (env-driven; set by run_all.sh) ---
LLAMA_OMNI_ROOT = os.environ.get("LLAMA_OMNI_ROOT", "")          # llama.cpp-omni checkout (cwd)
LLAMA_OMNI_BIN = os.environ.get(
    "LLAMA_OMNI_BIN", os.path.join(LLAMA_OMNI_ROOT, "build/bin/llama-server")
)
GGUF_DIR = os.environ.get("MINICPM_O_GGUF_DIR", "")             # dir with LLM + tts/ audio/ token2wav-gguf/
LLM_FILE = os.environ.get("MINICPM_O_LLM", "MiniCPM-o-4_5-Q4_K_M.gguf")
CPP_PORT = int(os.environ.get("MINICPM_O_CPP_PORT", "19080"))
CTX_SIZE = int(os.environ.get("MINICPM_O_CTX", "8192"))
N_GPU_LAYERS = int(os.environ.get("MINICPM_O_NGL", "99"))
LENGTH_PENALTY = float(os.environ.get("MINICPM_O_LENGTH_PENALTY", "1.1"))

REPO_ROOT = Path(__file__).resolve().parents[2]
REF_AUDIO_PATH = os.environ.get(
    "MINICPM_REF_AUDIO", str(REPO_ROOT / "recordings" / "Target_2.wav")
)
OUTPUT_DIR = os.environ.get(
    "MINICPM_O_OUTPUT_DIR", str(REPO_ROOT / "services" / "minicpm_o" / "_omni_out")
)
TEMP_DIR = os.path.join(OUTPUT_DIR, "_in")

_NO_PROXY = {"http": None, "https": None}


def build_prompts(text_prompt: str) -> dict:
    """Two-part duplex system prompt (cpp_backend.py _build_prompts_from_content).

    The frontend's text_prompt is the `before` (system) text; duplex puts no text
    after the audio prompt. Falls back to the project's default if empty.
    """
    before = (text_prompt or "").strip() or "Streaming Duplex Conversation! You are a helpful assistant."
    return {
        "voice_clone_prompt": f"<|im_start|>system\n{before}\n<|audio_start|>",
        "assistant_prompt": "<|audio_end|><|im_end|>\n",
    }


# ---------------------------------------------------------------------------
# llama.cpp-omni server manager (subprocess + HTTP/SSE client). Mirrors the
# official MiniCPM-o-Demo@Comni cpp_backend.py duplex path.
# ---------------------------------------------------------------------------
class LlamaOmni:
    def __init__(self):
        self.url = f"http://127.0.0.1:{CPP_PORT}"
        self.proc: subprocess.Popen | None = None
        self.cnt = 0
        self.sent_wavs: set[str] = set()
        self.cur_prompt: str | None = None
        self._cpp_log_path = os.path.join(OUTPUT_DIR, "llama-server.log")
        os.makedirs(TEMP_DIR, exist_ok=True)
        os.makedirs(os.path.join(OUTPUT_DIR, "tts_wav"), exist_ok=True)

    # -- subprocess lifecycle --
    def start_server(self):
        model_path = os.path.join(GGUF_DIR, LLM_FILE)
        if not os.path.exists(LLAMA_OMNI_BIN):
            raise RuntimeError(f"llama-omni-server not found: {LLAMA_OMNI_BIN}")
        if not os.path.exists(model_path):
            raise RuntimeError(f"LLM GGUF not found: {model_path}")
        cmd = [
            LLAMA_OMNI_BIN,
            "--host", "127.0.0.1", "--port", str(CPP_PORT),
            "--model", model_path,
            "--ctx-size", str(CTX_SIZE), "--n-gpu-layers", str(N_GPU_LAYERS),
            "--repeat-penalty", "1.05", "--temp", "0.7",
        ]
        logger.info("Starting llama-omni-server: %s", " ".join(cmd))
        self.proc = subprocess.Popen(
            cmd, cwd=LLAMA_OMNI_ROOT or None,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            bufsize=1, encoding="utf-8", errors="replace", start_new_session=True,
        )
        threading.Thread(target=self._log_reader, daemon=True).start()
        # Wait for /health, but fail fast if the process dies (don't hang 300s blind).
        for i in range(300):
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"llama-omni-server exited (code {self.proc.returncode}) during startup — "
                    f"see {self._cpp_log_path}"
                )
            try:
                if requests.get(f"{self.url}/health", timeout=2, proxies=_NO_PROXY).status_code == 200:
                    logger.info("llama-omni-server ready after %ds", i + 1)
                    return
            except Exception:
                pass
            time.sleep(1)
        raise RuntimeError(f"llama-omni-server startup timeout (300s) — see {self._cpp_log_path}")

    def _log_reader(self):
        # Tee the C++ engine's output to a file, and surface error-ish lines in our log.
        try:
            with open(self._cpp_log_path, "w") as f:
                for line in self.proc.stdout:
                    f.write(line)
                    f.flush()
                    s = line.rstrip()
                    if any(k in s.lower() for k in ("error", "fail", "cannot", "abort", "assert", "cuda")):
                        logger.warning("[llama-server] %s", s)
                    else:
                        logger.debug("[llama-server] %s", s)
        except Exception:
            pass

    def stop_server(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except Exception:
                    self.proc.kill()
        self.proc = None

    # -- HTTP calls --
    def omni_init(self, text_prompt: str):
        prompts = build_prompts(text_prompt)
        body = {
            "media_type": 2, "use_tts": True, "duplex_mode": True,
            "model_dir": GGUF_DIR, "tts_bin_dir": os.path.join(GGUF_DIR, "tts"),
            "tts_gpu_layers": 100, "token2wav_device": "gpu:0",
            "output_dir": OUTPUT_DIR,
            "voice_clone_prompt": prompts["voice_clone_prompt"],
            "assistant_prompt": prompts["assistant_prompt"],
        }
        if os.path.exists(REF_AUDIO_PATH):
            body["voice_audio"] = REF_AUDIO_PATH
        r = requests.post(f"{self.url}/v1/stream/omni_init", json=body, timeout=120, proxies=_NO_PROXY)
        if r.status_code != 200:
            raise RuntimeError(f"omni_init failed: {r.text}")
        self.cur_prompt = text_prompt
        logger.info("omni_init ok (duplex, prompt=%r)", (text_prompt or "")[:60])

    def begin_session(self, text_prompt: str):
        """Per-connection clean start. If the persona prompt changed, restart the
        server + omni_init (the stable clean-state path in cpp_backend.full_reinit);
        otherwise reset counters/output and reuse the loaded model."""
        self._reset_output()
        self.cnt = 0
        self.sent_wavs = set()
        if self.proc is None or self.proc.poll() is not None:
            self.start_server()
            self.omni_init(text_prompt)
        elif text_prompt != self.cur_prompt:
            logger.info("prompt changed -> full reinit")
            self.stop_server()
            self.start_server()
            self.omni_init(text_prompt)
        else:
            self.break_("new_session")

    def _reset_output(self):
        d = os.path.join(OUTPUT_DIR, "tts_wav")
        try:
            for f in os.listdir(d):
                if f.startswith("wav_") and f.endswith(".wav"):
                    os.remove(os.path.join(d, f))
        except FileNotFoundError:
            os.makedirs(d, exist_ok=True)

    def prefill(self, pcm_16k: np.ndarray):
        if len(pcm_16k) < MIN_PREFILL_SAMPLES:
            pcm_16k = np.pad(pcm_16k, (0, MIN_PREFILL_SAMPLES - len(pcm_16k)))
        path = os.path.join(TEMP_DIR, f"chunk_{self.cnt}.wav")
        sf.write(path, np.clip(pcm_16k, -1.0, 1.0).astype(np.float32),
                 MODEL_IN_SR, format="WAV", subtype="PCM_16")
        body = {"audio_path_prefix": path, "img_path_prefix": "", "cnt": self.cnt}
        self.cnt += 1
        try:
            requests.post(f"{self.url}/v1/stream/prefill", json=body, timeout=30, proxies=_NO_PROXY)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    def decode(self) -> tuple[str, bool]:
        """POST /v1/stream/decode (SSE). Returns (text, is_listen)."""
        r = requests.post(f"{self.url}/v1/stream/decode",
                          json={"stream": True, "length_penalty": LENGTH_PENALTY},
                          timeout=600, proxies=_NO_PROXY)
        texts, is_listen = [], True
        if r.status_code == 200:
            for line in r.text.splitlines():
                line = line.strip()
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    ev = json.loads(data)
                except ValueError:
                    continue
                if "is_listen" in ev:
                    is_listen = ev["is_listen"]
                if ev.get("text"):
                    texts.append(ev["text"])
                if ev.get("content"):
                    texts.append(ev["content"])
        return "".join(texts), is_listen

    def collect_new_audio(self) -> np.ndarray | None:
        """Scan <output_dir>/tts_wav for new wav_N.wav (24k float32); concat new ones."""
        d = os.path.join(OUTPUT_DIR, "tts_wav")
        if not os.path.isdir(d):
            return None
        wavs = sorted(
            (f for f in os.listdir(d) if f.startswith("wav_") and f.endswith(".wav")),
            key=lambda f: int(re.search(r"wav_(\d+)", f).group(1)) if re.search(r"wav_(\d+)", f) else 0,
        )
        new = [f for f in wavs if f not in self.sent_wavs]
        if not new:
            return None
        chunks = []
        for f in new:
            try:
                data, _sr = sf.read(os.path.join(d, f), dtype="float32")
                if len(data):
                    if data.ndim > 1:
                        data = data.mean(axis=1)
                    chunks.append(data)
                self.sent_wavs.add(f)
            except Exception:
                pass
        return np.concatenate(chunks) if chunks else None

    def break_(self, reason: str):
        try:
            requests.post(f"{self.url}/v1/stream/break", json={"reason": reason},
                         timeout=10, proxies=_NO_PROXY)
        except Exception as e:
            logger.warning("break failed: %s", e)


omni: LlamaOmni | None = None
_session_lock: asyncio.Lock | None = None


# ---------------------------------------------------------------------------
# WebSocket handler — the PersonaPlex-compatible /api/chat endpoint.
# ---------------------------------------------------------------------------
async def handle_chat(request: web.Request) -> web.WebSocketResponse:
    text_prompt = request.query.get("text_prompt", "")
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    opus_reader = sphn.OpusStreamReader(OPUS_SR)
    opus_writer = sphn.OpusStreamWriter(OPUS_SR)
    loop = asyncio.get_event_loop()

    in_q: queue.Queue = queue.Queue()
    out_q: asyncio.Queue = asyncio.Queue()
    sentinel = object()
    out_pcm_buf = np.array([], dtype=np.float32)
    pcm16_buf = np.array([], dtype=np.float32)

    async with _session_lock:
        try:
            await loop.run_in_executor(None, omni.begin_session, text_prompt)
        except Exception as e:
            logger.error("session init failed: %s", e)
            await ws.close()
            return ws
        await ws.send_bytes(TAG_HANDSHAKE)
        logger.info("[chat] connected, handshake sent")

        def worker():
            try:
                while True:
                    chunk = in_q.get()
                    if chunk is None:
                        break
                    omni.prefill(chunk)
                    text, _is_listen = omni.decode()
                    audio = omni.collect_new_audio()
                    loop.call_soon_threadsafe(out_q.put_nowait, (text, audio))
            except Exception as e:
                loop.call_soon_threadsafe(out_q.put_nowait, e)
            finally:
                loop.call_soon_threadsafe(out_q.put_nowait, sentinel)

        async def send_opus(pcm: np.ndarray, flush: bool = False):
            nonlocal out_pcm_buf
            out_pcm_buf = np.concatenate([out_pcm_buf, pcm])
            if flush:
                pad = (-len(out_pcm_buf)) % OPUS_FRAME
                if pad:
                    out_pcm_buf = np.concatenate([out_pcm_buf, np.zeros(pad, dtype=np.float32)])
            while len(out_pcm_buf) >= OPUS_FRAME:
                frame = np.ascontiguousarray(out_pcm_buf[:OPUS_FRAME])
                out_pcm_buf = out_pcm_buf[OPUS_FRAME:]
                opus_writer.append_pcm(frame)
                while True:
                    enc = opus_writer.read_bytes()
                    if len(enc) == 0:
                        break
                    if not ws.closed:
                        await ws.send_bytes(TAG_AUDIO + enc)

        async def reader():
            nonlocal pcm16_buf
            async for msg in ws:
                if msg.type == web.WSMsgType.BINARY:
                    data = msg.data
                    if not data or data[0:1] != TAG_AUDIO:
                        continue
                    opus_reader.append_bytes(data[1:])
                    pcm24 = opus_reader.read_pcm()
                    if pcm24.shape[-1] == 0:
                        continue
                    pcm16 = soxr.resample(pcm24.astype(np.float32), OPUS_SR, MODEL_IN_SR)
                    pcm16_buf = np.concatenate([pcm16_buf, pcm16])
                    while len(pcm16_buf) >= CHUNK_SAMPLES:
                        in_q.put(np.ascontiguousarray(pcm16_buf[:CHUNK_SAMPLES]))
                        pcm16_buf = pcm16_buf[CHUNK_SAMPLES:]
                elif msg.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
                    break
            in_q.put(None)

        async def sender():
            nonlocal out_pcm_buf
            while True:
                item = await out_q.get()
                if item is sentinel:
                    break
                if isinstance(item, Exception):
                    logger.error("[chat] worker error: %s", item)
                    break
                text, audio = item
                if text and not ws.closed:
                    await ws.send_bytes(TAG_TEXT + text.encode("utf-8"))
                if audio is not None and len(audio):
                    await send_opus(audio)
            if len(out_pcm_buf):
                await send_opus(np.array([], dtype=np.float32), flush=True)

        worker_fut = loop.run_in_executor(None, worker)
        try:
            await asyncio.gather(reader(), sender())
        finally:
            in_q.put(None)
            await worker_fut
            # Clean up for the next session in the background (server restart is slow).
            await loop.run_in_executor(None, omni.break_, "disconnect")
            if not ws.closed:
                await ws.close()

    logger.info("[chat] disconnected")
    return ws


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response()
    else:
        resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def create_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/api/chat", handle_chat)
    return app


def main():
    import ssl

    parser = argparse.ArgumentParser(description="Hear-Me-Out MiniCPM-o bridge (llama.cpp-omni)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--device", default="cuda")  # accepted for run_all.sh parity
    parser.add_argument("--ssl", default=os.environ.get("SSL_DIR", ""))
    args = parser.parse_args()

    global omni, _session_lock
    omni = LlamaOmni()
    omni.start_server()
    omni.omni_init("")  # warm load; per-connection begin_session re-inits if the prompt differs

    ssl_context = None
    if args.ssl:
        cert, key = os.path.join(args.ssl, "cert.pem"), os.path.join(args.ssl, "key.pem")
        if os.path.exists(cert) and os.path.exists(key):
            ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
            ssl_context.load_cert_chain(cert, key)
            logger.info("SSL enabled from %s", args.ssl)
        else:
            logger.warning("SSL dir %s missing cert.pem/key.pem — serving plain", args.ssl)

    async def _make_app():
        global _session_lock
        _session_lock = asyncio.Lock()
        return create_app()

    logger.info("MiniCPM-o bridge (llama.cpp-omni) on %s:%d (ssl=%s)",
                args.host, args.port, ssl_context is not None)
    web.run_app(_make_app(), host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
