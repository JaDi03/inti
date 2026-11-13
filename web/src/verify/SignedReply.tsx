import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { FAILURE_TEXT, fetchReplyProof, type ReplyProof } from "./verifyClient";

/** A signature not ready yet is asked for once more after this pause. */
const RETRY_MS = 4000;

/**
 * The line under one of Inti's replies that says whether the AI model's calls behind it were signed
 * by the key found in the verified chip. Tap it for the details.
 */
export function SignedReply({ proofId, getAccessToken }: { proofId: string; getAccessToken: () => Promise<string | null> }) {
  const [proof, setProof] = useState<ReplyProof | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        for (let attempt = 0; attempt < 2 && current; attempt++) {
          const token = await getAccessToken();
          if (!token) throw new Error("Sign in again to check this reply.");
          const result = await fetchReplyProof(token, proofId);
          if (!current) return;
          setProof(result);
          if (!result.calls.some((c) => c.failure === "unavailable")) return;
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      } catch (e) {
        if (current) setError(e instanceof Error ? e.message : "The check could not run right now.");
      }
    })();
    return () => {
      current = false;
    };
  }, [proofId, getAccessToken]);

  const signed = proof?.ok === true;
  const failure = proof?.calls.find((c) => c.failure)?.failure ?? null;
  const label = proof ? (signed ? "Signed by the verified AI model" : "Not proven") : error ? "Signature not checked" : "Checking signature…";
  return (
    <div className="mt-1 px-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn("flex items-center gap-1", signed ? "text-primary" : "text-muted-foreground")}
      >
        {!proof && !error ? <Loader2 className="size-3 animate-spin" /> : signed ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3" />}
        {label}
      </button>
      {open && (
        <div className="mt-1 max-w-[min(85vw,420px)] rounded-xl bg-muted px-3 py-2 text-muted-foreground">
          {proof && signed && (
            <p>
              Each of the {proof.calls.length} AI model {proof.calls.length === 1 ? "call" : "calls"} behind this reply was signed, inside the chip, over the exact words sent and received,
              by the key the hardware check found. That key is shared by the model's machines.
            </p>
          )}
          {proof && !signed && failure && <p>Not proven: {FAILURE_TEXT[failure]}.</p>}
          {error && <p>{error}</p>}
          {proof?.attestedKey && (
            <p className="mt-1 break-all">
              Key: <code>{proof.attestedKey}</code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
