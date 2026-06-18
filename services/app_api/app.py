"""
Main web application service. Serves the static frontend and provides
voice conversion, metrics comparison, and recording endpoints.
Standalone FastAPI (no Modal dependency).
"""

import os
import sys
import subprocess
import tempfile
import uuid
import shutil
import logging
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
import torch

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# This file lives at <repo>/services/app_api/app.py, so the repo root is parents[2].
REPO_ROOT = Path(__file__).resolve().parents[2]
_default_static = REPO_ROOT / "frontend" / "dist"
STATIC_PATH = Path(os.environ.get("FRONTEND_PATH", _default_static))
SEED_VC_DIR = REPO_ROOT / "seed-vc"
INFERENCE_SCRIPT = SEED_VC_DIR / "inference.py"
RECORDINGS_DIR = REPO_ROOT / "recordings"

ALLOWED_EXTENSIONS = {"wav", "mp3", "flac", "m4a", "ogg"}
UPLOAD_FOLDER = tempfile.gettempdir()

vad_model = None
get_speech_timestamps = None
save_audio = None
read_audio = None
collect_chunks = None

whisper_model = None
whisper_model_cpu = None


def _init_whisper():
    global whisper_model
    if whisper_model is None:
        from faster_whisper import WhisperModel

        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute = "int8_float16" if torch.cuda.is_available() else "int8"
        model_size = os.environ.get("WHISPER_MODEL", "small")
        whisper_model = WhisperModel(model_size, device=device, compute_type=compute)
        logger.info(f"Whisper model '{model_size}' loaded on {device}")


def _init_whisper_cpu():
    """Lazy CPU Whisper, used as an OOM fallback when the shared GPU is full."""
    global whisper_model_cpu
    if whisper_model_cpu is None:
        from faster_whisper import WhisperModel

        model_size = os.environ.get("WHISPER_MODEL", "small")
        whisper_model_cpu = WhisperModel(model_size, device="cpu", compute_type="int8")
        logger.info(f"Whisper CPU fallback model '{model_size}' loaded")
    return whisper_model_cpu


def _init_vad():
    global vad_model, get_speech_timestamps, save_audio, read_audio, collect_chunks
    if vad_model is None:
        model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad", model="silero_vad"
        )
        vad_model = model
        (get_speech_timestamps, save_audio, read_audio, _, collect_chunks) = utils


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def create_app():
    app = FastAPI()

    @app.on_event("startup")
    async def preload_models():
        logger.info("Pre-loading Whisper model...")
        _init_whisper()
        logger.info("Pre-loading VAD model...")
        _init_vad()
        logger.info("Pre-loading complete")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Disable caching on static files
    StaticFiles.is_not_modified = lambda self, *args, **kwargs: False

    @app.get("/api/health")
    async def health_check():
        return JSONResponse({"status": "healthy", "service": "vc-api"})

    @app.post("/api/transcribe")
    async def transcribe_audio(audio: UploadFile = File(...)):
        _init_whisper()

        contents = await audio.read()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(contents)
            temp_path = f.name

        def _run(model):
            segments_result, _ = model.transcribe(temp_path, beam_size=1, language="en")
            segs = []
            for s in segments_result:  # generation (and any OOM) happens here
                if s.text.strip():
                    segs.append(
                        {
                            "start": round(s.start, 2),
                            "end": round(s.end, 2),
                            "text": s.text.strip(),
                        }
                    )
            return segs

        try:
            try:
                segments = _run(whisper_model)
            except RuntimeError as e:
                # Shared GPU can be exhausted by PersonaPlex + other jobs; fall
                # back to a CPU model instead of 500-ing the whole transcript.
                if "out of memory" in str(e).lower() and torch.cuda.is_available():
                    logger.warning("Whisper CUDA OOM — clearing cache, retrying on CPU")
                    torch.cuda.empty_cache()
                    segments = _run(_init_whisper_cpu())
                else:
                    raise
            text = " ".join(s["text"] for s in segments)
            return JSONResponse({"text": text, "segments": segments})
        finally:
            os.unlink(temp_path)

    @app.post("/api/voice-conversion")
    async def voice_conversion(
        source_audio: UploadFile = File(...), target_audio: UploadFile = File(...)
    ):
        _init_vad()

        if not source_audio.filename or not target_audio.filename:
            raise HTTPException(status_code=400, detail="Missing audio files")

        if not (
            allowed_file(source_audio.filename) and allowed_file(target_audio.filename)
        ):
            raise HTTPException(
                status_code=400,
                detail="Invalid file format. Supported: wav, mp3, flac, m4a, ogg",
            )

        temp_dir = tempfile.mkdtemp()
        conversion_id = str(uuid.uuid4())

        try:
            source_filename = f"source_{conversion_id}.wav"
            target_filename = f"target_{conversion_id}.wav"
            source_path = os.path.join(temp_dir, source_filename)
            target_path = os.path.join(temp_dir, target_filename)
            output_dir = os.path.join(temp_dir, "output")

            with open(source_path, "wb") as f:
                f.write(await source_audio.read())
            with open(target_path, "wb") as f:
                f.write(await target_audio.read())
            os.makedirs(output_dir, exist_ok=True)

            vad_processed_source_path = os.path.join(temp_dir, f"vad_{source_filename}")
            threshold = 0.25
            wav = read_audio(source_path, sampling_rate=16000)
            speech_timestamps = get_speech_timestamps(
                wav, vad_model, sampling_rate=16000, threshold=threshold
            )
            save_audio(
                vad_processed_source_path,
                collect_chunks(speech_timestamps, wav),
                sampling_rate=16000,
            )

            logger.info(f"Processing voice conversion with ID: {conversion_id}")

            diffusion_steps = 15
            length_adjust = 1.0
            inference_cfg_rate = 0.7

            # Check for volume-mounted checkpoint, fall back to HF download
            checkpoint_path = os.environ.get("VC_CHECKPOINT_PATH", "")
            checkpoint_args = []
            if checkpoint_path and os.path.exists(checkpoint_path):
                config_path = os.environ.get(
                    "VC_MODEL_CONFIG",
                    "configs/presets/config_dit_mel_seed_uvit_xlsr_tiny.yml",
                )
                checkpoint_args = [
                    "--checkpoint",
                    checkpoint_path,
                    "--config",
                    config_path,
                ]

            cmd = [
                sys.executable,
                str(INFERENCE_SCRIPT),
                "--source",
                vad_processed_source_path,
                "--target",
                target_path,
                "--output",
                output_dir,
                "--diffusion-steps",
                str(diffusion_steps),
                "--length-adjust",
                str(length_adjust),
                "--inference-cfg-rate",
                str(inference_cfg_rate),
                "--fp16",
                "True",
            ] + checkpoint_args

            logger.info(f"Running command: {' '.join(cmd)}")

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=str(SEED_VC_DIR),
                timeout=300,
            )

            logger.info(f"Inference stdout: {result.stdout}")
            if result.stderr:
                logger.warning(f"Inference stderr: {result.stderr}")

            if result.returncode != 0:
                error_msg = f"Voice conversion failed: {result.stderr}"
                logger.error(error_msg)
                raise HTTPException(status_code=500, detail=error_msg)

            output_files = [f for f in os.listdir(output_dir) if f.endswith(".wav")]
            if not output_files:
                raise HTTPException(status_code=500, detail="No output file generated")

            output_file_path = os.path.join(output_dir, output_files[0])
            logger.info(f"Generated output file: {output_file_path}")

            cleanup = BackgroundTask(shutil.rmtree, temp_dir, ignore_errors=True)
            return FileResponse(
                output_file_path,
                media_type="audio/wav",
                filename=f"converted_{conversion_id}.wav",
                background=cleanup,
            )

        except subprocess.TimeoutExpired:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise HTTPException(status_code=408, detail="Voice conversion timed out")
        except HTTPException:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise
        except Exception as e:
            logger.error(f"Error during voice conversion: {str(e)}")
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")

    @app.post("/api/metrics-comparison")
    async def metrics_comparison(
        source_audio: UploadFile = File(...),
        target_audio: UploadFile = File(...),
        output: str = "image",
    ):
        if not source_audio.filename or not target_audio.filename:
            raise HTTPException(status_code=400, detail="Missing audio files")

        if not (
            allowed_file(source_audio.filename) and allowed_file(target_audio.filename)
        ):
            raise HTTPException(
                status_code=400,
                detail="Invalid file format. Supported: wav, mp3, flac, m4a, ogg",
            )

        temp_dir = tempfile.mkdtemp()
        comparison_id = str(uuid.uuid4())

        try:
            source_filename = f"source_{comparison_id}.wav"
            target_filename = f"target_{comparison_id}.wav"
            source_path = os.path.join(temp_dir, source_filename)
            target_path = os.path.join(temp_dir, target_filename)
            plot_path = os.path.join(
                temp_dir, f"metrics_comparison_{comparison_id}.png"
            )

            with open(source_path, "wb") as f:
                f.write(await source_audio.read())
            with open(target_path, "wb") as f:
                f.write(await target_audio.read())

            logger.info(f"Processing metrics comparison with ID: {comparison_id}")

            # metrics.py sits beside this file (services/app_api/).
            sys.path.insert(0, str(Path(__file__).resolve().parent))

            try:
                from metrics import analyze_voices, create_comprehensive_metrics_plot
            except ImportError as e:
                raise HTTPException(
                    status_code=500,
                    detail=f"Metrics analysis module not available: {e}",
                )

            results = analyze_voices(source_path, target_path)

            # JSON path: return the raw metrics dict so the frontend can render
            # it with HTML/CSS (no server-side matplotlib). Temp files are already
            # consumed by analyze_voices, so they can be cleaned up immediately.
            if output == "json":
                shutil.rmtree(temp_dir, ignore_errors=True)
                return JSONResponse(results)

            if (
                results["aesthetics"]["response_a"]
                and results["aesthetics"]["response_b"]
            ):
                create_comprehensive_metrics_plot(results, save_path=plot_path)
                logger.info(f"Generated metrics comparison plot: {plot_path}")

                cleanup = BackgroundTask(shutil.rmtree, temp_dir, ignore_errors=True)
                return FileResponse(
                    plot_path,
                    media_type="image/png",
                    filename=f"metrics_comparison_{comparison_id}.png",
                    background=cleanup,
                )
            else:
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise HTTPException(
                    status_code=500,
                    detail="Failed to compute aesthetic metrics for the audio files",
                )

        except HTTPException:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise
        except Exception as e:
            logger.error(f"Error during metrics comparison: {str(e)}")
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")

    @app.get("/recordings/{filename}")
    async def serve_recording(filename: str):
        if not RECORDINGS_DIR.exists():
            raise HTTPException(
                status_code=404, detail="Recordings directory not found"
            )

        from werkzeug.utils import secure_filename

        secure_name = secure_filename(filename)
        file_path = RECORDINGS_DIR / secure_name

        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Recording file not found")

        if not allowed_file(secure_name):
            raise HTTPException(status_code=400, detail="File type not allowed")

        logger.info(f"Serving recording file: {file_path}")
        return FileResponse(file_path, media_type="audio/wav")

    # Serve static frontend files
    app.mount("/", StaticFiles(directory=str(STATIC_PATH), html=True))

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:create_app",
        host="0.0.0.0",
        port=5001,
        factory=True,
    )
