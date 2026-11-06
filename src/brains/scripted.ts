import type { AssistantTurn, Brain, Turn } from "../agent/types.js";

/**
 * Test brain: each step is a function of the history so far, so a script can
 * react to tool results (for example, retry smaller after a denial).
 */
export type ScriptStep = (history: readonly Turn[]) => Omit<AssistantTurn, "role">;

export class ScriptedBrain implements Brain {
  readonly name = "scripted";
  private index = 0;

  constructor(private readonly steps: readonly ScriptStep[]) {}

  step(_system: string, history: readonly Turn[]): Promise<AssistantTurn> {
    const next = this.steps[this.index++];
    if (!next) return Promise.resolve({ role: "assistant", text: "script finished", toolCalls: [], stop: "end" });
    return Promise.resolve({ role: "assistant", ...next(history) });
  }
}
