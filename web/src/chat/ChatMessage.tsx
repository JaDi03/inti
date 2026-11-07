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
    return <img src="/favicon.svg" alt="Inti" className="size-8 shrink-0 rounded-full bg-muted p-1" />;
  }
  return (
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
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
}

export function ChatMessage({ from, text, firstOfTurn, userInitials }: Props) {
  const mine = from === "user";
  return (
    <li className={cn("flex max-w-full items-start gap-2", mine ? "flex-row-reverse self-end" : "self-start", firstOfTurn ? "mt-5 first:mt-0" : "mt-1")}>
      {firstOfTurn ? <Avatar from={from} initials={userInitials} /> : <span className="w-8 shrink-0" aria-hidden="true" />}
      <div
        className={cn(
          // pre-wrap keeps the line breaks the user typed with Shift+Enter.
          "relative max-w-[min(85%,420px)] rounded-2xl px-[18px] py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words",
          mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          firstOfTurn && (mine ? "bubble-tail-right rounded-tr-[4px]" : "bubble-tail-left rounded-tl-[4px]"),
        )}
      >
        {text}
      </div>
    </li>
  );
}
