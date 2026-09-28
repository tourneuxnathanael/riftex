import { spawn } from "node:child_process";
import { config } from "../config.js";

export class FfmpegError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

function run(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => {
      stderr += d;
      // On ne garde que la fin du log pour éviter de gonfler la mémoire sur les longs rendus.
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    proc.on("error", (err) =>
      reject(new FfmpegError(`Impossible de lancer ${bin} : ${err.message}`, "")),
    );
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new FfmpegError(
            `${bin} a échoué (code ${code}) :\n${stderr.split("\n").slice(-25).join("\n")}`,
            stderr,
          ),
        );
    });
  });
}

/**
 * Lance ffmpeg. `cwd` permet de référencer des fichiers en chemin relatif dans les
 * filtergraphs (ex : `ass=subtitles.ass`) et d'éviter l'échappement des `:` / `\`.
 */
export function ffmpeg(args: string[], cwd?: string) {
  return run(config.render.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], cwd);
}

/** Durée d'un média en secondes. */
export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run(config.render.ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`Durée illisible pour ${file}`);
  return d;
}
