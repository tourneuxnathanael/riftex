# Riftex — générateur de vidéos verticales (TikTok / Shorts)

Pipeline automatisé : **sujet → script (Claude) → voix off (ElevenLabs) → visuels (Pexels / OpenAI Images) → sous-titres animés mot à mot (ASS) → assemblage FFmpeg 1080x1920 @30 fps → publication TikTok**.

## Stack retenue

| Couche | Choix | Pourquoi |
|---|---|---|
| Langage | Node.js 20+ / TypeScript (ESM, exécuté via `tsx`) | Un seul langage pour le backend et le futur front Next.js, SDK officiels disponibles |
| LLM | `@anthropic-ai/sdk` + sorties structurées Zod | Le JSON du script est validé par schéma, pas de parsing fragile |
| TTS | ElevenLabs `/with-timestamps` | Audio + alignement caractère → timings mot à mot sans passer par Whisper |
| Visuels | Pexels Videos (portrait) → repli Pexels Photos ; option OpenAI Images | Libres de droits, déjà au format vertical |
| Rendu | FFmpeg local (`child_process`) + libass | Le plus robuste et le plus rapide ; aucun navigateur headless requis |
| Sous-titres | Fichier `.ass` généré, incrusté par le filtre `ass` | Styles riches (contour, pop, surlignage) rendus nativement par libass |
| Jobs | File en mémoire (`src/jobs/queue.ts`) | Zéro infra pour le MVP ; interface compatible avec un passage à BullMQ/Redis |
| Front (étape suivante) | Next.js + Tailwind dans `web/` | Consommera `renderQueue` via une API Fastify |

## Arborescence

```
riftex/
├── .env.example              # toutes les variables requises
├── assets/
│   ├── fonts/                # Montserrat (npm run fonts)
│   └── music/                # musiques libres de droits (optionnel)
├── scripts/fetch-fonts.ts
├── src/
│   ├── config.ts             # lecture de l'environnement
│   ├── types.ts
│   ├── services/
│   │   ├── llm.ts            # script JSON { hook, scenes[], call_to_action, hashtags }
│   │   ├── tts.ts            # ElevenLabs + conversion alignement -> mots
│   │   ├── assets.ts         # Pexels / OpenAI Images / mock
│   │   ├── subtitles.ts      # ⭐ générateur ASS style TikTok (mot actif surligné)
│   │   ├── video-engine.ts   # ⭐ assemblage FFmpeg (Ken Burns, concat, mix, burn-in)
│   │   └── tiktok.ts         # OAuth 2.0 + Content Posting API (brouillon / direct)
│   ├── pipeline/generate.ts  # orchestration des étapes, artefacts par job
│   ├── jobs/queue.ts         # file de rendu asynchrone
│   └── cli/
│       ├── generate.ts       # npm run generate
│       └── tiktok-auth.ts    # npm run tiktok:auth
└── output/<job-id>/          # script.json, narration.json, timeline.json, subtitles.ass, voice.mp3, final.mp4, caption.txt
```

## Installation

Prérequis : Node.js ≥ 20 et FFmpeg ≥ 5 compilé avec `libx264` et `libass` (c'est le cas des paquets `apt install ffmpeg` / `brew install ffmpeg`).

```bash
npm install
npm run fonts          # télécharge Montserrat ExtraBold/Black dans assets/fonts
cp .env.example .env   # puis renseigner les clés
```

## Utilisation (CLI)

```bash
# Test hors-ligne (aucune clé API, seul FFmpeg est utilisé)
npm run generate -- --topic "Histoire mystérieuse" --mock

# Pipeline réel
npm run generate -- --topic "Histoire mystérieuse"
npm run generate -- --topic "Le triangle des Bermudes" --duration 40 --music assets/music/dark.mp3 --highlight "#39FF14"

# Publication TikTok
npm run tiktok:auth                                     # une seule fois
npm run generate -- --topic "..." --publish draft       # envoie dans les brouillons TikTok
npm run generate -- --topic "..." --publish direct      # publie (SELF_ONLY tant que l'app n'est pas auditée)
```

Tests unitaires (sous-titres, alignement, timings) : `npm test`.

## Détails du rendu

1. **Découpage temporel** : la narration complète (hook + scènes + CTA) est synthétisée en un seul appel ; les timings mot à mot servent à placer les coupes de plans exactement au début de chaque scène. Une scène de plus de 6 s est découpée en plusieurs visuels pour garder du rythme.
2. **Plans** : chaque visuel est recadré en « cover » 9:16, sur-échantillonné puis animé via `zoompan` (zoom avant/arrière alterné de 10 %). Les durées sont converties en nombre exact de frames à partir des temps cumulés : aucune dérive de synchronisation audio/vidéo.
3. **Concaténation** sans ré-encodage (segments encodés à l'identique).
4. **Passe finale** : sous-titres ASS brûlés via libass, voix + musique en boucle à 18 % (fondu d'entrée/sortie, `amix normalize=0` pour ne pas atténuer la voix), H.264 High / AAC 192k, `+faststart`.

Sous-titres : blocs de 1 à 3 mots (coupure sur ponctuation, pause > 400 ms ou largeur), deux lignes équilibrées au besoin, police Montserrat ExtraBold en majuscules, contour noir épais, mot actif en jaune (`#FFE600`) avec un « pop » de 125 % → 110 % en 90 ms. Tout est paramétrable via `SubtitleStyle` dans `src/services/subtitles.ts`.

## Notes TikTok

- Créez une app sur developers.tiktok.com, activez **Login Kit** et **Content Posting API**, scopes `video.upload` et `video.publish`, et déclarez la redirect URI de `.env`.
- Sans audit TikTok, les publications directes sont forcées en `SELF_ONLY` (privées). Le mode `draft` envoie la vidéo dans la boîte de réception de l'app TikTok, où l'utilisateur finalise la publication.
- Si TikTok refuse `http://localhost` comme redirect URI, utilisez un tunnel HTTPS puis `npm run tiktok:auth -- --code <code>`.
