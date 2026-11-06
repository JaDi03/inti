import Anthropic from "@anthropic-ai/sdk";
import type { AssistantTurn, Brain, ToolSpec, Turn } from "../agent/types.js";

/** Provisional brain until NEAR AI Cloud credits are available. */
export const ANTHROPIC_MODEL = "claude-haiku-5-5";

function toMessages(history: readonly Turn[]): Anthropic.MessageParam[] {
  return history.map((turn): Anthropic.MessageParam => {
    if (turn.role === "user") return { role: "user", content: turn.text };
    if (turn.role === "tool_results") {
      return {
        role: "user",
        content: turn.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.content,
          is_error: r.isError,
        })),
      };
    }
    // Replay the provider content unchanged (keeps thinking blocks valid).
    if (turn.raw !== undefined) return { role: "assistant", content: turn.raw as Anthropic.ContentBlock[] };
    return {
      role: "assistant",
      content: [
        ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
        ...turn.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
      ],
    };
  });
}

/** Manual tool loop step over the Messages API, so the loop stays provider-neutral. */
export class AnthropicBrain implements Brain {
  readonly name: string;

  constructor(
    private readonly client: Anthropic = new Anthropic(),
    private readonly model: string = ANTHROPIC_MODEL,
  ) {
    this.name = `anthropic:${model}`;
  }

  async step(system: string, history: readonly Turn[], tools: readonly ToolSpec[]): Promise<AssistantTurn> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      system,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        strict: true,
      })),
      messages: toMessages(history),
    });

    if (response.stop_reason === "max_tokens") throw new Error("model output hit max_tokens");

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (response.stop_reason === "refusal") {
      return { role: "assistant", text: text || "The model declined this request.", toolCalls: [], stop: "end", raw: response.content };
    }

    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      role: "assistant",
      text,
      toolCalls,
      stop: response.stop_reason === "tool_use" && toolCalls.length > 0 ? "tool_use" : "end",
      raw: response.content,
    };
  }
}
