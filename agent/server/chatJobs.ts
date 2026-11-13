import { randomUUID } from "node:crypto";
import { tradable, TRADABLE_KEYS, type TradableKey } from "../policy/heldAssets.js";

/** An asset's name from a key the model wrote, or null when it is not one Inti trades. */
function assetName(value: unknown): string | null {
  return typeof value === "string" && (TRADABLE_KEYS as readonly string[]).includes(value) ? tradable(value as TradableKey).name : null;
}

/**
 * One short line for a step the agent starts. Built only from the tool's name and asset keys Inti
 * knows, never from other text the model wrote.
 */
export function stepLabel(name: string, input: unknown): string | null {
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const asset = assetName(fields.asset);
  const receive = fields.receive === "near" ? "NEAR" : assetName(fields.receive);
  switch (name) {
    case "get_portfolio":
      return "Checking your portfolio";
    case "get_quote":
    case "get_sell_quote":
      return asset ? `Getting a price for ${asset}` : "Getting a price";
    case "buy_now":
      return asset ? `Buying ${asset}` : "Buying";
    case "sell_now":
      if (!asset || !receive) return "Selling";
      return receive === "NEAR" ? `Selling ${asset} for NEAR` : `Swapping ${asset} for ${receive}`;
    case "buy_at_price":
      return asset ? `Placing a price order for ${asset}` : "Placing a price order";
    case "send_near_to_wallet":
      return "Sending NEAR to your wallet";
    default:
      return null;
  }
}

/**
 * One chat message the agent is working on, so a reply that takes minutes (several trades in a
 * row) never depends on one long request. The app asks for it every few seconds and shows each
 * step as it starts. Each user has at most one, kept a while after it ends.
 */
export interface ChatJob {
  id: string;
  /** What the agent is doing, one short line per step, in the order they started. */
  steps: string[];
  state: { status: "running" } | { status: "done"; reply: Record<string, unknown> } | { status: "failed" };
  endedAt: number | null;
}

export class ChatJobs {
  private readonly jobs = new Map<string, ChatJob>();

  constructor(
    private readonly maxUsers: number,
    private readonly keepMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new job for `userId`, replacing the user's last one; the oldest user's is dropped when full. */
  start(userId: string): ChatJob {
    this.jobs.delete(userId);
    for (const [user, job] of this.jobs) {
      if (job.endedAt !== null && this.now() - job.endedAt > this.keepMs) this.jobs.delete(user);
    }
    if (this.jobs.size >= this.maxUsers) {
      const oldest = this.jobs.keys().next().value;
      if (oldest !== undefined) this.jobs.delete(oldest);
    }
    const job: ChatJob = { id: randomUUID(), steps: [], state: { status: "running" }, endedAt: null };
    this.jobs.set(userId, job);
    return job;
  }

  /** The user's own job with this id; another user's id finds nothing. */
  get(userId: string, id: string): ChatJob | null {
    const job = this.jobs.get(userId);
    return job?.id === id ? job : null;
  }

  finish(job: ChatJob, state: ChatJob["state"]): void {
    job.state = state;
    job.endedAt = this.now();
  }
}
