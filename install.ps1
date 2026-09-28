# Installation des prérequis (Windows PowerShell) : FFmpeg, environnement Python, polices, .env
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> FFmpeg"
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    Write-Host "FFmpeg installé : fermez et rouvrez PowerShell, puis relancez ce script."
    exit 0
}
ffmpeg -version | Select-Object -First 1

Write-Host "==> Environnement Python (.venv)"
python -c "import sys; assert sys.version_info >= (3, 10), 'Python 3.10+ requis'"
python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip -q
.\.venv\Scripts\pip install -r requirements.txt -q

Write-Host "==> Polices (Montserrat, SIL Open Font License)"
New-Item -ItemType Directory -Force -Path assets\fonts | Out-Null
foreach ($f in @("Montserrat-Black.ttf", "Montserrat-ExtraBold.ttf")) {
    if (-not (Test-Path "assets\fonts\$f")) {
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/$f" -OutFile "assets\fonts\$f"
    }
}

if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "==> .env créé : ajoutez ANTHROPIC_API_KEY et PEXELS_API_KEY" }

Write-Host ""
Write-Host "Installation terminée."
Write-Host "  Test hors-ligne : .\.venv\Scripts\python main.py --mock"
Write-Host "  Vraie vidéo     : .\.venv\Scripts\python main.py --topic `"Le casse du siècle oublié`""
