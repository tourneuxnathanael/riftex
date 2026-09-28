/**
 * Génération de sous-titres animés « style TikTok » au format ASS (Advanced SubStation Alpha).
 *
 * Principe : les mots sont regroupés en petits blocs (1 à 3 mots). Pour chaque mot prononcé,
 * on émet un événement Dialogue qui affiche tout le bloc, le mot actif étant surligné
 * (couleur vive + léger « pop » d'échelle). Les événements d'un même bloc sont contigus,
 * ce qui donne l'effet de surlignage mot à mot sans clignotement. Le fichier est ensuite
 * incrusté par FFmpeg via le filtre `ass` (libass).
 */
import { writeFile } from "node:fs/promises";
import type { WordTiming } from "../types.js";

export interface SubtitleStyle {
  /** Nom de famille de la police tel que vu par libass/fontconfig. */
  fontName: string;
  fontSize: number;
  /** Couleurs au format #RRGGBB. */
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  outline: number;
  shadow: number;
  /** Centre vertical des sous-titres (en px sur 1920). ~60 % laisse la place à l'UI TikTok. */
  positionY: number;
  maxWordsPerChunk: number;
  maxCharsPerLine: number;
  uppercase: boolean;
  /** Retire la ponctuation faible en fin de mot (virgules, points) pour un rendu plus « punchy ». */
  stripPunctuation: boolean;
  /** Échelle (%) du mot actif à son apparition, puis au repos. */
  popFrom: number;
  popTo: number;
  popMs: number;
}

export const TIKTOK_STYLE: SubtitleStyle = {
  fontName: "Montserrat ExtraBold",
  fontSize: 92,
  textColor: "#FFFFFF",
  highlightColor: "#FFE600", // jaune vif ; "#39FF14" pour du vert fluo
  outlineColor: "#000000",
  outline: 7,
  shadow: 3,
  positionY: 1180,
  maxWordsPerChunk: 3,
  maxCharsPerLine: 14,
  uppercase: true,
  stripPunctuation: true,
  popFrom: 125,
  popTo: 110,
  popMs: 90,
};

const STRONG_BREAK = /[.!?…]["»”)]*$/;
const SOFT_BREAK = /[,;:—–]["»”)]*$/;
/** Silence (s) au-delà duquel on force un nouveau bloc. */
const PAUSE_BREAK = 0.4;
/** Durée (s) pendant laquelle le dernier bloc reste affiché après le dernier mot. */
const TAIL_HOLD = 0.25;

/** #RRGGBB -> &HAABBGGRR (ASS stocke les couleurs en BGR, alpha 00 = opaque). */
export function hexToAss(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Couleur invalide : ${hex}`);
  const [, r, g, b] = m;
  const a = alpha.toString(16).padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Secondes -> h:mm:ss.cc */
export function formatAssTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function sanitize(text: string): string {
  // `{` `}` ouvrent des blocs d'override et `\` des tags : on les neutralise.
  return text.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

function displayWord(word: string, style: SubtitleStyle): string {
  let w = sanitize(word);
  if (style.stripPunctuation) w = w.replace(/[.,;:…]+$/u, "");
  return style.uppercase ? w.toLocaleUpperCase() : w;
}

/** Découpe la liste de mots en blocs courts, lisibles en un coup d'œil. */
export function groupWords(words: WordTiming[], style: SubtitleStyle): WordTiming[][] {
  const chunks: WordTiming[][] = [];
  let current: WordTiming[] = [];
  const maxChars = style.maxCharsPerLine * 2;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidateLen = [...current, w].map((x) => displayWord(x.word, style)).join(" ").length;
    if (current.length > 0 && (current.length >= style.maxWordsPerChunk || candidateLen > maxChars)) {
      chunks.push(current);
      current = [];
    }
    current.push(w);

    const next = words[i + 1];
    const pause = next ? next.start - w.end : 0;
    if (STRONG_BREAK.test(w.word) || SOFT_BREAK.test(w.word) || pause > PAUSE_BREAK) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  return chunks.filter((c) => c.some((w) => displayWord(w.word, style).length > 0));
}

/** Coupe un bloc en deux lignes équilibrées s'il dépasse la largeur d'une ligne. */
function lineBreakIndex(labels: string[], maxCharsPerLine: number): number {
  const total = labels.join(" ").length;
  if (total <= maxCharsPerLine || labels.length < 2) return -1;
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 1; i < labels.length; i++) {
    const a = labels.slice(0, i).join(" ").length;
    const b = labels.slice(i).join(" ").length;
    const diff = Math.abs(a - b);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

export interface AssOptions {
  width: number;
  height: number;
  style?: Partial<SubtitleStyle>;
}

export function buildAss(words: WordTiming[], opts: AssOptions): string {
  const style: SubtitleStyle = { ...TIKTOK_STYLE, ...opts.style };
  const primary = hexToAss(style.textColor);
  const highlight = hexToAss(style.highlightColor);
  const outline = hexToAss(style.outlineColor);
  const shadowColor = hexToAss("#000000", 0x80);
  const x = Math.round(opts.width / 2);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Alignment 5 = centré horizontalement et verticalement autour de \pos.
    `Style: Word,${style.fontName},${style.fontSize},${primary},${highlight},${outline},${shadowColor},-1,0,0,0,100,100,1,0,1,${style.outline},${style.shadow},5,40,40,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  const chunks = groupWords(words, style);

  chunks.forEach((chunk, ci) => {
    const labels = chunk.map((w) => displayWord(w.word, style));
    const nextChunkStart = chunks[ci + 1]?.[0]?.start ?? Infinity;
    const lastEnd = chunk[chunk.length - 1].end;
    // Si le blanc avant le bloc suivant est court, on prolonge pour éviter un « flash » vide.
    const chunkEnd = Math.min(lastEnd + TAIL_HOLD, nextChunkStart);
    const breakAt = lineBreakIndex(labels, style.maxCharsPerLine);

    // Un mot isolé très long est réduit pour tenir dans la largeur.
    const longest = Math.max(...labels.map((l) => l.length));
    const fontSize =
      longest > style.maxCharsPerLine
        ? Math.floor((style.fontSize * style.maxCharsPerLine) / longest)
        : style.fontSize;

    chunk.forEach((w, wi) => {
      const start = w.start;
      const end = wi < chunk.length - 1 ? chunk[wi + 1].start : chunkEnd;
      if (end - start < 0.01) return;

      const parts = labels.map((label, li) => {
        const text =
          li === wi
            ? `{\\c${highlight}\\fscx${style.popFrom}\\fscy${style.popFrom}\\t(0,${style.popMs},\\fscx${style.popTo}\\fscy${style.popTo})}${label}{\\c${primary}\\fscx100\\fscy100}`
            : label;
        return li === breakAt ? `\\N${text}` : text;
      });
      const body = parts.join(" ").replace(/ \\N/g, "\\N");
      const prefix = `{\\an5\\pos(${x},${style.positionY})${fontSize !== style.fontSize ? `\\fs${fontSize}` : ""}}`;
      events.push(
        `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Word,,0,0,0,,${prefix}${body}`,
      );
    });
  });

  return [...header, ...events, ""].join("\n");
}

export async function writeAssFile(
  words: WordTiming[],
  outPath: string,
  opts: AssOptions,
): Promise<string> {
  await writeFile(outPath, buildAss(words, opts), "utf8");
  return outPath;
}
