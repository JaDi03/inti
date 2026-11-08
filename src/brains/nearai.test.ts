import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { ToolSpec, Turn } from "../agent/types.js";
import { NearAiBrain } from "./nearai.js";

type CreateParams = OpenAI.ChatCompletionCreateParamsNonStreaming;

/** Fake client: records each request and answers with the next canned completion. */
function fakeClient(replies: Array<Partial<OpenAI.ChatCompletion>>) {
  const requests: CreateParams[] = [];
  const client = {
    chat: {
      completions: {
        create: (params: CreateParams) => {
          requests.push(structuredClone(params));
          const next = replies.shift();
          if (!next) throw new Error("no reply left");
          return Promise.resolve(next);
        },
      },
    },
  } as unknown as OpenAI;
  return { client, requests };
}

const tools: ToolSpec[] = [
  { name: "get_portfolio", description: "Balances.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

const toolCallReply: Partial<OpenAI.ChatCompletion> = {
  id: "chatcmpl-1",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      logprobs: null,
      message: {
        role: "assistant",
        content: "",
        refusal: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "get_portfolio", arguments: "{}" } }],
      },
    },
  ],
};

describe("NearAiBrain", () => {
  it("maps tools, parses tool calls and keeps the response id", async () => {
    const { client, requests } = fakeClient([toolCallReply]);
    const turn = await new NearAiBrain(client, "test-model").step("system text", [{ role: "user", text: "hi" }], tools);

    expect(requests[0]?.model).toBe("test-model");
    expect(requests[0]?.messages[0]).toEqual({ role: "system", content: "system text" });
    expect(requests[0]?.tools?.[0]).toEqual({
      type: "function",
      function: { name: "get_portfolio", description: "Balances.", parameters: tools[0]?.inputSchema },
    });
    expect(turn.stop).toBe("tool_use");
    expect(turn.toolCalls).toEqual([{ id: "call-1", name: "get_portfolio", input: {} }]);
    expect(turn.audit).toEqual({ provider: "nearai", model: "test-model", responseId: "chatcmpl-1" });
  });

  it("replays the provider message unchanged and sends tool results by call id", async () => {
    const final: Partial<OpenAI.ChatCompletion> = {
      id: "chatcmpl-2",
      choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: " Done. ", refusal: null } }],
    };
    const { client, requests } = fakeClient([toolCallReply, final]);
    const brain = new NearAiBrain(client, "test-model");
    const history: Turn[] = [{ role: "user", text: "hi" }];

    history.push(await brain.step("s", history, tools));
    history.push({ role: "tool_results", results: [{ callId: "call-1", content: '{"ok":true}', isError: false }] });
    const turn = await brain.step("s", history, tools);

    expect(requests[1]?.messages[2]).toEqual(toolCallReply.choices?.[0]?.message);
    expect(requests[1]?.messages[3]).toEqual({ role: "tool", tool_call_id: "call-1", content: '{"ok":true}' });
    expect(turn).toMatchObject({ text: "Done.", stop: "end", toolCalls: [] });
  });

  it("passes malformed tool arguments through so tool validation rejects them", async () => {
    const reply = structuredClone(toolCallReply);
    const call = reply.choices?.[0]?.message.tool_calls?.[0];
    if (call?.type === "function") call.function.arguments = "{not json";
    const { client } = fakeClient([reply]);
    const turn = await new NearAiBrain(client).step("s", [{ role: "user", text: "hi" }], tools);
    expect(turn.toolCalls[0]?.input).toBe("{not json");
  });

  it("fails loudly when the output is cut by max_tokens", async () => {
    const cut = structuredClone(toolCallReply);
    if (cut.choices?.[0]) cut.choices[0].finish_reason = "length";
    const { client } = fakeClient([cut]);
    await expect(new NearAiBrain(client).step("s", [{ role: "user", text: "hi" }], tools)).rejects.toThrow("max_tokens");
  });
});
