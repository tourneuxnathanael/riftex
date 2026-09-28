"""Visuels : recherche Pexels (vidéos verticales), téléchargement avec cache, et découpage en plans.

Le découpage suit le rythme de la narration : un plan toutes les ~3,5 s, coupé sur le début d'un
mot, et chaque plan utilise la requête correspondant à sa position dans l'histoire (les
search_queries sont ordonnées selon le déroulé du récit).
"""
from __future__ import annotations

import random
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import requests

from . import config
from .subtitles import Word

PEXELS_VIDEOS_URL = "https://api.pexels.com/videos/search"


@dataclass
class Clip:
    path: Path
    duration: float
    kind: str  # "video" | "image"
    source: str


@dataclass
class Shot:
    clip: Clip
    start: float  # position dans la vidéo finale (s)
    duration: float
    offset: float = 0.0  # point d'entrée dans le clip source (s)
    query: str = ""


@dataclass
class _PexelsPool:
    used_ids: set[int] = field(default_factory=set)


# ------------------------------------------------------------------ Pexels


def _pick_file(video: dict) -> dict | None:
    """Fichier MP4 portrait le plus proche de 1080x1920, en évitant la 4K inutilement lourde."""
    files = [
        f for f in video.get("video_files", [])
        if f.get("file_type") == "video/mp4" and f.get("width") and f.get("height")
        and f["height"] > f["width"] and f["height"] <= 2160
    ]
    return min(files, key=lambda f: abs(f["height"] - 1920), default=None)


def _search(query: str, per_page: int = 15) -> list[dict]:
    resp = requests.get(
        PEXELS_VIDEOS_URL,
        headers={"Authorization": config.PEXELS_API_KEY},
        params={"query": query, "orientation": "portrait", "size": "medium", "per_page": per_page},
        timeout=20,
    )
    if resp.status_code == 429:
        raise RuntimeError("Quota Pexels atteint (200 requêtes/heure). Réessayez plus tard.")
    resp.raise_for_status()
    return resp.json().get("videos", [])


def _download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:  # cache : un clip n'est téléchargé qu'une fois
        return dest
    tmp = dest.with_suffix(".part")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
    tmp.rename(dest)
    return dest


def fetch_clips(query: str, count: int, pool: _PexelsPool, min_duration: float = 4.0) -> list[Clip]:
    """Télécharge jusqu'à `count` clips distincts pour une requête (élargit la requête si besoin)."""
    if not config.PEXELS_API_KEY:
        raise RuntimeError("PEXELS_API_KEY manquant : renseignez-le dans .env")
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    clips: list[Clip] = []
    words = query.split()
    for q in dict.fromkeys([query, " ".join(words[:2]), words[-1]]):  # requêtes uniques, dans l'ordre
        for video in _search(q):
            if len(clips) >= count:
                return clips
            if video["id"] in pool.used_ids or video.get("duration", 0) < min_duration:
                continue
            f = _pick_file(video)
            if not f:
                continue
            pool.used_ids.add(video["id"])
            path = _download(f["link"], config.CACHE_DIR / f"{video['id']}_{f['height']}.mp4")
            clips.append(Clip(path, float(video["duration"]), "video", f"pexels:{video['id']}"))
        if clips:
            break
    return clips


# ------------------------------------------------------------------ Mock (hors-ligne)

_PALETTE = ["0x0f172a", "0x3f1d0b", "0x1e293b", "0x2d1b4e", "0x111827", "0x3b0d0d"]


def _mock_clip(index: int, work_dir: Path) -> Clip:
    dest = work_dir / f"mock_{index:02d}.png"
    c1, c2 = _PALETTE[index % len(_PALETTE)], _PALETTE[(index + 2) % len(_PALETTE)]
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", f"gradients=s=1080x1920:c0={c1}:c1={c2}:x0=0:y0=0:x1=1080:y1=1920:d=1",
         "-vf", "drawgrid=w=120:h=120:t=2:c=white@0.12", "-frames:v", "1", str(dest)],
        check=True,
    )
    return Clip(dest, 0.0, "image", "mock")


# ------------------------------------------------------------------ Découpage en plans


def plan_cuts(words: list[Word], total: float, target: float = 3.5, min_len: float = 2.0) -> list[tuple[float, float]]:
    """Intervalles des plans : une coupe toutes les ~`target` s, calée sur le début d'un mot."""
    starts = [w.start for w in words]
    cuts = [0.0]
    t = target
    while t < total - min_len:
        candidates = [s for s in starts if cuts[-1] + min_len <= s <= total - min_len]
        if not candidates:
            break
        cut = min(candidates, key=lambda s: abs(s - t))
        cuts.append(cut)
        t = cut + target
    cuts.append(total)
    return list(zip(cuts[:-1], cuts[1:]))


def build_shots(
    queries: list[str],
    words: list[Word],
    total: float,
    work_dir: Path,
    mock: bool = False,
    on_progress=print,
) -> list[Shot]:
    cuts = plan_cuts(words, total)
    # Répartition des plans par requête selon leur position dans l'histoire.
    per_query: dict[int, list[tuple[float, float]]] = {}
    for start, end in cuts:
        idx = min(len(queries) - 1, int((start + end) / 2 / total * len(queries)))
        per_query.setdefault(idx, []).append((start, end))

    pool = _PexelsPool()
    shots: list[Shot] = []
    for idx, intervals in sorted(per_query.items()):
        query = queries[idx]
        if mock:
            clips = [_mock_clip(len(shots) + k, work_dir) for k in range(len(intervals))]
        else:
            clips = fetch_clips(query, len(intervals), pool)
            if not clips:  # requête sans résultat : on emprunte la requête voisine
                fallback = queries[(idx + 1) % len(queries)]
                clips = fetch_clips(fallback, len(intervals), pool)
            if not clips:
                raise RuntimeError(f"Aucune vidéo Pexels pour « {query} ».")
        on_progress(f"  « {query} » : {len(clips)} clip(s) pour {len(intervals)} plan(s)")

        for k, (start, end) in enumerate(intervals):
            clip = clips[k % len(clips)]
            length = end - start
            # Point d'entrée aléatoire (hors 1re demi-seconde, souvent un fondu) si le clip est assez long.
            offset = 0.0
            if clip.kind == "video" and clip.duration > length + 1.0:
                offset = random.uniform(0.5, clip.duration - length - 0.3)
            shots.append(Shot(clip, start, length, offset, query))
    shots.sort(key=lambda s: s.start)
    return shots
