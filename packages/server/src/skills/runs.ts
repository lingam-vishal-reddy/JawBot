import type { SkillRun, SkillRunStep } from "@jawbot/shared";

export class SkillRunStore {
  private readonly runs = new Map<string, SkillRun>();

  upsert(run: SkillRun): SkillRun {
    this.runs.set(run.id, run);
    return run;
  }

  get(id: string): SkillRun | undefined {
    return this.runs.get(id);
  }

  update(id: string, patch: Partial<SkillRun>): SkillRun | undefined {
    const existing = this.runs.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.runs.set(id, next);
    return next;
  }

  updateStep(
    id: string,
    index: number,
    patch: Partial<SkillRunStep>,
  ): SkillRun | undefined {
    const existing = this.runs.get(id);
    if (!existing) return undefined;
    const steps = existing.steps.map((s) =>
      s.index === index ? { ...s, ...patch } : s,
    );
    const next = { ...existing, steps };
    this.runs.set(id, next);
    return next;
  }

  list(limit = 50): SkillRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  listForSession(sessionId: string, limit = 50): SkillRun[] {
    return this.list(Number.MAX_SAFE_INTEGER)
      .filter((r) => r.sessionId === sessionId)
      .slice(0, limit);
  }
}
