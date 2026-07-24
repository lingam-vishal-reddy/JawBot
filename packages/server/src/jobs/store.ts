import type { Job } from "@jawbot/shared";

export class JobStore {
  private readonly jobs = new Map<string, Job>();

  upsert(job: Job): Job {
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(limit = 50): Job[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  update(id: string, patch: Partial<Job>): Job | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.jobs.set(id, next);
    return next;
  }
}
