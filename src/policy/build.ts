import type { Policy } from "@near-intents-agent-api/sdk";
import { z } from "zod";
import { toAtomic, toUsd } from "./units.js";

/**
 * A policy draft in human units. Inti only builds policies with
 * destinations in "only" mode and never enables native methods, so funds
 * can only leave to addresses the owner listed. Field rules follow
 * https://docs.agentsonintents.com/integration/agent-api/policies-and-limits
 */
const decimalString = z.string().regex(/^\d+(\.\d+)?$/);
const usdString = z.string().regex(/^\d+(\.\d{1,2})?$/);

const assetSchema = z.object({
  assetId: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0),
  perTransaction: decimalString.optional(),
  daily: decimalString.optional(),
});

const destinationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("withdraw"),
    chain: z.string().min(1),
    address: z.string().min(1),
    memo: z.string().nullable().default(null),
  }),
  z.object({
    action: z.literal("transfer"),
    address: z.string().min(1),
    confidential: z.boolean().default(false),
  }),
]);

export const MAX_ASSETS = 128;
export const MAX_DESTINATIONS = 256;
export const MAX_TIMELOCK_MS = 2_592_000_000;

export const policyDraftSchema = z.object({
  actions: z.array(z.enum(["swap", "transfer", "withdraw"])).min(1),
  assets: z.array(assetSchema).min(1).max(MAX_ASSETS),
  destinations: z.array(destinationSchema).max(MAX_DESTINATIONS).default([]),
  budget: z
    .object({
      dailyUsd: usdString.nullable().default(null),
      weeklyUsd: usdString.nullable().default(null),
      monthlyUsd: usdString.nullable().default(null),
    })
    .default({ dailyUsd: null, weeklyUsd: null, monthlyUsd: null }),
  maxActionsPerHour: z.number().int().positive().nullable().default(null),
  timelockMs: z.number().int().min(0).max(MAX_TIMELOCK_MS).default(0),
  ownerApproval: z.boolean().default(false),
});

export type PolicyDraft = z.input<typeof policyDraftSchema>;

/** EVM addresses must be lowercase hex in the policy. */
function canonicalAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address;
}

export function buildPolicy(input: PolicyDraft): Policy {
  const draft = policyDraftSchema.parse(input);

  const ids = draft.assets.map((a) => a.assetId);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate asset_id in draft");

  const perTransaction: Record<string, string> = {};
  const daily: Record<string, string> = {};
  for (const asset of draft.assets) {
    if (asset.perTransaction) perTransaction[asset.assetId] = toAtomic(asset.perTransaction, asset.decimals);
    if (asset.daily) daily[asset.assetId] = toAtomic(asset.daily, asset.decimals);
  }

  const sendsOut = draft.actions.some((a) => a !== "swap");
  if (!sendsOut && draft.destinations.length > 0) {
    throw new Error("destinations listed but no transfer or withdraw action allowed");
  }
  for (const d of draft.destinations) {
    if (!draft.actions.includes(d.action)) {
      throw new Error(`destination for "${d.action}" but that action is not allowed`);
    }
  }

  return {
    frozen: false,
    actions: draft.actions,
    confidential: false,
    owner_approval: draft.ownerApproval,
    assets: ids,
    limits: {
      ...(Object.keys(perTransaction).length ? { per_transaction: perTransaction } : {}),
      ...(Object.keys(daily).length ? { daily } : {}),
    },
    max_actions_per_hour: draft.maxActionsPerHour,
    destinations: {
      mode: "only",
      list: draft.destinations.map((d) =>
        d.action === "withdraw"
          ? { action: "withdraw", chain: d.chain, address: canonicalAddress(d.address), memo: d.memo }
          : { action: "transfer", address: d.address, confidential: d.confidential },
      ),
    },
    budget: {
      daily_usd: draft.budget.dailyUsd === null ? null : toUsd(draft.budget.dailyUsd),
      weekly_usd: draft.budget.weeklyUsd === null ? null : toUsd(draft.budget.weeklyUsd),
      monthly_usd: draft.budget.monthlyUsd === null ? null : toUsd(draft.budget.monthlyUsd),
    },
    timelock_ms: draft.timelockMs,
  };
}
