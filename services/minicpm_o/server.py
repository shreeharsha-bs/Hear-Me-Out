"""Hear-Me-Out MiniCPM-o bridge server (full-duplex).

Drop-in alternative to PersonaPlex on :8000. The frontend speaks PersonaPlex's
binary-tag WebSocket protocol at /api/chat; this server speaks that same protocol
outward while driving openbmb/MiniCPM-o internally — so no frontend changes are
needed (mirrors how services/xvc swaps in for services/meanvc on :5002).

Protocol on /api/chat (matches moshi/PersonaPlex):
  server -> browser : 0x00 handshake (once, on connect)
                      0x01 Ogg-Opus audio frame @24kHz (assistant speech)
                      0x02 UTF-8 text chunk (assistant transcript)
  browser -> server : 0x01 Ogg-Opus audio frame @24kHz (mic)

Audio rates are fixed to match the browser:
  - opus-recorder encodes mic at 24kHz (frontend/useRecorder.ts), so we decode at 24kHz.
  - ogg-opus-decoder (frontend/useWebSocket.ts) plays our 24kHz Opus output.
  - MiniCPM-o works at 16kHz in / 24kHz TTS out, so we resample mic 24k->16k.

Full-duplex: we use MiniCPM-o 4.5's native duplex mode (model.as_duplex()). The model
itself decides, per ~1s chunk, whether to listen or speak (its 1Hz mechanism) — so it
yields the floor the moment the user starts talking (Moshi-like barge-in), no VAD needed.
We feed every incoming mic chunk via streaming_prefill and forward whatever speech the
model emits from streaming_generate.
"""

import argparse
import asyncio
import logging
import os
import queue
from pathlib import Path

import librosa
import numpy as np
import sphn
import torch

from aiohttp import web

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("minicpm-o-server")

# Tag bytes (must match frontend/useWebSocket.ts and moshi's server).
TAG_HANDSHAKE = b"\x00"
TAG_AUDIO = b"\x01"
TAG_TEXT = b"\x02"

# Browser-facing Opus rate (opus-recorder/ogg-opus-decoder both use 24kHz here),
# which is also MiniCPM-o's fixed TTS output rate — so reply audio needs no resampling.
OPUS_SR = 24000
# MiniCPM-o consumes 16kHz audio (fixed).
MODEL_IN_SR = 16000
# Duplex mode processes the input in ~1s chunks (its 1Hz listen/speak decision rate).
CHUNK_SAMPLES = MODEL_IN_SR
# sphn.append_pcm only accepts exact Opus frame sizes; 1920 @ 24kHz = 80ms.
OPUS_FRAME = 1920

MODEL_ID = os.environ.get("MINICPM_O_MODEL", "openbmb/MiniCPM-o-4_5")

# Speech tokens generated per ~1s chunk. This trades smoothness vs latency:
#  - too low  -> the model emits less than 1s of audio per 1s chunk, the browser's
#    playback buffer underruns and you hear "dip" pauses;
#  - too high -> each generate() takes longer than the 1s chunk cadence, input backs
#    up and lag accumulates.
# Official example uses 20; tune MINICPM_SPEAK_TOKENS on the box to taste.
SPEAK_TOKENS_PER_CHUNK = int(os.environ.get("MINICPM_SPEAK_TOKENS", "20"))

# Attention kernel: "sdpa" (default, always works) or "flash_attention_2" (faster,
# better real-time factor) if the flash-attn wheel installed cleanly on the box.
ATTN_IMPL = os.environ.get("MINICPM_ATTN", "sdpa")

# Reference audio that defines the assistant's voice (16kHz). MiniCPM-o clones this
# voice for its replies. Override with MINICPM_REF_AUDIO; defaults to a repo recording.
REPO_ROOT = Path(__file__).resolve().parents[2]
REF_AUDIO_PATH = os.environ.get(
    "MINICPM_REF_AUDIO", str(REPO_ROOT / "recordings" / "Target_2.wav")
)

# Assistant instruction prefix when the frontend doesn't pass a text_prompt.
DEFAULT_SYS_PROMPT = (
    "Streaming Omni Conversation. You are a helpful, human-like voice assistant. "
    "Chat naturally and concisely."
)


# ---------------------------------------------------------------------------
# MiniCPM-o duplex engine — follows the official "Duplex Omni Mode" API
# (model card for openbmb/MiniCPM-o-4_5: model.as_duplex() + per-chunk
# streaming_prefill/streaming_generate with the model's own listen/speak decision).
# ---------------------------------------------------------------------------
class MiniCPMODuplexEngine:
    """Loads MiniCPM-o once, converts to duplex mode; one conversation at a time.

    The model holds a single global duplex session, so a process-wide lock
    serializes connections (fine for the single-speaker research UI).
    """

    def __init__(self, device: str = "cuda", ref_audio_path: str = REF_AUDIO_PATH):
        from transformers import AutoModel

        logger.info(f"Loading {MODEL_ID} on {device} (bf16, duplex, attn={ATTN_IMPL})...")
        self.device = device
        model = AutoModel.from_pretrained(
            MODEL_ID,
            trust_remote_code=True,
            attn_implementation=ATTN_IMPL,
            torch_dtype=torch.bfloat16,
            # Speech-to-speech only — skip the vision encoder to save VRAM.
            init_vision=False,
            init_audio=True,
            init_tts=True,
        )
        model.eval().to(device)
        # Convert to full-duplex mode (listen + speak on parallel streams).
        # NB: as_duplex() calls init_tts() internally — do NOT init_tts() here too,
        # or the Token2wav vocoder loads twice and wastes VRAM (OOMs a full 24GB card).
        self.model = model.as_duplex()

        if not os.path.exists(ref_audio_path):
            raise FileNotFoundError(
                f"Reference voice audio not found: {ref_audio_path} "
                f"(set MINICPM_REF_AUDIO to a 16kHz wav)."
            )
        self.ref_audio_path = ref_audio_path
        self.ref_audio, _ = librosa.load(ref_audio_path, sr=16000, mono=True)
        logger.info(f"Voice reference: {ref_audio_path}")
        self.lock = asyncio.Lock()
        logger.info("MiniCPM-o loaded (duplex).")

    def run_session(self, text_prompt, in_q, out_q, loop, sentinel):
        """Blocking worker (one connection): prepare the duplex session, then for
        every ~1s mic chunk run prefill+generate and push (text, audio_24k) to the
        event loop. audio_24k is None on chunks where the model chooses to listen.
        """
        try:
            self.model.prepare(
                prefix_system_prompt=text_prompt or DEFAULT_SYS_PROMPT,
                ref_audio=self.ref_audio,
                prompt_wav_path=self.ref_audio_path,
            )
            while True:
                chunk = in_q.get()  # blocks until the reader supplies a chunk
                if chunk is None:  # shutdown signal
                    break
                self.model.streaming_prefill(
                    audio_waveform=chunk,
                    frame_list=[],  # audio-only, no video frames
                    max_slice_nums=1,
                    batch_vision_feed=False,
                )
                result = self.model.streaming_generate(
                    prompt_wav_path=self.ref_audio_path,
                    max_new_speak_tokens_per_chunk=SPEAK_TOKENS_PER_CHUNK,
                    decode_mode="sampling",
                )
                text = result.get("text") or ""
                audio = result.get("audio_waveform")
                if audio is not None:
                    if isinstance(audio, torch.Tensor):
                        audio = audio.squeeze().float().cpu().numpy()
                    audio = np.asarray(audio, dtype=np.float32)
                loop.call_soon_threadsafe(out_q.put_nowait, (text, audio))
        except Exception as e:
            loop.call_soon_threadsafe(out_q.put_nowait, e)
        finally:
            loop.call_soon_threadsafe(out_q.put_nowait, sentinel)


engine: MiniCPMODuplexEngine | None = None


# ---------------------------------------------------------------------------
# WebSocket handler — the PersonaPlex-compatible /api/chat endpoint.
# ---------------------------------------------------------------------------
async def handle_chat(request: web.Request) -> web.WebSocketResponse:
    text_prompt = request.query.get("text_prompt", "")
    # voice_prompt is part of the PersonaPlex URL but MiniCPM-o picks its own
    # voice (the reference audio); accept and ignore it so the frontend URL works.

    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    opus_reader = sphn.OpusStreamReader(OPUS_SR)
    opus_writer = sphn.OpusStreamWriter(OPUS_SR)
    loop = asyncio.get_event_loop()

    in_q: queue.Queue = queue.Queue()       # reader (async) -> worker (thread)
    out_q: asyncio.Queue = asyncio.Queue()  # worker (thread) -> sender (async)
    sentinel = object()
    out_pcm_buf = np.array([], dtype=np.float32)   # reply PCM awaiting Opus framing
    pcm16_buf = np.array([], dtype=np.float32)     # mic PCM awaiting 1s chunking

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
                encoded = opus_writer.read_bytes()
                if len(encoded) == 0:
                    break
                if not ws.closed:
                    await ws.send_bytes(TAG_AUDIO + encoded)

    async def reader():
        """Decode incoming mic Opus -> 16kHz PCM -> feed the model in 1s chunks."""
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
                pcm16 = librosa.resample(
                    pcm24.astype(np.float32), orig_sr=OPUS_SR, target_sr=MODEL_IN_SR
                )
                pcm16_buf = np.concatenate([pcm16_buf, pcm16])
                while len(pcm16_buf) >= CHUNK_SAMPLES:
                    chunk = np.ascontiguousarray(pcm16_buf[:CHUNK_SAMPLES])
                    pcm16_buf = pcm16_buf[CHUNK_SAMPLES:]
                    in_q.put(chunk)
            elif msg.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
                break
        in_q.put(None)  # tell the worker to stop

    async def sender():
        """Forward the model's speech (Opus 0x01) and text (0x02) to the browser."""
        while True:
            item = await out_q.get()
            if item is sentinel:
                break
            if isinstance(item, Exception):
                logger.error(f"[chat] duplex worker error: {item}")
                break
            text, audio = item
            if text and not ws.closed:
                await ws.send_bytes(TAG_TEXT + text.encode("utf-8"))
            if audio is not None and len(audio):
                await send_opus(audio)
        if len(out_pcm_buf):  # flush any tail
            await send_opus(np.array([], dtype=np.float32), flush=True)

    # One conversation at a time (single global duplex session).
    async with engine.lock:
        worker = loop.run_in_executor(
            None, engine.run_session, text_prompt, in_q, out_q, loop, sentinel
        )
        await ws.send_bytes(TAG_HANDSHAKE)
        logger.info("[chat] client connected, handshake sent")
        try:
            await asyncio.gather(reader(), sender())
        finally:
            in_q.put(None)
            await worker
            if not ws.closed:
                await ws.close()

    logger.info("[chat] client disconnected")
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

    parser = argparse.ArgumentParser(description="Hear-Me-Out MiniCPM-o bridge server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--device", default="cuda")
    parser.add_argument(
        "--ssl",
        default=os.environ.get("SSL_DIR", ""),
        help="Directory containing cert.pem and key.pem",
    )
    args = parser.parse_args()

    global engine
    engine = MiniCPMODuplexEngine(device=args.device)

    ssl_context = None
    if args.ssl:
        cert_file = os.path.join(args.ssl, "cert.pem")
        key_file = os.path.join(args.ssl, "key.pem")
        if os.path.exists(cert_file) and os.path.exists(key_file):
            ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
            ssl_context.load_cert_chain(cert_file, key_file)
            logger.info(f"SSL enabled from {args.ssl}")
        else:
            logger.warning(f"SSL dir {args.ssl} missing cert.pem/key.pem — serving plain")

    logger.info(
        f"MiniCPM-o duplex server on {args.host}:{args.port} (ssl={ssl_context is not None})"
    )
    web.run_app(create_app(), host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
