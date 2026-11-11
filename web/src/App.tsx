import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useExportWallet } from "@privy-io/react-auth/extended-chains";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PromptInput } from "@/components/ui/ai-chat-input";
import { Button } from "@/components/ui/button";
import { IntiMascot } from "@/components/ui/inti-mascot";
import { cn } from "@/lib/utils";
import { AgentError, askAgent } from "./chat/agentClient";
import { ChatMessage, initialsOf, TypingIndicator } from "./chat/ChatMessage";
import { TradeGrantCard, useGrantNeeded } from "./agent/TradeGrantCard";
import { Dashboard } from "./dashboard/Dashboard";
import { ActivationCard } from "./limits/ActivationCard";
import { SpendingLimitsPanel } from "./limits/SpendingLimitsPanel";
import { UNAVAILABLE, useLimits } from "./limits/useLimits";
import { logoSrc, ThemeToggle, useTheme } from "./theme";

type Message = { id: number; from: "user" | "inti"; text: string; simulated?: boolean; orderWaiting?: boolean };

/** Inti knows the account is not set up yet and says what to do (first step of the agent knowing the state). */
const ACTIVATE_FIRST = "Before I can act for you, set up your spending limits. It takes 4 steps, right here.";

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
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { theme } = useTheme();
  const { createWallet } = useCreateWallet();
  const { exportWallet } = useExportWallet();
  const [messages, setMessages] = useState<Message[]>([]);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  // On a phone the chat and the portfolio take turns; on a wide screen both show.
  const [view, setView] = useState<"chat" | "portfolio">("chat");
  // True while the agent works on the user's message.
  const [thinking, setThinking] = useState(false);
  const creating = useRef(false);
  const nextId = useRef(1);
  const chatEnd = useRef<HTMLLIElement>(null);
  const chatList = useRef<HTMLOListElement>(null);
  // True while the user is reading the end of the conversation (not scrolled up).
  const followingEnd = useRef(true);

  // Keep the newest message (or the typing dots) in view.
  useEffect(() => {
    followingEnd.current = true;
    chatEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, thinking]);

  // When the prompt bar grows while typing, the list gets shorter: stay at the end if the user was there.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const list = chatList.current;
    if (!list) return;
    const observer = new ResizeObserver(() => {
      if (followingEnd.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [hasMessages]);

  const address = user ? nearAddress(user.linkedAccounts) : null;
  // Privy gives no profile photo for Google or email logins: the avatar shows initials.
  const userInitials = initialsOf(user?.google?.name ?? user?.google?.email ?? user?.email?.address);

  // Spending Limits status on the selected network. Re-read every few seconds until it is active.
  const [pollLimits, setPollLimits] = useState(false);
  const limits = useLimits(address, pollLimits, getAccessToken);
  const needsActivation = limits.setup.kind !== "ready" || (limits.status !== null && limits.status.kind !== "installed");
  // Shows the "ready" summary once, right after activating in this visit.
  const [sawInactive, setSawInactive] = useState(false);
  const [activationDone, setActivationDone] = useState(false);
  useEffect(() => {
    setPollLimits(limits.status !== null && limits.status.kind !== "installed");
    if (needsActivation) setSawInactive(true);
  }, [limits.status, needsActivation]);
  const showActivation = address !== null && (needsActivation || (sawInactive && !activationDone && limits.status?.kind === "installed"));
  const [activating, setActivating] = useState(false);
  const grantNeeded = useGrantNeeded(limits.status?.kind === "installed" ? limits.agentAccount : null, getAccessToken);
  const [grantDone, setGrantDone] = useState(false);

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

  const addMessage = (from: Message["from"], text: string, simulated = false, orderWaiting = false) =>
    setMessages((prev) => [...prev, { id: nextId.current++, from, text, simulated, orderWaiting }]);

  const send = async (text: string) => {
    addMessage("user", text);
    if (limits.setup.kind === "error") return addMessage("inti", UNAVAILABLE);
    if (needsActivation) return addMessage("inti", ACTIVATE_FIRST);
    setThinking(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new AgentError("Your session expired. Sign in again and retry.");
      const reply = await askAgent(token, text);
      addMessage("inti", reply.report || "Done.", reply.simulated, reply.events.some((e) => e.type === "limit_order_placed"));
    } catch (error) {
      addMessage("inti", error instanceof AgentError ? error.message : "Something went wrong. Try again in a minute.");
    } finally {
      setThinking(false);
    }
  };

  const empty = messages.length === 0;
  const activationCard =
    showActivation && address ? (
      <ActivationCard
        address={address}
        setup={limits.setup}
        status={limits.status}
        refresh={limits.refresh}
        getAccessToken={getAccessToken}
        onAgent={limits.rememberAgent}
        onDone={() => setActivationDone(true)}
        onWorking={setActivating}
      />
    ) : address && limits.setup.kind === "ready" && limits.status?.kind === "installed" && grantNeeded && !grantDone ? (
      // After activation: one more signature lets Inti trade on its own.
      <TradeGrantCard address={address} config={limits.setup.config} getAccessToken={getAccessToken} onDone={() => setGrantDone(true)} />
    ) : null;

  // The mascot "thinks" (antennas light up) whenever the app is working for the user.
  const creatingWallet = address === null && walletError === null;
  const checkingAccount = address !== null && limits.setup.kind === "ready" && limits.status === null;
  const working = creatingWallet || checkingAccount || activating || thinking;
  const installed = limits.setup.kind === "ready" && limits.status?.kind === "installed" ? { setup: limits.setup, status: limits.status } : null;

  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <img src={logoSrc(theme)} alt="Inti" className="h-8 w-auto" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {address && (
            <code className="hidden rounded-full bg-muted px-3 py-1 text-xs sm:inline" title={address}>
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

      {installed && (
        <div className="flex justify-center px-4 pb-2 lg:hidden" role="tablist" aria-label="View">
          <div className="flex w-full max-w-sm rounded-full bg-muted p-1 text-sm">
            {(["chat", "portfolio"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                className={cn("h-9 flex-1 rounded-full font-medium capitalize transition-colors", view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
                onClick={() => setView(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
      <main className={cn("flex min-h-0 flex-1 flex-col items-center px-4", installed && view === "portfolio" && "hidden lg:flex")}>
        <div
          className={cn(
            "flex w-full max-w-2xl shrink-0 flex-col items-center transition-all duration-500",
            empty && !activationCard ? "mt-[12vh]" : "mt-2",
          )}
        >
          <IntiMascot size={empty ? (activationCard ? 96 : 180) : 104} state={working ? "thinking" : "idle"} />
          {empty && !activationCard && creatingWallet && (
            <div className="mt-4 text-center" role="status">
              <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">Creating your wallet...</h1>
              <p className="mt-2 text-sm text-muted-foreground">Secured by your email or Google login. No seed phrase to write down.</p>
            </div>
          )}
          {empty && !activationCard && !creatingWallet && (
            <h1 className="mt-4 text-center text-2xl font-semibold text-foreground sm:text-3xl">
              {checkingAccount ? "Checking your account..." : "What do you want to do with your money?"}
            </h1>
          )}
        </div>

        {empty && activationCard && (
          // First run: the activation card sits in its own scrollable section, above the prompt bar.
          <div className="no-scrollbar mb-6 flex min-h-0 w-full flex-1 items-start justify-center overflow-y-auto py-4">{activationCard}</div>
        )}

        {!empty && (
          // min-h-0 keeps the list inside its section (it scrolls) instead of growing under the prompt bar.
          // The list ends with a clear gap above the prompt bar: messages never look like they slide under it.
          <ol
            ref={chatList}
            onScroll={(e) => {
              const el = e.currentTarget;
              followingEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
            }}
            // Same width as the open prompt bar (560px), so the chat reads as one centered column.
            className="no-scrollbar mb-6 flex min-h-0 w-full max-w-[560px] flex-1 flex-col overflow-y-auto py-4"
            aria-live="polite"
          >
            {messages.map((m, i) => (
              <ChatMessage
                key={m.id}
                from={m.from}
                text={m.text}
                firstOfTurn={i === 0 || messages[i - 1]?.from !== m.from}
                userInitials={userInitials}
                simulated={m.simulated}
                orderWaiting={m.orderWaiting}
              />
            ))}
            {thinking && <TypingIndicator firstOfTurn={messages.at(-1)?.from !== "inti"} />}
            {activationCard && <li className="mt-5 flex justify-center">{activationCard}</li>}
            <li ref={chatEnd} aria-hidden="true" />
          </ol>
        )}

        <div className={cn("flex w-full shrink-0 justify-center pb-6", empty && !activationCard ? "mt-8" : "mt-auto")}>
          <PromptInput onSubmit={(text) => void send(text)} placeholder="e.g. invest $40 in NEAR" disabled={thinking} />
        </div>
        {walletError && <p className="pb-4 text-sm text-destructive">{walletError}</p>}
      </main>
      {installed && address && (
        <aside className={cn("no-scrollbar min-h-0 overflow-y-auto px-4 pb-6 lg:block lg:w-[400px] lg:shrink-0 lg:pr-6 lg:pl-0", view === "chat" ? "hidden" : "flex-1")}>
          <Dashboard
            address={address}
            config={installed.setup.config}
            client={installed.setup.client}
            status={installed.status}
            getAccessToken={getAccessToken}
            onManage={() => setLimitsOpen(true)}
            className="mx-auto max-w-md"
          />
        </aside>
      )}
      </div>
      {limitsOpen && address && (
        <SpendingLimitsPanel
          address={address}
          onClose={() => {
            setLimitsOpen(false);
            void limits.refresh();
          }}
        />
      )}
    </div>
  );
}
