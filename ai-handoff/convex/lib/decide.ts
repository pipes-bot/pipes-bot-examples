import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { clampText } from "./prompt";

export type ReplyDecision = {
  text: string;
  handoff?: { reason: string; summary: string };
  requests: { summary: string; details: string; customerName?: string }[];
  toolCalls: { name: string; args: unknown }[];
  usage?: { inputTokens: number; outputTokens: number };
};

const MAX_REQUESTS = 3;
const MODEL_TIMEOUT_MS = 60_000;
const MAX_MODEL_STEPS = 3;

export async function modelDecision(
  model: LanguageModel,
  system: string,
  prompt: string,
): Promise<ReplyDecision> {
  let handoff: ReplyDecision["handoff"];
  const requests: ReplyDecision["requests"] = [];

  // Tools only record intents; the effect happens later, in commitReply.
  // Schemas carry no .max(): oversized input is cut in execute, never rejected.
  const tools = {
    request_human: tool({
      description:
        "Ask a human from the team to take over this conversation. The last call wins.",
      inputSchema: z.object({
        reason: z.string().describe("Why a human is needed (up to 200 characters)"),
        summary: z.string().describe("Short summary for the team (up to 500 characters)"),
      }),
      execute: async ({ reason, summary }) => {
        handoff = { reason: clampText(reason, 200), summary: clampText(summary, 500) };
        return "Recorded.";
      },
    }),
    save_request: tool({
      description:
        "Save a customer order, quote or booking request for the team (at most 3 per turn).",
      inputSchema: z.object({
        summary: z.string().describe("One-line summary (up to 500 characters)"),
        details: z.string().describe("Everything the team needs (up to 2000 characters)"),
        customerName: z.string().optional().describe("Customer name if known (up to 80 characters)"),
      }),
      execute: async ({ summary, details, customerName }) => {
        if (requests.length >= MAX_REQUESTS) return "Limit reached, not saved.";
        const name = clampText(customerName, 80);
        requests.push({
          summary: clampText(summary, 500),
          details: clampText(details, 2000),
          ...(name ? { customerName: name } : {}),
        });
        return "Recorded.";
      },
    }),
  };

  const result = await generateText({
    model,
    system,
    prompt,
    tools,
    stopWhen: stepCountIs(MAX_MODEL_STEPS),
    maxRetries: 0,
    timeout: MODEL_TIMEOUT_MS,
  });

  return {
    text: result.text.trim(),
    ...(handoff ? { handoff } : {}),
    requests,
    toolCalls: result.steps.flatMap((s) =>
      s.toolCalls.map((c) => ({ name: c.toolName as string, args: c.input as unknown })),
    ),
    usage: {
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
    },
  };
}

const wordRe = (words: string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "iu");

const HANDOFF_RE = wordRe(["human", "agent", "person", "humano", "atendente", "pessoa"]);
const REQUEST_RE = wordRe(["order", "quote", "buy", "book", "pedido", "orçamento", "comprar"]);

export function demoDecision(lastCustomerText: string): ReplyDecision {
  if (HANDOFF_RE.test(lastCustomerText)) {
    const handoff = {
      reason: "Customer asked for a person",
      summary: clampText(lastCustomerText, 500),
    };
    return {
      text: "Sure — someone from our team will take it from here.",
      handoff,
      requests: [],
      toolCalls: [{ name: "request_human", args: handoff }],
    };
  }
  if (REQUEST_RE.test(lastCustomerText)) {
    const request = { summary: "Demo request", details: clampText(lastCustomerText, 2000) };
    return {
      text: "Got it — I saved your request and the team will confirm.",
      requests: [request],
      toolCalls: [{ name: "save_request", args: request }],
    };
  }
  return {
    text: "Thanks for your message! This is a demo reply — set OPENROUTER_API_KEY to answer with a real model.",
    requests: [],
    toolCalls: [],
  };
}
