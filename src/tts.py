"""Voix off gratuite via edge-tts (voix neuronales Microsoft Edge, sans clé API)."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import edge_tts

from . import config


async def _synthesize(text: str, out_path: Path, voice: str, rate: str) -> None:
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(str(out_path))


def synthesize(text: str, out_path: Path, voice: str | None = None, rate: str | None = None) -> Path:
    """Génère un MP3 de la narration. Réessaie une fois en cas d'erreur réseau transitoire."""
    voice = voice or config.TTS_VOICE
    rate = rate or config.TTS_RATE
    for attempt in range(2):
        try:
            asyncio.run(_synthesize(text, out_path, voice, rate))
            if out_path.exists() and out_path.stat().st_size > 0:
                return out_path
        except Exception as exc:  # erreurs réseau / websocket edge-tts
            if attempt == 1:
                raise RuntimeError(f"edge-tts a échoué : {exc}") from exc
    raise RuntimeError("edge-tts n'a produit aucun audio.")


def synthesize_silent(duration: float, out_path: Path) -> Path:
    """Audio silencieux pour le mode --mock (aucun accès réseau)."""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
         "-t", f"{duration:.3f}", "-c:a", "libmp3lame", "-b:a", "64k", str(out_path)],
        check=True,
    )
    return out_path
