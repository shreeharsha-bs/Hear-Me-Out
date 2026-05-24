import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from threading import Lock

import librosa
import numpy as np
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
        from transformers import WavLMModel, Wav2Vec2FeatureExtractor

        sv_ckpt = sv_ckpt_path
        if os.path.exists(sv_ckpt):
            self.sv_model = torch.jit.load(sv_ckpt, map_location="cpu")
            self.sv_model.eval()
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

    ws = web.WebSocketResponse()
    await ws.prepare(request)
    await ws.send_json({"status": "ready", "chunk_size": session.CHUNK})

    async for msg in ws:
        if msg.type == web.WSMsgType.BINARY:
            chunk_count += 1
            raw = msg.data
            samples = np.frombuffer(raw, dtype=np.float32).copy()

            if session.need_extra_data:
                # First chunk: pad with silence for the look-ahead
                extra = np.zeros(720, dtype=np.float32)
                samples = np.concatenate([samples, extra])
                session.need_extra_data = False

            if chunk_count % 50 == 0 and chunk_count > 0:
                session.reset_cache()

            try:
                vc_wav = session.inference_one_chunk(samples)
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


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_post("/api/meanvc/load-target", handle_load_target)
    app.router.add_get("/api/meanvc/stream", handle_stream)
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
    port = int(os.environ.get("MEANVC_PORT", 5002))
    app = create_app()
    app.on_startup.append(on_startup)
    logger.info(f"MeanVC server starting on port {port}")
    web.run_app(app, port=port)


if __name__ == "__main__":
    main()
