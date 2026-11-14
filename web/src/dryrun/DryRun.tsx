import { PrivyProvider } from "@privy-io/react-auth";
import { ArrowLeftRight, Bot, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MOBILE_VIEWS, PortfolioLayout, type MobileView } from "../dashboard/Dashboard";
import type { DashboardData } from "../dashboard/dashboardClient";
import { NOTHING_SIGNED, PRACTICE_WALLET, PracticeLimitsClient, practiceConfig, practiceStatus } from "./practice";
import { PromptInput } from "@/components/ui/ai-chat-input";
import { IntiMascot } from "@/components/ui/inti-mascot";
import { cn } from "@/lib/utils";
import { ChatMessage, TypingIndicator } from "../chat/ChatMessage";
import { logoSrc, ThemeProvider, ThemeToggle, useTheme } from "../theme";
import { askDryRun, DryRunError, fetchPracticeDashboard, type DryRunLogEntry, type FundStep } from "./client";

type Message = { id: number; from: "user" | "inti"; text: string; steps?: FundStep[]; log?: DryRunLogEntry[] };

const SUGGESTIONS = ["Buy $5 of bitcoin", "How much gold do I get for $10?", "What can I buy?"];

const PLACE: Record<FundStep["place"], { label: string; icon: typeof Wallet }> = {
  wallet: { label: "Your wallet", icon: Wallet },
  agent: { label: "Your agent", icon: Bot },
  intents: { label: "NEAR Intents", icon: ArrowLeftRight },
};

/** Where the money would sit at each step of a real purchase, in order. */
function FundSteps({ steps }: { steps: FundStep[] }) {
  return (
    <section className="mt-2 w-full rounded-xl border bg-card p-3 text-sm" aria-label="Where your money would sit">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Where your money would sit</h3>
      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => {
          const { label, icon: Icon } = PLACE[s.place];
          return (
            <li key={i} className="flex gap-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-medium text-foreground">
                  <Icon className="size-3.5" aria-hidden="true" />
                  {label}
                </p>
                <p className="text-muted-foreground">{s.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const lines = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

/** What the agent asked for and what came back, exactly as the server recorded it. */
function AgentLog({ log }: { log: DryRunLogEntry[] }) {
  return (
    <details className="mt-2 w-full rounded-xl border bg-card p-3 text-sm">
      <summary className="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground uppercase">Agent log ({log.length})</summary>
      <ol className="mt-2 flex flex-col gap-3">
        {log.map((e, i) => (
          <li key={i} className="min-w-0">
            <p className="font-medium text-foreground">{e.tool}</p>
            {Object.keys(e.asked).length > 0 && <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">{lines(e.asked)}</pre>}
            {e.request ? (
              <>
                <p className="mt-1 text-xs text-muted-foreground">Sent to the NEAR Intents Agent API: {e.request.route}</p>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">{lines(e.request.body)}</pre>
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">No request to the Agent API.</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Answer</p>
            <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">{lines(e.answer)}</pre>
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * The app's own portfolio panels around the chat, on the practice wallet: what can be bought, the
 * limits, the agent's rules and the protections, exactly as a real owner sees them. Anything that
 * would sign shows a note instead.
 */
function PracticePortfolio({ view, onNote, children }: { view: MobileView; onNote: (text: string) => void; children: ReactNode }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void fetchPracticeDashboard().then((d) => {
      if (!current) return;
      if (d?.prices.near) setData(d);
      else setFailed(true);
    });
    return () => {
      current = false;
    };
  }, []);
  const config = useMemo(() => practiceConfig(), []);
  const client = useMemo(() => new PracticeLimitsClient(config), [config]);
  const readDashboard = useCallback(() => Promise.resolve(data), [data]);
  const noToken = useCallback(() => Promise.resolve(null), []);
  if (!data?.prices.near) {
    return (
      <>
        {failed && <p className="sr-only">The practice portfolio could not be loaded.</p>}
        {children}
      </>
    );
  }
  return (
    <PortfolioLayout
      address={PRACTICE_WALLET}
      config={config}
      client={client}
      status={practiceStatus(data.prices.near)}
      getAccessToken={noToken}
      onManage={() => onNote(NOTHING_SIGNED)}
      onExport={() => onNote(NOTHING_SIGNED)}
      onChanged={() => undefined}
      view={view}
      grantSigned
      refreshKey={0}
      readDashboard={readDashboard}
    >
      {children}
    </PortfolioLayout>
  );
}

function DryRunChat() {
  const { theme } = useTheme();
  const [view, setView] = useState<MobileView>("chat");
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 4_000);
    return () => clearTimeout(timer);
  }, [note]);
  // Every button of the portfolio panels that would act (sign, enable, renew, freeze, add a passkey)
  // shows the note instead; only the ones that read (fold, show amounts, refresh) still work. Copy is
  // blocked too: the practice address takes real deposits that nobody could ever get back.
  useEffect(() => {
    const reads = /^(Show amounts|Hide amounts|Refresh)$/;
    const onClick = (e: MouseEvent) => {
      const button = e.target instanceof Element ? e.target.closest("button") : null;
      if (!button?.closest("aside")) return;
      if (button.hasAttribute("aria-expanded") || reads.test(button.getAttribute("aria-label") ?? "")) return;
      e.preventDefault();
      e.stopPropagation();
      setNote(NOTHING_SIGNED);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [thinking, setThinking] = useState(false);
  const nextId = useRef(0);
  const chatEnd = useRef<HTMLLIElement>(null);
  const empty = messages.length === 0;

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [messages, thinking]);

  const add = (m: Omit<Message, "id">) => setMessages((prev) => [...prev, { ...m, id: nextId.current++ }]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || thinking) return;
    add({ from: "user", text: message });
    setThinking(true);
    try {
      const reply = await askDryRun(message);
      add({ from: "inti", text: reply.report || "I couldn't finish that. Try asking in another way.", steps: reply.steps, log: reply.log });
    } catch (error) {
      add({ from: "inti", text: error instanceof DryRunError ? error.message : "Something went wrong. Try again in a minute." });
    } finally {
      setThinking(false);
    }
  };

  return (
    <div className="group/app flex h-svh flex-col">
      <header className="flex items-center justify-between gap-2 px-4 py-3 max-lg:group-has-[textarea:focus]/app:hidden sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <a href="/">
            <img src={logoSrc(theme)} alt="Inti" className="h-8 w-auto" />
          </a>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-foreground">Dry run</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <ThemeToggle />
          <a href="/app" className="rounded-full border px-3 py-1.5 font-medium whitespace-nowrap text-foreground transition-colors hover:border-primary hover:text-primary">
            Open app
          </a>
        </div>
      </header>

      <div className="flex justify-center px-4 pb-2 group-has-[textarea:focus]/app:hidden lg:hidden" role="tablist" aria-label="View">
        <div className="flex w-full max-w-md rounded-full bg-muted p-1 text-[13px]">
          {MOBILE_VIEWS.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={cn("h-9 min-w-0 flex-1 rounded-full px-1 font-medium capitalize transition-colors", view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {note && (
        <p role="status" className="fixed inset-x-4 bottom-24 z-50 mx-auto max-w-md rounded-xl bg-foreground px-4 py-3 text-center text-sm text-background shadow-lg">
          {note}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
      <PracticePortfolio view={view} onNote={setNote}>
      <main className={cn("flex min-h-0 flex-1 flex-col items-center px-4", view !== "chat" && "hidden lg:flex")}>
        <div className={cn("flex w-full max-w-2xl shrink-0 flex-col items-center", empty ? "mt-[10vh]" : "mt-2 max-lg:hidden")}>
          <IntiMascot size={empty ? 160 : 96} state={thinking ? "thinking" : "idle"} />
          {empty && (
            <>
              <h1 className="mt-4 text-center font-heading text-2xl font-semibold text-foreground sm:text-3xl">Try Inti with no funds</h1>
              <p className="mt-2 max-w-md text-center text-sm text-muted-foreground">
                A practice wallet with $100 in NEAR. Prices and quotes are live from NEAR Intents. Nothing is bought and no money moves.
              </p>
              <ul className="mt-6 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button
                      className="rounded-full border bg-card px-4 py-2 text-sm text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                      disabled={thinking}
                      onClick={() => void send(s)}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {!empty && (
          <ol className="no-scrollbar mb-6 flex min-h-0 w-full max-w-[560px] flex-1 flex-col overflow-y-auto py-4" aria-live="polite">
            {messages.map((m, i) => (
              <ChatMessage
                key={m.id}
                from={m.from}
                text={m.text}
                firstOfTurn={i === 0 || messages[i - 1]?.from !== m.from}
                userInitials="You"
                proof={
                  m.from === "inti" && ((m.steps?.length ?? 0) > 0 || (m.log?.length ?? 0) > 0) ? (
                    <>
                      <span className="mt-1 px-2 text-xs text-muted-foreground">Dry run, no real funds moved</span>
                      {m.steps && m.steps.length > 0 && <FundSteps steps={m.steps} />}
                      {m.log && m.log.length > 0 && <AgentLog log={m.log} />}
                    </>
                  ) : undefined
                }
              />
            ))}
            {thinking && <TypingIndicator firstOfTurn={messages.at(-1)?.from !== "inti"} />}
            <li ref={chatEnd} aria-hidden="true" />
          </ol>
        )}

        <div className={cn("flex w-full shrink-0 justify-center pb-6", empty ? "mt-8" : "mt-auto")}>
          <PromptInput onSubmit={(text) => void send(text)} placeholder="e.g. buy $5 of bitcoin" disabled={thinking} />
        </div>
      </main>
      </PracticePortfolio>
      </div>
    </div>
  );
}

const appId = import.meta.env.PRIVY_APP_ID as string | undefined;

/**
 * The dry run page. The portfolio panels are the app's own, which expect the sign-in provider, so
 * it is loaded; nobody signs in here, so there is no wallet and nothing that could sign.
 */
export function DryRunRoot() {
  return (
    <ThemeProvider>
      {(theme) =>
        appId ? (
          <PrivyProvider appId={appId} config={{ loginMethods: ["email", "google"], appearance: { theme, accentColor: "#00EB96" } }}>
            <DryRunChat />
          </PrivyProvider>
        ) : (
          <DryRunChat />
        )
      }
    </ThemeProvider>
  );
}
