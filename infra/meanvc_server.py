import asyncio
import json
import logging
import os
import sys
import time
import uuid
import wave
from pathlib import Path
from threading import Lock
from urllib.parse import urlencode

import aiohttp
import librosa
import numpy as np
import sphn
import torch
import torch.nn as nn
import torchaudio.compliance.kaldi as kaldi
from aiohttp import web
from librosa.filters import mel as librosa_mel_fn

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("meanvc-server")


# Replicate MeanVC's Mel spectrogram and fbank extractors ------------------------------------------------
def _amp_to_db(x, min_level_db):
    min_level = np.exp(min_level_db / 20 * np.log(10))
    return 20 * torch.log10(torch.maximum(torch.tensor(min_level), x))


def _normalize(S, max_abs_value, min_db):
    return torch.clamp(
        (2 * max_abs_value) * ((S - min_db) / (-min_db)) - max_abs_value,
        -max_abs_value,
        max_abs_value,
    )


class MelSpectrogramFeatures(nn.Module):
    def __init__(
        self,
        sample_rate=16000,
        n_fft=1024,
        win_size=640,
        hop_length=160,
        n_mels=80,
        fmin=0,
        fmax=8000,
    ):
        super().__init__()
        self.sample_rate = sample_rate
        self.n_fft = n_fft
        self.hop_length = hop_length
        self.n_mels = n_mels
        self.win_size = win_size
        self.fmin = fmin
        self.fmax = fmax
        self.mel_basis = {}
        self.hann_window = {}

    def forward(self, y):
        dtype_device = str(y.dtype) + "_" + str(y.device)
        fmax_key = str(self.fmax) + "_" + dtype_device
        wnsize_key = str(self.win_size) + "_" + dtype_device
        if fmax_key not in self.mel_basis:
            mel = librosa_mel_fn(
                sr=self.sample_rate,
                n_fft=self.n_fft,
                n_mels=self.n_mels,
                fmin=self.fmin,
                fmax=self.fmax,
            )
            self.mel_basis[fmax_key] = torch.from_numpy(mel).to(
                dtype=y.dtype, device=y.device
            )
        if wnsize_key not in self.hann_window:
            self.hann_window[wnsize_key] = torch.hann_window(self.win_size).to(
                dtype=y.dtype, device=y.device
            )
        spec = torch.stft(
            y,
            self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_size,
            window=self.hann_window[wnsize_key],
            center=True,
            pad_mode="reflect",
            normalized=False,
            onesided=True,
            return_complex=False,
        )
        spec = torch.sqrt(spec.pow(2).sum(-1) + 1e-6)
        spec = torch.matmul(self.mel_basis[fmax_key], spec)
        spec = _amp_to_db(spec, -115) - 20
        return _normalize(spec, 1, -115)


def extract_fbanks(
    wav, sample_rate=16000, mel_bins=80, frame_length=25, frame_shift=12.5
):
    wav = wav * (1 << 15)
    wav = torch.from_numpy(wav).unsqueeze(0)
    fbanks = kaldi.fbank(
        wav,
        frame_length=frame_length,
        frame_shift=frame_shift,
        snip_edges=True,
        num_mel_bins=mel_bins,
        energy_floor=0.0,
        dither=0.0,
        sample_frequency=sample_rate,
    )
    return fbanks.unsqueeze(0)


# Shared model store -------------------------------------------------------------------------------------
class SharedModels:
    def __init__(self, ckpt_dir: str, sv_ckpt_path: str):
        torch.set_num_threads(4)
        self.ckpt_dir = Path(ckpt_dir)
        self.device = "cpu"
        logger.info(f"MeanVC using device: {self.device}")

        logger.info("Loading Speaker Verification model (wavlm_large)...")
        sv_ckpt = sv_ckpt_path
        if os.path.exists(sv_ckpt):
            sv_root = os.environ.get("SPEAKER_VERIFICATION_ROOT", os.getcwd())
            if sv_root not in sys.path:
                sys.path.insert(0, sv_root)
            from src.runtime.speaker_verification.verification import init_model

            self.sv_model = init_model("wavlm_large", sv_ckpt)
            self.sv_model.eval()
            logger.info("Speaker verification model loaded")
        else:
            logger.warning(
                f"Speaker verification model not found at {sv_ckpt}, using fallback"
            )
            self.sv_model = None

        logger.info("Loading ASR model...")
        self.asr = torch.jit.load(
            str(self.ckpt_dir / "fastu2++.pt"), map_location="cpu"
        )
        self.asr.eval()

        logger.info("Loading VC model...")
        self.vc = torch.jit.load(
            str(self.ckpt_dir / "meanvc_200ms.pt"), map_location="cpu"
        )
        self.vc.eval()

        logger.info("Loading Vocoder...")
        self.vocoder = torch.jit.load(
            str(self.ckpt_dir / "vocos.pt"), map_location="cpu"
        )
        self.vocoder.eval()

        self.mel_extract = MelSpectrogramFeatures()
        logger.info("All models loaded")


# Per-session inference state ---------------------------------------------------------------------------
class InferenceSession:
    def __init__(
        self,
        models: SharedModels,
        target_emb: torch.Tensor,
        target_mel: torch.Tensor,
        steps: int = 2,
    ):
        self.models = models
        self.steps = steps
        if steps == 1:
            self.timesteps = torch.tensor([1.0, 0.0])
        elif steps == 2:
            self.timesteps = torch.tensor([1.0, 0.8, 0.0])
        else:
            self.timesteps = torch.linspace(1.0, 0.0, steps + 1)

        self.vc_spk_emb = target_emb
        self.vc_prompt_mel = target_mel

        # Chunk sizing
        decoding_chunk_size = 5
        num_decoding_left_chunks = 2
        subsampling = 4
        context = 7
        stride = subsampling * decoding_chunk_size
        self.required_cache_size = decoding_chunk_size * num_decoding_left_chunks
        self.CHUNK = 160 * stride
        self.vc_chunk = int(decoding_chunk_size * 4)
        self.vocoder_overlap = 3
        upsample_factor = 160
        self.vocoder_wav_overlap = (self.vocoder_overlap - 1) * upsample_factor
        self.down_linspace = torch.linspace(
            1, 0, steps=self.vocoder_wav_overlap
        ).numpy()
        self.up_linspace = torch.linspace(0, 1, steps=self.vocoder_wav_overlap).numpy()

        self.init_cache()

    def init_cache(self):
        self.samples_cache_len = 720
        self.samples_cache = None
        self.att_cache = torch.zeros((0, 0, 0, 0))
        self.cnn_cache = torch.zeros((0, 0, 0, 0))
        self.asr_offset = 0
        self.encoder_output_cache = None
        self.vc_offset = 0
        self.vc_cache = None
        self.vc_kv_cache = None
        self.vocoder_cache = None
        self.last_wav = None
        self.need_extra_data = True

    def reset_cache(self):
        self.asr_offset = 20
        self.vc_offset = 120

    @torch.no_grad()
    def inference_one_chunk(self, samples: np.ndarray) -> np.ndarray:
        """Process one chunk of float32 samples at 16kHz, returns float32 wav."""
        if self.samples_cache is None:
            samples = samples
        else:
            samples = np.concatenate((self.samples_cache, samples))
        self.samples_cache = samples[-self.samples_cache_len :]

        fbanks = extract_fbanks(samples, frame_shift=10).float()
        fbanks = fbanks
        (encoder_output, self.att_cache, self.cnn_cache) = (
            self.models.asr.forward_encoder_chunk(
                fbanks,
                self.asr_offset,
                self.required_cache_size,
                self.att_cache,
                self.cnn_cache,
            )
        )

        self.asr_offset += encoder_output.size(1)
        if self.encoder_output_cache is None:
            encoder_output = torch.cat(
                [encoder_output[:, 0:1, :], encoder_output], dim=1
            )
        else:
            encoder_output = torch.cat(
                [self.encoder_output_cache, encoder_output], dim=1
            )
        self.encoder_output_cache = encoder_output[:, -1:, :]

        encoder_output_upsample = encoder_output.transpose(1, 2)
        encoder_output_upsample = torch.nn.functional.interpolate(
            encoder_output_upsample,
            size=self.vc_chunk + 1,
            mode="linear",
            align_corners=True,
        )
        encoder_output_upsample = encoder_output_upsample.transpose(1, 2)
        encoder_output_upsample = encoder_output_upsample[:, 1:, :]

        x = torch.randn(
            1, encoder_output_upsample.shape[1], 80, dtype=encoder_output_upsample.dtype
        )

        for i in range(self.steps):
            t = self.timesteps[i]
            r = self.timesteps[i + 1]
            t_tensor = torch.full((1,), t, device=x.device)
            r_tensor = torch.full((1,), r, device=x.device)
            u, tmp_kv_cache = self.models.vc(
                x,
                t_tensor,
                r_tensor,
                cache=self.vc_cache,
                cond=encoder_output_upsample,
                spks=self.vc_spk_emb,
                prompts=self.vc_prompt_mel,
                offset=self.vc_offset,
                kv_cache=self.vc_kv_cache,
            )
            x = x - (t - r) * u

        self.vc_kv_cache = tmp_kv_cache
        self.vc_offset += x.shape[1]
        self.vc_cache = x

        VC_KV_CACHE_MAX_LEN = 100
        if (
            self.vc_offset > 40
            and self.vc_kv_cache[0][0].shape[2] > VC_KV_CACHE_MAX_LEN
        ):
            new_kv = []
            for k, v in self.vc_kv_cache:
                new_k = k[:, :, -VC_KV_CACHE_MAX_LEN:, :]
                new_v = v[:, :, -VC_KV_CACHE_MAX_LEN:, :]
                new_kv.append((new_k, new_v))
            self.vc_kv_cache = new_kv

        mel = x.transpose(1, 2)
        if self.vocoder_cache is not None:
            mel = torch.cat([self.vocoder_cache, mel], dim=-1)
        self.vocoder_cache = mel[:, :, -self.vocoder_overlap :]
        mel = (mel + 1) / 2
        wav = self.models.vocoder.decode(mel).squeeze()
        wav = wav.detach().cpu().numpy()

        if self.last_wav is not None:
            front_wav = wav[: self.vocoder_wav_overlap]
            smooth_front_wav = (
                self.last_wav * self.down_linspace + front_wav * self.up_linspace
            )
            new_wav = np.concatenate(
                [
                    smooth_front_wav,
                    wav[self.vocoder_wav_overlap : -self.vocoder_wav_overlap],
                ],
                axis=0,
            )
        else:
            new_wav = wav[: -self.vocoder_wav_overlap]
        self.last_wav = wav[-self.vocoder_wav_overlap :]

        return new_wav.astype(np.float32)


# Target voice store -------------------------------------------------------------------------------------
targets: dict[str, tuple[torch.Tensor, torch.Tensor]] = {}
targets_lock = Lock()
models: SharedModels | None = None


async def handle_load_target(request: web.Request) -> web.Response:
    """POST /api/meanvc/load-target - upload a target .wav file."""
    global models
    data = await request.post()
    wav_field = data.get("wav")
    if wav_field is None:
        return web.json_response({"error": "No wav file provided"}, status=400)

    target_id = data.get("target_id", uuid.uuid4().hex[:8])
    if isinstance(target_id, web.FileField):
        target_id = uuid.uuid4().hex[:8]
    else:
        target_id = str(target_id)

    tmp_path = f"/tmp/meanvc_target_{uuid.uuid4().hex}.wav"
    try:
        content = wav_field.file.read()
        with open(tmp_path, "wb") as f:
            f.write(content)

        wav, sr = librosa.load(tmp_path, sr=16000)
        wav_tensor = torch.from_numpy(wav).unsqueeze(0)

        # Speaker embedding
        if models.sv_model is not None:
            spk_emb = models.sv_model(wav_tensor).detach()
        else:
            spk_emb = torch.zeros(1, 512)

        # Prompt mel
        prompt_mel = models.mel_extract(wav_tensor)
        prompt_mel = prompt_mel.transpose(1, 2).detach()

        with targets_lock:
            targets[target_id] = (spk_emb, prompt_mel)

        duration = len(wav) / sr
        return web.json_response(
            {
                "target_id": target_id,
                "duration_seconds": round(duration, 2),
            }
        )
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


async def handle_stream(request: web.Request) -> web.WebSocketResponse:
    """WebSocket /api/meanvc/stream?target_id=X - bidirectional streaming."""
    target_id = request.query.get("target_id", "default")
    steps = int(request.query.get("steps", 2))
    source_sr = int(request.query.get("source_sr", 16000))
    need_resample = source_sr != 16000

    if need_resample:
        import torchaudio.functional as F

        resampler = torchaudio.transforms.Resample(
            orig_freq=source_sr, new_freq=16000
        ).to("cpu")
        logger.info(f"Resampling enabled: {source_sr}Hz -> 16000Hz")

    if target_id not in targets:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({"error": f"Unknown target_id: {target_id}"})
        await ws.close()
        return ws

    with targets_lock:
        spk_emb, prompt_mel = targets[target_id]

    session = InferenceSession(models, spk_emb, prompt_mel, steps=steps)
    chunk_count = 0
    acc_samples = np.array([], dtype=np.float32)

    ws = web.WebSocketResponse()
    await ws.prepare(request)
    await ws.send_json({"status": "ready", "chunk_size": session.CHUNK})

    async for msg in ws:
        if msg.type == web.WSMsgType.BINARY:
            raw = msg.data
            incoming = np.frombuffer(raw, dtype=np.float32).copy()

            if need_resample:
                t = torch.from_numpy(incoming).unsqueeze(0)
                incoming = resampler(t).squeeze(0).numpy()

            acc_samples = np.concatenate([acc_samples, incoming])

            while len(acc_samples) >= session.CHUNK:
                chunk = acc_samples[: session.CHUNK]
                acc_samples = acc_samples[session.CHUNK :]
                chunk_count += 1

                if chunk_count == 1:
                    chunk = np.concatenate([chunk, np.zeros(720, dtype=np.float32)])
                    vc_wav = session.inference_one_chunk(chunk)
                    continue  # skip first chunk output (warmup padding)

                try:
                    vc_wav = session.inference_one_chunk(chunk)
                    await ws.send_bytes(vc_wav.tobytes())
                except Exception as e:
                    logger.error(f"Inference error on chunk {chunk_count}: {e}")

        elif msg.type == web.WSMsgType.TEXT:
            cmd = json.loads(msg.data)
            if cmd.get("action") == "reset":
                session.init_cache()
                chunk_count = 0
                logger.info("Session reset")

        elif msg.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
            break

    logger.info(f"Stream closed after {chunk_count} chunks")
    return ws


# Tag bytes used on the proxy<->browser channel (mirrors PersonaPlex's protocol,
# plus 0x03 for the converted user voice that the browser keeps for downloads).
TAG_AUDIO = b"\x01"
TAG_VC_USER = b"\x03"

# Where PersonaPlex listens. It runs on the same host as MeanVC with self-signed
# SSL, so the proxy connects over localhost with cert verification disabled.
PERSONAPLEX_HOST = os.environ.get("PERSONAPLEX_PROXY_HOST", "127.0.0.1")
PERSONAPLEX_PORT = os.environ.get("PERSONAPLEX_PROXY_PORT", "8000")


def _save_wav(path: str, pcm: np.ndarray, sr: int) -> None:
    """Write mono float32 PCM (range -1..1) to a 16-bit WAV file."""
    pcm = np.clip(pcm, -1.0, 1.0)
    ints = (pcm * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(ints.tobytes())


async def handle_chat_proxy(request: web.Request) -> web.WebSocketResponse:
    """WebSocket /api/meanvc/chat-proxy - server-side VC bridge to PersonaPlex.

    The browser sends raw float32 PCM mic chunks (like /stream). We convert each
    chunk with MeanVC, Opus-encode it, and forward it to PersonaPlex over
    localhost - so the converted audio never makes the wasteful round trip back
    through the browser. PersonaPlex's framed replies (0x00 handshake, 0x01 Opus
    audio, 0x02 transcript) are relayed back verbatim. The converted user PCM is
    also sent back tagged 0x03 so the browser can still assemble the user/merged
    WAV downloads (this is off the latency-critical path).
    """
    target_id = request.query.get("target_id", "default")
    steps = int(request.query.get("steps", 2))
    source_sr = int(request.query.get("source_sr", 16000))
    voice_prompt = request.query.get("voice_prompt", "")
    text_prompt = request.query.get("text_prompt", "")
    need_resample = source_sr != 16000

    if need_resample:
        import torchaudio

        resampler = torchaudio.transforms.Resample(
            orig_freq=source_sr, new_freq=16000
        ).to("cpu")
        logger.info(f"[proxy] Resampling enabled: {source_sr}Hz -> 16000Hz")

    browser_ws = web.WebSocketResponse()
    await browser_ws.prepare(request)

    if target_id not in targets:
        await browser_ws.send_json({"error": f"Unknown target_id: {target_id}"})
        await browser_ws.close()
        return browser_ws

    with targets_lock:
        spk_emb, prompt_mel = targets[target_id]

    session = InferenceSession(models, spk_emb, prompt_mel, steps=steps)
    # MeanVC outputs 16 kHz, but sphn's Opus encoder only accepts 24 kHz / 48 kHz
    # (PersonaPlex itself uses 24 kHz = its mimi rate). So encode at 24 kHz and
    # resample the converted audio up before feeding the encoder.
    import torchaudio

    opus_writer = sphn.OpusStreamWriter(24000)
    out_resampler = torchaudio.transforms.Resample(16000, 24000).to("cpu")
    loop = asyncio.get_event_loop()

    # Optional debug capture: decode our own Opus stream with the SAME decoder
    # PersonaPlex uses, so the saved WAV is exactly what PersonaPlex hears
    # (post-Opus round trip). Enabled by setting MEANVC_PROXY_DEBUG_DIR.
    debug_dir = os.environ.get("MEANVC_PROXY_DEBUG_DIR")
    opus_reader_dbg = sphn.OpusStreamReader(24000) if debug_dir else None
    debug_pcm: list[np.ndarray] = []

    qs = urlencode({"voice_prompt": voice_prompt, "text_prompt": text_prompt})
    pplx_url = f"wss://{PERSONAPLEX_HOST}:{PERSONAPLEX_PORT}/api/chat?{qs}"
    logger.info(f"[proxy] Connecting to PersonaPlex: {pplx_url}")

    client = aiohttp.ClientSession()
    try:
        pplx_ws = await client.ws_connect(pplx_url, ssl=False, max_msg_size=0)
    except Exception as e:
        logger.error(f"[proxy] Failed to connect to PersonaPlex: {e}")
        await browser_ws.send_json({"error": f"PersonaPlex unavailable: {e}"})
        await browser_ws.close()
        await client.close()
        return browser_ws

    chunk_count = 0
    acc_samples = np.array([], dtype=np.float32)
    # sphn.append_pcm only accepts exact Opus frame sizes; 1920 @ 24 kHz is what
    # PersonaPlex itself feeds. Buffer the resampled audio and emit fixed frames.
    OPUS_FRAME = 1920
    opus_pcm_buf = np.array([], dtype=np.float32)

    async def browser_to_pplx():
        nonlocal chunk_count, acc_samples, opus_pcm_buf
        async for msg in browser_ws:
            if msg.type == web.WSMsgType.BINARY:
                incoming = np.frombuffer(msg.data, dtype=np.float32).copy()
                if need_resample:
                    t = torch.from_numpy(incoming).unsqueeze(0)
                    incoming = resampler(t).squeeze(0).numpy()
                acc_samples = np.concatenate([acc_samples, incoming])

                while len(acc_samples) >= session.CHUNK:
                    chunk = acc_samples[: session.CHUNK]
                    acc_samples = acc_samples[session.CHUNK :]
                    chunk_count += 1

                    if chunk_count == 1:
                        # First chunk is warmup padding; produce but don't forward.
                        chunk = np.concatenate(
                            [chunk, np.zeros(720, dtype=np.float32)]
                        )
                        await loop.run_in_executor(
                            None, session.inference_one_chunk, chunk
                        )
                        continue

                    try:
                        vc_wav = await loop.run_in_executor(
                            None, session.inference_one_chunk, chunk
                        )
                    except Exception as e:
                        logger.error(f"[proxy] Inference error chunk {chunk_count}: {e}")
                        continue

                    # (a) forward converted audio to PersonaPlex as Opus.
                    # sphn encodes at 24 kHz, so upsample the 16 kHz VC output,
                    # then hand the encoder exact 1920-sample frames.
                    vc_wav_24k = (
                        out_resampler(torch.from_numpy(vc_wav).unsqueeze(0))
                        .squeeze(0)
                        .numpy()
                    )
                    opus_pcm_buf = np.concatenate([opus_pcm_buf, vc_wav_24k])
                    while len(opus_pcm_buf) >= OPUS_FRAME:
                        frame = np.ascontiguousarray(opus_pcm_buf[:OPUS_FRAME])
                        opus_pcm_buf = opus_pcm_buf[OPUS_FRAME:]
                        opus_writer.append_pcm(frame)
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

                    # (b) send converted PCM (16 kHz) back to browser for downloads
                    if not browser_ws.closed:
                        await browser_ws.send_bytes(TAG_VC_USER + vc_wav.tobytes())

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
            out_path = os.path.join(
                debug_dir, f"pplx_input_{target_id}_{int(time.time())}.wav"
            )
            _save_wav(out_path, np.concatenate(debug_pcm), 24000)
            logger.info(f"[proxy] Saved PersonaPlex-input audio to {out_path}")
        except Exception as e:
            logger.error(f"[proxy] Failed to save debug WAV: {e}")

    logger.info(f"[proxy] Closed after {chunk_count} chunks")
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
    app = web.Application(
        middlewares=[cors_middleware], client_max_size=10 * 1024 * 1024
    )
    app.router.add_post("/api/meanvc/load-target", handle_load_target)
    app.router.add_get("/api/meanvc/stream", handle_stream)
    app.router.add_get("/api/meanvc/chat-proxy", handle_chat_proxy)
    return app


async def on_startup(app: web.Application):
    global models
    ckpt_dir = os.environ.get("MEANVC_CKPT_DIR", "/app/meanvc-src/ckpt")
    sv_ckpt = os.environ.get(
        "MEANVC_SV_CKPT",
        "/app/meanvc-src/runtime/speaker_verification/ckpt/wavlm_large_finetune.pth",
    )
    models = SharedModels(ckpt_dir, sv_ckpt)


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
    logger.info(
        f"MeanVC server starting on port {port} (ssl={ssl_context is not None})"
    )
    web.run_app(app, port=port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
