/**
 * Génération du script vidéo via l'API Anthropic, avec sortie structurée validée par Zod.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import type { VideoScript } from "../types.js";

const ScriptSchema = z.object({
  title: z.string().describe("Titre court de la publication, sans hashtags"),
  hook: z.string().describe("Première phrase choc, lue dans les 2 premières secondes"),
  scenes: z
    .array(
      z.object({
        text: z.string().describe("Narration de la scène (1 à 2 phrases courtes)"),
        visual_prompt: z
          .string()
          .describe(
            "Description visuelle EN ANGLAIS, 2 à 6 mots-clés concrets filmables, utilisable comme requête de banque vidéo",
          ),
      }),
    )
    .describe("4 à 8 scènes"),
  call_to_action: z.string().describe("Phrase finale d'appel à l'action (abonnement, commentaire...)"),
  hashtags: z.array(z.string()).describe("4 à 6 hashtags pertinents, sans le caractère #"),
});

export interface ScriptRequest {
  topic: string;
  language?: string;
  /** Durée cible en secondes. */
  targetSeconds?: number;
  tone?: string;
}

const SYSTEM_PROMPT = `Tu es un scénariste spécialisé dans les vidéos verticales courtes (TikTok, YouTube Shorts, Reels).
Tu écris des scripts de narration en voix off, rythmés, avec un hook qui capte l'attention dès la première seconde.
Règles :
- Phrases courtes, vocabulaire simple, style oral. Pas d'emojis, pas de didascalies, pas de markdown dans les textes lus.
- Le texte de chaque scène est lu tel quel par une synthèse vocale : écris les nombres en toutes lettres quand c'est ambigu à l'oral.
- Chaque visual_prompt décrit un plan concret et filmable (pas d'abstractions), en anglais, pour une recherche de vidéos de stock.
- Le hook, les scènes et le call_to_action s'enchaînent comme une seule narration fluide.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error("ANTHROPIC_API_KEY manquant (voir .env.example).");
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

async function callModel(model: string, req: ScriptRequest) {
  const seconds = req.targetSeconds ?? 45;
  // ~2.5 mots/s pour une voix off dynamique
  const words = Math.round(seconds * 2.5);
  return getClient().messages.parse({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(ScriptSchema) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Sujet : ${req.topic}
Langue de la narration : ${req.language ?? "fr"}
Durée cible : ${seconds} secondes (environ ${words} mots au total, hook et call_to_action compris).
Ton : ${req.tone ?? "intrigant, captivant"}.`,
      },
    ],
  });
}

export async function generateScript(req: ScriptRequest): Promise<VideoScript> {
  let response = await callModel(config.anthropic.model, req);
  if (response.stop_reason === "refusal" && config.anthropic.fallbackModel) {
    response = await callModel(config.anthropic.fallbackModel, req);
  }
  if (response.stop_reason === "refusal") {
    throw new Error("Le modèle a refusé de générer ce script. Essayez un autre sujet.");
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error(`Script invalide ou tronqué (stop_reason=${response.stop_reason}).`);
  }
  const script = response.parsed_output;
  script.hashtags = script.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, ""));
  return script;
}

/** Script de démonstration pour tester le pipeline sans clé API (`--mock`). */
export function mockScript(topic: string): VideoScript {
  return {
    title: `${topic} : ce que personne ne vous a dit`,
    hook: `Et si tout ce que vous saviez sur ${topic} était faux ?`,
    scenes: [
      { text: "Tout commence par une nuit sans lune, dans un village oublié.", visual_prompt: "foggy village night" },
      { text: "Les habitants racontent qu'une lumière étrange apparaissait chaque hiver.", visual_prompt: "mysterious light forest" },
      { text: "Personne n'a jamais su d'où elle venait. Jusqu'à ce jour-là.", visual_prompt: "old map candle" },
      { text: "Un enfant l'a suivie, et ce qu'il a découvert a changé l'histoire du village.", visual_prompt: "child walking woods" },
    ],
    call_to_action: "Abonne-toi pour découvrir la suite demain !",
    hashtags: ["mystere", "histoire", "fyp", "storytime"],
  };
}
