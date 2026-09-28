/** Télécharge la police Montserrat (SIL Open Font License) dans assets/fonts. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf";
const FILES = ["Montserrat-ExtraBold.ttf", "Montserrat-Black.ttf"];
const dir = path.resolve("assets/fonts");

await mkdir(dir, { recursive: true });
for (const file of FILES) {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`${file} : HTTP ${res.status}`);
  await writeFile(path.join(dir, file), Buffer.from(await res.arrayBuffer()));
  console.log(`✔ ${file}`);
}
