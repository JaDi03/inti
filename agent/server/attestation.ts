import { getCollateralAndVerify, INTEL_PCS_URL } from "@phala/dcap-qvl";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { NEAR_AI_BASE_URL } from "../brains/nearai.js";

/**
 * Checks that the model behind Inti runs inside attested hardware, following NEAR AI Cloud's
 * verification docs (docs.near.ai/cloud/verification): a fresh nonce, the Intel TDX quote checked
 * against Intel's own certificates, the quote binding the nonce and the model's signing key, the
 * measured software, and NVIDIA's verdict on the GPU. It proves where the model runs, not that a
 * given reply came from it. Nothing is stored.
 */

/** The facts read from a verified Intel TDX quote that the checks need. */
export interface VerifiedQuote {
  /** Intel's TCB status for the platform, e.g. "UpToDate". */
  status: string;
  reportData: Uint8Array;
  rtMr3: Uint8Array;
  mrConfigId: Uint8Array;
  tdAttributes: Uint8Array;
}

export interface AttestationDeps {
  fetch: typeof fetch;
  /** Verifies a raw TDX quote against Intel's certificates; throws when it does not verify. */
  verifyQuote: (quote: Uint8Array) => Promise<VerifiedQuote>;
  /** 32 random bytes as hex. */
  nonce: () => string;
  now: () => number;
}

export const ATTESTATION_CHECKS = ["report", "nonce", "intel", "not_debug", "binds_nonce", "binds_key", "software", "config", "gpu"] as const;
export type AttestationCheckId = (typeof ATTESTATION_CHECKS)[number];

export interface ModelAttestation {
  model: string;
  ok: boolean;
  checks: { id: AttestationCheckId; ok: boolean }[];
  signingAddress: string | null;
  intelStatus: string | null;
  checkedAt: string;
}

/** Intel's verdict a platform must have: no pending updates or advisories. */
const ACCEPTED_TCB = new Set(["UpToDate"]);
const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const STEP_TIMEOUT_MS = 20_000;

const hex = z.string().regex(/^[0-9a-f]*$/i);
const eventSchema = z.object({ imr: z.number().int(), event_type: z.number().int().nonnegative(), event: z.string(), event_payload: hex });
const modelSchema = z.object({
  model_name: z.string().optional(),
  signing_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signing_algo: z.literal("ecdsa"),
  request_nonce: z.string(),
  intel_quote: hex.min(2),
  nvidia_payload: z.string().optional(),
  event_log: z.union([z.string(), z.array(z.unknown())]),
  info: z.object({ tcb_info: z.union([z.string(), z.record(z.string(), z.unknown())]) }),
});
const reportSchema = z.object({ model_attestations: z.array(z.unknown()).optional() });
const appComposeSchema = z.object({ app_compose: z.string() });
const gpuPayloadSchema = z.object({ nonce: z.string() });
/** NRAS answers the overall verdict first (["JWT", token]), then one token per GPU. */
const nrasSchema = z.tuple([z.tuple([z.literal("JWT"), z.string()])], z.unknown());

const parseJson = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const equalHex = (a: Uint8Array, b: string) => Buffer.from(a).toString("hex") === b.toLowerCase();

/** Intel's quote check, with certificates from Intel's own Provisioning Certification Service. */
export async function verifyQuoteWithIntel(quote: Uint8Array): Promise<VerifiedQuote> {
  const verified = await getCollateralAndVerify(quote, INTEL_PCS_URL);
  const data = verified.report.data as unknown as Partial<VerifiedQuote> & { base?: Partial<VerifiedQuote> };
  const td = data.base ?? data;
  if (!td.reportData || !td.rtMr3 || !td.mrConfigId || !td.tdAttributes) throw new Error("not a TDX report");
  return { status: verified.status, reportData: td.reportData, rtMr3: td.rtMr3, mrConfigId: td.mrConfigId, tdAttributes: td.tdAttributes };
}

export const liveAttestationDeps: AttestationDeps = {
  fetch,
  verifyQuote: verifyQuoteWithIntel,
  nonce: () => randomBytes(32).toString("hex"),
  now: Date.now,
};

/** Replays the runtime events measured into RTMR3 (index 3 only), as NEAR AI's docs describe. */
function replayRtmr3(events: z.infer<typeof eventSchema>[]): string {
  let rtmr = Buffer.alloc(48);
  for (const e of events.filter((x) => x.imr === 3)) {
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type);
    const digest = createHash("sha384").update(Buffer.concat([type, Buffer.from(":"), Buffer.from(e.event), Buffer.from(":"), Buffer.from(e.event_payload, "hex")])).digest();
    rtmr = createHash("sha384").update(Buffer.concat([rtmr, digest])).digest();
  }
  return rtmr.toString("hex");
}

const withTimeout = <T>(work: Promise<T>): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), STEP_TIMEOUT_MS).unref())]);

/** Most machines one check verifies; each costs a quote check with Intel and one with NVIDIA. */
const MAX_MACHINES = 8;

/**
 * Runs every check once, with a fresh nonce. NEAR AI may serve the model from several machines;
 * all of them must name this model and share one signing key, so a reply's signature points to a
 * single key, and every machine must pass every check. A step that cannot run counts as failed.
 */
export async function attestModel(model: string, deps: AttestationDeps): Promise<ModelAttestation> {
  const passed = new Set<AttestationCheckId>();
  const nonce = deps.nonce();
  let signingAddress: string | null = null;
  let intelStatus: string | null = null;
  try {
    const url = new URL(`${NEAR_AI_BASE_URL}/attestation/report`);
    for (const [k, v] of Object.entries({ model, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce })) url.searchParams.set(k, v);
    const res = await deps.fetch(url, { headers: { Accept: "application/json", "x-no-aliasing": "true" }, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`report HTTP ${res.status}`);
    const reports = reportSchema.parse(await res.json()).model_attestations ?? [];
    if (reports.length === 0 || reports.length > MAX_MACHINES) throw new Error("no usable model reports");
    const machines = reports.map((r) => modelSchema.parse(r));
    // One key for every machine: with several, a reply's signature could not be tied to one check.
    const keys = new Set(machines.map((m) => m.signing_address.toLowerCase()));
    if (keys.size !== 1 || machines.some((m) => m.model_name !== undefined && m.model_name !== model)) throw new Error("machines disagree");
    passed.add("report");
    signingAddress = [...keys][0] ?? null;
    const results = await Promise.all(machines.map((m) => checkMachine(m, nonce, deps)));
    for (const id of ATTESTATION_CHECKS) if (id !== "report" && results.every((r) => r.passed.has(id))) passed.add(id);
    const statuses = [...new Set(results.flatMap((r) => (r.intelStatus === null ? [] : [r.intelStatus])))];
    intelStatus = statuses.length > 0 ? statuses.join(", ") : null;
  } catch {
    // The checks not reached stay failed; the reason is not shown to the user.
  }
  const checks = ATTESTATION_CHECKS.map((id) => ({ id, ok: passed.has(id) }));
  return { model, ok: checks.every((c) => c.ok), checks, signingAddress, intelStatus, checkedAt: new Date(deps.now()).toISOString() };
}

/** The checks one machine's report passes. A step that cannot run leaves the rest failed. */
async function checkMachine(m: z.infer<typeof modelSchema>, nonce: string, deps: AttestationDeps): Promise<{ passed: Set<AttestationCheckId>; intelStatus: string | null }> {
  const passed = new Set<AttestationCheckId>();
  let intelStatus: string | null = null;
  const signingAddress = m.signing_address.toLowerCase();
  try {
    if (m.request_nonce === nonce) passed.add("nonce");

    const quote = await withTimeout(deps.verifyQuote(Buffer.from(m.intel_quote, "hex")));
    intelStatus = quote.status;
    if (ACCEPTED_TCB.has(quote.status)) passed.add("intel");
    // TD attribute bit 0 is DEBUG: a debug TD lets its host read its memory.
    if (((quote.tdAttributes[0] ?? 1) & 1) === 0) passed.add("not_debug");
    // Report data: the signing key in the first 32 bytes (20-byte address, zero padded), the nonce in the last 32.
    const reportData = Buffer.from(quote.reportData).toString("hex");
    if (reportData.slice(64) === nonce) passed.add("binds_nonce");
    if (reportData.slice(0, 64) === signingAddress.slice(2).padEnd(64, "0")) passed.add("binds_key");

    const events = z.array(eventSchema).parse(parseJson(m.event_log));
    if (equalHex(quote.rtMr3, replayRtmr3(events))) passed.add("software");
    const compose = appComposeSchema.parse(parseJson(m.info.tcb_info)).app_compose;
    const configId = Buffer.concat([Buffer.from([1]), createHash("sha256").update(compose).digest(), Buffer.alloc(15)]).toString("hex");
    if (equalHex(quote.mrConfigId, configId)) passed.add("config");

    if (m.nvidia_payload && gpuPayloadSchema.parse(JSON.parse(m.nvidia_payload)).nonce === nonce) {
      const nras = await deps.fetch(NRAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: m.nvidia_payload,
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      if (nras.ok) {
        // NVIDIA's verdict, trusted as it comes over TLS from NVIDIA, as NEAR AI's docs' minimal flow does.
        const jwt = nrasSchema.parse(await nras.json())[0][1];
        const claims = z
          .object({ "x-nvidia-overall-att-result": z.boolean(), eat_nonce: z.string() })
          .parse(JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()));
        if (claims["x-nvidia-overall-att-result"] && claims.eat_nonce === nonce) passed.add("gpu");
      }
    }
  } catch {
    // The checks not reached stay failed for this machine.
  }
  return { passed, intelStatus };
}
