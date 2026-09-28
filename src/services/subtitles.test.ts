import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAss, formatAssTime, groupWords, hexToAss, TIKTOK_STYLE } from "./subtitles.js";
import { alignmentToWords } from "./tts.js";
import { framesPerShot } from "./video-engine.js";
import { alignSegments } from "../pipeline/generate.js";

const w = (word: string, start: number, end: number) => ({ word, start, end });

test("hexToAss convertit RGB en BGR", () => {
  assert.equal(hexToAss("#FFE600"), "&H0000E6FF");
  assert.equal(hexToAss("#39FF14", 0x80), "&H8014FF39");
});

test("formatAssTime", () => {
  assert.equal(formatAssTime(0), "0:00:00.00");
  assert.equal(formatAssTime(61.234), "0:01:01.23");
  assert.equal(formatAssTime(3725.5), "1:02:05.50");
});

test("groupWords coupe sur la ponctuation, les pauses et la taille max", () => {
  const words = [
    w("Et", 0, 0.2), w("si", 0.2, 0.4), w("tout", 0.4, 0.6), w("était", 0.6, 0.9),
    w("faux", 0.9, 1.2), w("?", 1.2, 1.25), w("Personne", 2.0, 2.4), w("ne", 2.4, 2.5),
  ];
  const chunks = groupWords(words, TIKTOK_STYLE).map((c) => c.map((x) => x.word).join(" "));
  assert.deepEqual(chunks, ["Et si tout", "était faux ?", "Personne ne"]);
});

test("buildAss surligne un mot par événement, sans trou entre les mots", () => {
  const ass = buildAss([w("Bonjour", 0.1, 0.5), w("à", 0.6, 0.7), w("tous.", 0.8, 1.2)], {
    width: 1080,
    height: 1920,
  });
  const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(events.length, 3);
  assert.match(events[0], /0:00:00\.10,0:00:00\.60/);
  assert.match(events[1], /0:00:00\.60,0:00:00\.80/);
  assert.match(events[2], /0:00:00\.80,0:00:01\.45/);
  assert.match(events[0], /\\c&H0000E6FF.*}BONJOUR\{/);
  assert.match(events[2], /}TOUS\{/); // ponctuation retirée, majuscules
});

test("alignmentToWords regroupe les caractères", () => {
  const chars = "Il était".split("");
  const words = alignmentToWords({
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * 0.1),
    character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
  });
  assert.deepEqual(words.map((x) => x.word), ["Il", "était"]);
  assert.equal(words[1].start, 0.30000000000000004);
  assert.ok(Math.abs(words[1].end - 0.8) < 1e-9);
});

test("framesPerShot n'accumule pas d'erreur d'arrondi", () => {
  const frames = framesPerShot([1.01, 1.01, 1.01]);
  assert.equal(frames.reduce((a, b) => a + b, 0), Math.round(3.03 * 30));
});

test("alignSegments découpe la timeline par bloc", () => {
  const words = [w("a", 0.1, 0.2), w("b", 0.3, 0.4), w("c", 1.0, 1.1), w("d", 1.2, 1.3)];
  const segs = alignSegments(
    [{ text: "a b", visualPrompt: "x" }, { text: "c d", visualPrompt: "y" }],
    words,
    2,
  );
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 1.0], [1.0, 2]]);
});
