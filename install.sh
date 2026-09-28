#!/usr/bin/env bash
# Installation des prérequis (Linux / macOS) : FFmpeg, environnement Python, polices, .env
set -euo pipefail
cd "$(dirname "$0")"

echo "==> FFmpeg"
if ! command -v ffmpeg >/dev/null 2>&1; then
  if [[ "$(uname)" == "Darwin" ]]; then
    command -v brew >/dev/null || { echo "Installez Homebrew : https://brew.sh"; exit 1; }
    brew install ffmpeg
  elif command -v apt-get >/dev/null; then
    sudo apt-get update && sudo apt-get install -y ffmpeg
  elif command -v dnf >/dev/null; then
    sudo dnf install -y ffmpeg
  elif command -v pacman >/dev/null; then
    sudo pacman -S --noconfirm ffmpeg
  else
    echo "Installez FFmpeg manuellement : https://ffmpeg.org/download.html"; exit 1
  fi
fi
FILTERS=$(ffmpeg -hide_banner -filters 2>/dev/null)
for f in ass zoompan; do
  grep -q " $f " <<<"$FILTERS" \
    || { echo "⚠ Votre FFmpeg n'a pas le filtre '$f' (libass requis pour les sous-titres)."; exit 1; }
done
ffmpeg -version | head -1

echo "==> Environnement Python (.venv)"
PY=${PYTHON:-python3}
"$PY" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ requis"'
"$PY" -m venv .venv
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q

echo "==> Polices (Montserrat, SIL Open Font License)"
mkdir -p assets/fonts
for f in Montserrat-Black.ttf Montserrat-ExtraBold.ttf; do
  [[ -s "assets/fonts/$f" ]] || curl -fsSL -o "assets/fonts/$f" \
    "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/$f"
done

[[ -f .env ]] || { cp .env.example .env; echo "==> .env créé : ajoutez ANTHROPIC_API_KEY et PEXELS_API_KEY"; }

echo
echo "✔ Installation terminée."
echo "  Test hors-ligne : .venv/bin/python main.py --mock"
echo "  Vraie vidéo     : .venv/bin/python main.py --topic \"Le casse du siècle oublié\""
