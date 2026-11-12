import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileGrantStore, grantKey, newGrantRequest, usableGrant } from "./grants.js";

const RECORD = { agentId: "agent_1", token: `ngt_${"a".repeat(43)}`, expiresAt: "2027-02-08T12:00:00.000Z" };

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "inti-grants-")), "grants.json");
}

describe("fileGrantStore", () => {
  it("keeps grants across restarts and never writes the token in clear", async () => {
    const path = await tempFile();
    const key = randomBytes(32);
    const store = await fileGrantStore(path, key);
    await store.put("did:privy:alice", RECORD);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("ngt_");
    expect(raw).not.toContain("agent_1");
    expect((await fileGrantStore(path, key)).get("did:privy:alice")).toEqual(RECORD);
  });

  it("cannot be read with another key, or after a record is moved to another user", async () => {
    const path = await tempFile();
    const key = randomBytes(32);
    await (await fileGrantStore(path, key)).put("did:privy:alice", RECORD);
    await expect(fileGrantStore(path, randomBytes(32))).rejects.toThrow();

    const sealed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ "did:privy:mallory": sealed["did:privy:alice"] }));
    await expect(fileGrantStore(path, key)).rejects.toThrow();
  });

  it("starts empty when there is no file yet and refuses a damaged one", async () => {
    const path = await tempFile();
    expect((await fileGrantStore(path, randomBytes(32))).get("did:privy:alice")).toBeNull();
    await writeFile(path, "not json");
    await expect(fileGrantStore(path, randomBytes(32))).rejects.toThrow("grant file unreadable");
  });

  it("refuses a record that is not a grant token", async () => {
    const store = await fileGrantStore(await tempFile(), randomBytes(32));
    await expect(store.put("did:privy:alice", { ...RECORD, token: "secret" })).rejects.toThrow();
  });
});

describe("grants", () => {
  it("accepts only a 32-byte key", () => {
    expect(() => grantKey(randomBytes(16).toString("base64"))).toThrow();
    expect(grantKey(randomBytes(32).toString("base64"))).toHaveLength(32);
  });

  it("makes a new token for every request and signs only its hash", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const a = newGrantRequest("agent_1", now, "Inti trading (getinti.xyz)");
    const b = newGrantRequest("agent_1", now, "Inti trading (getinti.xyz)");
    expect(a.token).not.toBe(b.token);
    expect(JSON.stringify(a.body)).not.toContain(a.token);
    expect(a.expiresAt).toBe("2027-02-08T12:00:00.000Z");
    expect(a.body.label).toBe("Inti trading (getinti.xyz)");
  });

  it("treats a grant with less than a day left as gone", () => {
    const now = Date.parse("2027-02-07T13:00:00Z");
    expect(usableGrant(RECORD, now)).toBeNull();
    expect(usableGrant(RECORD, Date.parse("2027-02-07T11:00:00Z"))).toEqual(RECORD);
    expect(usableGrant(null, now)).toBeNull();
  });
});
