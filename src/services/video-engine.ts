/**
 * Moteur d'assemblage vidéo basé sur FFmpeg.
 *
 * Étapes :
 *  1. Chaque plan (clip vidéo ou image) est normalisé en segment 1080x1920 @30 fps, H.264,
 *     avec recadrage « cover » et zoom lent (effet Ken Burns). Les durées sont calculées en
 *     nombre de frames à partir des temps absolus pour éviter toute dérive de synchronisation.
 *  2. Les segments (encodés à l'identique) sont concaténés sans ré-encodage (concat demuxer).
 *  3. Passe finale : incrustation des sous-titres ASS (libass), mixage voix off + musique
 *     (volume ~15-20 %, fondu de sortie), encodage H.264/AAC, `+faststart` pour le streaming.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { Shot } from "../types.js";
import { ffmpeg } from "../utils/ffmpeg.js";

export interface RenderOptions {
  shots: Shot[];
  voicePath: string;
  /** Durée totale de la vidéo finale (s). Les plans doivent la couvrir. */
  duration: number;
  assPath?: string;
  musicPath?: string;
  musicVolume?: number;
  workDir: string;
  outPath: string;
  kenBurns?: boolean;
  /** Amplitude du zoom Ken Burns (0.1 = 10 %). */
  zoomAmount?: number;
  /** Nombre de segments encodés en parallèle. */
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

const { width: W, height: H, fps: FPS } = config.render;

function x264Args(crf: number): string[] {
  return ["-c:v", "libx264", "-preset", config.render.preset, "-crf", String(crf), "-pix_fmt", "yuv420p"];
}

/**
 * Filtre vidéo d'un plan : recadrage plein écran 9:16 puis zoom lent.
 * On sur-échantillonne avant `zoompan` car celui-ci arrondit x/y à l'entier : plus la
 * résolution d'entrée est grande, moins le mouvement « tremble ».
 */
export function shotFilter(opts: {
  kind: "video" | "image";
  frames: number;
  zoomIn: boolean;
  kenBurns: boolean;
  zoomAmount: number;
}): string {
  const cover = (w: number, h: number) =>
    `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`;

  if (!opts.kenBurns) return `${cover(W, H)},fps=${FPS},format=yuv420p`;

  const up = opts.kind === "image" ? 2 : 1.25;
  const uw = Math.round((W * up) / 2) * 2;
  const uh = Math.round((H * up) / 2) * 2;
  const a = opts.zoomAmount;
  const n = Math.max(1, opts.frames - 1);
  // `on` = index de la frame de sortie ; zoom linéaire de 1 -> 1+a (ou l'inverse).
  const z = opts.zoomIn ? `1+${a}*on/${n}` : `${1 + a}-${a}*on/${n}`;
  return [
    cover(uw, uh),
    `fps=${FPS}`,
    `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`,
    "format=yuv420p",
  ].join(",");
}

async function renderShot(
  shot: Shot,
  frames: number,
  index: number,
  opts: RenderOptions,
): Promise<string> {
  const out = path.join(opts.workDir, `shot_${String(index).padStart(3, "0")}.mp4`);
  const input =
    shot.asset.kind === "video"
      ? ["-stream_loop", "-1", "-i", shot.asset.path] // boucle si le clip est plus court que le plan
      : ["-loop", "1", "-framerate", String(FPS), "-i", shot.asset.path];

  const vf = shotFilter({
    kind: shot.asset.kind,
    frames,
    zoomIn: index % 2 === 0, // alterne zoom avant / arrière pour varier le rythme
    kenBurns: opts.kenBurns ?? true,
    zoomAmount: opts.zoomAmount ?? 0.1,
  });

  await ffmpeg([
    ...input,
    "-vf", vf,
    "-frames:v", String(frames),
    "-an",
    ...x264Args(18),
    "-r", String(FPS),
    "-video_track_timescale", "15360",
    out,
  ]);
  return out;
}

/** Convertit des durées en nombres de frames sans accumuler d'erreur d'arrondi. */
export function framesPerShot(durations: number[]): number[] {
  const frames: number[] = [];
  let t = 0;
  let prevFrame = 0;
  for (const d of durations) {
    t += d;
    const f = Math.round(t * FPS);
    frames.push(Math.max(1, f - prevFrame));
    prevFrame = Math.max(f, prevFrame + 1);
  }
  return frames;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function renderVideo(opts: RenderOptions): Promise<string> {
  const log = opts.onProgress ?? (() => {});
  if (opts.shots.length === 0) throw new Error("Aucun plan à assembler.");
  await mkdir(opts.workDir, { recursive: true });

  // Le dernier plan est étiré pour couvrir exactement la durée demandée.
  const durations = opts.shots.map((s) => s.duration);
  const covered = durations.reduce((a, b) => a + b, 0);
  if (covered < opts.duration) durations[durations.length - 1] += opts.duration - covered;
  const frames = framesPerShot(durations);

  // 1. Segments normalisés
  let done = 0;
  const segments = await mapWithConcurrency(opts.shots, opts.concurrency ?? 2, async (shot, i) => {
    const seg = await renderShot(shot, frames[i], i, opts);
    log(`segment ${++done}/${opts.shots.length} rendu`);
    return seg;
  });

  // 2. Concaténation sans ré-encodage
  const listPath = path.join(opts.workDir, "concat.txt");
  await writeFile(
    listPath,
    segments.map((s) => `file '${path.basename(s).replace(/'/g, "'\\''")}'`).join("\n") + "\n",
  );
  const background = path.join(opts.workDir, "background.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", background], opts.workDir);
  log("fond vidéo concaténé");

  // 3. Passe finale : sous-titres + audio
  const args: string[] = ["-i", path.resolve(background), "-i", path.resolve(opts.voicePath)];
  const hasMusic = Boolean(opts.musicPath);
  if (hasMusic) args.push("-stream_loop", "-1", "-i", path.resolve(opts.musicPath!));

  const filters: string[] = [];
  if (opts.assPath) {
    // Chemins relatifs au workDir : évite l'échappement des ':' et '\' dans le filtergraph.
    const ass = path.relative(opts.workDir, path.resolve(opts.assPath)).split(path.sep).join("/");
    const fonts = path.relative(opts.workDir, config.render.fontsDir).split(path.sep).join("/");
    filters.push(`[0:v]ass=filename=${ass}:fontsdir=${fonts || "."}[v]`);
  } else {
    filters.push(`[0:v]null[v]`);
  }

  const fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
  if (hasMusic) {
    const vol = opts.musicVolume ?? config.render.musicVolume;
    const fadeStart = Math.max(0, opts.duration - 1.5);
    filters.push(`[1:a]${fmt}[vo]`);
    filters.push(`[2:a]${fmt},volume=${vol},afade=t=in:d=0.5,afade=t=out:st=${fadeStart.toFixed(2)}:d=1.5[bg]`);
    // normalize=0 : amix ne divise pas le volume de la voix par le nombre d'entrées.
    filters.push(`[vo][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,apad[a]`);
  } else {
    filters.push(`[1:a]${fmt},apad[a]`);
  }

  await ffmpeg(
    [
      ...args,
      "-filter_complex", filters.join(";"),
      "-map", "[v]",
      "-map", "[a]",
      ...x264Args(20),
      "-profile:v", "high",
      "-r", String(FPS),
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-t", opts.duration.toFixed(3),
      "-movflags", "+faststart",
      path.resolve(opts.outPath),
    ],
    opts.workDir,
  );
  log(`vidéo finale : ${opts.outPath}`);
  return opts.outPath;
}
