import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attestModel, type AttestationDeps, type VerifiedQuote } from "./attestation.js";

// One real attestation of Inti's model, with what Intel's check read from its quote and NVIDIA's verdict.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/near-ai-attestation.json", import.meta.url), "utf8")) as {
  model: string;
  nonce: string;
  report: { model_attestations: Record<string, unknown>[] };
  quote: Record<keyof VerifiedQuote, string>;
  nras: Record<string, unknown>;
};

const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const realQuote = (): VerifiedQuote => ({
  status: fixture.quote.status,
  reportData: bytes(fixture.quote.reportData),
  rtMr3: bytes(fixture.quote.rtMr3),
  mrConfigId: bytes(fixture.quote.mrConfigId),
  tdAttributes: bytes(fixture.quote.tdAttributes),
});
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/** NEAR AI and NVIDIA answering as they did when the fixture was recorded, unless told otherwise. */
function world(
  opts: { report?: unknown; quote?: Partial<VerifiedQuote>; quoteFor?: (quote: Uint8Array) => Partial<VerifiedQuote>; quoteFails?: boolean; nras?: Record<string, unknown>; nonce?: string } = {},
) {
  const asked: string[] = [];
  const deps: AttestationDeps = {
    fetch: ((input: URL | string) => {
      const url = new URL(input.toString());
      asked.push(url.origin + url.pathname);
      if (url.hostname === "cloud-api.near.ai") return Promise.resolve(Response.json(opts.report ?? fixture.report));
      // NRAS's real shape: the overall verdict, then one token per GPU.
      return Promise.resolve(Response.json([["JWT", jwt(opts.nras ?? fixture.nras)], { "GPU-0": "token", "GPU-1": "token" }]));
    }) as typeof fetch,
    verifyQuote: (quote) => (opts.quoteFails ? Promise.reject(new Error("bad signature")) : Promise.resolve({ ...realQuote(), ...opts.quote, ...opts.quoteFor?.(quote) })),
    nonce: () => opts.nonce ?? fixture.nonce,
    now: () => Date.parse("2026-11-13T07:00:00Z"),
  };
  return { deps, asked };
}
const failed = (r: Awaited<ReturnType<typeof attestModel>>) => r.checks.filter((c) => !c.ok).map((c) => c.id);

describe("attestModel", () => {
  it("passes every check on a real attestation of Inti's model", async () => {
    const { deps, asked } = world();
    const result = await attestModel(fixture.model, deps);
    expect(failed(result)).toEqual([]);
    expect(result).toMatchObject({ ok: true, intelStatus: "UpToDate", checkedAt: "2026-11-13T07:00:00.000Z" });
    expect(result.signingAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(asked).toEqual(["https://cloud-api.near.ai/v1/attestation/report", "https://nras.attestation.nvidia.com/v3/attest/gpu"]);
  });

  it("fails when the report does not answer our own fresh nonce", async () => {
    const result = await attestModel(fixture.model, world({ nonce: "ab".repeat(32) }).deps);
    expect(result.ok).toBe(false);
    // An old report replayed to us: its nonce, its quote and the GPU verdict carry another nonce.
    expect(failed(result)).toEqual(["nonce", "binds_nonce", "gpu"]);
  });

  it("fails when Intel's check refuses the quote, and says nothing past it", async () => {
    const result = await attestModel(fixture.model, world({ quoteFails: true }).deps);
    expect(failed(result)).toEqual(["intel", "not_debug", "binds_nonce", "binds_key", "software", "config", "gpu"]);
  });

  it("fails on a platform Intel does not rate up to date, or a debug machine", async () => {
    expect(failed(await attestModel(fixture.model, world({ quote: { status: "OutOfDate" } }).deps))).toEqual(["intel"]);
    const debug = bytes(fixture.quote.tdAttributes);
    debug[0] = (debug[0] ?? 0) | 1;
    expect(failed(await attestModel(fixture.model, world({ quote: { tdAttributes: debug } }).deps))).toEqual(["not_debug"]);
  });

  it("fails when the quote binds another signing key or other software", async () => {
    const otherKey = bytes(fixture.quote.reportData);
    otherKey[0] = (otherKey[0] ?? 0) ^ 0xff;
    expect(failed(await attestModel(fixture.model, world({ quote: { reportData: otherKey } }).deps))).toEqual(["binds_key"]);
    expect(failed(await attestModel(fixture.model, world({ quote: { rtMr3: new Uint8Array(48) } }).deps))).toEqual(["software"]);
    expect(failed(await attestModel(fixture.model, world({ quote: { mrConfigId: new Uint8Array(48) } }).deps))).toEqual(["config"]);
  });

  it("fails when NVIDIA does not vouch for the GPU", async () => {
    expect(failed(await attestModel(fixture.model, world({ nras: { ...fixture.nras, "x-nvidia-overall-att-result": false } }).deps))).toEqual(["gpu"]);
  });

  it("fails without a report for this model, or when its machines do not share one signing key", async () => {
    const one = fixture.report.model_attestations[0];
    const otherKey = { ...one, signing_address: "0x" + "1".repeat(40) };
    for (const report of [
      {},
      { model_attestations: [] },
      { model_attestations: [{ ...one, model_name: "another/model" }] },
      { model_attestations: [one, { ...one, model_name: "another/model" }] },
      { model_attestations: [one, otherKey] },
      { model_attestations: Array.from({ length: 9 }, () => one) },
    ]) {
      const result = await attestModel(fixture.model, world({ report }).deps);
      expect(result.ok).toBe(false);
      expect(result.checks.every((c) => !c.ok)).toBe(true);
    }
  });

  it("passes when the model runs on several machines with one key and every machine passes, and fails if one does not", async () => {
    const one = fixture.report.model_attestations[0] ?? {};
    // A second machine: its own quote, the same key and software.
    const second = { ...one, intel_quote: "00" + String(one.intel_quote).slice(2) };
    const both = { model_attestations: [one, second] };
    const ok = world({ report: both });
    const result = await attestModel(fixture.model, ok.deps);
    expect(failed(result)).toEqual([]);
    expect(result).toMatchObject({ ok: true, intelStatus: "UpToDate" });
    expect(ok.asked.filter((u) => u.includes("nvidia"))).toHaveLength(2);
    // The second machine runs on a platform Intel does not rate up to date.
    const stale = await attestModel(fixture.model, world({ report: both, quoteFor: (q) => (q[0] === 0 ? { status: "OutOfDate" } : {}) }).deps);
    expect(failed(stale)).toEqual(["intel"]);
    expect(stale.intelStatus).toBe("UpToDate, OutOfDate");
  });
});
