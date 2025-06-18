#!/usr/bin/env python
"""
Local Voice Conversion Server
Runs the Seed-VC inference.py script locally and provides API endpoints for the frontend.
"""

import os
import sys
import subprocess
import tempfile
import uuid
import shutil
import logging
from pathlib import Path

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Configuration
UPLOAD_FOLDER = tempfile.gettempdir()
ALLOWED_EXTENSIONS = {'wav', 'mp3', 'flac', 'm4a', 'ogg'}

# Path to the seed-vc directory
SEED_VC_DIR = Path(__file__).parent / "seed-vc"
INFERENCE_SCRIPT = SEED_VC_DIR / "inference.py"

def allowed_file(filename):
    """Check if file has allowed extension"""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({"status": "healthy", "service": "voice-conversion"})

@app.route('/api/voice-conversion', methods=['POST'])
def voice_conversion():
    """
    Voice conversion endpoint
    Expects two audio files: source_audio and target_audio
    Returns the converted audio file
    """
    try:
        # Check if the post request has the file parts
        if 'source_audio' not in request.files or 'target_audio' not in request.files:
            return jsonify({"error": "Missing source_audio or target_audio files"}), 400
        
        source_file = request.files['source_audio']
        target_file = request.files['target_audio']
        
        # Check if files are selected
        if source_file.filename == '' or target_file.filename == '':
            return jsonify({"error": "No files selected"}), 400
        
        # Check file extensions
        if not (allowed_file(source_file.filename) and allowed_file(target_file.filename)):
            return jsonify({"error": "Invalid file format. Supported: wav, mp3, flac, m4a, ogg"}), 400
        
        # Create temporary directory for this conversion
        temp_dir = tempfile.mkdtemp()
        conversion_id = str(uuid.uuid4())
        
        try:
            # Save uploaded files
            source_filename = secure_filename(f"source_{conversion_id}.wav")
            target_filename = secure_filename(f"target_{conversion_id}.wav")
            
            source_path = os.path.join(temp_dir, source_filename)
            target_path = os.path.join(temp_dir, target_filename)
            output_dir = os.path.join(temp_dir, "output")
            
            source_file.save(source_path)
            target_file.save(target_path)
            os.makedirs(output_dir, exist_ok=True)
            
            logger.info(f"Processing voice conversion with ID: {conversion_id}")
            logger.info(f"Source: {source_path}")
            logger.info(f"Target: {target_path}")
            logger.info(f"Output dir: {output_dir}")
            
            # Get optional parameters from request
            diffusion_steps = 15 # int(request.form.get('diffusion_steps', 10))
            length_adjust = float(request.form.get('length_adjust', 1.0))
            inference_cfg_rate = float(request.form.get('inference_cfg_rate', 0.7))
            
            # Build command to run inference.py
            cmd = [
                "python",  # Use python command
                str(INFERENCE_SCRIPT),
                "--source", source_path,
                "--target", target_path,
                "--output", output_dir,
                "--diffusion-steps", str(diffusion_steps),
                "--length-adjust", str(length_adjust),
                "--inference-cfg-rate", str(inference_cfg_rate),
                "--fp16", "True",
                "--checkpoint", "/Users/shreeharshabs/Library/CloudStorage/OneDrive-KTH/First-Year/IS_2025_Demo/VC_backup/DiT_uvit_tat_xlsr_ema.pth",
                "--config", "configs/presets/config_dit_mel_seed_uvit_xlsr_tiny.yml",
            ]
            
            logger.info(f"Running command: {' '.join(cmd)}")
            
            # Execute the inference script
            result = subprocess.run(
                cmd, 
                capture_output=True, 
                text=True, 
                cwd=str(SEED_VC_DIR),
                timeout=300  # 5 minute timeout
            )
            
            logger.info(f"Inference script stdout: {result.stdout}")
            if result.stderr:
                logger.warning(f"Inference script stderr: {result.stderr}")
            
            if result.returncode != 0:
                # Provide more specific error messages
                if "ModuleNotFoundError" in result.stderr:
                    error_msg = "Missing dependencies. Please install Seed-VC requirements first:\ncd seed-vc && pip3 install -r requirements-mac.txt"
                elif "CUDA" in result.stderr and "not available" in result.stderr:
                    error_msg = "CUDA not available. The model will run on CPU (slower). Consider installing CPU-only PyTorch."
                elif "FileNotFoundError" in result.stderr:
                    error_msg = "Audio file processing error. Please ensure audio files are valid."
                else:
                    error_msg = f"Voice conversion failed: {result.stderr}"
                    
                logger.error(error_msg)
                return jsonify({"error": error_msg}), 500
            
            # Find the output file
            output_files = [f for f in os.listdir(output_dir) if f.endswith('.wav')]
            if not output_files:
                error_msg = "No output file generated"
                logger.error(error_msg)
                return jsonify({"error": error_msg}), 500
            
            output_file_path = os.path.join(output_dir, output_files[0])
            logger.info(f"Generated output file: {output_file_path}")
            
            # Return the converted audio file
            def cleanup():
                try:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    logger.info(f"Cleaned up temporary directory: {temp_dir}")
                except Exception as e:
                    logger.warning(f"Failed to cleanup temp directory: {e}")
            
            return send_file(
                output_file_path,
                as_attachment=True,
                download_name=f"converted_{conversion_id}.wav",
                mimetype="audio/wav"
            )
            
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Voice conversion timed out"}), 408
        except Exception as e:
            logger.error(f"Error during voice conversion: {str(e)}")
            return jsonify({"error": f"Internal error: {str(e)}"}), 500
        finally:
            # Schedule cleanup (Flask will handle this after response is sent)
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except:
                pass
                
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500

@app.route('/api/conversion-status', methods=['GET'])
def conversion_status():
    """Get status of conversion capabilities"""
    return jsonify({
        "inference_script_exists": INFERENCE_SCRIPT.exists(),
        "seed_vc_dir": str(SEED_VC_DIR),
        "supported_formats": list(ALLOWED_EXTENSIONS)
    })

if __name__ == '__main__':
    # Check if inference script exists
    if not INFERENCE_SCRIPT.exists():
        logger.error(f"Inference script not found at: {INFERENCE_SCRIPT}")
        logger.error("Please ensure the seed-vc directory is in the correct location")
        sys.exit(1)
    
    logger.info(f"Found inference script at: {INFERENCE_SCRIPT}")
    logger.info("Starting local voice conversion server...")
    
    # Run the Flask app
    app.run(
        host='127.0.0.1',
        port=5001,  # Different port to avoid conflicts
        debug=True,
        threaded=True
    )
