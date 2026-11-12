import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { createGrantCredential } from "@near-intents-agent-api/sdk";
import { z } from "zod";

/**
 * A grant lets Inti's server act for one user's agent inside the policy the user signed.
 * The server makes the token; the user's wallet signs only its SHA-256 commitment.
 */
export interface GrantRecord {
  agentId: string;
  token: string;
  /** ISO 8601. After it the Agent API refuses the token and the user signs a new grant. */
  expiresAt: string;
}

/** Days a grant stays valid unless the user picks another choice; the Agent API allows up to 365. */
export const GRANT_DAYS = 90;
/** How long the user may let Inti trade before signing again. */
export const GRANT_DAY_CHOICES = [7, 30, 90] as const;
export type GrantDays = (typeof GRANT_DAY_CHOICES)[number];
export interface GrantStore {
  get(userId: string): GrantRecord | null;
  put(userId: string, record: GrantRecord): Promise<void>;
  /** Every user that has a grant, live or not. */
  users(): string[];
}

const recordSchema = z.strictObject({
  agentId: z.string().min(1).max(128),
  token: z.string().startsWith("ngt_").max(256),
  expiresAt: z.iso.datetime(),
});
const sealedSchema = z.record(z.string(), z.strictObject({ iv: z.string(), tag: z.string(), data: z.string() }));
type Sealed = z.infer<typeof sealedSchema>[string];

/** AES-256-GCM with the user id as associated data, so a record cannot be moved to another user. */
function seal(key: Buffer, userId: string, record: GrantRecord): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId));
  const data = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function open(key: Buffer, userId: string, sealed: Sealed): GrantRecord {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  return recordSchema.parse(JSON.parse(plain));
}

/** The encryption key: 32 random bytes, base64. */
export function grantKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("grant key must be 32 bytes in base64");
  return key;
}

/**
 * Grants kept in one file, each record encrypted on its own. Only its owner (mode 600) can read
 * the file, and a copy of it is useless without the key, which lives in the environment.
 */
export async function fileGrantStore(path: string, key: Buffer): Promise<GrantStore> {
  let sealed: Record<string, Sealed> = {};
  try {
    sealed = sealedSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("grant file unreadable", { cause: error });
  }
  const records = new Map<string, GrantRecord>();
  for (const [userId, s] of Object.entries(sealed)) records.set(userId, open(key, userId, s));

  // Writes run one after another, so two saves never interleave.
  let queue: Promise<void> = Promise.resolve();
  const persist = async () => {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(sealed), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  };
  return {
    get: (userId) => records.get(userId) ?? null,
    users: () => [...records.keys()],
    put: async (userId, record) => {
      const valid = recordSchema.parse(record);
      sealed = { ...sealed, [userId]: seal(key, userId, valid) };
      records.set(userId, valid);
      queue = queue.then(persist, persist);
      await queue;
    },
  };
}

/** A grant that still has at least a day left. */
export function usableGrant(record: GrantRecord | null, now: number): GrantRecord | null {
  if (!record) return null;
  return Date.parse(record.expiresAt) - now > 86_400_000 ? record : null;
}

/** A new token and the document the user's wallet signs for it. */
export interface PreparedGrant {
  correlationId: string;
  intent: unknown;
  preview: { summary: string };
  token: string;
  expiresAt: string;
}

/**
 * Builds the grant_issue request: a fresh token every time, expiring `days` from now. `label`
 * names the site that holds it (see grantLabel) and shows on the user's grant list.
 */
export function newGrantRequest(agentId: string, now: number, label: string, days: GrantDays = GRANT_DAYS): { token: string; expiresAt: string; body: Record<string, string> } {
  const { token, commitment } = createGrantCredential();
  const expiresAt = new Date(now + days * 86_400_000).toISOString();
  return { token, expiresAt, body: { type: "grant_issue", agent_id: agentId, label, credential: commitment, expires_at: expiresAt } };
}
