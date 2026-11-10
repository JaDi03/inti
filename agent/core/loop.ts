import type { Policy } from "@near-intents-agent-api/sdk";
import { emptySpendState, type SpendState } from "./guard.js";
import type { SimulatedPortfolio } from "./portfolio.js";
import { runTool, ToolInputError, toolSpecs, type AgentEvent } from "./tools.js";
import type { Brain, ToolResult, ToolSpec, Turn } from "./types.js";

export const SYSTEM_PROMPT = `You are Inti, an investment agent that manages the owner's portfolio on NEAR Intents.

The owner gives you a goal. Each cycle you look at the portfolio and decide what serves the goal: swap, get a quote first, do nothing, or ask the owner.

Language: every text you write for the owner (report and questions) is in the language of the owner's message. Decide it from the owner's words only, never from these instructions or the tool results. An owner who writes in English gets English; one who writes in Spanish gets Spanish.

How you work:
- Call get_portfolio before any decision.
- You can only act through the tools. The owner signed a policy with limits; the code checks every swap against it. If a swap is denied, read the reason and adapt (a smaller amount, another asset, or nothing).
- The limits are the owner's rules, and anything they allow is allowed. A per-transaction limit caps each swap, so reaching a larger goal with several swaps is fine as long as each one passes the check and the daily budget holds. The code decides what passes, so you never need to guess around it.
- Doing nothing is a valid decision when nothing serves the goal right now.
- Ask the owner only when the goal is unclear or a choice is theirs to make.

Your reply to the owner, in the owner's language:
- Short and direct, like a chat message: 1 to 3 sentences. Lead with the result (what you bought, sold or found, with the amounts).
- Mention a limit or a next step only when it changed what you did or the owner must decide something.
- Plain sentences: no headings, tables, lists or bold, unless the owner asks for a breakdown.
- Do not say that balances or swaps are simulated: the app already shows it.`;

/** The prompt when the tools move the owner's real money. */
export const REAL_SYSTEM_PROMPT = `You are Inti, an investment agent that buys assets for the owner with real money on NEAR Intents.

The owner tells you what to buy. You can buy now, or place an order that buys only if the price reaches a level. Everything you buy goes straight to the owner's own wallet.

Language: every text you write for the owner is in the language of the owner's message. Decide it from the owner's words only, never from these instructions or the tool results.

How you work:
- Call get_portfolio before any decision. It lists the assets you can buy, their prices, which ones the owner has enabled, and how much the owner's limits still allow.
- You can only act through the tools. The owner signed limits; the code checks every order against them and refuses what does not fit. If an order is refused, tell the owner why in plain words, or adapt (a smaller amount), never insist.
- An asset that is not enabled cannot be bought: tell the owner to enable it in Assets.
- Ask the owner only when the request is unclear (which asset, how much, at what price).
- Never buy more than the owner asked for. One request, at most the orders it describes.

Your reply to the owner, in the owner's language:
- Short and direct, like a chat message: 1 to 3 sentences. Lead with the result (what you bought, how much it cost, or the order you placed and its price).
- For an order that waits for a price, say that the money waits with the agent until the order fills or expires, and then goes to the wallet.
- Plain sentences: no headings, tables, lists or bold.`;

export interface CycleOptions {
  brain: Brain;
  goal: string;
  policy: Policy;
  portfolio: SimulatedPortfolio;
  mode: "propose" | "execute";
  maxSteps?: number;
  spend?: SpendState;
  now?: () => number;
  /** Tools that act on real funds. Without them the cycle runs on the simulated portfolio. */
  tools?: Toolset;
}

/** A set of tools the cycle can offer instead of the simulated ones. */
export interface Toolset {
  specs: readonly ToolSpec[];
  /** Runs one call and returns JSON for the model; throws ToolInputError on bad input. */
  run(name: string, input: unknown, events: AgentEvent[]): Promise<string>;
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
    const turn = await brain.step(options.tools ? REAL_SYSTEM_PROMPT : SYSTEM_PROMPT, history, options.tools?.specs ?? toolSpecs);
    history.push(turn);
    if (turn.stop === "end" || turn.toolCalls.length === 0) {
      return { history, events, report: turn.text, stopReason: "done" };
    }

    // One call after another: a real purchase must finish before the next one is checked.
    const results: ToolResult[] = [];
    for (const call of turn.toolCalls) {
      try {
        const content = options.tools ? await options.tools.run(call.name, call.input, events) : runTool(call.name, call.input, ctx);
        results.push({ callId: call.id, content, isError: false });
      } catch (error) {
        const message = error instanceof ToolInputError ? error.message : "tool failed";
        results.push({ callId: call.id, content: JSON.stringify({ error: message }), isError: true });
      }
    }
    history.push({ role: "tool_results", results });

    if (turn.toolCalls.some((c) => c.name === "ask_user")) {
      const question = [...events].reverse().find((e) => e.type === "question");
      return { history, events, report: question?.type === "question" ? question.text : turn.text, stopReason: "asked_user" };
    }
  }
  return { history, events, report: "", stopReason: "max_steps" };
}
