#!/usr/bin/env python
"""
Pre-download only the HuggingFace models actually needed by the default
voice conversion config (XLSR tiny) and metrics analysis.
"""

import os
import sys
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

os.environ["HF_HUB_CACHE"] = "./checkpoints/hf_cache"


def download_xlsr_model():
    """Speech tokenizer for the default XLSR config."""
    logger.info("Downloading XLSR model...")
    from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2Model

    Wav2Vec2Model.from_pretrained("facebook/wav2vec2-xls-r-300m")
    Wav2Vec2FeatureExtractor.from_pretrained("facebook/wav2vec2-xls-r-300m")
    logger.info("  Done: facebook/wav2vec2-xls-r-300m")


def download_whisper_model():
    """Whisper-small for metrics.py transcription."""
    logger.info("Downloading Whisper model...")
    from transformers import AutoFeatureExtractor, WhisperModel

    WhisperModel.from_pretrained("openai/whisper-small", torch_dtype="auto")
    AutoFeatureExtractor.from_pretrained("openai/whisper-small")
    logger.info("  Done: openai/whisper-small")


def download_sentence_model():
    """Semantic similarity model for metrics.py."""
    logger.info("Downloading sentence-transformers model...")
    from sentence_transformers import SentenceTransformer

    SentenceTransformer("all-mpnet-base-v2")
    logger.info("  Done: all-mpnet-base-v2")


def download_seed_vc_models():
    """Core seed-vc models for XLSR config: CAMPPlus + HiFiGAN vocoder."""
    logger.info("Downloading Seed-VC support models...")
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "seed-vc"))
    from hf_utils import load_custom_model_from_hf

    # CAMPPlus speaker embedding (used by all configs)
    load_custom_model_from_hf("funasr/campplus", "campplus_cn_common.bin", None)
    logger.info("  Done: funasr/campplus/campplus_cn_common.bin")

    # HiFiGAN vocoder (default for XLSR config)
    load_custom_model_from_hf("FunAudioLLM/CosyVoice-300M", "hift.pt", None)
    logger.info("  Done: FunAudioLLM/CosyVoice-300M/hift.pt")


if __name__ == "__main__":
    download_xlsr_model()
    download_whisper_model()
    download_sentence_model()
    download_seed_vc_models()
    logger.info("All models downloaded successfully")
