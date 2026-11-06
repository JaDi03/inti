import type { Policy } from "@near-intents-agent-api/sdk";

/** Recursively sorts object keys so two equal policies serialize the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function diff(expected: unknown, received: unknown, path: string, out: string[]): void {
  if (JSON.stringify(canonical(expected)) === JSON.stringify(canonical(received))) return;
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(expected) && isObj(received)) {
    for (const k of new Set([...Object.keys(expected), ...Object.keys(received)])) {
      diff(expected[k], received[k], path ? `${path}.${k}` : k, out);
    }
    return;
  }
  out.push(path || "(root)");
}

/** Paths where the received policy differs from the one Inti built. Empty means identical. */
export function policyDifferences(expected: Policy, received: unknown): string[] {
  const out: string[] = [];
  diff(expected, received, "", out);
  return out;
}

/**
 * Round-trip check before asking the owner to sign: the policy in the API's
 * preview must be exactly the one Inti built. Any difference aborts.
 */
export function assertPolicyMatches(expected: Policy, received: unknown): void {
  const differences = policyDifferences(expected, received);
  if (differences.length > 0) {
    throw new Error(`policy mismatch, refusing to sign: ${differences.join(", ")}`);
  }
}
