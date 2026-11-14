import type { DashboardData } from "../dashboard/dashboardClient";
/** Public URL of Inti's agent API (INTI_API_URL in the root .env). Not a secret. */
const API_URL = (import.meta.env as Record<string, string | undefined>).INTI_API_URL;

export interface DryRunLogEntry {
  tool: string;
  asked: Record<string, string>;
  request: { route: string; body: Record<string, string> } | null;
  answer: Record<string, string>;
}

export interface FundStep {
  place: "wallet" | "agent" | "intents";
  text: string;
}

export interface DryRunReply {
  report: string;
  log: DryRunLogEntry[];
  steps: FundStep[];
}

const MESSAGES: Record<string, string> = {
  user_limit: "You reached today's limit of dry-run messages. Open the app to keep going.",
  server_limit: "The dry run is very busy today. Try again tomorrow, or open the app.",
  rate_limited: "Too many messages in a minute. Wait a moment and retry.",
  busy: "A few dry-run messages from your network are still running. Wait for one to finish.",
  dry_run_full: "Many people are trying the dry run right now. Try again in a minute.",
  agent_paused: "Inti is paused for maintenance. Try again later.",
  agent_unavailable: "I couldn't reach my tools right now. Try again in a minute.",
};
const GENERIC = "Something went wrong. Try again in a minute.";

export class DryRunError extends Error {}

const record = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string");

/** Sends one message to the dry run. No sign-in: nothing here can move money. */
export async function askDryRun(message: string): Promise<DryRunReply> {
  if (!API_URL) throw new DryRunError("Inti's server is not configured yet.");
  let res: Response;
  try {
    res = await fetch(new URL("/api/dry-run/chat", API_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new DryRunError("I couldn't reach Inti's server. Check your connection and retry.");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new DryRunError(MESSAGES[typeof body.error === "string" ? body.error : ""] ?? GENERIC);
  // Only the fields the page shows, each checked: text that is not a string is dropped.
  const log = Array.isArray(body.log)
    ? body.log.flatMap((e: unknown): DryRunLogEntry[] => {
        const entry = e as Record<string, unknown>;
        if (typeof entry.tool !== "string" || !record(entry.asked) || !record(entry.answer)) return [];
        const req = entry.request as { route?: unknown; body?: unknown } | null;
        const request = req && typeof req.route === "string" && record(req.body) ? { route: req.route, body: req.body } : null;
        return [{ tool: entry.tool, asked: entry.asked, request, answer: entry.answer }];
      })
    : [];
  const steps = Array.isArray(body.steps)
    ? body.steps.flatMap((s: unknown): FundStep[] => {
        const step = s as Record<string, unknown>;
        return (step.place === "wallet" || step.place === "agent" || step.place === "intents") && typeof step.text === "string" ? [{ place: step.place, text: step.text }] : [];
      })
    : [];
  return { report: typeof body.report === "string" ? body.report : "", log, steps };
}

/** The practice wallet's dashboard: live prices and the rules every agent signs. Null when it cannot be read. */
export async function fetchPracticeDashboard(): Promise<DashboardData | null> {
  if (!API_URL) return null;
  try {
    const res = await fetch(new URL("/api/dry-run/dashboard", API_URL), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as DashboardData;
    return typeof body === "object" && body !== null && typeof body.prices === "object" && body.prices !== null ? body : null;
  } catch {
    return null;
  }
}
