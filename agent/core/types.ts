/**
 * Provider-neutral agent types. The loop only speaks these, so the brain (NEAR AI
 * Cloud, or the scripted brain in tests) can change without touching the loop.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

export interface AssistantTurn {
  role: "assistant";
  text: string;
  toolCalls: ToolCall[];
  /** "end" when the model finished, "tool_use" when it wants tools run. */
  stop: "end" | "tool_use";
  /** Provider-specific content, replayed unchanged on the next request. */
  raw?: unknown;
  /** Where this step ran, so it can be checked later (NEAR AI signs each response id in its TEE). */
  audit?: { provider: string; model: string; responseId: string };
}

export type Turn =
  | { role: "user"; text: string }
  | AssistantTurn
  | { role: "tool_results"; results: ToolResult[] };

/** One model step: read the history, answer with text and/or tool calls. */
export interface Brain {
  readonly name: string;
  step(system: string, history: readonly Turn[], tools: readonly ToolSpec[]): Promise<AssistantTurn>;
}
