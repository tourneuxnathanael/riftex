import "dotenv/config";
import path from "node:path";

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && value !== "" && value !== undefined ? n : fallback;
}

export const config = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
    fallbackModel: process.env.ANTHROPIC_FALLBACK_MODEL || "claude-opus-4-8",
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? "",
    modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
  },
  visuals: {
    provider: (process.env.VISUAL_PROVIDER || "pexels") as "pexels" | "openai" | "mock",
    pexelsApiKey: process.env.PEXELS_API_KEY ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiImageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
  },
  render: {
    width: 1080,
    height: 1920,
    fps: 30,
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
    preset: process.env.X264_PRESET || "veryfast",
    musicPath: process.env.BACKGROUND_MUSIC_PATH || "",
    musicVolume: num(process.env.MUSIC_VOLUME, 0.18),
    fontsDir: path.resolve("assets/fonts"),
    outputDir: path.resolve(process.env.OUTPUT_DIR || "./output"),
  },
  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY ?? "",
    clientSecret: process.env.TIKTOK_CLIENT_SECRET ?? "",
    redirectUri: process.env.TIKTOK_REDIRECT_URI || "http://localhost:3456/tiktok/callback",
    tokenPath: path.resolve(process.env.TIKTOK_TOKEN_PATH || "./.data/tiktok-token.json"),
  },
};

export type VisualProvider = typeof config.visuals.provider;
