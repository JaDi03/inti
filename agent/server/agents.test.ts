import { describe, expect, it } from "vitest";
import { agentPolicy } from "../policy/agentPolicy.js";
import { agentApiAccounts } from "./agents.js";

const OWNER = "91".repeat(32);
const AGENT = "ea".repeat(32);

const live = (id: string, changes: Record<string, unknown> = {}) => ({
  grant_id: id.repeat(64),
  label: "Inti trading",
  expires_at: "2999-01-01T00:00:00.000Z",
  revoked_at: null,
  ...changes,
});

/** An Agent API stand-in: answers the policy view and the grant list, and records every generate-intent body. */
function api(cooldown: string | null, grants: unknown[] = []) {
  const generated: unknown[] = [];
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path === `/v1/agents/${AGENT}/policy`) {
      return Promise.resolve(Response.json({ revision: 4, cooldowns: { policy_change_available_at: cooldown, unfreeze_available_at: null } }));
    }
    if (path === `/v1/agents/${AGENT}/grants`) return Promise.resolve(Response.json({ data: grants }));
    if (path === "/v1/generate-intent") {
      generated.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({ correlation_id: "intent_x", intent: { standard: "nep413" }, preview: { summary: "s", policy: {} } }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  return { accounts: agentApiAccounts("key", "https://api.example", fetcher as typeof fetch), generated };
}

describe("preparePolicy", () => {
  it("asks for Inti's own rules with only the chosen price protection, on top of the current revision", async () => {
    const { accounts, generated } = api(null);
    expect(await accounts.preparePolicy(AGENT, OWNER, 100)).toMatchObject({ status: "pending_signature", correlationId: "intent_x" });
    expect(generated).toEqual([{ type: "policy_update", agent_id: AGENT, policy: agentPolicy(OWNER, 100), expected_revision: 4 }]);
  });

  it("asks for nothing while the Agent API is still waiting between changes", async () => {
    const { accounts, generated } = api("2999-01-01T00:00:00.000Z");
    expect(await accounts.preparePolicy(AGENT, OWNER, 200)).toEqual({ status: "cooldown", availableAt: "2999-01-01T00:00:00.000Z" });
    expect(generated).toEqual([]);
    const past = api("2000-01-01T00:00:00.000Z");
    expect((await past.accounts.preparePolicy(AGENT, OWNER, 200)).status).toBe("pending_signature");
  });
});

describe("prepareFreeze", () => {
  it("asks for a freeze of exactly this agent, and passes the rules preview on for the owner's check", async () => {
    const { accounts, generated } = api(null);
    expect(await accounts.prepareFreeze(AGENT, true)).toEqual({ status: "pending_signature", correlationId: "intent_x", intent: { standard: "nep413" }, preview: { policy: {} } });
    await accounts.prepareFreeze(AGENT, false);
    expect(generated).toEqual([
      { type: "agent_freeze", agent_id: AGENT },
      { type: "agent_unfreeze", agent_id: AGENT },
    ]);
  });

  it("says an agent already in that state needs nothing signed, and treats any other refusal as an outage", async () => {
    // The Agent API's own codes, as it answers them.
    const answer = (status: number, code: string) => () => Promise.resolve(Response.json({ errors: [{ status: String(status), code }] }, { status }));
    expect(await agentApiAccounts("key", "https://api.example", answer(409, "wallet_already_frozen") as typeof fetch).prepareFreeze(AGENT, true)).toEqual({ status: "already_frozen" });
    expect(await agentApiAccounts("key", "https://api.example", answer(409, "wallet_already_unfrozen") as typeof fetch).prepareFreeze(AGENT, false)).toEqual({ status: "already_unfrozen" });
    await expect(agentApiAccounts("key", "https://api.example", answer(409, "something_else") as typeof fetch).prepareFreeze(AGENT, true)).rejects.toThrow("agents_unavailable");
  });
});

describe("prepareRevokes", () => {
  it("closes only Inti's own grants that are still live, at most five", async () => {
    const grants = [
      live("1"),
      live("2", { label: "Another app" }),
      live("3", { revoked_at: "2026-11-01T00:00:00.000Z" }),
      live("4", { expires_at: "2000-01-01T00:00:00.000Z" }),
      ...["5", "6", "7", "8", "9", "a"].map((id) => live(id)),
    ];
    const { accounts, generated } = api(null, grants);
    expect(await accounts.prepareRevokes(AGENT)).toHaveLength(5);
    expect(generated.map((g) => (g as { grant_id: string }).grant_id[0])).toEqual(["1", "5", "6", "7", "8"]);
    expect(generated.every((g) => (g as { type: string }).type === "grant_revoke")).toBe(true);
  });
});
