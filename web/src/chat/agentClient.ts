/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

export interface AgentReply {
  simulated: boolean;
  report: string;
  stopReason: string;
  events: Array<Record<string, string>>;
  responseIds: string[];
  /** Lets the user check that the AI model calls behind this reply were signed in the verified chip. */
  proofId?: string | null;
}

/** Every failure becomes one short sentence the user understands. */
const MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired. Sign in again and retry.",
  user_limit: "You reached today's limit of messages to Inti. Try again tomorrow.",
  server_limit: "Inti is very busy today. Try again tomorrow.",
  rate_limited: "Too many messages in a minute. Wait a moment and retry.",
  busy: "I'm still working on your last message.",
  agent_paused: "Inti is paused for maintenance. Try again later.",
  agent_unavailable: "I couldn't reach my tools right now. Try again in a minute.",
};
const GENERIC = "Something went wrong. Try again in a minute.";
const STILL_WORKING = "Inti is still working on this. Check your balance in a few minutes before you ask again.";

export class AgentError extends Error {}

/** How often the app asks how the message is going, and for how long at most. */
const POLL_MS = 2_500;
const FOLLOW_MS = 12 * 60_000;
/** Reads in a row that may fail (a phone switching networks) before the app stops following. */
const MISSED_READS = 6;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sends a message and follows it until the reply is there. The server answers at once and works on
 * it, so several trades in a row never hang on one request; `onSteps` gets what the agent is doing.
 */
export async function askAgent(getAccessToken: () => Promise<string | null>, message: string, onSteps: (steps: string[]) => void): Promise<AgentReply> {
  if (!API_URL) throw new AgentError("Inti's server is not configured yet.");
  const token = await getAccessToken();
  if (!token) throw new AgentError(MESSAGES.unauthorized);
  let res: Response;
  try {
    res = await fetch(new URL("/api/chat", API_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // The server may have got the message and started an order: a retry could buy twice.
    if (error instanceof DOMException && error.name === "TimeoutError") throw new AgentError(STILL_WORKING);
    throw new AgentError("I couldn't reach Inti's server. Check your connection and retry.");
  }
  const started = (await res.json().catch(() => ({}))) as { jobId?: unknown; error?: string };
  if (!res.ok) throw new AgentError(MESSAGES[started.error ?? ""] ?? GENERIC);
  if (typeof started.jobId !== "string") throw new AgentError(GENERIC);

  const url = new URL(`/api/chat/jobs/${encodeURIComponent(started.jobId)}`, API_URL);
  let missed = 0;
  for (const until = Date.now() + FOLLOW_MS; Date.now() < until; ) {
    await sleep(POLL_MS);
    let body: Partial<AgentReply> & { status?: string; steps?: unknown; error?: string };
    let ok: boolean;
    try {
      // A fresh token each time: a long run can outlast the one the message was sent with.
      const current = await getAccessToken();
      if (!current) throw new AgentError(MESSAGES.unauthorized);
      const read = await fetch(url, { headers: { Authorization: `Bearer ${current}` }, signal: AbortSignal.timeout(15_000) });
      ok = read.ok;
      body = (await read.json().catch(() => ({}))) as typeof body;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (++missed >= MISSED_READS) throw new AgentError(STILL_WORKING);
      continue;
    }
    missed = 0;
    if (!ok) throw new AgentError(body.error === "not_found" ? STILL_WORKING : (MESSAGES[body.error ?? ""] ?? GENERIC));
    if (body.status === "running") {
      if (Array.isArray(body.steps)) onSteps(body.steps.filter((s): s is string => typeof s === "string"));
      continue;
    }
    if (typeof body.report !== "string") throw new AgentError(GENERIC);
    return body as AgentReply;
  }
  throw new AgentError(STILL_WORKING);
}
