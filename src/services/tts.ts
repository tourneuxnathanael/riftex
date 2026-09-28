/**
 * Voix off : ElevenLabs « text-to-speech with timestamps ».
 * L'API renvoie l'audio (base64) + un alignement caractère par caractère, que l'on
 * convertit en timings mot par mot pour les sous-titres et le découpage des scènes.
 */
import { writeFile } from "node:fs/promises";
import { config } from "../config.js";
import type { Narration, WordTiming } from "../types.js";
import { ffmpeg, probeDuration } from "../utils/ffmpeg.js";

interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface ElevenLabsTimestampResponse {
  audio_base64: string;
  alignment: ElevenLabsAlignment | null;
  normalized_alignment: ElevenLabsAlignment | null;
}

/** Regroupe l'alignement par caractère en mots (séparés par des espaces). */
export function alignmentToWords(al: ElevenLabsAlignment): WordTiming[] {
  const words: WordTiming[] = [];
  let buf = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (buf.trim()) words.push({ word: buf, start, end });
    buf = "";
  };
  al.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) return flush();
    if (!buf) start = al.character_start_times_seconds[i];
    buf += ch;
    end = al.character_end_times_seconds[i];
  });
  flush();
  return words;
}

export async function synthesizeElevenLabs(text: string, outPath: string): Promise<Narration> {
  const { apiKey, voiceId, modelId } = config.elevenlabs;
  if (!apiKey || !voiceId) throw new Error("ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID manquants.");

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
      }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status} : ${await res.text()}`);
  const data = (await res.json()) as ElevenLabsTimestampResponse;
  const alignment = data.alignment ?? data.normalized_alignment;
  if (!alignment) throw new Error("ElevenLabs n'a pas renvoyé d'alignement.");

  await writeFile(outPath, Buffer.from(data.audio_base64, "base64"));
  const words = alignmentToWords(alignment);
  const duration = await probeDuration(outPath);
  return { audioPath: outPath, duration, words };
}

/**
 * Voix « factice » pour tester le pipeline hors-ligne : audio silencieux + timings
 * synthétiques réalistes (~2.7 mots/s, pauses sur la ponctuation).
 */
export async function synthesizeMock(text: string, outPath: string): Promise<Narration> {
  const words: WordTiming[] = [];
  let t = 0.15;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const d = Math.min(0.75, 0.14 + 0.055 * w.length);
    words.push({ word: w, start: t, end: t + d });
    t += d + (/[.!?]$/.test(w) ? 0.35 : /[,;:]$/.test(w) ? 0.15 : 0.04);
  }
  const duration = t + 0.2;
  await ffmpeg([
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", duration.toFixed(3),
    "-c:a", "libmp3lame", "-b:a", "128k",
    outPath,
  ]);
  return { audioPath: outPath, duration, words };
}

export function synthesize(text: string, outPath: string, mock = false): Promise<Narration> {
  return mock ? synthesizeMock(text, outPath) : synthesizeElevenLabs(text, outPath);
}
