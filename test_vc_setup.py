#!/usr/bin/env python
"""
Test script for the voice conversion setup
"""

import sys
import os
import requests
import time
from pathlib import Path

def test_local_server():
    """Test if the local server is running and responding"""
    try:
        response = requests.get('http://127.0.0.1:5001/health', timeout=5)
        if response.status_code == 200:
            print("✓ Local server is running and responding")
            return True
        else:
            print(f"✗ Local server responded with status code: {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print("✗ Cannot connect to local server at http://127.0.0.1:5001")
        print("  Make sure to start the server with: ./start_local_vc_server.sh")
        return False
    except Exception as e:
        print(f"✗ Error testing local server: {e}")
        return False

def test_dependencies():
    """Test if required dependencies are available"""
    print("Testing dependencies...")
    
    # Test local server dependencies
    try:
        import flask
        import flask_cors
        print("✓ Local server dependencies (Flask, Flask-CORS) available")
    except ImportError as e:
        print(f"✗ Missing local server dependency: {e}")
        return False
    
    # Test seed-vc dependencies
    seed_vc_path = Path("seed-vc")
    if not seed_vc_path.exists():
        print("✗ seed-vc directory not found")
        return False
    
    sys.path.insert(0, str(seed_vc_path))
    try:
        import torch
        import numpy as np
        import librosa
        print("✓ Seed-VC core dependencies available")
    except ImportError as e:
        print(f"✗ Missing Seed-VC dependency: {e}")
        print("  Install with: cd seed-vc && pip3 install -r requirements-mac.txt")
        return False
    
    return True

def test_inference_script():
    """Test if the inference script exists and can show help"""
    inference_script = Path("seed-vc/inference.py")
    if not inference_script.exists():
        print("✗ inference.py not found in seed-vc directory")
        return False
    
    print("✓ inference.py found")
    return True

def main():
    print("Voice Conversion Setup Test")
    print("=" * 40)
    
    # Test dependencies
    deps_ok = test_dependencies()
    
    # Test inference script
    script_ok = test_inference_script()
    
    # Test local server (if running)
    server_ok = test_local_server()
    
    print("\nTest Summary:")
    print("=" * 40)
    
    if deps_ok and script_ok:
        print("✓ Setup appears to be correct")
        if server_ok:
            print("✓ Local server is running - you can use voice conversion!")
        else:
            print("ℹ️  Start the local server with: ./start_local_vc_server.sh")
        print("\nNext steps:")
        print("1. Start the local server: ./start_local_vc_server.sh")
        print("2. Start your Modal app: modal serve src.app")
        print("3. Open the web interface and try voice conversion!")
    else:
        print("✗ Setup incomplete")
        if not deps_ok:
            print("  - Install missing dependencies")
        if not script_ok:
            print("  - Ensure seed-vc directory is properly set up")

if __name__ == "__main__":
    main()
