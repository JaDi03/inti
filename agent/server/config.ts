import { z } from "zod";
import { DEFAULT_AGENT_API_URL } from "../core/demo.js";

/**
 * Caps on what one client and the whole server may consume. They bound NEAR AI
 * spend (each cycle is a few model calls) and memory. Product choices, not provider limits:
 * NEAR AI publishes only a default concurrency of 64 per model (docs.near.ai/llms.txt).
 */
export const LIMITS = {
  bodyBytes: 4096,
  messageChars: 1000,
  cyclesPerUserPerDay: 40,
  cyclesPerDayTotal: 400,
  requestsPerIpPerMinute: 10,
  /** Users whose simulated portfolio stays in memory; the oldest is dropped first. */
  usersInMemory: 1000,
  /** Live token prices are re-read at most this often. */
  tokensTtlMs: 60_000,
  /** A signed agent creation carries the encrypted rules, so it needs a larger body than a chat message. */
  agentBodyBytes: 32_768,
  /** Agent creations one user may start per day (each one that is not signed is left pending upstream). */
  agentsPerUserPerDay: 3,
  /** Agent creations per day for everyone; the Agent API allows 100 per partner (docs: network-and-quotas). */
  agentsPerDayTotal: 80,
  /** Creations waiting for the owner's signature that the server remembers; the oldest is dropped first. */
  pendingAgentsInMemory: 2000,
  /** Grant documents one user may ask for per day; a grant normally lasts 90 days. */
  grantsPerUserPerDay: 5,
  /** Grant documents per day for everyone. */
  grantsPerDayTotal: 400,
  /** Grants waiting for the owner's signature that the server remembers; the oldest is dropped first. */
  pendingGrantsInMemory: 2000,
  /** How often every agent is swept back to its owner's wallet. */
  sweepEveryMs: 5 * 60_000,
} as const;

const envSchema = z.object({
  PRIVY_APP_ID: z.string().min(1),
  /** Public key from the Privy dashboard (App settings > Basics > Verify with key instead), PEM. */
  PRIVY_VERIFICATION_KEY: z.string().includes("BEGIN PUBLIC KEY"),
  NEAR_AI_API_KEY: z.string().min(1),
  /** Partner key of the NEAR Intents Agent API. It can create agents, never move their funds. */
  NEAR_INTENTS_AGENT_API_KEY: z.string().min(1),
  NEAR_INTENTS_AGENT_API_URL: z.url().default(DEFAULT_AGENT_API_URL),
  /** Exact origins allowed to call the API, comma separated (e.g. https://hellointi.xyz). */
  SERVER_ALLOWED_ORIGINS: z.string().min(1),
  SERVER_HOST: z.string().default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Address of the reverse proxy whose X-Forwarded-For is trusted, or empty when there is none. */
  SERVER_TRUSTED_PROXY: z.string().default(""),
  /** Kill switch: "false" stops every agent cycle without a deploy. */
  SERVER_AGENT_ENABLED: z.enum(["true", "false"]).default("true"),
  /** Where users' trading grants are kept, each one encrypted. */
  SERVER_GRANT_FILE: z.string().min(1).default("./grants.json"),
  /** 32 random bytes in base64 that encrypt the grants. */
  SERVER_GRANT_KEY: z.base64().refine((v) => Buffer.from(v, "base64").length === 32),
  /** JSON file with Inti's function-call key ({ publicKey, secretKey }); it can only call fund_agent. */
  SERVER_INTI_KEY_FILE: z.string().min(1),
  SERVER_NEAR_RPC_URL: z.url().default("https://free.rpc.fastnear.com"),
});

export interface ServerConfig {
  privyAppId: string;
  privyVerificationKey: string;
  nearAiApiKey: string;
  agentApiKey: string;
  agentApiUrl: string;
  allowedOrigins: string[];
  host: string;
  port: number;
  trustedProxy: string | null;
  agentEnabled: boolean;
  grantFile: string;
  grantKey: string;
  intiKeyFile: string;
  nearRpcUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Names only: values may be secrets.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`invalid or missing server settings: ${names.join(", ")}`);
  }
  const e = parsed.data;
  const origins = e.SERVER_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  for (const origin of origins) {
    if (new URL(origin).origin !== origin) throw new Error(`SERVER_ALLOWED_ORIGINS entry is not an exact origin: ${origin}`);
  }
  return {
    privyAppId: e.PRIVY_APP_ID,
    // .env files keep the PEM on one line with literal \n.
    privyVerificationKey: e.PRIVY_VERIFICATION_KEY.replace(/\\n/g, "\n"),
    nearAiApiKey: e.NEAR_AI_API_KEY,
    agentApiKey: e.NEAR_INTENTS_AGENT_API_KEY,
    agentApiUrl: e.NEAR_INTENTS_AGENT_API_URL,
    allowedOrigins: origins,
    host: e.SERVER_HOST,
    port: e.SERVER_PORT,
    trustedProxy: e.SERVER_TRUSTED_PROXY || null,
    agentEnabled: e.SERVER_AGENT_ENABLED === "true",
    grantFile: e.SERVER_GRANT_FILE,
    grantKey: e.SERVER_GRANT_KEY,
    intiKeyFile: e.SERVER_INTI_KEY_FILE,
    nearRpcUrl: e.SERVER_NEAR_RPC_URL,
  };
}
