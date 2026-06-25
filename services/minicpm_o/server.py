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
import sys
import tempfile

import librosa
import numpy as np
import sphn
import torch

import aiohttp
from aiohttp import web

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("minicpm-o-server")

# Tag bytes (must match frontend/useWebSocket.ts and moshi's server).
TAG_HANDSHAKE = b"\x00"
TAG_AUDIO = b"\x01"
TAG_TEXT = b"\x02"

# Browser-facing Opus rate (opus-recorder/ogg-opus-decoder both use 24kHz here).
OPUS_SR = 24000
# MiniCPM-o consumes 16kHz audio.
MODEL_IN_SR = 16000
# sphn.append_pcm only accepts exact Opus frame sizes; 1920 @ 24kHz = 80ms,
# the same frame PersonaPlex feeds.
OPUS_FRAME = 1920

MODEL_ID = os.environ.get("MINICPM_O_MODEL", "openbmb/MiniCPM-o-4_5")


# ---------------------------------------------------------------------------
# MiniCPM-o engine (the one place to adjust for the installed model version).
# ---------------------------------------------------------------------------
class MiniCPMOEngine:
    """Loads MiniCPM-o once and runs one speech-to-speech turn at a time.

    Concurrency: the model holds per-call state, so a process-wide lock
    serializes turns (fine for the single-speaker research UI).
    """

    def __init__(self, device: str = "cuda"):
        from transformers import AutoModel, AutoTokenizer

        logger.info(f"Loading {MODEL_ID} on {device} (bf16)...")
        self.device = device
        self.model = AutoModel.from_pretrained(
            MODEL_ID,
            trust_remote_code=True,
            torch_dtype=torch.bfloat16,
            attn_implementation="sdpa",
        )
        # Initialize the TTS sub-module so the model can emit speech.
        self.model.init_tts()
        self.model.to(device).eval()
        self.tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID, trust_remote_code=True
        )
        self.lock = asyncio.Lock()
        logger.info("MiniCPM-o loaded.")

    def _run(self, pcm_16k: np.ndarray, system_prompt: str):
        """Blocking: one user turn (16kHz PCM) -> (text, audio_24k float32).

        Uses MiniCPM-o's documented speech-to-speech chat API. If the installed
        4.5 build differs, this method is the only thing to adjust.
        """
        import soundfile as sf

        msgs = []
        if system_prompt:
            msgs.append({"role": "system", "content": [system_prompt]})
        msgs.append({"role": "user", "content": [pcm_16k]})

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            out_path = tf.name
        try:
            res = self.model.chat(
                msgs=msgs,
                tokenizer=self.tokenizer,
                sampling=True,
                max_new_tokens=512,
                use_tts_template=True,
                generate_audio=True,
                output_audio_path=out_path,
            )
            text = getattr(res, "text", None)
            if text is None:
                text = res if isinstance(res, str) else str(res)

            audio_24k = np.array([], dtype=np.float32)
            if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                wav, sr = sf.read(out_path, dtype="float32")
                if wav.ndim > 1:
                    wav = wav.mean(axis=1)
                if sr != OPUS_SR:
                    wav = librosa.resample(wav, orig_sr=sr, target_sr=OPUS_SR)
                audio_24k = wav.astype(np.float32)
            return text, audio_24k
        finally:
            if os.path.exists(out_path):
                os.unlink(out_path)

    async def generate(self, pcm_16k: np.ndarray, system_prompt: str):
        loop = asyncio.get_event_loop()
        async with self.lock:
            return await loop.run_in_executor(None, self._run, pcm_16k, system_prompt)


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
    in_speech = False

    async def stream_reply(text: str, audio_24k: np.ndarray):
        if text:
            await ws.send_bytes(TAG_TEXT + text.encode("utf-8"))
        # Push the reply audio through the Opus encoder in fixed frames.
        buf = audio_24k
        n = (len(buf) // OPUS_FRAME) * OPUS_FRAME
        for i in range(0, n, OPUS_FRAME):
            frame = np.ascontiguousarray(buf[i : i + OPUS_FRAME])
            opus_writer.append_pcm(frame)
            while True:
                encoded = opus_writer.read_bytes()
                if len(encoded) == 0:
                    break
                if not ws.closed:
                    await ws.send_bytes(TAG_AUDIO + encoded)

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
                        text, audio_24k = await engine.generate(utterance, text_prompt)
                        await stream_reply(text, audio_24k)
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
