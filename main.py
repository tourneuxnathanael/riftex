#!/usr/bin/env python3
"""Génère une vidéo TikTok « story-time / fait réel » de A à Z.

Exemples :
    python main.py --topic "Le casse du siècle oublié"
    python main.py                        # sujet aléatoire choisi par Claude
    python main.py --music assets/music/dark.mp3 --rate +10%
    python main.py --mock                 # test hors-ligne : ni API ni réseau, FFmpeg seul
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
import unicodedata
from datetime import datetime
from pathlib import Path

from src import config
from src.assets import build_shots
from src.generator import ScriptError, generate_story, mock_story, word_count
from src.subtitles import align_to_script, mock_timings, transcribe, write_ass
from src.tts import synthesize, synthesize_silent
from src.video_engine import FFmpegError, check_ffmpeg, probe_duration, render

TAIL_SECONDS = 0.8  # courte respiration après la dernière phrase


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50] or "video"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Générateur de vidéos TikTok story-time (faits réels).")
    p.add_argument("--topic", "-t", help="Sujet de l'histoire (aléatoire si absent)")
    p.add_argument("--voice", default=config.TTS_VOICE, help=f"Voix edge-tts (défaut : {config.TTS_VOICE})")
    p.add_argument("--rate", default=config.TTS_RATE, help="Débit de la voix, ex. +10%% (défaut : %(default)s)")
    p.add_argument("--music", default=config.BACKGROUND_MUSIC or None, help="Musique de fond libre de droits")
    p.add_argument("--output", "-o", type=Path, default=config.OUTPUT_DIR, help="Dossier de sortie")
    p.add_argument("--keep-work", action="store_true", help="Conserver les segments intermédiaires")
    p.add_argument("--mock", action="store_true", help="Test hors-ligne (histoire fixe, voix muette, fonds générés)")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    t0 = time.time()
    log = lambda msg: print(f"[{time.time() - t0:6.1f}s] {msg}", flush=True)  # noqa: E731

    try:
        check_ffmpeg()

        # 1. Script
        log("1/5 Écriture du script…")
        story = mock_story(args.topic) if args.mock else generate_story(args.topic)
        n_words = word_count(story.spoken_text)
        log(f"    « {story.title} » ({n_words} mots)")
        if not 110 <= n_words <= 175:
            log(f"    ⚠ longueur inhabituelle ({n_words} mots) : la vidéo sera hors de la fourchette 45-60 s")

        job_dir = args.output / f"{datetime.now():%Y%m%d-%H%M%S}-{slugify(story.title)}"
        work_dir = job_dir / "work"
        work_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "script.json").write_text(story.model_dump_json(indent=2), encoding="utf-8")

        # 2. Voix off
        log(f"2/5 Voix off ({args.voice}, {args.rate})…")
        voice_path = job_dir / "voice.mp3"
        if args.mock:
            words = mock_timings(story.spoken_text)
            synthesize_silent(words[-1].end + 0.2, voice_path)
        else:
            synthesize(story.spoken_text, voice_path, args.voice, args.rate)
        voice_duration = probe_duration(voice_path)
        duration = voice_duration + TAIL_SECONDS
        log(f"    durée : {voice_duration:.1f} s")

        # 3. Timestamps mot à mot + sous-titres
        if not args.mock:
            log(f"3/5 Transcription faster-whisper ({config.WHISPER_MODEL})…")
            words = align_to_script(story.spoken_text, transcribe(voice_path, story.spoken_text))
        else:
            log("3/5 Sous-titres (timings simulés)…")
        (job_dir / "words.json").write_text(
            json.dumps([w.to_dict() for w in words], ensure_ascii=False, indent=1), encoding="utf-8"
        )
        ass_path = write_ass(words, job_dir / "subtitles.ass")

        # 4. Visuels
        log(f"4/5 Visuels Pexels : {', '.join(story.search_queries)}")
        shots = build_shots(story.search_queries, words, duration, work_dir, mock=args.mock, on_progress=log)

        # 5. Montage
        log(f"5/5 Montage de {len(shots)} plans…")
        video_path = render(
            shots, voice_path, ass_path, job_dir / "final.mp4", duration, work_dir,
            music_path=Path(args.music) if args.music else None, on_progress=log,
        )
        (job_dir / "caption.txt").write_text(story.caption, encoding="utf-8")
        if not args.keep_work:
            shutil.rmtree(work_dir, ignore_errors=True)

    except (ScriptError, FFmpegError, RuntimeError) as exc:
        print(f"\n✖ {exc}", file=sys.stderr)
        return 1

    print(f"\n✔ Vidéo prête en {time.time() - t0:.0f} s : {video_path}")
    print(f"  Durée   : {duration:.1f} s")
    print(f"  Légende : {story.caption}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
