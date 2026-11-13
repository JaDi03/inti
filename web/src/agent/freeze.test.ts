import { describe, expect, it } from "vitest";
import { agentPolicy } from "../../../agent/policy/agentPolicy";
import { frozenRulesAreSafe } from "./freeze";

const OWNER = "91".repeat(32);
const frozen = (changes: Record<string, unknown> = {}) => ({ ...agentPolicy(OWNER, 200), frozen: true, ...changes });
// An agent created before the Agent API took only confidential transfers also lists a plain one, to the owner.
const OLDER_LIST = [{ action: "transfer", address: OWNER, confidential: false }, ...agentPolicy(OWNER).destinations.list];

describe("frozenRulesAreSafe", () => {
  it("accepts the owner's rules marked frozen, including an older agent's extra transfer to the owner", () => {
    expect(frozenRulesAreSafe(frozen(), OWNER, 200)).toBe(true);
    expect(frozenRulesAreSafe(frozen({ destinations: { mode: "only", list: OLDER_LIST } }), OWNER, 200)).toBe(true);
  });

  it("checks an unfreeze against the same rules, marked not frozen", () => {
    expect(frozenRulesAreSafe(frozen({ frozen: false, destinations: { mode: "only", list: OLDER_LIST } }), OWNER, 200, false)).toBe(true);
    expect(frozenRulesAreSafe(frozen(), OWNER, 200, false)).toBe(false);
  });

  it.each([
    ["not marked frozen", frozen({ frozen: false })],
    ["another price protection", frozen({ limit_order: { max_deviation_bps: 300 } })],
    ["a destination that is not the owner", frozen({ destinations: { mode: "only", list: [...OLDER_LIST, { action: "transfer", address: "ab".repeat(32), confidential: true }] } })],
    ["any destination allowed", frozen({ destinations: { mode: "any", list: OLDER_LIST } })],
    ["no destination at all", frozen({ destinations: { mode: "only", list: [] } })],
    ["a withdrawal to another chain", frozen({ destinations: { mode: "only", list: [{ action: "withdraw", chain: "eth", address: OWNER, memo: null }] } })],
    ["a destination with an extra field", frozen({ destinations: { mode: "only", list: [{ action: "transfer", address: OWNER, confidential: true, via: "x" }] } })],
    ["more actions per hour", frozen({ max_actions_per_hour: 1000 })],
    ["not an object", null],
  ])("refuses rules %s", (_name, policy) => {
    expect(frozenRulesAreSafe(policy, OWNER, 200)).toBe(false);
  });
});
