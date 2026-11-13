import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

/** Entries older than this no longer count against the daily limit. */
export const SPEND_WINDOW_MS = 86_400_000;

/**
 * One trade the agent paid from what it already held: when, and its value in micro-dollars. A
 * negative value gives back the room of a trade that did not go through.
 */
export interface AgentSpend {
  at: number;
  micro: bigint;
}

/**
 * What each owner's agent spent from what it already held in the last 24 hours. Spending Limits
 * only sees money leaving the wallet, so these count against the same daily limit in Inti. They
 * are kept on disk, so a restart or a deploy never resets the owner's limit.
 */
export interface SpendLog {
  recent(owner: string, now: number): AgentSpend[];
  add(owner: string, spend: AgentSpend): Promise<void>;
}

/** A log that lives only as long as the process; for tests. */
export function memorySpendLog(): SpendLog {
  const entries = new Map<string, AgentSpend[]>();
  return {
    recent: (owner, now) => (entries.get(owner) ?? []).filter((s) => now - s.at < SPEND_WINDOW_MS),
    add: (owner, spend) => {
      entries.set(owner, [...(entries.get(owner) ?? []), spend]);
      return Promise.resolve();
    },
  };
}

const fileSchema = z.record(z.string(), z.array(z.tuple([z.number().int().nonnegative(), z.string().regex(/^-?\d{1,30}$/)])));

/** A log kept in one file that only its owner can read (mode 600), written whole after each trade. */
export async function fileSpendLog(path: string, now: () => number = Date.now): Promise<SpendLog> {
  const entries = new Map<string, AgentSpend[]>();
  try {
    for (const [owner, list] of Object.entries(fileSchema.parse(JSON.parse(await readFile(path, "utf8"))))) {
      entries.set(owner, list.map(([at, micro]) => ({ at, micro: BigInt(micro) })));
    }
  } catch (error) {
    // A missing file is a first start; any other problem stops the server rather than forget what was spent.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("agent spend file unreadable", { cause: error });
  }

  // Writes run one after another, so two saves never interleave.
  let queue: Promise<void> = Promise.resolve();
  const persist = async () => {
    const cutoff = now() - SPEND_WINDOW_MS;
    const doc: Record<string, [number, string][]> = {};
    for (const [owner, list] of entries) {
      const kept = list.filter((s) => s.at > cutoff);
      if (kept.length > 0) doc[owner] = kept.map((s) => [s.at, s.micro.toString()]);
      else entries.delete(owner);
    }
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  };
  return {
    recent: (owner, at) => (entries.get(owner) ?? []).filter((s) => at - s.at < SPEND_WINDOW_MS),
    add: async (owner, spend) => {
      entries.set(owner, [...(entries.get(owner) ?? []), spend]);
      queue = queue.then(persist, persist);
      await queue;
    },
  };
}
