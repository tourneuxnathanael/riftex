"""Assemblage final avec FFmpeg.

1. Chaque plan est normalisé en segment 1080x1920 @30 fps : entrée à `offset` dans le clip
   source (bouclé s'il est trop court), recadrage plein écran, étalonnage « cinéma » léger
   (désaturation, contraste, vignette) et zoom lent (Ken Burns) alterné avant/arrière.
   Les durées sont converties en nombre exact de frames à partir des temps cumulés :
   aucune dérive de synchronisation avec la voix.
2. Les segments, encodés à l'identique, sont concaténés sans ré-encodage.
3. Passe finale : incrustation des sous-titres .ass (libass), voix off + musique optionnelle,
   H.264 High / AAC, +faststart.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import ffmpeg  # ffmpeg-python

from . import config
from .assets import Shot

W, H, FPS = config.WIDTH, config.HEIGHT, config.FPS


class FFmpegError(RuntimeError):
    pass


def check_ffmpeg() -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise FFmpegError("FFmpeg introuvable : lancez install.sh (ou installez ffmpeg) puis réessayez.")


def run_ffmpeg(args: list[str], cwd: Path | None = None) -> None:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        cwd=cwd, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise FFmpegError(f"ffmpeg a échoué :\n{proc.stderr[-3000:]}")


def probe_duration(path: Path) -> float:
    return float(ffmpeg.probe(str(path))["format"]["duration"])


def _x264(crf: int) -> list[str]:
    return ["-c:v", "libx264", "-preset", config.X264_PRESET, "-crf", str(crf), "-pix_fmt", "yuv420p"]


def shot_filter(kind: str, frames: int, zoom_in: bool, zoom: float = 0.08, grade: bool = True) -> str:
    """Recadrage 9:16 + étalonnage + zoom lent. On sur-échantillonne avant `zoompan`, qui arrondit
    x/y à l'entier : une entrée plus grande donne un mouvement plus fluide."""
    up = 2.0 if kind == "image" else 1.25
    uw, uh = int(W * up) // 2 * 2, int(H * up) // 2 * 2
    n = max(1, frames - 1)
    z = f"1+{zoom}*on/{n}" if zoom_in else f"{1 + zoom}-{zoom}*on/{n}"
    chain = [
        f"scale={uw}:{uh}:force_original_aspect_ratio=increase:flags=lanczos",
        f"crop={uw}:{uh}",
        "setsar=1",
        f"fps={FPS}",
    ]
    if grade:
        chain.append("eq=saturation=0.82:contrast=1.06:brightness=-0.02")
    chain += [
        f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS}",
    ]
    if grade:
        chain.append("vignette=PI/5")
    chain.append("format=yuv420p")
    return ",".join(chain)


def frames_per_shot(durations: list[float]) -> list[int]:
    """Durées -> nombres de frames, sans accumuler d'erreur d'arrondi."""
    frames, t, prev = [], 0.0, 0
    for d in durations:
        t += d
        f = round(t * FPS)
        frames.append(max(1, f - prev))
        prev = max(f, prev + 1)
    return frames


def _render_shot(shot: Shot, frames: int, index: int, work_dir: Path) -> Path:
    out = work_dir / f"shot_{index:03d}.mp4"
    if shot.clip.kind == "video":
        inp = ["-stream_loop", "-1", "-ss", f"{shot.offset:.3f}", "-i", str(shot.clip.path)]
    else:
        inp = ["-loop", "1", "-framerate", str(FPS), "-i", str(shot.clip.path)]
    vf = shot_filter(shot.clip.kind, frames, zoom_in=index % 2 == 0)
    run_ffmpeg([*inp, "-vf", vf, "-frames:v", str(frames), "-an", *_x264(18),
                "-r", str(FPS), "-video_track_timescale", "15360", str(out)])
    return out


def render(
    shots: list[Shot],
    voice_path: Path,
    ass_path: Path,
    out_path: Path,
    duration: float,
    work_dir: Path,
    music_path: Path | None = None,
    music_volume: float | None = None,
    on_progress=print,
) -> Path:
    check_ffmpeg()
    work_dir.mkdir(parents=True, exist_ok=True)

    durations = [s.duration for s in shots]
    durations[-1] += max(0.0, duration - sum(durations))  # le dernier plan couvre la fin
    frames = frames_per_shot(durations)

    # 1. Segments normalisés (en parallèle : FFmpeg est majoritairement mono-thread sur zoompan)
    workers = max(1, min(4, (os.cpu_count() or 2) // 2))
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_render_shot, s, frames[i], i, work_dir) for i, s in enumerate(shots)]
        segments = []
        for f in futures:
            segments.append(f.result())
            done += 1
            on_progress(f"  plan {done}/{len(shots)} rendu")

    # 2. Concaténation sans ré-encodage
    (work_dir / "concat.txt").write_text("".join(f"file '{p.name}'\n" for p in segments), encoding="utf-8")
    run_ffmpeg(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "background.mp4"], cwd=work_dir)

    # 3. Passe finale. Les chemins utilisés DANS le filtergraph sont relatifs au dossier de
    #    travail : cela évite l'échappement des ':' et '\' (chemins Windows notamment).
    ass_rel = Path(os.path.relpath(ass_path, work_dir)).as_posix()
    fonts_rel = Path(os.path.relpath(config.FONTS_DIR, work_dir)).as_posix()
    filters = [f"[0:v]ass=filename={ass_rel}:fontsdir={fonts_rel}[v]"]
    inputs = ["-i", "background.mp4", "-i", str(voice_path.resolve())]
    fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
    if music_path:
        vol = config.MUSIC_VOLUME if music_volume is None else music_volume
        inputs += ["-stream_loop", "-1", "-i", str(Path(music_path).resolve())]
        fade = max(0.0, duration - 1.5)
        filters += [
            f"[1:a]{fmt}[vo]",
            f"[2:a]{fmt},volume={vol},afade=t=in:d=0.5,afade=t=out:st={fade:.2f}:d=1.5[bg]",
            # normalize=0 : la voix n'est pas atténuée par le mixage
            "[vo][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,apad[a]",
        ]
    else:
        filters.append(f"[1:a]{fmt},apad[a]")

    run_ffmpeg([
        *inputs,
        "-filter_complex", ";".join(filters),
        "-map", "[v]", "-map", "[a]",
        *_x264(20), "-profile:v", "high", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", f"{duration:.3f}", "-movflags", "+faststart",
        str(out_path.resolve()),
    ], cwd=work_dir)
    return out_path
