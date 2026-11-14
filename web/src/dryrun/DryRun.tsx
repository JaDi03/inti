import { ArrowLeftRight, Bot, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PromptInput } from "@/components/ui/ai-chat-input";
import { IntiMascot } from "@/components/ui/inti-mascot";
import { cn } from "@/lib/utils";
import { ChatMessage, TypingIndicator } from "../chat/ChatMessage";
import { logoSrc, ThemeProvider, ThemeToggle, useTheme } from "../theme";
import { askDryRun, DryRunError, type DryRunLogEntry, type FundStep } from "./client";

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

function DryRunChat() {
  const { theme } = useTheme();
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

      <main className="flex min-h-0 flex-1 flex-col items-center px-4">
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
    </div>
  );
}

/** The dry run page: no sign-in and no wallet, only its theme. */
export function DryRunRoot() {
  return <ThemeProvider>{() => <DryRunChat />}</ThemeProvider>;
}
