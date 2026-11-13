import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileSpendLog, SPEND_WINDOW_MS } from "./spendLog.js";

const OWNER = "91".repeat(32);

describe("fileSpendLog", () => {
  it("keeps what the agent spent across a restart, and forgets it after 24 hours", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "spend-")), "agent-spend.json");
    let clock = 1_000_000;
    const first = await fileSpendLog(path, () => clock);
    await first.add(OWNER, { at: clock, micro: 3_550_000n });
    // A trade that did not go through gives its room back.
    await first.add(OWNER, { at: clock, micro: 2_000_000n });
    await first.add(OWNER, { at: clock, micro: -2_000_000n });

    const restarted = await fileSpendLog(path, () => clock);
    expect(restarted.recent(OWNER, clock).reduce((a, s) => a + s.micro, 0n)).toBe(3_550_000n);
    expect(restarted.recent("someone-else", clock)).toEqual([]);
    expect(restarted.recent(OWNER, clock + SPEND_WINDOW_MS)).toEqual([]);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);

    // The next save drops what is older than a day.
    clock += SPEND_WINDOW_MS + 1;
    await restarted.add("other", { at: clock, micro: 1n });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ other: [[clock, "1"]] });
  });

  it("refuses to start on a file it cannot read, rather than forget what was spent", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "spend-")), "agent-spend.json");
    await writeFile(path, "{not json");
    await expect(fileSpendLog(path)).rejects.toThrow("agent spend file unreadable");
    await writeFile(path, JSON.stringify({ [OWNER]: [[1, "1e9"]] }));
    await expect(fileSpendLog(path)).rejects.toThrow("agent spend file unreadable");
  });
});
