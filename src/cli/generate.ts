/**
 * Test de bout en bout du pipeline :
 *   npm run generate -- --topic "Histoire mystérieuse"
 *   npm run generate -- --topic "Le triangle des Bermudes" --duration 40 --music assets/music/dark.mp3
 *   npm run generate -- --topic "Test" --mock            (hors-ligne, FFmpeg seul)
 *   npm run generate -- --topic "..." --publish draft     (upload dans les brouillons TikTok)
 */
import { parseArgs } from "node:util";
import { renderQueue } from "../jobs/queue.js";
import { waitForPublish } from "../services/tiktok.js";

const HELP = `Usage : npm run generate -- --topic "<sujet>" [options]

  --topic, -t      Sujet de la vidéo (requis)
  --lang           Langue de la narration (défaut : fr)
  --duration, -d   Durée cible en secondes (défaut : 45)
  --visuals        pexels | openai | mock (défaut : VISUAL_PROVIDER)
  --music          Chemin d'une musique de fond libre de droits
  --publish        draft | direct : publie sur TikTok après le rendu
  --mock           Pipeline hors-ligne (script, voix et visuels factices)
  --highlight      Couleur du mot actif (défaut : #FFE600)
  --help, -h`;

const { values } = parseArgs({
  options: {
    topic: { type: "string", short: "t" },
    lang: { type: "string", default: "fr" },
    duration: { type: "string", short: "d", default: "45" },
    visuals: { type: "string" },
    music: { type: "string" },
    publish: { type: "string" },
    mock: { type: "boolean", default: false },
    highlight: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || !values.topic) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}
if (values.publish && !["draft", "direct"].includes(values.publish)) {
  console.error("--publish doit valoir draft ou direct");
  process.exit(1);
}
if (values.visuals && !["pexels", "openai", "mock"].includes(values.visuals)) {
  console.error("--visuals doit valoir pexels, openai ou mock");
  process.exit(1);
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`.padStart(6);

const job = renderQueue.add({
  topic: values.topic,
  language: values.lang,
  targetSeconds: Number(values.duration),
  visuals: values.visuals as "pexels" | "openai" | "mock" | undefined,
  musicPath: values.music,
  publish: values.publish as "draft" | "direct" | undefined,
  mock: values.mock,
  subtitleStyle: values.highlight ? { highlightColor: values.highlight } : undefined,
});

let lastLine = "";
renderQueue.on("update", (j) => {
  if (j.id !== job.id || !j.step) return;
  const line = `[${elapsed()}] ${j.step}${j.detail ? ` — ${j.detail}` : ""}`;
  if (line !== lastLine) console.log(line);
  lastLine = line;
});

try {
  const result = await renderQueue.waitFor(job.id);
  console.log(`\n✔ Vidéo générée en ${elapsed().trim()} (${result.duration.toFixed(1)} s)`);
  console.log(`  Fichier  : ${result.videoPath}`);
  console.log(`  Légende  : ${result.caption}`);
  if (result.publishId) {
    console.log(`  TikTok   : publish_id=${result.publishId}, attente du traitement...`);
    const status = await waitForPublish(result.publishId);
    console.log(`  TikTok   : ${status.status}`);
  }
} catch (err) {
  console.error(`\n✖ Échec : ${(err as Error).message}`);
  process.exit(1);
}
