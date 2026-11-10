import { useLinkWithPasskey, useMfaEnrollment, usePrivy, useUser, type User } from "@privy-io/react-auth";
import { Fingerprint, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** True once the user has a passkey. Privy then asks for it before the wallet signs. */
export function useHasPasskey(): boolean {
  const { user } = usePrivy();
  return (user?.mfaMethods ?? []).includes("passkey");
}

/**
 * Asks the user to add a passkey. Once enrolled, Privy requires it before the wallet signs,
 * so code running in the page alone cannot sign. Inti does not sign without one.
 */
/** Credential ids of the passkeys linked to the user. */
function passkeyIds(user: User | null): string[] {
  return (user?.linkedAccounts ?? []).flatMap((a) => (a.type === "passkey" ? [a.credentialId] : []));
}

export function PasskeyProtection() {
  const hasPasskey = useHasPasskey();
  const { user, refreshUser } = useUser();
  const { linkWithPasskey } = useLinkWithPasskey();
  const { initEnrollmentWithPasskey, submitEnrollmentWithPasskey } = useMfaEnrollment();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (hasPasskey) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Fingerprint className="size-4 text-primary" /> Every signature asks for your passkey.
      </p>
    );
  }

  const enroll = async () => {
    setBusy(true);
    setError(null);
    try {
      // Privy enrolls a passkey as a second factor in three steps: link one to the account, start the
      // enrollment, then confirm it with the linked passkeys (docs.privy.io, MFA enrollment with passkeys).
      let ids = passkeyIds(user);
      if (ids.length === 0) {
        await linkWithPasskey({ name: "Inti" });
        ids = passkeyIds(await refreshUser());
      }
      if (ids.length === 0) throw new Error("no passkey linked");
      await initEnrollmentWithPasskey();
      await submitEnrollmentWithPasskey({ credentialIds: ids });
      await refreshUser();
    } catch {
      setError("The passkey was not added. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-dashed p-3 text-sm">
      <p>Add a passkey so every signature asks for your fingerprint, face or security key. Inti does not sign without it.</p>
      <Button className="mt-2" size="sm" disabled={busy} onClick={() => void enroll()}>
        {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />} Add a passkey
      </Button>
      {error && <p className="mt-2 text-destructive">{error}</p>}
    </div>
  );
}
