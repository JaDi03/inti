import type { Policy } from "@near-intents-agent-api/sdk";
import { emptySpendState, type SpendState } from "./guard.js";
import type { SimulatedPortfolio } from "./portfolio.js";
import { runTool, ToolInputError, toolSpecs, type AgentEvent } from "./tools.js";
import type { Brain, ToolResult, Turn } from "./types.js";

export const SYSTEM_PROMPT = `You are Inti, an investment agent that manages the owner's portfolio on NEAR Intents.

The owner gives you a goal. Each cycle you look at the portfolio and decide what serves the goal: swap, get a quote first, do nothing, or ask the owner.

How you work:
- Call get_portfolio before any decision.
- You can only act through the tools. The owner signed a policy with limits; the code checks every swap against it. If a swap is denied, read the reason and adapt (a smaller amount, another asset, or nothing).
- The limits are the owner's rules, and anything they allow is allowed. A per-transaction limit caps each swap, so reaching a larger goal with several swaps is fine as long as each one passes the check and the daily budget holds. The code decides what passes, so you never need to guess around it.
- Doing nothing is a valid decision when nothing serves the goal right now.
- Ask the owner only when the goal is unclear or a choice is theirs to make.
- Balances and swaps may be simulated; say so in your report when the tool results say simulated.

End with a short report for the owner, in the language the owner used: what you did, why, and what you left for later.`;

export interface CycleOptions {
  brain: Brain;
  goal: string;
  policy: Policy;
  portfolio: SimulatedPortfolio;
  mode: "propose" | "execute";
  maxSteps?: number;
  spend?: SpendState;
  now?: () => number;
}

export interface CycleResult {
  history: Turn[];
  events: AgentEvent[];
  report: string;
  stopReason: "done" | "asked_user" | "max_steps";
}

/**
 * One agent cycle: the brain decides, the code runs tools and enforces limits,
 * until the brain ends its turn, asks the owner, or the step budget runs out.
 */
export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const { brain, goal, policy, portfolio, mode } = options;
  const maxSteps = options.maxSteps ?? 8;
  const events: AgentEvent[] = [];
  const ctx = {
    policy,
    portfolio,
    spend: options.spend ?? emptySpendState(),
    mode,
    now: options.now ?? Date.now,
    events,
  };
  const history: Turn[] = [{ role: "user", text: goal }];

  for (let step = 0; step < maxSteps; step++) {
    const turn = await brain.step(SYSTEM_PROMPT, history, toolSpecs);
    history.push(turn);
    if (turn.stop === "end" || turn.toolCalls.length === 0) {
      return { history, events, report: turn.text, stopReason: "done" };
    }

    const results: ToolResult[] = turn.toolCalls.map((call) => {
      try {
        return { callId: call.id, content: runTool(call.name, call.input, ctx), isError: false };
      } catch (error) {
        const message = error instanceof ToolInputError ? error.message : "tool failed";
        return { callId: call.id, content: JSON.stringify({ error: message }), isError: true };
      }
    });
    history.push({ role: "tool_results", results });

    if (turn.toolCalls.some((c) => c.name === "ask_user")) {
      const question = [...events].reverse().find((e) => e.type === "question");
      return { history, events, report: question?.type === "question" ? question.text : turn.text, stopReason: "asked_user" };
    }
  }
  return { history, events, report: "", stopReason: "max_steps" };
}
