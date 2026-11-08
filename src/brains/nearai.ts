import OpenAI from "openai";
import type { AssistantTurn, Brain, ToolCall, ToolSpec, Turn } from "../agent/types.js";

/** NEAR AI Cloud gateway, OpenAI-compatible (docs.near.ai/cloud/quickstart). */
export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";
/**
 * Runs on NEAR AI's own TEE fleet and supports tool calls (GET /v1/models lists
 * "tools"). Anthropic, OpenAI and Gemini models on NEAR AI run outside a TEE.
 */
export const NEAR_AI_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const MAX_OUTPUT_TOKENS = 4000;
const REQUEST_TIMEOUT_MS = 60_000;

function toMessages(system: string, history: readonly Turn[]): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const turn of history) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
    } else if (turn.role === "tool_results") {
      for (const r of turn.results) messages.push({ role: "tool", tool_call_id: r.callId, content: r.content });
    } else if (turn.raw !== undefined) {
      // Replay the provider message unchanged (keeps reasoning_content and tool call ids).
      messages.push(turn.raw as OpenAI.ChatCompletionMessageParam);
    } else {
      messages.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.toolCalls.length > 0 && {
          tool_calls: turn.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        }),
      });
    }
  }
  return messages;
}

/** Tool arguments arrive as a JSON string; bad JSON is passed on so tool validation rejects it. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Brain on NEAR AI Cloud. Each step keeps the chat id, which signs the response inside the TEE. */
export class NearAiBrain implements Brain {
  readonly name: string;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string = NEAR_AI_MODEL,
  ) {
    this.name = `nearai:${model}`;
  }

  static fromApiKey(apiKey: string, model?: string): NearAiBrain {
    return new NearAiBrain(new OpenAI({ baseURL: NEAR_AI_BASE_URL, apiKey, timeout: REQUEST_TIMEOUT_MS }), model);
  }

  async step(system: string, history: readonly Turn[], tools: readonly ToolSpec[]): Promise<AssistantTurn> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: toMessages(system, history),
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("model returned no choices");
    if (choice.finish_reason === "length") throw new Error("model output hit max_tokens");

    const message = choice.message;
    const toolCalls: ToolCall[] = (message.tool_calls ?? [])
      .filter((c) => c.type === "function")
      .map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));

    return {
      role: "assistant",
      text: (message.content ?? "").trim(),
      toolCalls,
      stop: toolCalls.length > 0 ? "tool_use" : "end",
      raw: message,
      audit: { provider: "nearai", model: this.model, responseId: response.id },
    };
  }
}
