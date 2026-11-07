import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useExportWallet } from "@privy-io/react-auth/extended-chains";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PromptInput } from "@/components/ui/ai-chat-input";
import { Button } from "@/components/ui/button";
import { IntiMascot } from "@/components/ui/inti-mascot";
import { cn } from "@/lib/utils";
import { SpendingLimitsPanel } from "./limits/SpendingLimitsPanel";
import { logoSrc, ThemeToggle, useTheme } from "./theme";

type Message = { id: number; from: "user" | "inti"; text: string };

/** Shown until the chat is wired to the agent (next step). */
const NOT_CONNECTED = "I'm not connected to the agent yet. Soon I'll be able to answer you and act for you.";

/** The user's Privy NEAR wallet address (implicit account id), if any. */
function nearAddress(accounts: readonly unknown[]): string | null {
  for (const account of accounts) {
    const a = account as { type?: string; chainType?: string; address?: string };
    if (a.type === "wallet" && a.chainType === "near" && typeof a.address === "string") return a.address;
  }
  return null;
}

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address;
}

function Wordmark({ className }: { className?: string }) {
  return <span className={cn("font-heading font-bold tracking-tight text-primary", className)}>Inti</span>;
}

function Welcome({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="absolute top-3 right-4">
        <ThemeToggle />
      </div>
      <IntiMascot size={220} />
      <div>
        <Wordmark className="text-6xl" />
        <p className="mt-2 text-lg text-muted-foreground">The AI for your Intents</p>
      </div>
      <Button size="lg" className="h-11 rounded-full px-8 text-base" onClick={onLogin}>
        Sign in with email or Google
      </Button>
    </main>
  );
}

export function App() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { theme } = useTheme();
  const { createWallet } = useCreateWallet();
  const { exportWallet } = useExportWallet();
  const [messages, setMessages] = useState<Message[]>([]);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const creating = useRef(false);
  const nextId = useRef(1);

  const address = user ? nearAddress(user.linkedAccounts) : null;

  // Every user needs a NEAR wallet; create it once, without asking.
  useEffect(() => {
    if (!authenticated || !user || address !== null || creating.current) return;
    creating.current = true;
    createWallet({ chainType: "near" }).catch((e: unknown) => {
      creating.current = false;
      setWalletError(e instanceof Error ? e.message : "Could not create your NEAR account.");
    });
  }, [authenticated, user, address, createWallet]);

  if (!ready) return <main className="flex min-h-svh items-center justify-center text-muted-foreground">Loading...</main>;
  if (!authenticated || !user) return <Welcome onLogin={login} />;

  const send = (text: string) => {
    const userMsg: Message = { id: nextId.current++, from: "user", text };
    const reply: Message = { id: nextId.current++, from: "inti", text: NOT_CONNECTED };
    setMessages((prev) => [...prev, userMsg, reply]);
  };

  const empty = messages.length === 0;

  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <img src={logoSrc(theme)} alt="Inti" className="h-8 w-auto" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {address && (
            <code className="rounded-full bg-muted px-3 py-1 text-xs" title={address}>
              {shortAddress(address)}
            </code>
          )}
          {address && (
            <Button variant="ghost" size="icon" aria-label="Spending limits" title="Spending limits" onClick={() => setLimitsOpen(true)}>
              <ShieldCheck />
            </Button>
          )}
          {address && (
            // Privy's own modal shows the key; it never reaches Inti's code.
            <Button
              variant="ghost"
              size="icon"
              aria-label="Export wallet"
              title="Export wallet"
              onClick={() => void exportWallet({ address }).catch(() => undefined)}
            >
              <KeyRound />
            </Button>
          )}
          <ThemeToggle />
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void logout()}>
            <LogOut />
          </Button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center px-4">
        <div className={cn("flex w-full max-w-2xl flex-col items-center transition-all duration-500", empty ? "mt-[12vh]" : "mt-2")}>
          <IntiMascot size={empty ? 180 : 96} />
          {empty && (
            <h1 className="mt-4 text-center text-2xl font-semibold text-foreground sm:text-3xl">
              What do you want to do with your money?
            </h1>
          )}
        </div>

        {!empty && (
          <ol className="flex w-full max-w-2xl flex-1 flex-col gap-3 overflow-y-auto py-4" aria-live="polite">
            {messages.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                  m.from === "user" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted text-foreground",
                )}
              >
                {m.text}
              </li>
            ))}
          </ol>
        )}

        <div className={cn("flex w-full justify-center pb-6", empty ? "mt-8" : "mt-auto")}>
          <PromptInput onSubmit={send} placeholder="e.g. invest $40 in NEAR" />
        </div>
        {walletError && <p className="pb-4 text-sm text-destructive">{walletError}</p>}
      </main>
      {limitsOpen && address && <SpendingLimitsPanel address={address} onClose={() => setLimitsOpen(false)} />}
    </div>
  );
}
