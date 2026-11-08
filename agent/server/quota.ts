/**
 * Agent cycles per UTC day, per user and in total. In memory: a restart resets
 * the counts, which is acceptable for the demo server (one process).
 */
export class DailyQuota {
  private day = "";
  private total = 0;
  private readonly perUser = new Map<string, number>();

  constructor(
    private readonly maxPerUser: number,
    private readonly maxTotal: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one cycle, or says which cap is full. */
  take(userId: string): "ok" | "user_limit" | "server_limit" {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.total = 0;
      this.perUser.clear();
    }
    const used = this.perUser.get(userId) ?? 0;
    if (used >= this.maxPerUser) return "user_limit";
    if (this.total >= this.maxTotal) return "server_limit";
    this.perUser.set(userId, used + 1);
    this.total += 1;
    return "ok";
  }
}
