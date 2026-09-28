# Riftex — story-times TikTok sur des faits réels

Génère de A à Z une vidéo verticale 1080x1920 @30 fps : **histoire vraie écrite par Claude → voix off edge-tts → timestamps faster-whisper → sous-titres animés mot à mot → plans d'ambiance Pexels → montage FFmpeg**.

Seul coût : les tokens de l'API Anthropic (quelques centimes par vidéo). Tout le reste est gratuit : voix edge-tts, API Pexels gratuite, Whisper en local, FFmpeg.

## Installation

Prérequis : Python 3.10+ et une connexion internet (voix edge-tts, Pexels, 1er téléchargement du modèle Whisper).

```bash
./install.sh          # Linux / macOS : FFmpeg, .venv, dépendances, polices Montserrat, .env
# Windows : powershell -ExecutionPolicy Bypass -File install.ps1
```

Puis renseignez `.env` :
- `ANTHROPIC_API_KEY` : https://console.anthropic.com
- `PEXELS_API_KEY` : gratuite sur https://www.pexels.com/api/ (200 requêtes/heure)

## Utilisation

```bash
source .venv/bin/activate
python main.py --mock                                   # test hors-ligne (aucune API, FFmpeg seul)
python main.py --topic "Le casse du siècle oublié"      # sujet imposé
python main.py                                          # sujet aléatoire choisi par Claude
python main.py --rate +10% --music assets/music/dark.mp3
```

Résultat dans `output/<date>-<titre>/` : `final.mp4`, `caption.txt` (titre + hashtags à coller sur TikTok), `script.json`, `words.json`, `subtitles.ass`, `voice.mp3`.

## Architecture

```
main.py               CLI : orchestre les 5 étapes
src/config.py         variables d'environnement et constantes (1080x1920, 30 fps)
src/generator.py      Claude → JSON validé { title, hook, narration, search_queries, tags }
src/tts.py            edge-tts (fr-FR-HenriNeural, +8 %)
src/subtitles.py      faster-whisper (timestamps mot à mot) + réalignement sur le script + .ass animé
src/assets.py         recherche/téléchargement Pexels (cache .cache/pexels) + découpage en plans
src/video_engine.py   FFmpeg : plans Ken Burns étalonnés, concaténation, sous-titres, mixage audio
tests/                tests unitaires : python -m unittest discover -s tests
```

## Choix techniques

- **Script** : sortie structurée (`messages.parse` + Pydantic), donc JSON toujours valide. Le prompt impose des faits vérifiables, 130-150 mots, un présent de narration et un twist final. Sans `--topic`, un thème est tiré au hasard pour varier les histoires.
- **Sous-titres exacts** : Whisper peut mal orthographier les noms propres (« Dillinjer »). Chaque mot transcrit est réaligné sur le script d'origine (difflib) : on garde le timing de Whisper et l'orthographe du script.
- **Style** : Montserrat Black en majuscules, blanc avec contour noir épais, mot actif en jaune `#FFE600` avec un léger « pop », blocs de 1 à 3 mots, placés à ~60 % de la hauteur (au-dessus de l'interface TikTok). Paramétrable via `SubtitleStyle`.
- **Rythme visuel** : une coupe toutes les ~3,5 s, calée sur le début d'un mot. Chaque plan utilise la requête correspondant à sa place dans l'histoire, avec un point d'entrée aléatoire dans le clip. Les clips déjà utilisés ne sont pas réutilisés et sont mis en cache.
- **Ambiance** : légère désaturation, contraste et vignette sur chaque plan, zoom lent alterné avant/arrière.
- **Synchro** : durées converties en nombre exact de frames à partir des temps cumulés, sans dérive audio/vidéo.

## Réglages utiles (.env)

| Variable | Défaut | Rôle |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-opus-5` | `claude-sonnet-5` pour réduire le coût par script |
| `TTS_RATE` | `+8%` | débit de la voix |
| `WHISPER_MODEL` | `small` | `base` = plus rapide, `medium` = plus précis |
| `BACKGROUND_MUSIC` / `MUSIC_VOLUME` | — / `0.15` | musique libre de droits mixée sous la voix |
| `X264_PRESET` | `veryfast` | `ultrafast` pour itérer vite, `medium` pour la version finale |
