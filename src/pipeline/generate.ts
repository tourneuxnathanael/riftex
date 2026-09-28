/**
 * Orchestration du pipeline : script -> voix off -> visuels -> sous-titres -> rendu -> (publication).
 * Chaque étape écrit ses artefacts dans le dossier du job, ce qui facilite le debug
 * et permettra à l'interface web de prévisualiser les résultats intermédiaires.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, type VisualProvider } from "../config.js";
import { fetchVisual, type UsedIds } from "../services/assets.js";
import { generateScript, mockScript } from "../services/llm.js";
import { writeAssFile, type SubtitleStyle } from "../services/subtitles.js";
import { publishVideo } from "../services/tiktok.js";
import { synthesize } from "../services/tts.js";
import { renderVideo } from "../services/video-engine.js";
import type { Shot, TimedSegment, VideoScript, WordTiming } from "../types.js";

export type PipelineStep = "script" | "voice" | "visuals" | "subtitles" | "render" | "publish" | "done";

export interface GenerateOptions {
  topic: string;
  language?: string;
  targetSeconds?: number;
  visuals?: VisualProvider;
  musicPath?: string;
  publish?: "draft" | "direct";
  /** Mode hors-ligne : script, voix et visuels factices (seul FFmpeg est requis). */
  mock?: boolean;
  subtitleStyle?: Partial<SubtitleStyle>;
  /** Durée max d'un plan : au-delà, la scène est découpée en plusieurs visuels. */
  maxShotSeconds?: number;
  jobId?: string;
  onStep?: (step: PipelineStep, detail?: string) => void;
}

export interface GenerateResult {
  jobId: string;
  dir: string;
  videoPath: string;
  script: VideoScript;
  caption: string;
  duration: number;
  publishId?: string;
}

const TAIL_SECONDS = 0.6;

function slugify(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

const countWords = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * Associe chaque bloc de texte à son intervalle temporel dans la narration, à partir des
 * timings mot à mot. Si le TTS a tokenisé différemment, on retombe sur une répartition
 * proportionnelle au nombre de mots.
 */
export function alignSegments(
  blocks: { text: string; visualPrompt: string }[],
  words: WordTiming[],
  totalDuration: number,
): TimedSegment[] {
  const counts = blocks.map((b) => countWords(b.text));
  const expected = counts.reduce((a, b) => a + b, 0);
  const ratio = expected === words.length ? 1 : words.length / Math.max(1, expected);

  let cumulative = 0;
  const firstIdx = counts.map((c) => {
    const idx = Math.min(words.length - 1, Math.round(cumulative * ratio));
    cumulative += c;
    return idx;
  });

  return blocks.map((b, i) => ({
    text: b.text,
    visualPrompt: b.visualPrompt,
    start: i === 0 ? 0 : words[firstIdx[i]]?.start ?? 0,
    end: i === blocks.length - 1 ? totalDuration : words[firstIdx[i + 1]]?.start ?? totalDuration,
  }));
}

export async function generateVideo(opts: GenerateOptions): Promise<GenerateResult> {
  const step = opts.onStep ?? (() => {});
  const jobId =
    opts.jobId ?? `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${slugify(opts.topic)}`;
  const dir = path.join(config.render.outputDir, jobId);
  const assetsDir = path.join(dir, "assets");
  const workDir = path.join(dir, "work");
  await mkdir(assetsDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  const save = (name: string, data: unknown) =>
    writeFile(path.join(dir, name), JSON.stringify(data, null, 2), "utf8");

  // 1. Script
  step("script");
  const script = opts.mock
    ? mockScript(opts.topic)
    : await generateScript({ topic: opts.topic, language: opts.language, targetSeconds: opts.targetSeconds });
  await save("script.json", script);

  // Le hook est lu sur le premier visuel, le CTA sur le dernier.
  const blocks = script.scenes.map((s) => ({ text: s.text, visualPrompt: s.visual_prompt }));
  blocks[0] = { ...blocks[0], text: `${script.hook} ${blocks[0].text}` };
  const last = blocks.length - 1;
  blocks[last] = { ...blocks[last], text: `${blocks[last].text} ${script.call_to_action}` };
  const narrationText = blocks.map((b) => b.text).join(" ");

  // 2. Voix off + timings mot à mot
  step("voice");
  const narration = await synthesize(narrationText, path.join(dir, "voice.mp3"), opts.mock);
  await save("narration.json", narration);
  const duration = narration.duration + TAIL_SECONDS;

  // 3. Visuels (un ou plusieurs plans par scène)
  step("visuals");
  const segments = alignSegments(blocks, narration.words, duration);
  const maxShot = opts.maxShotSeconds ?? 6;
  const provider: VisualProvider = opts.mock ? "mock" : opts.visuals ?? config.visuals.provider;
  const used: UsedIds = new Set();
  const shots: Shot[] = [];
  for (const seg of segments) {
    const segDuration = seg.end - seg.start;
    const parts = Math.max(1, Math.ceil(segDuration / maxShot));
    for (let p = 0; p < parts; p++) {
      const asset = await fetchVisual({
        prompt: seg.visualPrompt,
        index: shots.length,
        minDuration: segDuration / parts,
        dir: assetsDir,
        provider,
        used,
      });
      shots.push({ asset, duration: segDuration / parts });
      step("visuals", `${shots.length} visuel(s) — ${asset.source}`);
    }
  }
  await save("timeline.json", { duration, segments, shots });

  // 4. Sous-titres animés
  step("subtitles");
  const assPath = await writeAssFile(narration.words, path.join(dir, "subtitles.ass"), {
    width: config.render.width,
    height: config.render.height,
    style: opts.subtitleStyle,
  });

  // 5. Assemblage
  step("render");
  const videoPath = path.join(dir, "final.mp4");
  await renderVideo({
    shots,
    voicePath: narration.audioPath,
    duration,
    assPath,
    musicPath: opts.musicPath ?? (config.render.musicPath || undefined),
    workDir,
    outPath: videoPath,
    onProgress: (m) => step("render", m),
  });

  const caption = `${script.title} ${script.hashtags.map((h) => `#${h}`).join(" ")}`.trim();
  await writeFile(path.join(dir, "caption.txt"), caption, "utf8");

  // 6. Publication TikTok (optionnelle)
  let publishId: string | undefined;
  if (opts.publish) {
    step("publish", opts.publish);
    publishId = await publishVideo({ videoPath, caption, mode: opts.publish });
  }

  step("done", videoPath);
  return { jobId, dir, videoPath, script, caption, duration, publishId };
}
