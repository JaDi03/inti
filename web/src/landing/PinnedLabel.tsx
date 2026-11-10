import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A round push pin, drawn in SVG so the page loads no outside image. */
function Pin({ className }: { className?: string }) {
  return (
    <svg className={className} width="22" height="30" viewBox="0 0 22 30" aria-hidden="true">
      <line x1="11" y1="17" x2="11" y2="29" stroke="#9fb3b8" strokeWidth="2" strokeLinecap="round" />
      <circle cx="11" cy="10" r="9" fill="var(--landing-pink)" />
      <circle cx="8" cy="7" r="3" fill="#ffffff" opacity="0.45" />
    </svg>
  );
}

type PinnedLabelProps = {
  children: ReactNode;
  /** Background color of the note. */
  color: string;
  /** Tilt in degrees; the note straightens on hover. */
  tilt?: number;
  className?: string;
};

/** A word on a tilted, pinned note, like the ones in the hero and section titles. */
export function PinnedLabel({ children, color, tilt = -3, className }: PinnedLabelProps) {
  return (
    <span
      className={cn("landing-tilt relative inline-block rounded-md px-3 py-1 text-(--landing-ink) shadow-lg sm:px-4", className)}
      style={{ backgroundColor: color, "--tilt": `${tilt}deg` } as CSSProperties}
    >
      {children}
      <Pin className="absolute -top-5 right-4 rotate-12" />
    </span>
  );
}
