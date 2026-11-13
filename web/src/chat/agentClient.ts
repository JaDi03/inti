/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

export interface AgentReply {
  simulated: boolean;
  report: string;
  stopReason: string;
  events: Array<Record<string, string>>;
  responseIds: string[];
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

export async function askAgent(accessToken: string, message: string): Promise<AgentReply> {
  if (!API_URL) throw new AgentError("Inti's server is not configured yet.");
  let res: Response;
  try {
    res = await fetch(new URL("/api/chat", API_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    // The server got the message and may still be running an order: a retry could buy twice.
    if (error instanceof DOMException && error.name === "TimeoutError") throw new AgentError(STILL_WORKING);
    throw new AgentError("I couldn't reach Inti's server. Check your connection and retry.");
  }
  const body = (await res.json().catch(() => ({}))) as Partial<AgentReply> & { error?: string };
  if (!res.ok) throw new AgentError(MESSAGES[body.error ?? ""] ?? GENERIC);
  if (typeof body.report !== "string") throw new AgentError(GENERIC);
  return body as AgentReply;
}
