import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { demoDecision, modelDecision } from "./decide";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

const toolResult = (calls: { name: string; args: unknown }[]) => ({
  content: calls.map((c, i) => ({
    type: "tool-call" as const,
    toolCallId: `call_${i}`,
    toolName: c.name,
    input: JSON.stringify(c.args),
  })),
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

// Returns the first result on call 1, the second on call 2, and so on.
function sequence(...results: ReturnType<typeof textResult | typeof toolResult>[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => results[Math.min(i++, results.length - 1)],
  });
}

describe("modelDecision", () => {
  it("plain text reply", async () => {
    const model = sequence(textResult("  We open at 9.  "));
    const d = await modelDecision(model, "sys", "<conversation>\nCustomer: hi\n</conversation>");
    expect(d.text).toBe("We open at 9.");
    expect(d.handoff).toBeUndefined();
    expect(d.requests).toEqual([]);
    expect(d.toolCalls).toEqual([]);
    expect(d.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("request_human records a handoff", async () => {
    const model = sequence(
      toolResult([{ name: "request_human", args: { reason: "asked for a person", summary: "Wants a refund" } }]),
      textResult("Someone will follow up."),
    );
    const d = await modelDecision(model, "sys", "prompt");
    expect(d.text).toBe("Someone will follow up.");
    expect(d.handoff).toEqual({ reason: "asked for a person", summary: "Wants a refund" });
    expect(d.toolCalls).toEqual([
      { name: "request_human", args: { reason: "asked for a person", summary: "Wants a refund" } },
    ]);
    expect(d.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("the last request_human wins and save_request is kept up to 3", async () => {
    const save = (n: number) => ({ name: "save_request", args: { summary: `s${n}`, details: `d${n}`, customerName: "Ana" } });
    const model = sequence(
      toolResult([
        { name: "request_human", args: { reason: "first", summary: "one" } },
        { name: "request_human", args: { reason: "second", summary: "two" } },
        save(1),
        save(2),
        save(3),
        save(4),
      ]),
      textResult("Done."),
    );
    const d = await modelDecision(model, "sys", "prompt");
    expect(d.handoff).toEqual({ reason: "second", summary: "two" });
    expect(d.requests).toHaveLength(3);
    expect(d.requests[0]).toEqual({ summary: "s1", details: "d1", customerName: "Ana" });
  });

  it("tool input is cut, not rejected", async () => {
    const model = sequence(
      toolResult([
        { name: "request_human", args: { reason: "r".repeat(900), summary: "s".repeat(900) } },
        { name: "save_request", args: { summary: "x".repeat(900), details: "y".repeat(3000) } },
        { name: "save_request", args: { summary: "a", details: "b", customerName: "n".repeat(200) } },
      ]),
      textResult("Ok."),
    );
    const d = await modelDecision(model, "sys", "prompt");
    expect(d.handoff?.reason).toHaveLength(200);
    expect(d.handoff?.summary).toHaveLength(500);
    expect(d.requests[0].summary).toHaveLength(500);
    expect(d.requests[0].details).toHaveLength(2000);
    expect(d.requests[0].customerName).toBeUndefined();
    expect(d.requests[1].customerName).toHaveLength(80);
    expect(d.text).toBe("Ok.");
  });

  it("model error propagates", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("upstream down");
      },
    });
    await expect(modelDecision(model, "sys", "prompt")).rejects.toThrow("upstream down");
  });
});

describe("demoDecision", () => {
  it("asks for a person", () => {
    const d = demoDecision("Can I talk to a person?");
    expect(d.handoff).toEqual({
      reason: "Customer asked for a person",
      summary: "Can I talk to a person?",
    });
    expect(d.text).toBe("Sure — someone from our team will take it from here.");
    expect(d.requests).toEqual([]);
    expect(d.toolCalls.map((c) => c.name)).toEqual(["request_human"]);
  });

  it("handles other languages and uppercase", () => {
    expect(demoDecision("Quero falar com um ATENDENTE").handoff).toBeDefined();
    expect(demoDecision("preciso de um orçamento").requests).toHaveLength(1);
  });

  it("saves a request", () => {
    const d = demoDecision("I'd like a quote for 3 boxes");
    expect(d.handoff).toBeUndefined();
    expect(d.requests).toEqual([{ summary: "Demo request", details: "I'd like a quote for 3 boxes" }]);
    expect(d.text).toBe("Got it — I saved your request and the team will confirm.");
    expect(d.toolCalls.map((c) => c.name)).toEqual(["save_request"]);
  });

  it("falls back to the fixed reply", () => {
    const d = demoDecision("hello");
    expect(d.text).toBe(
      "Thanks for your message! This is a demo reply — set OPENROUTER_API_KEY to answer with a real model.",
    );
    expect(d.handoff).toBeUndefined();
    expect(d.requests).toEqual([]);
    expect(d.toolCalls).toEqual([]);
  });

  it("matches whole words only", () => {
    expect(demoDecision("I need personal help").handoff).toBeUndefined();
    expect(demoDecision("a bookshelf").requests).toEqual([]);
    expect(demoDecision("humanoid robot").handoff).toBeUndefined();
  });

  it("checks handoff before request", () => {
    const d = demoDecision("I want to order from a human");
    expect(d.handoff).toBeDefined();
    expect(d.requests).toEqual([]);
  });

  it("cuts long text", () => {
    const long = "person " + "x".repeat(3000);
    expect(demoDecision(long).handoff?.summary).toHaveLength(500);
    expect(demoDecision("order " + "x".repeat(3000)).requests[0].details).toHaveLength(2000);
  });
});
