import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { FRONT, TEMPLATES, pathFrom, poseAt } from "./inti-poses";

/** What the agent is doing; the antenna nodes show it. */
export type MascotState = "idle" | "thinking" | "acting";

export type IntiMascotProps = {
  className?: string;
  /** Edge length in CSS pixels. Default `200`. */
  size?: number;
  state?: MascotState;
};

// Gaze behavior adapted from the 21st.dev "live-orb" component: the eyes
// follow the pointer, glance around after it rests, and blink now and then.
const IDLE_MS = 3000;
const REST = { x: 0, y: 0 };
/** Extra eye travel up/down in viewBox units; left/right comes from the poses. */
const REACH_Y = 45;

const eyeTransform = (e: number[]) => `rotate(${(e[2] ?? 0).toFixed(2)} ${(e[3] ?? 0).toFixed(1)} ${(e[4] ?? 0).toFixed(1)})`;

/**
 * Head turn by morphing between the designer's three poses (left, front,
 * right). x picks the pose; y tilts the gaze and the top face.
 */
function applyTurn(parts: Parts, x: number, y: number) {
  const p = poseAt(x);
  parts.body.setAttribute("d", pathFrom(TEMPLATES.body, p.body));
  parts.top.setAttribute("d", pathFrom(TEMPLATES.top, p.top));
  parts.side.setAttribute("d", pathFrom(TEMPLATES.side, p.side));
  parts.sideRight.setAttribute("d", pathFrom(TEMPLATES.sideRight, p.sideRight));
  // Looking up shows more of the top face.
  parts.top.setAttribute("transform", `translate(0 ${(-y * 30).toFixed(2)})`);
  p.antennas.forEach((a, i) => {
    const line = parts.stalks[i];
    const ball = parts.balls[i];
    if (!line || !ball) return;
    line.setAttribute("x1", String(a[0]));
    line.setAttribute("y1", String(a[1]));
    line.setAttribute("x2", String(a[2]));
    line.setAttribute("y2", String(a[3]));
    ball.setAttribute("cx", String(a[0]));
    ball.setAttribute("cy", String(a[1]));
    ball.setAttribute("r", String(a[4]));
  });
  p.eyes.forEach((e, i) => {
    const rect = parts.eyeRects[i];
    if (!rect) return;
    rect.setAttribute("x", String(e[0]));
    rect.setAttribute("y", String(e[1]));
    rect.setAttribute("transform", eyeTransform(e));
  });
  parts.eyes.setAttribute("transform", `translate(0 ${(y * REACH_Y).toFixed(2)})`);
}

type Parts = {
  body: SVGPathElement;
  top: SVGPathElement;
  side: SVGPathElement;
  sideRight: SVGPathElement;
  stalks: SVGLineElement[];
  balls: SVGCircleElement[];
  eyeRects: SVGRectElement[];
  eyes: SVGGElement;
  lids: SVGGElement;
};

function findParts(svg: SVGSVGElement): Parts | null {
  const q = <T extends Element>(name: string) => svg.querySelector<T>(`[data-part="${name}"]`);
  const all = <T extends Element>(name: string) => Array.from(svg.querySelectorAll<T>(`[data-part="${name}"]`));
  const body = q<SVGPathElement>("body");
  const top = q<SVGPathElement>("top");
  const side = q<SVGPathElement>("side");
  const sideRight = q<SVGPathElement>("side-right");
  const eyes = q<SVGGElement>("eyes");
  const lids = q<SVGGElement>("lids");
  if (!body || !top || !side || !sideRight || !eyes || !lids) return null;
  return { body, top, side, sideRight, eyes, lids, stalks: all("stalk"), balls: all("ball"), eyeRects: all("eye") };
}

function useGaze(svgRef: React.RefObject<SVGSVGElement | null>) {
  useEffect(() => {
    const svg = svgRef.current;
    const parts = svg ? findParts(svg) : null;
    if (!svg || !parts) return;
    const lidGroup = parts.lids;

    const look = { ...REST };
    const target = { ...REST };
    const glance = { ...REST };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let pointerAt = -Infinity;
    let raf = 0;
    let last = performance.now();
    let clock = 0;
    let nextGlance = 800;
    let nextBlink = 1800 + Math.random() * 2400;
    let blinkAt = -10_000;

    const onMove = (e: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      // Direction from the mascot to the pointer; full reach once the pointer
      // is about one mascot-width away, so the gaze clearly points at it.
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy);
      const strength = Math.min(1, dist / Math.max(rect.width, 1));
      target.x = dist > 0 ? (dx / dist) * strength : 0;
      target.y = dist > 0 ? (dy / dist) * strength : 0;
      pointerAt = performance.now();
    };

    const tick = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      clock += dt;
      const still = reduce.matches;

      const steering = now - pointerAt < IDLE_MS;
      if (!steering && clock >= nextGlance) {
        const back = Math.random() < 0.3;
        glance.x = back ? 0 : (Math.random() * 2 - 1) * 0.8;
        glance.y = back ? 0 : (Math.random() * 2 - 1) * 0.5;
        nextGlance = clock + 900 + Math.random() * 2100;
      }
      const goal = still ? REST : steering ? target : glance;
      const ease = still ? 1 : steering ? 0.16 : 0.08;
      look.x += (goal.x - look.x) * ease;
      look.y += (goal.y - look.y) * ease;
      applyTurn(parts, look.x, look.y);

      if (!still && clock >= nextBlink) {
        blinkAt = clock;
        nextBlink = clock + 2200 + Math.random() * 3800;
      }
      const bt = (clock - blinkAt) / 1000;
      let shut = 0;
      if (!still) {
        if (bt < 0.055) shut = bt / 0.055;
        else if (bt < 0.1) shut = 1;
        else if (bt < 0.18) shut = 1 - (bt - 0.1) / 0.08;
      }
      // Blink, plus foreshortening: eyes narrow when looking sideways.
      lidGroup.style.transform = `scaleY(${(1 - shut * 0.9).toFixed(3)})`;

      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (raf || document.visibilityState === "hidden") return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      stop();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [svgRef]);
}

/**
 * Inti: a soft block (the blockchain) with network-node antennas.
 * The eyes follow the pointer; the nodes light up while the agent works.
 */
export function IntiMascot({ className, size = 200, state = "idle" }: IntiMascotProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  useGaze(svgRef);
  // Unique per instance so two mascots on one page do not share a clipPath.
  const clipId = `inti-body-clip-${useId().replace(/:/g, "")}`;

  // Artwork: designer poses (see inti-poses.ts); first paint is the front pose.
  const p = FRONT;
  return (
    <svg
      ref={svgRef}
      viewBox="218 264 622 586"
      width={size}
      height={(size * 586) / 622}
      role="img"
      aria-label="Inti"
      data-state={state}
      className={cn("inti-mascot shrink-0 overflow-visible", className)}
    >
      <g className="inti-body">
        <path data-part="body" id={`${clipId}-body`} fill="var(--inti-body)" d={pathFrom(TEMPLATES.body, p.body)} />
        <clipPath id={clipId}>
          <use href={`#${clipId}-body`} />
        </clipPath>
        <g clipPath={`url(#${clipId})`}>
          <path data-part="top" fill="var(--inti-top)" d={pathFrom(TEMPLATES.top, p.top)} />
          <path data-part="side" fill="var(--inti-side)" d={pathFrom(TEMPLATES.side, p.side)} />
          <path data-part="side-right" fill="var(--inti-side-right)" d={pathFrom(TEMPLATES.sideRight, p.sideRight)} />
        </g>
        <g fill="var(--inti-body)" stroke="var(--inti-body)" strokeWidth={15} strokeLinecap="round">
          {p.antennas.map((a, i) => (
            <g key={i}>
              <line data-part="stalk" x1={a[0]} y1={a[1]} x2={a[2]} y2={a[3]} />
              <circle
                data-part="ball"
                className="inti-node"
                style={{ animationDelay: `${i * 0.15}s` }}
                cx={a[0]}
                cy={a[1]}
                r={a[4]}
                stroke="none"
              />
            </g>
          ))}
        </g>
        <g data-part="eyes">
          <g data-part="lids" style={{ transformBox: "fill-box", transformOrigin: "center" }}>
            {p.eyes.map((e, i) => (
              <rect key={i} data-part="eye" fill="var(--inti-eye)" x={e[0]} y={e[1]} width={52} height={108} rx={26} transform={eyeTransform(e)} />
            ))}
          </g>
        </g>
      </g>
    </svg>
  );
}
