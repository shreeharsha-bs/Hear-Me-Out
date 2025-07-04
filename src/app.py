"""
Main web application service. Serves the static frontend.
"""
from pathlib import Path
import modal
from .moshi import Moshi  # makes modal deploy also deploy moshi

from .common import app

static_path = Path(__file__).with_name("frontend").resolve()


@app.function(
    mounts=[modal.Mount.from_local_dir(static_path, remote_path="/assets")],
    scaledown_window=600,
    timeout=600,
    allow_concurrent_inputs=100,
    image=modal.Image.debian_slim(python_version="3.11").pip_install(
        "fastapi==0.115.5", "python-multipart"
    ),
)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, UploadFile, File, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse
    import subprocess
    import tempfile
    import os
    import uuid
    import shutil

    # disable caching on static files
    StaticFiles.is_not_modified = lambda self, *args, **kwargs: False

    web_app = FastAPI()

    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Voice conversion endpoint
    @web_app.post("/api/voice-conversion")
    async def voice_conversion(
        source_audio: UploadFile = File(...),
        target_audio: UploadFile = File(...)
    ):
        """
        Run voice conversion using the local inference.py script.
        This runs on the user's local machine, not on Modal.
        """
        try:
            # Create temporary directory for this conversion
            temp_dir = tempfile.mkdtemp()
            conversion_id = str(uuid.uuid4())
            
            # Save uploaded files
            source_path = os.path.join(temp_dir, f"source_{conversion_id}.wav")
            target_path = os.path.join(temp_dir, f"target_{conversion_id}.wav")
            output_dir = os.path.join(temp_dir, "output")
            
            with open(source_path, "wb") as f:
                content = await source_audio.read()
                f.write(content)
            
            with open(target_path, "wb") as f:
                content = await target_audio.read()
                f.write(content)
            
            os.makedirs(output_dir, exist_ok=True)
            
            # Path to the local inference script
            # This assumes the script is run from the project root
            script_path = os.path.abspath("../../seed-vc/inference.py")
            
            # Run the inference script on local machine
            cmd = [
                "python", script_path,
                "--source", source_path,
                "--target", target_path,
                "--output", output_dir,
                "--diffusion-steps", "15",
                "--length-adjust", "1.0",
                "--inference-cfg-rate", "0.7"
            ]
            
            # Execute the command
            result = subprocess.run(cmd, capture_output=True, text=True, cwd="../../seed-vc")
            
            if result.returncode != 0:
                raise HTTPException(status_code=500, detail=f"Voice conversion failed: {result.stderr}")
            
            # Find the output file
            output_files = [f for f in os.listdir(output_dir) if f.endswith('.wav')]
            if not output_files:
                raise HTTPException(status_code=500, detail="No output file generated")
            
            output_file = os.path.join(output_dir, output_files[0])
            
            # Return the converted audio file
            return FileResponse(
                output_file,
                media_type="audio/wav",
                filename=f"converted_{conversion_id}.wav",
                background=lambda: shutil.rmtree(temp_dir, ignore_errors=True)
            )
            
        except Exception as e:
            # Clean up temp directory on error
            if 'temp_dir' in locals():
                shutil.rmtree(temp_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=str(e))

    # Serve static files, for the frontend
    web_app.mount("/", StaticFiles(directory="/assets", html=True))
    return web_app
