import { useCallback, useEffect, useMemo, useState } from "react";
import { findAgent } from "../agent/createAgent";
import { LimitsClient, type LimitsStatus } from "./client";
import { loadLimitsConfig, type LimitsConfig } from "./config";

export type LimitsSetup =
  | { kind: "ready"; config: LimitsConfig; client: LimitsClient }
  | { kind: "error"; message: string };

/** Shown instead of the app when its settings are incomplete. */
export const UNAVAILABLE = "Inti is not available right now. Please try again later.";

/** How often the account is re-read while the app waits for funds to arrive. */
const POLL_MS = 5000;

/** The user's agent account is remembered in this browser, per account. */
const agentKey = (address: string) => `inti-agent:${address}`;

function savedAgent(address: string | null): string | null {
  if (!address) return null;
  try {
    const value = localStorage.getItem(agentKey(address));
    return value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Spending Limits state for the user's account, and the user's own agent account.
 * `poll` re-reads the account every few seconds (used while waiting for funds).
 */
export function useLimits(address: string | null, poll: boolean, getAccessToken: () => Promise<string | null>) {
  const [agentAccount, setAgentAccount] = useState<string | null>(null);
  const rememberAgent = useCallback(
    (agent: string) => {
      setAgentAccount(agent);
      if (!address) return;
      try {
        localStorage.setItem(agentKey(address), agent);
      } catch {
        // Storage can be blocked; the agent is found again through Inti's server.
      }
    },
    [address],
  );

  // The agent created in this browser, else the one Inti's server knows for this user.
  useEffect(() => {
    const saved = savedAgent(address);
    setAgentAccount(saved);
    if (!address || saved) return;
    let current = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        const found = token ? await findAgent(token, address) : null;
        if (current && found) rememberAgent(found);
      } catch {
        // No agent known yet: the setup offers to create one.
      }
    })();
    return () => {
      current = false;
    };
  }, [address, getAccessToken, rememberAgent]);

  const setup = useMemo((): LimitsSetup => {
    try {
      const config = loadLimitsConfig(agentAccount);
      return { kind: "ready", config, client: new LimitsClient(config) };
    } catch (e) {
      // The missing setting is for the operator; the user only sees that Inti is unavailable.
      console.error(e);
      return { kind: "error", message: UNAVAILABLE };
    }
  }, [agentAccount]);

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

  return { setup, status, error, refresh, agentAccount, rememberAgent };
}
