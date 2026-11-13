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
export function TypingIndicator({ firstOfTurn }: { firstOfTurn: boolean }) {
  return (
    <li className={cn("flex items-start gap-3.5 self-start", firstOfTurn ? "mt-5 first:mt-0" : "mt-1")} role="status" aria-label="Inti is typing">
      {firstOfTurn ? <Avatar from="inti" initials="" /> : <span className="w-10 shrink-0" aria-hidden="true" />}
      <div className={cn("relative flex h-[46px] items-center gap-1.5 rounded-2xl bg-muted px-[18px]", firstOfTurn && "bubble-tail-left rounded-tl-[4px]")}>
        {[0, 1, 2].map((i) => (
          <span key={i} className="typing-dot size-2 rounded-full bg-muted-foreground" aria-hidden="true" />
        ))}
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
