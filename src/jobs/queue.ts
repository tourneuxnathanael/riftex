/**
 * File de jobs en mémoire (concurrence configurable) pour exécuter le rendu hors du cycle
 * requête/réponse HTTP. L'API web pourra faire `queue.add(...)`, renvoyer l'id immédiatement,
 * puis exposer `queue.get(id)` en polling ou relayer les événements `update` en SSE.
 *
 * Pour du multi-process / persistance, remplacer par BullMQ + Redis en gardant cette interface.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { generateVideo, type GenerateOptions, type GenerateResult, type PipelineStep } from "../pipeline/generate.js";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface RenderJob {
  id: string;
  status: JobStatus;
  step?: PipelineStep;
  detail?: string;
  options: Omit<GenerateOptions, "onStep">;
  result?: GenerateResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export class RenderQueue extends EventEmitter {
  private jobs = new Map<string, RenderJob>();
  private pending: string[] = [];
  private running = 0;

  constructor(private readonly concurrency = 1) {
    super();
  }

  add(options: Omit<GenerateOptions, "onStep">): RenderJob {
    const now = Date.now();
    const job: RenderJob = { id: randomUUID(), status: "queued", options, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.emit("update", job);
    queueMicrotask(() => this.drain());
    return job;
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Résout quand le job est terminé (rejette s'il a échoué). */
  waitFor(id: string): Promise<GenerateResult> {
    return new Promise((resolve, reject) => {
      const check = (job: RenderJob) => {
        if (job.id !== id) return false;
        if (job.status === "completed") resolve(job.result!);
        else if (job.status === "failed") reject(new Error(job.error));
        else return false;
        this.off("update", check);
        return true;
      };
      const job = this.jobs.get(id);
      if (!job) return reject(new Error(`Job inconnu : ${id}`));
      if (!check(job)) this.on("update", check);
    });
  }

  private update(job: RenderJob, patch: Partial<RenderJob>) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.emit("update", job);
  }

  private drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const job = this.jobs.get(this.pending.shift()!)!;
      this.running++;
      this.update(job, { status: "running" });
      generateVideo({
        ...job.options,
        onStep: (step, detail) => this.update(job, { step, detail }),
      })
        .then((result) => this.update(job, { status: "completed", result }))
        .catch((err: Error) => this.update(job, { status: "failed", error: err.message }))
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}

export const renderQueue = new RenderQueue(1);
