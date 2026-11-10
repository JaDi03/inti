import { useCallback, useEffect, useMemo, useState } from "react";
import { LimitsClient, type LimitsStatus } from "./client";
import { loadLimitsConfig, type LimitsConfig } from "./config";

export type LimitsSetup =
  | { kind: "ready"; config: LimitsConfig; client: LimitsClient }
  | { kind: "error"; message: string };

/** Shown instead of the app when its settings are incomplete. */
export const UNAVAILABLE = "Inti is not available right now. Please try again later.";

/** How often the account is re-read while the app waits for funds to arrive. */
const POLL_MS = 5000;

/**
 * Spending Limits state for the user's account.
 * `poll` re-reads the account every few seconds (used while waiting for funds).
 */
export function useLimits(address: string | null, poll: boolean) {
  const setup = useMemo((): LimitsSetup => {
    try {
      const config = loadLimitsConfig();
      return { kind: "ready", config, client: new LimitsClient(config) };
    } catch (e) {
      // The missing setting is for the operator; the user only sees that Inti is unavailable.
      console.error(e);
      return { kind: "error", message: UNAVAILABLE };
    }
  }, []);

  const [status, setStatus] = useState<LimitsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = setup.kind === "ready" ? setup.client : null;

  const refresh = useCallback(async () => {
    if (!client || !address) return;
    try {
      setStatus(await client.status(address));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read your account.");
    }
  }, [client, address]);

  // A new account starts from an unknown status.
  useEffect(() => {
    setStatus(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll, refresh]);

  return { setup, status, error, refresh };
}
