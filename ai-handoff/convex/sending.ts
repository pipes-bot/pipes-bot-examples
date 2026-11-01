import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { applyEvent, ownedNumber } from "./handoff";
import { SEND_TIMEOUT_MS, countReply, previewOf } from "./lib/handoff";
import { apiBaseUrl } from "./lib/env";
import { parseSendFailure, rateLimitDelayMs, sendErrorMessage, type SendError } from "./lib/send";

// Sends the AI's replies. `commitReply` stores a pending message with `insertAiMessage`, which
// schedules `deliver` (pipes.bot, or simulated for demo numbers) and then `finish` records the
// outcome. Only a 429 is retried automatically: the message was not sent, so trying again cannot
// send it twice. A timeout is never retried, because the message may have gone out.

const MAX_ATTEMPTS = 3;
const DEMO_DELIVERED_DELAY_MS = 2000;

type DeliverResult = "sent" | "queued" | "failed" | "gone";

/**
 * Stores an AI reply as a pending message, records it on the conversation and schedules its
 * delivery. A plain helper: `commitReply` calls it inside its own mutation.
 */
export async function insertAiMessage(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  text: string,
  now: number,
): Promise<Id<"messages">> {
  const messageId = await ctx.db.insert("messages", {
    workspaceId: conversation.workspaceId,
    conversationId: conversation._id,
    numberId: conversation.numberId,
    direction: "out",
    source: "ai",
    type: "text",
    text,
    status: "pending",
    attempt: 1,
    sentAt: now,
  });
  await ctx.db.patch(conversation._id, {
    lastMessageAt: now,
    lastFrom: "ai",
    lastPreview: previewOf({ type: "text", text }),
    aiReplies: countReply(conversation.aiReplies, now),
  });
  await ctx.scheduler.runAfter(0, internal.sending.deliver, { messageId });
  return messageId;
}

export const deliveryContext = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message) return null;
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation) return null;
    // A number re-onboarded into another workspace is gone for this conversation's messages.
    const number = ownedNumber(conversation, await ctx.db.get(conversation.numberId));
    return { message, conversation, number };
  },
});

const outcomeValidator = v.union(
  v.object({ status: v.literal("sent"), wamid: v.string() }),
  v.object({ status: v.literal("failed"), error: v.string() }),
);

type Outcome = { status: "sent"; wamid: string } | { status: "failed"; error: SendError };

export const finish = internalMutation({
  args: { messageId: v.id("messages"), outcome: outcomeValidator },
  handler: async (ctx, { messageId, outcome }) => {
    const message = await ctx.db.get(messageId);
    if (!message) return null;
    if (outcome.status === "sent") {
      // The conversation fields were set by insertAiMessage.
      await ctx.db.patch(messageId, { status: "sent", wamid: outcome.wamid });
      return null;
    }
    await ctx.db.patch(messageId, { status: "failed", error: outcome.error });
    // Re-read: a take over may have moved the conversation out of `ai` meanwhile. A superseded
    // reply was dropped on purpose, so it is not an AI error.
    const conversation = await ctx.db.get(message.conversationId);
    if (conversation?.mode === "ai" && outcome.error !== "superseded") {
      await applyEvent(
        ctx,
        conversation,
        { kind: "ai_error", error: sendErrorMessage(outcome.error) },
        Date.now(),
      );
    }
    return null;
  },
});

export const queueRetry = internalMutation({
  args: { messageId: v.id("messages"), attempt: v.number(), delayMs: v.number() },
  handler: async (ctx, { messageId, attempt, delayMs }) => {
    await ctx.db.patch(messageId, { status: "queued", attempt });
    await ctx.scheduler.runAfter(delayMs, internal.sending.deliver, { messageId });
    return null;
  },
});

/** Demo messages skip pipes.bot, so nothing else would ever mark them delivered. */
export const markDelivered = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (message?.status === "sent") await ctx.db.patch(messageId, { status: "delivered" });
    return null;
  },
});

type ApiAttempt =
  | { kind: "sent"; wamid: string }
  | { kind: "failed"; error: SendError }
  | { kind: "rate_limited"; reset: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimeout(error: unknown): boolean {
  const name = isRecord(error) ? error.name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

async function postToPipes(
  apiKey: string,
  payload: { poolNumberId: string; to: string; text: string },
): Promise<ApiAttempt> {
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/messages/app/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status === 429) {
      return { kind: "rate_limited", reset: response.headers.get("x-ratelimit-reset") };
    }
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // Not JSON: parseSendFailure falls back to the HTTP status.
    }
    if (response.ok) {
      // API v2 answers { messageId: "wamid....", contacts: [...] }.
      const wamid = isRecord(body) ? body.messageId : undefined;
      return typeof wamid === "string" && wamid.length > 0
        ? { kind: "sent", wamid }
        : { kind: "failed", error: `http_${response.status}` };
    }
    return { kind: "failed", error: parseSendFailure(response.status, body) };
  } catch (error) {
    // The request may have reached WhatsApp, so neither case is retried automatically.
    return { kind: "failed", error: isTimeout(error) ? "unknown" : "network_error" };
  }
}

function demoWamid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `wamid.demo_${Array.from(bytes, (byte) => (byte % 36).toString(36)).join("")}`;
}

export const deliver = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<DeliverResult> => {
    const context = await ctx.runQuery(internal.sending.deliveryContext, { messageId });
    // Deleted meanwhile (demo reset): nothing left to send or to update.
    if (!context) return "gone";
    const { message, conversation, number } = context;
    // Only a message waiting to be sent is delivered, so a stray second call cannot send it twice.
    if (message.status !== "pending" && message.status !== "queued") {
      return message.status === "failed" ? "failed" : "sent";
    }
    if (!number) return "gone";

    const finishWith = async (outcome: Outcome): Promise<DeliverResult> => {
      await ctx.runMutation(internal.sending.finish, { messageId, outcome });
      return outcome.status;
    };

    // A 429 retry waited a while: if staff took over meanwhile, the AI reply must not go out.
    if ((message.attempt ?? 1) > 1 && conversation.mode !== "ai") {
      return await finishWith({ status: "failed", error: "superseded" });
    }

    if (number.health?.canSendMessage === "BLOCKED") {
      return await finishWith({ status: "failed", error: "number_blocked" });
    }
    const to = conversation.waId ?? conversation.userId;
    if (to === undefined) return await finishWith({ status: "failed", error: "no_recipient" });
    if (number.isDemo) {
      const result = await finishWith({ status: "sent", wamid: demoWamid() });
      await ctx.scheduler.runAfter(DEMO_DELIVERED_DELAY_MS, internal.sending.markDelivered, {
        messageId,
      });
      return result;
    }
    const apiKey = process.env.PIPES_API_KEY;
    if (!apiKey) return await finishWith({ status: "failed", error: "not_configured" });

    const result = await postToPipes(apiKey, {
      poolNumberId: number.poolNumberId,
      to,
      text: message.text ?? "",
    });
    if (result.kind === "rate_limited") {
      const attempt = message.attempt ?? 1;
      if (attempt >= MAX_ATTEMPTS) {
        return await finishWith({ status: "failed", error: "rate_limited" });
      }
      await ctx.runMutation(internal.sending.queueRetry, {
        messageId,
        attempt: attempt + 1,
        delayMs: rateLimitDelayMs(result.reset, Date.now()),
      });
      return "queued";
    }
    return await finishWith(
      result.kind === "sent"
        ? { status: "sent", wamid: result.wamid }
        : { status: "failed", error: result.error },
    );
  },
});
