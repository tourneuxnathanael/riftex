"""Configuration centrale, lue depuis l'environnement (.env)."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, ""))
    except ValueError:
        return default


ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL") or "claude-opus-5"
# Modèle utilisé si le modèle principal refuse la requête (stop_reason == "refusal").
ANTHROPIC_FALLBACK_MODEL = os.getenv("ANTHROPIC_FALLBACK_MODEL") or "claude-opus-4-8"

PEXELS_API_KEY = os.getenv("PEXELS_API_KEY", "")

TTS_VOICE = os.getenv("TTS_VOICE") or "fr-FR-HenriNeural"
TTS_RATE = os.getenv("TTS_RATE") or "+8%"

WHISPER_MODEL = os.getenv("WHISPER_MODEL") or "small"
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE") or "auto"

BACKGROUND_MUSIC = os.getenv("BACKGROUND_MUSIC", "")
MUSIC_VOLUME = _float("MUSIC_VOLUME", 0.15)
X264_PRESET = os.getenv("X264_PRESET") or "veryfast"

WIDTH, HEIGHT, FPS = 1080, 1920, 30

FONTS_DIR = ROOT / "assets" / "fonts"
OUTPUT_DIR = ROOT / "output"
CACHE_DIR = ROOT / ".cache" / "pexels"
