import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { loadIntiKey } from "./orders.js";

async function keyFile(): Promise<{ path: string; publicKey: string; secretKey: string }> {
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  const secretKey = pair.toString();
  const path = join(await mkdtemp(join(tmpdir(), "inti-key-")), "inti-key.json");
  await writeFile(path, JSON.stringify({ publicKey, secretKey }));
  return { path, publicKey, secretKey };
}

describe("loadIntiKey", () => {
  it("returns the secret key when the file matches INTI_KEY_PUBLIC", async () => {
    const { path, publicKey, secretKey } = await keyFile();
    await expect(loadIntiKey(path, publicKey)).resolves.toBe(secretKey);
  });

  it("refuses to start when INTI_KEY_PUBLIC is another key", async () => {
    const { path } = await keyFile();
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    await expect(loadIntiKey(path, other)).rejects.toThrow("INTI_KEY_PUBLIC is not the public key of SERVER_INTI_KEY_FILE");
  });
});
