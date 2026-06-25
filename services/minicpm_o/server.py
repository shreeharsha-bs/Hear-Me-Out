"""Hear-Me-Out MiniCPM-o bridge server.

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
  - MiniCPM-o works at 16kHz in / 24kHz TTS out, so we resample 24k<->16k internally.

Turn-taking is half-duplex: Silero VAD detects the end of the user's turn, then we
run one MiniCPM-o generation and stream the reply back. This is enough for the
existing single-speaker conversation UI; full-duplex barge-in is future work.
"""

import argparse
import asyncio
import logging
import os
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
# streaming_prefill takes the user turn in 1s chunks (16000 samples @16kHz).
PREFILL_CHUNK = 16000
MIN_AUDIO_SAMPLES = 16000  # pad the final chunk up to this if shorter
# sphn.append_pcm only accepts exact Opus frame sizes; 1920 @ 24kHz = 80ms,
# the same frame PersonaPlex feeds.
OPUS_FRAME = 1920

MODEL_ID = os.environ.get("MINICPM_O_MODEL", "openbmb/MiniCPM-o-4_5")

# Reference audio that defines the assistant's voice (16kHz). MiniCPM-o clones this
# voice for its replies. Override with MINICPM_REF_AUDIO; defaults to a repo recording.
REPO_ROOT = Path(__file__).resolve().parents[2]
REF_AUDIO_PATH = os.environ.get(
    "MINICPM_REF_AUDIO", str(REPO_ROOT / "recordings" / "Target_2.wav")
)

# Default assistant instruction when the frontend doesn't pass a text_prompt.
DEFAULT_INSTRUCTION = (
    "Please assist users while maintaining this voice style. Answer the user's "
    "questions seriously and with high quality, in a highly human-like and oral style."
)


# ---------------------------------------------------------------------------
# MiniCPM-o engine — follows the official "Half-Duplex Realtime Speech
# Conversation" API (model card for openbmb/MiniCPM-o-4_5).
# ---------------------------------------------------------------------------
class MiniCPMOEngine:
    """Loads MiniCPM-o once; one conversation (session) at a time.

    The model keeps a single global streaming session + token2wav cache, so a
    process-wide lock serializes turns/sessions (fine for the single-speaker
    research UI). Output audio is fixed at 24kHz.
    """

    SESSION_ID = "hmo"

    def __init__(self, device: str = "cuda", ref_audio_path: str = REF_AUDIO_PATH):
        from transformers import AutoModel

        logger.info(f"Loading {MODEL_ID} on {device} (bf16)...")
        self.device = device
        # We only do speech-to-speech, so skip the vision encoder (init_vision=False)
        # to save several GB of VRAM — omni models load vision+audio+tts by default.
        self.model = AutoModel.from_pretrained(
            MODEL_ID,
            trust_remote_code=True,
            attn_implementation="sdpa",
            torch_dtype=torch.bfloat16,
            init_vision=False,
            init_audio=True,
            init_tts=True,
        )
        self.model.eval().to(device)
        self.model.init_tts()

        if not os.path.exists(ref_audio_path):
            raise FileNotFoundError(
                f"Reference voice audio not found: {ref_audio_path} "
                f"(set MINICPM_REF_AUDIO to a 16kHz wav)."
            )
        self.ref_audio, _ = librosa.load(ref_audio_path, sr=16000, mono=True)
        logger.info(f"Voice reference: {ref_audio_path}")
        self.lock = asyncio.Lock()
        logger.info("MiniCPM-o loaded.")

    def _sys_msg(self, text_prompt: str) -> dict:
        # Per the model card: instruct voice-clone, supply the ref audio, then the
        # behaviour instruction. The frontend's text_prompt becomes that instruction.
        return {
            "role": "system",
            "content": [
                "Clone the voice in the provided audio prompt.",
                self.ref_audio,
                text_prompt or DEFAULT_INSTRUCTION,
            ],
        }

    def _start_session(self, text_prompt: str):
        """Reset state, set the voice, and prefill the system turn."""
        self.model.reset_session(reset_token2wav_cache=True)
        self.model.init_token2wav_cache(prompt_speech_16k=self.ref_audio)
        self.model.streaming_prefill(
            session_id=self.SESSION_ID,
            msgs=[self._sys_msg(text_prompt)],
            omni_mode=False,
            is_last_chunk=True,
        )

    def _run_stream(self, pcm_16k, loop, q, sentinel):
        """Blocking worker: prefill one user turn (16kHz) in 1s chunks, then
        generate, pushing each (text_chunk, audio_24k) onto the asyncio queue as
        soon as the model yields it (low time-to-first-audio)."""
        try:
            total = len(pcm_16k)
            num_chunks = (total + PREFILL_CHUNK - 1) // PREFILL_CHUNK
            for ci in range(num_chunks):
                start = ci * PREFILL_CHUNK
                end = min((ci + 1) * PREFILL_CHUNK, total)
                chunk = pcm_16k[start:end]
                is_last = ci == num_chunks - 1
                if is_last and len(chunk) < MIN_AUDIO_SAMPLES:
                    chunk = np.concatenate(
                        [chunk, np.zeros(MIN_AUDIO_SAMPLES - len(chunk), dtype=chunk.dtype)]
                    )
                self.model.streaming_prefill(
                    session_id=self.SESSION_ID,
                    msgs=[{"role": "user", "content": [chunk]}],
                    omni_mode=False,
                    is_last_chunk=is_last,
                )

            iter_gen = self.model.streaming_generate(
                session_id=self.SESSION_ID,
                generate_audio=True,
                use_tts_template=True,
                enable_thinking=False,
                do_sample=True,
                max_new_tokens=512,
                length_penalty=1.1,  # model card's suggestion for realtime speech
            )
            for wav_chunk, text_chunk in iter_gen:
                wav = wav_chunk
                if isinstance(wav, torch.Tensor):
                    wav = wav.squeeze().float().cpu().numpy()
                loop.call_soon_threadsafe(
                    q.put_nowait, (text_chunk, np.asarray(wav, dtype=np.float32))
                )
        except Exception as e:
            loop.call_soon_threadsafe(q.put_nowait, e)
        finally:
            loop.call_soon_threadsafe(q.put_nowait, sentinel)

    async def start_session(self, text_prompt: str):
        loop = asyncio.get_event_loop()
        async with self.lock:
            await loop.run_in_executor(None, self._start_session, text_prompt)

    async def generate_stream(self, pcm_16k: np.ndarray):
        """Async generator yielding (text_chunk, audio_24k float32) as produced."""
        loop = asyncio.get_event_loop()
        q: asyncio.Queue = asyncio.Queue()
        sentinel = object()
        async with self.lock:
            loop.run_in_executor(None, self._run_stream, pcm_16k, loop, q, sentinel)
            while True:
                item = await q.get()
                if item is sentinel:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item


engine: MiniCPMOEngine | None = None


# ---------------------------------------------------------------------------
# WebSocket handler — the PersonaPlex-compatible /api/chat endpoint.
# ---------------------------------------------------------------------------
async def handle_chat(request: web.Request) -> web.WebSocketResponse:
    from silero_vad import load_silero_vad, VADIterator

    text_prompt = request.query.get("text_prompt", "")
    # voice_prompt is part of the PersonaPlex URL but MiniCPM-o picks its own
    # voice; accept and ignore it so the frontend URL works unchanged.

    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    # Set the voice + prefill the system turn before signalling ready.
    try:
        await engine.start_session(text_prompt)
    except Exception as e:
        logger.error(f"[chat] session init failed: {e}")
        await ws.close()
        return ws
    await ws.send_bytes(TAG_HANDSHAKE)
    logger.info("[chat] client connected, handshake sent")

    opus_reader = sphn.OpusStreamReader(OPUS_SR)
    opus_writer = sphn.OpusStreamWriter(OPUS_SR)

    vad_model = load_silero_vad()
    vad = VADIterator(vad_model, sampling_rate=MODEL_IN_SR)
    VAD_WINDOW = 512  # silero expects 512-sample windows at 16kHz

    # Buffers: 24kHz PCM straight from Opus, 16kHz PCM for VAD/model.
    pcm16_buf = np.array([], dtype=np.float32)      # awaiting VAD windowing
    speech_buf = np.array([], dtype=np.float32)     # current utterance (16kHz)
    out_pcm_buf = np.array([], dtype=np.float32)    # reply PCM awaiting Opus framing
    in_speech = False

    async def _send_opus(pcm: np.ndarray):
        """Encode 24kHz PCM and send any complete Opus frames (0x01)."""
        nonlocal out_pcm_buf
        out_pcm_buf = np.concatenate([out_pcm_buf, pcm])
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

    async def stream_reply(utterance: np.ndarray):
        """Stream the reply chunk-by-chunk as the model produces it."""
        nonlocal out_pcm_buf
        out_pcm_buf = np.array([], dtype=np.float32)
        async for text_chunk, audio_24k in engine.generate_stream(utterance):
            if text_chunk and not ws.closed:
                await ws.send_bytes(TAG_TEXT + text_chunk.encode("utf-8"))
            if len(audio_24k):
                await _send_opus(audio_24k)
        # Flush the tail: pad the remainder up to one Opus frame.
        if len(out_pcm_buf):
            pad = (-len(out_pcm_buf)) % OPUS_FRAME
            tail = out_pcm_buf
            if pad:
                tail = np.concatenate([tail, np.zeros(pad, dtype=np.float32)])
            out_pcm_buf = np.array([], dtype=np.float32)  # clear before re-appending
            await _send_opus(tail)

    async for msg in ws:
        if msg.type == web.WSMsgType.BINARY:
            data = msg.data
            if not data:
                continue
            tag = data[0:1]
            if tag != TAG_AUDIO:
                continue
            # Decode incoming Ogg-Opus (24kHz) -> float32 PCM.
            opus_reader.append_bytes(data[1:])
            pcm24 = opus_reader.read_pcm()
            if pcm24.shape[-1] == 0:
                continue
            pcm16 = librosa.resample(
                pcm24.astype(np.float32), orig_sr=OPUS_SR, target_sr=MODEL_IN_SR
            )
            pcm16_buf = np.concatenate([pcm16_buf, pcm16])

            # Feed VAD in 512-sample windows.
            while len(pcm16_buf) >= VAD_WINDOW:
                window = pcm16_buf[:VAD_WINDOW]
                pcm16_buf = pcm16_buf[VAD_WINDOW:]
                if in_speech:
                    speech_buf = np.concatenate([speech_buf, window])
                event = vad(torch.from_numpy(window.copy()), return_seconds=False)
                if event is None:
                    continue
                if "start" in event and not in_speech:
                    in_speech = True
                    speech_buf = window.copy()
                elif "end" in event and in_speech:
                    in_speech = False
                    utterance = speech_buf
                    speech_buf = np.array([], dtype=np.float32)
                    vad.reset_states()
                    if len(utterance) < MODEL_IN_SR // 4:  # <0.25s -> noise
                        continue
                    try:
                        await stream_reply(utterance)
                    except Exception as e:
                        logger.error(f"[chat] generation error: {e}")
        elif msg.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
            break

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
    engine = MiniCPMOEngine(device=args.device)

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
        f"MiniCPM-o server on {args.host}:{args.port} (ssl={ssl_context is not None})"
    )
    web.run_app(
        create_app(), host=args.host, port=args.port, ssl_context=ssl_context
    )


if __name__ == "__main__":
    main()
