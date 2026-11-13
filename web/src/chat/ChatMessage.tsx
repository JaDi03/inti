import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type Sender = "user" | "inti";

/** Up to two initials from a name ("Ada Lovelace" -> "AL") or the first letter of an email. */
export function initialsOf(nameOrEmail: string | null | undefined): string {
  const source = (nameOrEmail ?? "").trim();
  if (!source) return "?";
  const base = source.includes("@") ? source.split("@")[0] ?? "" : source;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words[1]] : [base]).map((w) => w?.[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

function Avatar({ from, initials }: { from: Sender; initials: string }) {
  if (from === "inti") {
    return <img src="/favicon.svg" alt="Inti" className="size-10 shrink-0 rounded-full bg-muted p-1.5" />;
  }
  return (
    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-sm font-semibold text-foreground">
      {initials}
    </span>
  );
}

interface Props {
  from: Sender;
  text: string;
  /** First message of a turn: shows the avatar and the bubble tail, like mobile chat apps. */
  firstOfTurn: boolean;
  userInitials: string;
  /** The agent ran on a simulated portfolio: a small label under the bubble says so. */
  simulated?: boolean;
  /** The agent placed an order that waits for a price: its money sits with the agent until then. */
  orderWaiting?: boolean;
  /** Under Inti's reply: whether its AI model calls were signed by the verified model. */
  proof?: React.ReactNode;
}

/** Inti's bubble with three moving dots while the agent works, like mobile chat apps. */
/** Steps shown while the agent works: the last few, the newest one still running. */
const SHOWN_STEPS = 5;

export function TypingIndicator({ firstOfTurn, steps = [] }: { firstOfTurn: boolean; steps?: string[] }) {
  const shown = steps.slice(-SHOWN_STEPS);
  return (
    <li className={cn("flex items-start gap-3.5 self-start", firstOfTurn ? "mt-5 first:mt-0" : "mt-1")} role="status" aria-label={shown.at(-1) ?? "Inti is typing"}>
      {firstOfTurn ? <Avatar from="inti" initials="" /> : <span className="w-10 shrink-0" aria-hidden="true" />}
      <div className={cn("relative flex flex-col gap-1.5 rounded-2xl bg-muted px-[18px] py-3", firstOfTurn && "bubble-tail-left rounded-tl-[4px]")}>
        {shown.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {shown.map((step, i) => {
              const current = i === shown.length - 1;
              return (
                <li key={`${steps.length - shown.length + i}`} className={cn("flex items-center gap-2", current ? "text-foreground" : "text-muted-foreground")}>
                  {current ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : <Check className="size-3.5 shrink-0" aria-hidden="true" />}
                  {step}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex h-[22px] items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="typing-dot size-2 rounded-full bg-muted-foreground" aria-hidden="true" />
          ))}
        </div>
      </div>
    </li>
  );
}

export function ChatMessage({ from, text, firstOfTurn, userInitials, simulated = false, orderWaiting = false, proof }: Props) {
  const mine = from === "user";
  return (
    <li className={cn("flex max-w-full items-start gap-3.5", mine ? "flex-row-reverse self-end" : "self-start", firstOfTurn ? "mt-5 first:mt-0" : "mt-1")}>
      {firstOfTurn ? <Avatar from={from} initials={userInitials} /> : <span className="w-10 shrink-0" aria-hidden="true" />}
      <div className={cn("flex max-w-[min(85%,420px)] flex-col", mine ? "items-end" : "items-start")}>
        <div
          className={cn(
            // pre-wrap keeps the line breaks the user typed with Shift+Enter.
            "relative max-w-full rounded-2xl px-[18px] py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words",
            mine ? "bg-chat-user text-chat-user-foreground" : "bg-muted text-foreground",
            firstOfTurn && (mine ? "bubble-tail-right rounded-tr-[4px]" : "bubble-tail-left rounded-tl-[4px]"),
          )}
        >
          {text}
        </div>
        {proof}
        {simulated && <span className="mt-1 px-2 text-xs text-muted-foreground">Simulated portfolio, no real funds moved</span>}
        {orderWaiting && (
          <span className="mt-1 px-2 text-xs text-muted-foreground">
            While this order waits, its money sits with your agent. It is the only time your money is not in your wallet. When the order fills, what it buys goes to your wallet; if it expires, the money comes back.
          </span>
        )}
      </div>
    </li>
  );
}
