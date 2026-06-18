"""X-VC streaming voice-conversion server (alternative to meanvc_server.py).

Runs in its OWN venv (X-VC pins torch==2.5.1 / transformers==4.44.1, incompatible
with the shared hearmeout-venv) and on the SAME port + endpoint contract as
meanvc_server.py, so it's a drop-in swap selected by run_all.sh (VC_ENGINE=xvc):

    GET/POST /api/meanvc/load-target   - register a target voice (precompute conditions)
    GET      /api/meanvc/stream        - browser-mediated VC (legacy/fallback)
    GET      /api/meanvc/chat-proxy    - server-side VC bridge to PersonaPlex (the live path)

It reuses X-VC's OFFICIAL inference code verbatim (bins.infer_utils:
load_xvc / precompute_conditions / run_stream_chunk_forward and the run_streaming
window math, plus models.codec.sac.utils.process_audio). The only thing added on
top is feeding each window from a live incoming buffer instead of a complete file
(X-VC did not publish a live-server entrypoint).

Env:
  XVC_DIR              path to the cloned X-VC repo (added to sys.path; also the cwd)
  XVC_CONFIG           default $XVC_DIR/configs/xvc.yaml
  XVC_CKPT             default $XVC_DIR/ckpts/xvc.pt
  XVC_DEVICE           CUDA device index (default 0)
  XVC_EMA_LOAD         load EMA weights (default 1)
  XVC_CHUNK_MS/CURRENT_MS/SMOOTH_MS/FUTURE_MS  streaming window (default 2400/120/20/100)
  MEANVC_PORT          listen port (default 5002)
  SSL_DIR              dir with cert.pem/key.pem
  PERSONAPLEX_PROXY_HOST / PERSONAPLEX_PROXY_PORT   default 127.0.0.1 / 8000
  XVC_PROXY_DEBUG_DIR  optional: dump exactly-what-PersonaPlex-hears WAVs
"""
import asyncio
import logging
import os
import sys
import time
import uuid
import wave
from urllib.parse import urlencode

import numpy as np
import torch
from aiohttp import web
import aiohttp
import sphn
import torchaudio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("xvc_server")

# --- make the X-VC repo importable -----------------------------------------
XVC_DIR = os.environ.get("XVC_DIR", os.getcwd())
if XVC_DIR not in sys.path:
    sys.path.insert(0, XVC_DIR)

from bins.infer_utils import (  # noqa: E402  (import after sys.path setup)
    load_xvc,
    precompute_conditions,
    run_stream_chunk_forward,
)
from models.codec.sac.utils import process_audio  # noqa: E402
from utils.audio import audio_highpass_filter  # noqa: E402

TAG_AUDIO = b"\x01"      # converted audio -> PersonaPlex (Opus)
TAG_VC_USER = b"\x03"    # converted user PCM (float32 16k) -> browser

XVC_CONFIG = os.environ.get("XVC_CONFIG", os.path.join(XVC_DIR, "configs/xvc.yaml"))
XVC_CKPT = os.environ.get("XVC_CKPT", os.path.join(XVC_DIR, "ckpts/xvc.pt"))
XVC_DEVICE = int(os.environ.get("XVC_DEVICE", 0))
XVC_EMA_LOAD = os.environ.get("XVC_EMA_LOAD", "1") not in ("0", "false", "False")

CHUNK_MS = int(os.environ.get("XVC_CHUNK_MS", 2400))
CURRENT_MS = int(os.environ.get("XVC_CURRENT_MS", 120))
SMOOTH_MS = int(os.environ.get("XVC_SMOOTH_MS", 20))
FUTURE_MS = int(os.environ.get("XVC_FUTURE_MS", 100))

PERSONAPLEX_HOST = os.environ.get("PERSONAPLEX_PROXY_HOST", "127.0.0.1")
PERSONAPLEX_PORT = os.environ.get("PERSONAPLEX_PROXY_PORT", "8000")

# Globals populated on startup.
cfg: dict | None = None
model = None
device: torch.device | None = None
SR = 16000
HP_CUT = 0.0
MASK_TARGET_COND = True

# target_id -> (speaker_condition, frame_condition)
targets: dict[str, tuple[torch.Tensor, torch.Tensor]] = {}


def _save_wav(path: str, pcm: np.ndarray, sr: int) -> None:
    pcm = np.clip(pcm, -1.0, 1.0)
    ints = (pcm * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(ints.tobytes())


class XVCStreamSession:
    """Online driver around X-VC's official per-window forward.

    Mirrors bins.infer_utils.run_streaming exactly, but pulls each window from a
    growing buffer (live mic) instead of a complete source array. Per-window work
    is stateless except the overlap cross-fade tail_buffer.
    """

    def __init__(self, speaker_condition, frame_condition):
        self.spk = speaker_condition
        self.frame = frame_condition
        self.sr = SR
        self.current_ms = CURRENT_MS
        self.smooth_ms = SMOOTH_MS
        self.future_ms = FUTURE_MS
        self.history_ms = CHUNK_MS - CURRENT_MS - SMOOTH_MS - FUTURE_MS
        if self.history_ms < 0:
            raise ValueError("CHUNK_MS - CURRENT_MS - SMOOTH_MS - FUTURE_MS must be >= 0")
        self.overlap_len = SMOOTH_MS * SR // 1000
        if self.overlap_len > 0:
            self.fade_in = 0.5 * (
                1 - torch.cos(torch.pi * torch.linspace(0, 1, self.overlap_len, device=device))
            )
            self.fade_out = 1 - self.fade_in
            self.tail_buffer = torch.zeros(1, 1, self.overlap_len, device=device)
        else:
            self.fade_in = self.fade_out = self.tail_buffer = None
        self.buf = np.zeros(0, dtype=np.float32)
        self.i = 0

    def feed(self, pcm: np.ndarray) -> list[np.ndarray]:
        """Append incoming 16 kHz PCM, return any completed current-region chunks."""
        self.buf = np.concatenate([self.buf, pcm.astype(np.float32)])
        outs: list[np.ndarray] = []
        while True:
            start = (self.i * self.current_ms - self.history_ms) * self.sr // 1000
            end = (
                self.i * self.current_ms + self.current_ms + self.smooth_ms + self.future_ms
            ) * self.sr // 1000
            if len(self.buf) < end:
                break  # need more look-ahead audio before this window is ready
            left_pad = max(0, -start)
            seg = self.buf[max(0, start):end]
            if left_pad:
                seg = np.concatenate([np.zeros(left_pad, dtype=np.float32), seg])
            if HP_CUT:
                seg = audio_highpass_filter(seg, self.sr, HP_CUT).astype(np.float32)
            outs.append(self._forward(seg))
            self.i += 1
        return outs

    @torch.inference_mode()
    def _forward(self, seg_np: np.ndarray) -> np.ndarray:
        win = torch.from_numpy(seg_np)[None, None].float().to(device)
        out = run_stream_chunk_forward(model, win, self.spk, self.frame)
        cur_start = self.history_ms * self.sr // 1000
        cur_end = (self.history_ms + self.current_ms) * self.sr // 1000
        cur = out[:, :, cur_start:cur_end]
        if self.overlap_len > 0:
            if self.i > 0:
                head = cur[..., : self.overlap_len]
                head_sm = self.tail_buffer * self.fade_out + head * self.fade_in
                cur = torch.cat([head_sm, cur[..., self.overlap_len:]], dim=-1)
            tail_start = (self.history_ms + self.current_ms) * self.sr // 1000
            self.tail_buffer = out[:, :, tail_start: tail_start + self.overlap_len]
        return cur.squeeze().detach().cpu().numpy().astype(np.float32)


async def handle_load_target(request: web.Request) -> web.Response:
    """POST /api/meanvc/load-target - upload target WAV, precompute conditions."""
    post = await request.post()
    field = post.get("wav")
    if field is None:
        return web.json_response({"error": "missing 'wav' file"}, status=400)

    target_id = uuid.uuid4().hex
    tmp_path = os.path.join("/tmp", f"xvc_target_{target_id}.wav")
    with open(tmp_path, "wb") as f:
        f.write(field.file.read())

    try:
        target_np = process_audio(tmp_path, cfg, int(cfg["latent_hop_length"]))
        target_wav = torch.from_numpy(target_np)[None, None].float().to(device)
        if MASK_TARGET_COND:
            pad = torch.zeros((1, 1, int(2.4 * SR)), device=device)
            target_wav_cond = torch.cat([target_wav, pad], dim=-1)
        else:
            target_wav_cond = target_wav
        spk, frame = precompute_conditions(model, target_wav, target_wav_cond)
        targets[target_id] = (spk, frame)
        duration = round(len(target_np) / SR, 2)
        logger.info(f"[xvc] loaded target {target_id} ({duration}s)")
        return web.json_response({"target_id": target_id, "duration_seconds": duration})
    except Exception as e:
        logger.exception("[xvc] load-target failed")
        return web.json_response({"error": str(e)}, status=500)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _maybe_resampler(source_sr: int):
    if source_sr == SR:
        return None
    return torchaudio.transforms.Resample(orig_freq=source_sr, new_freq=SR).to("cpu")


async def handle_stream(request: web.Request) -> web.WebSocketResponse:
    """GET /api/meanvc/stream - browser-mediated VC (legacy fallback).

    Browser sends raw float32 PCM; we return converted float32 PCM (16 kHz).
    """
    target_id = request.query.get("target_id", "")
    source_sr = int(request.query.get("source_sr", SR))
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    if target_id not in targets:
        await ws.send_json({"error": f"Unknown target_id: {target_id}"})
        await ws.close()
        return ws

    spk, frame = targets[target_id]
    session = XVCStreamSession(spk, frame)
    resampler = _maybe_resampler(source_sr)
    loop = asyncio.get_event_loop()
    await ws.send_json({"status": "ready"})

    async for msg in ws:
        if msg.type == web.WSMsgType.BINARY:
            incoming = np.frombuffer(msg.data, dtype=np.float32).copy()
            if resampler is not None:
                incoming = resampler(torch.from_numpy(incoming).unsqueeze(0)).squeeze(0).numpy()
            curs = await loop.run_in_executor(None, session.feed, incoming)
            for cur in curs:
                if not ws.closed:
                    await ws.send_bytes(cur.tobytes())
        elif msg.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
            break
    return ws


async def handle_chat_proxy(request: web.Request) -> web.WebSocketResponse:
    """GET /api/meanvc/chat-proxy - server-side VC bridge to PersonaPlex.

    Browser sends raw float32 mic PCM; we convert each window with X-VC, Opus-encode
    at 24 kHz, and forward to PersonaPlex over localhost. PersonaPlex's framed replies
    (0x00/0x01/0x02) are relayed back verbatim; the converted user PCM (16 kHz) is also
    sent back tagged 0x03 for the browser's downloads/monitor.
    """
    target_id = request.query.get("target_id", "default")
    source_sr = int(request.query.get("source_sr", SR))
    voice_prompt = request.query.get("voice_prompt", "")
    text_prompt = request.query.get("text_prompt", "")
    resampler = _maybe_resampler(source_sr)

    browser_ws = web.WebSocketResponse()
    await browser_ws.prepare(request)
    if target_id not in targets:
        await browser_ws.send_json({"error": f"Unknown target_id: {target_id}"})
        await browser_ws.close()
        return browser_ws

    spk, frame = targets[target_id]
    session = XVCStreamSession(spk, frame)
    loop = asyncio.get_event_loop()

    # X-VC outputs 16 kHz; sphn's Opus encoder only accepts 24/48 kHz (PersonaPlex
    # uses 24 kHz = its mimi rate). Encode at 24 kHz and upsample before encoding.
    opus_writer = sphn.OpusStreamWriter(24000)
    out_resampler = torchaudio.transforms.Resample(16000, 24000).to("cpu")
    OPUS_FRAME = 1920

    debug_dir = os.environ.get("XVC_PROXY_DEBUG_DIR")
    opus_reader_dbg = sphn.OpusStreamReader(24000) if debug_dir else None
    debug_pcm: list[np.ndarray] = []

    qs = urlencode({"voice_prompt": voice_prompt, "text_prompt": text_prompt})
    pplx_url = f"wss://{PERSONAPLEX_HOST}:{PERSONAPLEX_PORT}/api/chat?{qs}"
    logger.info(f"[xvc proxy] connecting to PersonaPlex: {pplx_url}")

    client = aiohttp.ClientSession()
    try:
        pplx_ws = await client.ws_connect(pplx_url, ssl=False, max_msg_size=0)
    except Exception as e:
        logger.error(f"[xvc proxy] PersonaPlex connect failed: {e}")
        await browser_ws.send_json({"error": f"PersonaPlex unavailable: {e}"})
        await browser_ws.close()
        await client.close()
        return browser_ws

    chunk_count = 0
    opus_pcm_buf = np.zeros(0, dtype=np.float32)

    async def browser_to_pplx():
        nonlocal chunk_count, opus_pcm_buf
        async for msg in browser_ws:
            if msg.type == web.WSMsgType.BINARY:
                incoming = np.frombuffer(msg.data, dtype=np.float32).copy()
                if resampler is not None:
                    incoming = resampler(torch.from_numpy(incoming).unsqueeze(0)).squeeze(0).numpy()
                try:
                    curs = await loop.run_in_executor(None, session.feed, incoming)
                except Exception as e:
                    logger.error(f"[xvc proxy] inference error: {e}")
                    continue

                for cur in curs:
                    chunk_count += 1
                    cur_24k = (
                        out_resampler(torch.from_numpy(cur).unsqueeze(0)).squeeze(0).numpy()
                    )
                    opus_pcm_buf = np.concatenate([opus_pcm_buf, cur_24k])
                    while len(opus_pcm_buf) >= OPUS_FRAME:
                        frame_pcm = np.ascontiguousarray(opus_pcm_buf[:OPUS_FRAME])
                        opus_pcm_buf = opus_pcm_buf[OPUS_FRAME:]
                        opus_writer.append_pcm(frame_pcm)
                        while True:
                            encoded = opus_writer.read_bytes()
                            if len(encoded) == 0:
                                break
                            await pplx_ws.send_bytes(TAG_AUDIO + encoded)
                            if opus_reader_dbg is not None:
                                opus_reader_dbg.append_bytes(encoded)
                                pcm = opus_reader_dbg.read_pcm()
                                if pcm.shape[-1] > 0:
                                    debug_pcm.append(pcm.astype(np.float32))
                    if not browser_ws.closed:
                        await browser_ws.send_bytes(TAG_VC_USER + cur.tobytes())
            elif msg.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
                break

    async def pplx_to_browser():
        async for msg in pplx_ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                if not browser_ws.closed:
                    await browser_ws.send_bytes(msg.data)
            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                break

    tasks = [
        asyncio.create_task(browser_to_pplx()),
        asyncio.create_task(pplx_to_browser()),
    ]
    try:
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        await pplx_ws.close()
        await client.close()
        if not browser_ws.closed:
            await browser_ws.close()

    if debug_dir and debug_pcm:
        try:
            os.makedirs(debug_dir, exist_ok=True)
            out_path = os.path.join(debug_dir, f"pplx_input_{target_id}_{int(time.time())}.wav")
            _save_wav(out_path, np.concatenate(debug_pcm), 24000)
            logger.info(f"[xvc proxy] saved PersonaPlex-input audio to {out_path}")
        except Exception as e:
            logger.error(f"[xvc proxy] failed to save debug WAV: {e}")

    logger.info(f"[xvc proxy] closed after {chunk_count} chunks")
    return browser_ws


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
    app = web.Application(middlewares=[cors_middleware], client_max_size=10 * 1024 * 1024)
    app.router.add_post("/api/meanvc/load-target", handle_load_target)
    app.router.add_get("/api/meanvc/stream", handle_stream)
    app.router.add_get("/api/meanvc/chat-proxy", handle_chat_proxy)
    return app


async def on_startup(app: web.Application):
    global cfg, model, device, SR, HP_CUT, MASK_TARGET_COND
    logger.info(f"[xvc] loading model: config={XVC_CONFIG} ckpt={XVC_CKPT} device={XVC_DEVICE}")
    cfg, model, device = load_xvc(XVC_CONFIG, XVC_CKPT, XVC_DEVICE, XVC_EMA_LOAD)
    SR = int(cfg["sample_rate"])
    HP_CUT = float(cfg.get("highpass_cutoff_freq", 0.0))
    MASK_TARGET_COND = bool(cfg.get("dataloader", {}).get("mask_target_condition", True))
    logger.info(
        f"[xvc] ready: sr={SR} hp_cut={HP_CUT} window(ms) chunk={CHUNK_MS} "
        f"current={CURRENT_MS} smooth={SMOOTH_MS} future={FUTURE_MS}"
    )


def main():
    import ssl

    port = int(os.environ.get("MEANVC_PORT", 5002))
    app = create_app()
    app.on_startup.append(on_startup)
    ssl_dir = os.environ.get("SSL_DIR", "/app/ssl")
    ssl_context = None
    cert_file = os.path.join(ssl_dir, "cert.pem")
    key_file = os.path.join(ssl_dir, "key.pem")
    if os.path.exists(cert_file) and os.path.exists(key_file):
        ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_context.load_cert_chain(cert_file, key_file)
        logger.info(f"SSL enabled from {ssl_dir}")
    logger.info(f"X-VC server starting on port {port} (ssl={ssl_context is not None})")
    web.run_app(app, port=port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
