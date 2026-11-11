import { describe, expect, it } from "vitest";
import { agentPolicy } from "../policy/agentPolicy.js";
import { agentApiAccounts } from "./agents.js";

const OWNER = "91".repeat(32);
const AGENT = "ea".repeat(32);

/** An Agent API stand-in: answers the policy view and records every generate-intent body. */
function api(cooldown: string | null) {
  const generated: unknown[] = [];
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path === `/v1/agents/${AGENT}/policy`) {
      return Promise.resolve(Response.json({ revision: 4, cooldowns: { policy_change_available_at: cooldown, unfreeze_available_at: null } }));
    }
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
