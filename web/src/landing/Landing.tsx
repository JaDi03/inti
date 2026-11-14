import type { CSSProperties } from "react";
import { IntiMascot } from "@/components/ui/inti-mascot";
import { PinnedLabel } from "./PinnedLabel";
import "./landing.css";

type Barrier = {
  problem: string;
  answer: string;
  tilt: number;
  accent: string;
};

/** The three barriers that still stop people, and what Inti does about each one. */
const BARRIERS: readonly Barrier[] = [
  {
    problem: "Signing what you can't read",
    answer:
      "Your limits are written in plain words before you sign, and checked so what you sign is exactly what you read.",
    tilt: -4,
    accent: "var(--landing-yellow)",
  },
  {
    problem: "A wrong address you can't undo",
    answer: "Your money can only go to your own agent, and what it buys can only come back to you. Anything else is refused before it moves.",
    tilt: 3,
    accent: "var(--landing-green)",
  },
  {
    problem: "Handing an AI the keys to your money",
    answer:
      "The agent gets a limited key on your own account. It can only take funds within the ceiling you signed, never more.",
    tilt: -2,
    accent: "var(--landing-pink)",
  },
];

/** Where the app lives; the landing only links to it. */
const APP_PATH = "/app";
/** The dry run: try Inti with a practice wallet, no sign-in. */
const TRY_PATH = "/try";
/** The public source code and the demo video, for anyone who wants to check how it works. */
const SOURCE_URL = "https://github.com/JaDi03/inti";
const VIDEO_URL = "https://x.com/_Ja_V1/status/2121621345314189646";

function Header() {
  return (
    <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
      <img src="/inti-logo-horizontal-dark.svg" alt="Inti" className="h-9 w-auto sm:h-10" />
      <nav className="flex items-center gap-4">
        <a href={SOURCE_URL} className="text-sm font-bold text-white/75 transition-colors hover:text-(--landing-green)">
          GitHub
        </a>
        <a
          href={APP_PATH}
          className="rounded-full border-2 border-white/70 px-4 py-1.5 text-sm font-bold transition-colors hover:border-(--landing-green) hover:text-(--landing-green)"
        >
          Open app
        </a>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative px-4 pt-8 pb-20 text-center sm:pt-16 sm:pb-28">
      <IntiMascot size={150} className="mx-auto" />
      <h1 className="landing-heading mx-auto mt-6 max-w-4xl text-4xl leading-tight font-bold sm:text-6xl">
        Blockchain, without the parts that{" "}
        <PinnedLabel color="var(--landing-green)" tilt={-4} className="mt-2">
          stop
        </PinnedLabel>{" "}
        you.
      </h1>
      <p className="mx-auto mt-8 max-w-2xl text-lg text-white/75 sm:text-xl">
        Type what you want, like &ldquo;sell half my bitcoin and buy gold with it&rdquo;. Your own agent does it on NEAR
        Intents, the AI runs on private hardware in NEAR AI Cloud, and a contract on your account refuses anything over the
        limits you sign.
      </p>
      <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
        <a
          href={APP_PATH}
          className="landing-wiggle rounded-full bg-(--landing-green) px-7 py-3 text-lg font-bold text-(--landing-ink) shadow-xl"
        >
          Open app
        </a>
        <a
          href={TRY_PATH}
          className="rounded-full border-2 border-white/70 px-6 py-3 font-bold transition-colors hover:border-(--landing-green) hover:text-(--landing-green)"
        >
          Dry run, no funds
        </a>
        <a
          href="#barriers"
          className="rounded-full border-2 border-dashed border-white/60 px-6 py-3 font-bold transition-colors hover:border-white"
        >
          What stops people?
        </a>
      </div>
      <a href={VIDEO_URL} className="mt-6 inline-block text-sm font-bold text-white/75 underline underline-offset-4 hover:text-(--landing-green)">
        Watch the demo
      </a>
    </section>
  );
}

function BarrierCard({ barrier, index }: { barrier: Barrier; index: number }) {
  return (
    <li
      tabIndex={0}
      className="landing-tilt relative rounded-xl bg-white p-6 text-(--landing-ink) shadow-2xl outline-none focus-visible:ring-4 focus-visible:ring-(--landing-green)"
      style={{ "--tilt": `${barrier.tilt}deg` } as CSSProperties}
    >
      <span
        className="landing-heading absolute -top-5 -left-3 flex size-11 items-center justify-center rounded-full border-2 border-dotted border-white text-xl font-bold shadow-md"
        style={{ backgroundColor: barrier.accent }}
        aria-hidden="true"
      >
        {index + 1}
      </span>
      <h3 className="landing-heading text-xl leading-snug font-bold line-through decoration-(--landing-pink) decoration-2">
        {barrier.problem}
      </h3>
      <p className="mt-3 text-base leading-relaxed text-(--landing-ink)/80">
        <strong className="text-(--landing-green-dark)">Inti: </strong>
        {barrier.answer}
      </p>
    </li>
  );
}

function Barriers() {
  return (
    <section id="barriers" className="rounded-2xl bg-(--landing-bg-deep) px-4 py-16 sm:px-8 sm:py-20">
      <h2 className="landing-heading text-center text-3xl font-bold sm:text-5xl">
        <PinnedLabel color="var(--landing-yellow)" tilt={-3}>
          The last 3 barriers
        </PinnedLabel>
      </h2>
      <p className="mx-auto mt-8 max-w-xl text-center text-lg text-white/70">
        Wanting in is the easy part. These are the moments that make people stop.
      </p>
      <ol className="mx-auto mt-14 grid max-w-5xl gap-12 md:grid-cols-3 md:gap-8">
        {BARRIERS.map((barrier, index) => (
          <BarrierCard key={barrier.problem} barrier={barrier} index={index} />
        ))}
      </ol>
    </section>
  );
}

/** The public page people see before signing in. */
export function Landing() {
  return (
    <div className="landing relative min-h-svh w-full overflow-x-hidden">
      <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <Header />
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <Hero />
        <Barriers />
      </main>
    </div>
  );
}
