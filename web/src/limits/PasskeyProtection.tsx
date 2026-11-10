import { useMfaEnrollment, usePrivy } from "@privy-io/react-auth";
import { Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";

/** True once the user has any second factor (passkey, authenticator app or SMS), whichever they chose. */
export function useHasSecondFactor(): boolean {
  const { user } = usePrivy();
  return (user?.mfaMethods ?? []).length > 0;
}

/**
 * Asks the user to add a passkey (or an authenticator app) as a second factor. Once enrolled,
 * Privy requires it before the wallet signs, so code running in the page alone cannot sign.
 */
export function PasskeyProtection() {
  const { user } = usePrivy();
  const { showMfaEnrollmentModal } = useMfaEnrollment();
  const methods = user?.mfaMethods ?? [];

  if (methods.length > 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p className="flex items-center gap-2">
          <Fingerprint className="size-4 text-primary" /> Every signature asks for your {methods.includes("passkey") ? "passkey" : "authenticator code"}.
        </p>
        {/* Privy's window to add or remove methods, so a lost device never locks the user out. */}
        <Button size="sm" variant="ghost" onClick={showMfaEnrollmentModal}>
          Manage
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-dashed p-3 text-sm">
      <p>Protect your account: add a passkey so every signature asks for your fingerprint, face or security key.</p>
      <Button className="mt-2" size="sm" onClick={showMfaEnrollmentModal}>
        <Fingerprint /> Add a passkey
      </Button>
    </div>
  );
}
