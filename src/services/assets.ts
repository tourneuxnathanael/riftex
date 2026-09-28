/**
 * Visuels d'arrière-plan.
 *  - Option A : vidéos de stock verticales (Pexels Videos), repli sur photos Pexels.
 *  - Option B : génération d'image (OpenAI Images).
 *  - mock : dégradé généré par FFmpeg, pour les tests hors-ligne.
 */
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { config, type VisualProvider } from "../config.js";
import type { VisualAsset } from "../types.js";
import { ffmpeg } from "../utils/ffmpeg.js";

async function download(url: string, dest: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`Téléchargement échoué ${res.status} : ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  return dest;
}

// ---------------------------------------------------------------- Pexels
interface PexelsVideoFile {
  link: string;
  width: number | null;
  height: number | null;
  file_type: string;
}
interface PexelsVideo {
  id: number;
  duration: number;
  width: number;
  height: number;
  video_files: PexelsVideoFile[];
}

/** Choisit le fichier MP4 portrait le plus proche de 1080x1920 (évite la 4K inutilement lourde). */
function pickVideoFile(video: PexelsVideo): PexelsVideoFile | undefined {
  return video.video_files
    .filter((f) => f.file_type === "video/mp4" && f.width && f.height && f.height > f.width)
    .sort((a, b) => Math.abs(a.height! - 1920) - Math.abs(b.height! - 1920))[0];
}

/** Ids déjà utilisés dans la vidéo courante, pour éviter les doublons entre scènes. */
export type UsedIds = Set<string>;

async function pexelsVideo(
  query: string,
  minDuration: number,
  dest: string,
  used: UsedIds,
): Promise<VisualAsset | null> {
  const url = new URL("https://api.pexels.com/videos/search");
  url.search = new URLSearchParams({
    query,
    orientation: "portrait",
    size: "medium",
    per_page: "15",
  }).toString();
  const res = await fetch(url, { headers: { Authorization: config.visuals.pexelsApiKey } });
  if (!res.ok) throw new Error(`Pexels ${res.status} : ${await res.text()}`);
  const { videos } = (await res.json()) as { videos: PexelsVideo[] };

  const candidates = videos
    .filter((v) => !used.has(`pv${v.id}`) && v.height > v.width)
    // Les clips assez longs d'abord (évite de boucler), puis l'ordre de pertinence Pexels.
    .sort((a, b) => Number(b.duration >= minDuration) - Number(a.duration >= minDuration));
  for (const v of candidates) {
    const file = pickVideoFile(v);
    if (!file) continue;
    used.add(`pv${v.id}`);
    await download(file.link, dest);
    return { path: dest, kind: "video", source: `pexels:video:${v.id}` };
  }
  return null;
}

async function pexelsPhoto(query: string, dest: string, used: UsedIds): Promise<VisualAsset | null> {
  const url = new URL("https://api.pexels.com/v1/search");
  url.search = new URLSearchParams({ query, orientation: "portrait", per_page: "10" }).toString();
  const res = await fetch(url, { headers: { Authorization: config.visuals.pexelsApiKey } });
  if (!res.ok) throw new Error(`Pexels ${res.status} : ${await res.text()}`);
  const { photos } = (await res.json()) as { photos: { id: number; src: { large2x: string } }[] };
  const photo = photos.find((p) => !used.has(`pp${p.id}`));
  if (!photo) return null;
  used.add(`pp${photo.id}`);
  await download(photo.src.large2x, dest);
  return { path: dest, kind: "image", source: `pexels:photo:${photo.id}` };
}

async function fromPexels(prompt: string, minDuration: number, base: string, used: UsedIds) {
  if (!config.visuals.pexelsApiKey) throw new Error("PEXELS_API_KEY manquant.");
  // On élargit progressivement la requête si rien n'est trouvé.
  const words = prompt.split(/\s+/).filter(Boolean);
  const queries = [prompt, words.slice(0, 2).join(" "), words[0]].filter(
    (q, i, arr) => q && arr.indexOf(q) === i,
  );
  for (const q of queries) {
    const v = await pexelsVideo(q, minDuration, `${base}.mp4`, used);
    if (v) return v;
  }
  for (const q of queries) {
    const p = await pexelsPhoto(q, `${base}.jpg`, used);
    if (p) return p;
  }
  throw new Error(`Aucun visuel Pexels trouvé pour « ${prompt} ».`);
}

// ---------------------------------------------------------------- OpenAI Images
async function fromOpenAI(prompt: string, base: string): Promise<VisualAsset> {
  if (!config.visuals.openaiApiKey) throw new Error("OPENAI_API_KEY manquant.");
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.visuals.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.visuals.openaiImageModel,
      prompt: `Vertical cinematic photo, dramatic lighting, no text: ${prompt}`,
      size: "1024x1536",
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI Images ${res.status} : ${await res.text()}`);
  const { data } = (await res.json()) as { data: { b64_json?: string; url?: string }[] };
  const dest = `${base}.png`;
  if (data[0]?.b64_json) await writeFile(dest, Buffer.from(data[0].b64_json, "base64"));
  else if (data[0]?.url) await download(data[0].url, dest);
  else throw new Error("OpenAI Images n'a renvoyé aucune image.");
  return { path: dest, kind: "image", source: `openai:${config.visuals.openaiImageModel}` };
}

// ---------------------------------------------------------------- Mock
const MOCK_PALETTE = ["0x1e3a8a", "0x7c2d12", "0x14532d", "0x581c87", "0x0f172a", "0x831843"];

async function mockVisual(index: number, base: string): Promise<VisualAsset> {
  const dest = `${base}.png`;
  const c1 = MOCK_PALETTE[index % MOCK_PALETTE.length];
  const c2 = MOCK_PALETTE[(index + 3) % MOCK_PALETTE.length];
  // Dégradé + grille pour que le zoom Ken Burns soit visible.
  await ffmpeg([
    "-f", "lavfi",
    "-i", `gradients=s=1080x1920:c0=${c1}:c1=${c2}:x0=0:y0=0:x1=1080:y1=1920:d=1`,
    "-vf", "drawgrid=w=120:h=120:t=2:c=white@0.15",
    "-frames:v", "1",
    dest,
  ]);
  return { path: dest, kind: "image", source: "mock" };
}

export interface FetchVisualOptions {
  prompt: string;
  index: number;
  minDuration: number;
  dir: string;
  provider: VisualProvider;
  used: UsedIds;
}

export async function fetchVisual(opts: FetchVisualOptions): Promise<VisualAsset> {
  const base = path.join(opts.dir, `visual_${String(opts.index).padStart(3, "0")}`);
  switch (opts.provider) {
    case "pexels":
      return fromPexels(opts.prompt, opts.minDuration, base, opts.used);
    case "openai":
      return fromOpenAI(opts.prompt, base);
    case "mock":
      return mockVisual(opts.index, base);
  }
}
