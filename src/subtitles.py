"""Sous-titres mot à mot : transcription faster-whisper + génération d'un fichier .ass animé.

1. faster-whisper transcrit la voix off avec des timestamps par mot.
2. Les mots transcrits sont réalignés sur le script d'origine (difflib) : on garde les timings
   de Whisper mais l'orthographe exacte du script (noms propres, chiffres, ponctuation).
3. Les mots sont groupés en blocs de 1 à 3 ; pour chaque mot prononcé, un événement ASS affiche
   le bloc avec le mot actif surligné en jaune et un léger « pop ». Les événements d'un bloc
   sont contigus, donc aucun clignotement.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path

from . import config


@dataclass
class Word:
    text: str
    start: float
    end: float

    def to_dict(self) -> dict:
        return asdict(self)


# ------------------------------------------------------------------ Transcription


def transcribe(audio_path: Path, script_text: str | None = None, language: str = "fr") -> list[Word]:
    """Timestamps mot à mot via faster-whisper (modèle téléchargé une seule fois, puis local)."""
    from faster_whisper import WhisperModel  # import tardif : chargement lourd

    model = WhisperModel(config.WHISPER_MODEL, device=config.WHISPER_DEVICE, compute_type="auto")
    segments, _info = model.transcribe(
        str(audio_path),
        language=language,
        word_timestamps=True,
        beam_size=5,
        vad_filter=False,
        condition_on_previous_text=False,
        # Le script oriente la transcription (orthographe des noms propres).
        initial_prompt=script_text[:800] if script_text else None,
    )
    words = [
        Word(w.word.strip(), float(w.start), float(w.end))
        for seg in segments
        for w in (seg.words or [])
        if w.word.strip()
    ]
    if not words:
        raise RuntimeError("faster-whisper n'a détecté aucun mot dans la voix off.")
    return words


def _norm(token: str) -> str:
    token = unicodedata.normalize("NFD", token.lower())
    token = "".join(c for c in token if unicodedata.category(c) != "Mn")
    return re.sub(r"[^\w]", "", token)


def _spread(tokens: list[str], start: float, end: float) -> list[Word]:
    """Répartit des mots sur un intervalle, proportionnellement à leur longueur."""
    if not tokens:
        return []
    end = max(end, start + 0.08 * len(tokens))
    weights = [max(1, len(_norm(t))) for t in tokens]
    total = sum(weights)
    out, t = [], start
    for tok, w in zip(tokens, weights):
        d = (end - start) * w / total
        out.append(Word(tok, t, t + d))
        t += d
    return out


def align_to_script(script_text: str, whisper_words: list[Word]) -> list[Word]:
    """Associe chaque mot du script à un timing Whisper (corrige les fautes de transcription)."""
    script_tokens = script_text.split()
    s_norm = [_norm(t) for t in script_tokens]
    w_norm = [_norm(w.text) for w in whisper_words]
    aligned: list[Word] = []

    for op, i1, i2, j1, j2 in SequenceMatcher(None, s_norm, w_norm, autojunk=False).get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                w = whisper_words[j1 + k]
                aligned.append(Word(script_tokens[i1 + k], w.start, w.end))
        elif op == "replace":
            aligned += _spread(script_tokens[i1:i2], whisper_words[j1].start, whisper_words[j2 - 1].end)
        elif op == "delete":  # mots du script absents de la transcription
            prev_end = aligned[-1].end if aligned else 0.0
            next_start = whisper_words[j1].start if j1 < len(whisper_words) else prev_end + 0.3 * (i2 - i1)
            aligned += _spread(script_tokens[i1:i2], prev_end, max(next_start, prev_end))
        # "insert" : mots entendus par Whisper mais absents du script -> ignorés

    # Garantit des timings croissants et non nuls.
    for k, w in enumerate(aligned):
        if k and w.start < aligned[k - 1].start:
            w.start = aligned[k - 1].start
        w.end = max(w.end, w.start + 0.05)
    return aligned


def mock_timings(text: str) -> list[Word]:
    """Timings synthétiques réalistes (~2,7 mots/s) pour le mode --mock."""
    words, t = [], 0.15
    for tok in text.split():
        d = min(0.75, 0.14 + 0.055 * len(tok))
        words.append(Word(tok, t, t + d))
        t += d + (0.35 if re.search(r"[.!?]$", tok) else 0.15 if re.search(r"[,;:]$", tok) else 0.04)
    return words


# ------------------------------------------------------------------ Génération ASS


@dataclass
class SubtitleStyle:
    font_name: str = "Montserrat Black"
    font_size: int = 90
    text_color: str = "#FFFFFF"
    highlight_color: str = "#FFE600"
    outline_color: str = "#000000"
    outline: int = 7
    shadow: int = 2
    position_y: int = 1150  # ~60 % de la hauteur : au-dessus de l'UI TikTok
    max_words: int = 3
    max_chars_per_line: int = 14
    uppercase: bool = True
    strip_punctuation: bool = True
    pop_from: int = 125
    pop_to: int = 110
    pop_ms: int = 90


STRONG_BREAK = re.compile(r"[.!?…][\"»”)]*$")
SOFT_BREAK = re.compile(r"[,;:—–][\"»”)]*$")
PAUSE_BREAK = 0.4  # silence (s) qui force un nouveau bloc
TAIL_HOLD = 0.25  # maintien (s) du bloc après son dernier mot


def hex_to_ass(hex_color: str, alpha: int = 0) -> str:
    """#RRGGBB -> &HAABBGGRR (ASS stocke les couleurs en BGR)."""
    m = re.fullmatch(r"#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})", hex_color)
    if not m:
        raise ValueError(f"Couleur invalide : {hex_color}")
    r, g, b = m.groups()
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_time(seconds: float) -> str:
    cs = max(0, round(seconds * 100))
    return f"{cs // 360000}:{cs % 360000 // 6000:02d}:{cs % 6000 // 100:02d}.{cs % 100:02d}"


def _label(text: str, style: SubtitleStyle) -> str:
    text = re.sub(r"[{}]", "", text).replace("\\", "/").strip()
    if style.strip_punctuation:
        text = re.sub(r"[.,;:…]+$", "", text)
    return text.upper() if style.uppercase else text


def group_words(words: list[Word], style: SubtitleStyle) -> list[list[Word]]:
    chunks: list[list[Word]] = []
    current: list[Word] = []
    for i, w in enumerate(words):
        candidate = " ".join(_label(x.text, style) for x in [*current, w])
        if current and (len(current) >= style.max_words or len(candidate) > style.max_chars_per_line * 2):
            chunks.append(current)
            current = []
        current.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        pause = nxt.start - w.end if nxt else 0
        if STRONG_BREAK.search(w.text) or SOFT_BREAK.search(w.text) or pause > PAUSE_BREAK:
            chunks.append(current)
            current = []
    if current:
        chunks.append(current)
    return [c for c in chunks if any(_label(w.text, style) for w in c)]


def _line_break_index(labels: list[str], max_chars: int) -> int:
    """Index du mot qui commence la 2e ligne (-1 si une seule ligne suffit)."""
    if len(" ".join(labels)) <= max_chars or len(labels) < 2:
        return -1
    return min(
        range(1, len(labels)),
        key=lambda i: abs(len(" ".join(labels[:i])) - len(" ".join(labels[i:]))),
    )


def build_ass(words: list[Word], style: SubtitleStyle | None = None) -> str:
    style = style or SubtitleStyle()
    primary = hex_to_ass(style.text_color)
    highlight = hex_to_ass(style.highlight_color)
    outline = hex_to_ass(style.outline_color)
    back = hex_to_ass("#000000", 0x80)
    x = config.WIDTH // 2

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {config.WIDTH}",
        f"PlayResY: {config.HEIGHT}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Word,{style.font_name},{style.font_size},{primary},{highlight},{outline},{back},"
        f"-1,0,0,0,100,100,1,0,1,{style.outline},{style.shadow},5,40,40,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    chunks = group_words(words, style)
    for ci, chunk in enumerate(chunks):
        labels = [_label(w.text, style) for w in chunk]
        next_start = chunks[ci + 1][0].start if ci + 1 < len(chunks) else float("inf")
        chunk_end = min(chunk[-1].end + TAIL_HOLD, next_start)
        break_at = _line_break_index(labels, style.max_chars_per_line)
        longest = max(len(label) for label in labels)
        size = style.font_size
        if longest > style.max_chars_per_line:  # mot isolé très long : on réduit la taille
            size = style.font_size * style.max_chars_per_line // longest
        prefix = f"{{\\an5\\pos({x},{style.position_y})" + (f"\\fs{size}" if size != style.font_size else "") + "}"

        for wi, w in enumerate(chunk):
            end = chunk[wi + 1].start if wi + 1 < len(chunk) else chunk_end
            if end - w.start < 0.01:
                continue
            parts = []
            for li, label in enumerate(labels):
                if li == wi:
                    label = (
                        f"{{\\c{highlight}\\fscx{style.pop_from}\\fscy{style.pop_from}"
                        f"\\t(0,{style.pop_ms},\\fscx{style.pop_to}\\fscy{style.pop_to})}}"
                        f"{label}{{\\c{primary}\\fscx100\\fscy100}}"
                    )
                parts.append(("\\N" if li == break_at else "") + label)
            body = " ".join(parts).replace(" \\N", "\\N")
            lines.append(f"Dialogue: 0,{ass_time(w.start)},{ass_time(end)},Word,,0,0,0,,{prefix}{body}")

    return "\n".join(lines) + "\n"


def write_ass(words: list[Word], out_path: Path, style: SubtitleStyle | None = None) -> Path:
    out_path.write_text(build_ass(words, style), encoding="utf-8")
    return out_path
