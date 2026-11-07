import { useCallback, useEffect, useMemo, useState } from "react";
import { useNetwork } from "../network";
import { LimitsClient, type LimitsStatus } from "./client";
import { loadLimitsConfig, NetworkNotReadyError, type LimitsConfig } from "./config";

export type LimitsSetup =
  | { kind: "ready"; config: LimitsConfig; client: LimitsClient }
  | { kind: "not-ready"; message: string }
  | { kind: "error"; message: string };

/** How often the account is re-read while the app waits for funds to arrive. */
const POLL_MS = 5000;

/**
 * Spending Limits state for the user's account on the selected network.
 * `poll` re-reads the account every few seconds (used while waiting for funds).
 */
export function useLimits(address: string | null, poll: boolean) {
  const { network } = useNetwork();
  const setup = useMemo((): LimitsSetup => {
    try {
      const config = loadLimitsConfig(network);
      return { kind: "ready", config, client: new LimitsClient(config) };
    } catch (e) {
      if (e instanceof NetworkNotReadyError) return { kind: "not-ready", message: e.message };
      return { kind: "error", message: e instanceof Error ? e.message : "Spending Limits is not configured." };
    }
  }, [network]);

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

  // A new network or account starts from an unknown status.
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
