import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireWorkspaceId } from "./authz";
import { recordActivity } from "./crm";
import { cleanText, previewOf, windowState } from "./lib/crm";
import { apiBaseUrl } from "./lib/env";
import { parseSendFailure, rateLimitDelayMs, type SendError, type SendResult } from "./lib/send";

// The only path that sends a WhatsApp message: prepareSend (refuse without writing) →
// insertOutgoing (the message shows up as pending) → deliver (pipes.bot, or simulated for demo
// numbers) → finish. Only a 429 is retried automatically: the message was not sent, so trying
// again cannot send it twice. A timeout is never retried, because the message may have gone out.

const MAX_TEXT_LENGTH = 4096;
const SEND_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const ACTIVITY_DETAIL_LENGTH = 80;

const outgoingSourceValidator = v.union(v.literal("app"), v.literal("mcp"));

type OutgoingSource = "app" | "mcp";

export type SendArgs = {
  workspaceId: Id<"workspaces">;
  contactId: Id<"contacts">;
  text: string;
  source: OutgoingSource;
  clientName?: string;
  draftId?: Id<"drafts">;
  retryOf?: Id<"messages">;
};

/** Trimmed text, or null when it is empty or longer than WhatsApp allows. */
export function sendableText(raw: string): string | null {
  try {
    return cleanText(raw, MAX_TEXT_LENGTH, "text");
  } catch {
    return null;
  }
}

function isBlocked(number: Doc<"numbers">): boolean {
  return number.health?.state === "unhealthy" || number.health?.canSendMessage === "BLOCKED";
}

type Prepared = { ok: true } | { ok: false; error: SendError };

export const prepareSend = internalQuery({
  args: { workspaceId: v.id("workspaces"), contactId: v.id("contacts"), text: v.string() },
  handler: async (ctx, { workspaceId, contactId, text }): Promise<Prepared> => {
    if (sendableText(text) === null) return { ok: false, error: "invalid_text" };
    const contact = await ctx.db.get(contactId);
    if (!contact || contact.workspaceId !== workspaceId) throw new ConvexError("Not found");
    if ((contact.waId ?? contact.userId) === undefined) return { ok: false, error: "no_recipient" };
    const number = await ctx.db.get(contact.lastNumberId);
    if (!number || number.workspaceId !== workspaceId) {
      return { ok: false, error: "number_unavailable" };
    }
    if (isBlocked(number)) return { ok: false, error: "number_blocked" };
    if (!windowState(contact, Date.now()).open) return { ok: false, error: "window_closed" };
    return { ok: true };
  },
});

async function requireRetryable(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  messageId: Id<"messages">,
): Promise<Doc<"messages"> & { text: string }> {
  const message = await ctx.db.get(messageId);
  if (!message || message.workspaceId !== workspaceId) throw new ConvexError("Not found");
  if (message.direction !== "out" || message.status !== "failed" || message.text === undefined) {
    throw new ConvexError("Only a failed message can be retried");
  }
  if (message.retriedBy !== undefined) throw new ConvexError("This message was already retried");
  return { ...message, text: message.text };
}

export const insertOutgoing = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    contactId: v.id("contacts"),
    text: v.string(),
    source: outgoingSourceValidator,
    clientName: v.optional(v.string()),
    draftId: v.optional(v.id("drafts")),
    // Links the failed message being retried, in the same transaction, so it is retried once.
    retryOf: v.optional(v.id("messages")),
  },
  handler: async (ctx, args): Promise<Id<"messages">> => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.workspaceId !== args.workspaceId) throw new ConvexError("Not found");
    if (args.retryOf !== undefined) await requireRetryable(ctx, args.workspaceId, args.retryOf);
    const messageId = await ctx.db.insert("messages", {
      workspaceId: args.workspaceId,
      contactId: args.contactId,
      numberId: contact.lastNumberId,
      direction: "out",
      source: args.source,
      ...(args.clientName !== undefined ? { clientName: args.clientName } : {}),
      type: "text",
      text: args.text,
      status: "pending",
      attempt: 1,
      ...(args.draftId !== undefined ? { draftId: args.draftId } : {}),
      sentAt: Date.now(),
    });
    if (args.retryOf !== undefined) await ctx.db.patch(args.retryOf, { retriedBy: messageId });
    return messageId;
  },
});

export const deliveryContext = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message) return null;
    return {
      message,
      contact: await ctx.db.get(message.contactId),
      number: await ctx.db.get(message.numberId),
    };
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
    const now = Date.now();

    if (outcome.status === "sent") {
      await ctx.db.patch(messageId, { status: "sent", wamid: outcome.wamid });
      const contact = await ctx.db.get(message.contactId);
      if (contact) {
        await ctx.db.patch(contact._id, {
          lastMessageAt: now,
          lastDirection: "out",
          lastPreview: previewOf(message),
        });
        await recordActivity(ctx, {
          workspaceId: message.workspaceId,
          contactId: message.contactId,
          kind: "message_sent",
          actor: message.source === "app" ? "you" : (message.clientName ?? "MCP"),
          detail: (message.text ?? "").slice(0, ACTIVITY_DETAIL_LENGTH),
          createdAt: now,
        });
      }
    } else {
      await ctx.db.patch(messageId, { status: "failed", error: outcome.error });
    }

    if (message.draftId === undefined) return null;
    const draft = await ctx.db.get(message.draftId);
    if (!draft) return null;
    // The draft keeps the text the MCP client proposed; the message has what was actually sent.
    await ctx.db.patch(draft._id, {
      status: outcome.status,
      messageId,
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
      decidedAt: now,
    });
    await recordActivity(ctx, {
      workspaceId: draft.workspaceId,
      contactId: draft.contactId,
      kind: "draft_decided",
      actor: "you",
      detail:
        outcome.status === "failed"
          ? `failed: ${outcome.error}`
          : message.text !== draft.text
            ? "sent (edited)"
            : "sent",
      createdAt: now,
    });
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
    return { kind: "failed", error: isTimeout(error) ? "timeout" : "network_error" };
  }
}

function demoWamid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `wamid.demo_${Array.from(bytes, (byte) => (byte % 36).toString(36)).join("")}`;
}

async function finishWith(
  ctx: ActionCtx,
  messageId: Id<"messages">,
  outcome: Outcome,
): Promise<SendResult> {
  await ctx.runMutation(internal.sending.finish, { messageId, outcome });
  return outcome.status === "sent"
    ? { status: "sent", messageId }
    : { status: "failed", messageId, error: outcome.error };
}

export async function deliverMessage(
  ctx: ActionCtx,
  messageId: Id<"messages">,
): Promise<SendResult> {
  const context = await ctx.runQuery(internal.sending.deliveryContext, { messageId });
  // Deleted meanwhile (demo reset): nothing left to send or to update.
  if (!context) return { status: "failed", messageId, error: "number_unavailable" };
  const { message, contact, number } = context;
  // Only a message waiting to be sent is delivered, so a stray second call cannot send it again.
  if (message.status !== "pending" && message.status !== "queued") {
    return message.status === "failed"
      ? { status: "failed", messageId, ...(message.error ? { error: message.error } : {}) }
      : { status: "sent", messageId };
  }
  if (!number || number.workspaceId !== message.workspaceId) {
    return await finishWith(ctx, messageId, { status: "failed", error: "number_unavailable" });
  }
  const to = contact?.waId ?? contact?.userId;
  if (to === undefined) {
    return await finishWith(ctx, messageId, { status: "failed", error: "no_recipient" });
  }
  if (number.isDemo) {
    return await finishWith(ctx, messageId, { status: "sent", wamid: demoWamid() });
  }
  const apiKey = process.env.PIPES_API_KEY;
  if (!apiKey) {
    return await finishWith(ctx, messageId, { status: "failed", error: "not_configured" });
  }

  const result = await postToPipes(apiKey, {
    poolNumberId: number.poolNumberId,
    to,
    text: message.text ?? "",
  });
  if (result.kind === "rate_limited") {
    const attempt = message.attempt ?? 1;
    if (attempt >= MAX_ATTEMPTS) {
      return await finishWith(ctx, messageId, { status: "failed", error: "rate_limited" });
    }
    await ctx.runMutation(internal.sending.queueRetry, {
      messageId,
      attempt: attempt + 1,
      delayMs: rateLimitDelayMs(result.reset, Date.now()),
    });
    return { status: "queued", messageId };
  }
  return await finishWith(
    ctx,
    messageId,
    result.kind === "sent"
      ? { status: "sent", wamid: result.wamid }
      : { status: "failed", error: result.error },
  );
}

export const deliver = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<SendResult> => await deliverMessage(ctx, messageId),
});

/** prepareSend, then insertOutgoing. A refusal writes nothing. */
export async function startSend(
  ctx: ActionCtx,
  args: SendArgs,
): Promise<{ messageId: Id<"messages"> } | { error: SendError }> {
  const text = args.text.trim();
  const check = await ctx.runQuery(internal.sending.prepareSend, {
    workspaceId: args.workspaceId,
    contactId: args.contactId,
    text,
  });
  if (!check.ok) return { error: check.error };
  const messageId = await ctx.runMutation(internal.sending.insertOutgoing, { ...args, text });
  return { messageId };
}

export async function runSend(ctx: ActionCtx, args: SendArgs): Promise<SendResult> {
  const started = await startSend(ctx, args);
  if ("error" in started) return { status: "failed", error: started.error };
  return await deliverMessage(ctx, started.messageId);
}

export const sendMessage = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    contactId: v.id("contacts"),
    text: v.string(),
    source: outgoingSourceValidator,
    clientName: v.optional(v.string()),
    draftId: v.optional(v.id("drafts")),
  },
  handler: async (ctx, args): Promise<SendResult> => await runSend(ctx, args),
});

export const send = action({
  args: { contactId: v.id("contacts"), text: v.string() },
  handler: async (ctx, { contactId, text }): Promise<SendResult> => {
    const workspaceId = await requireWorkspaceId(ctx);
    // prepareSend throws "Not found" for a contact of another workspace.
    return await runSend(ctx, { workspaceId, contactId, text, source: "app" });
  },
});

export const retryable = internalQuery({
  args: { workspaceId: v.id("workspaces"), messageId: v.id("messages") },
  handler: async (ctx, { workspaceId, messageId }) => {
    const message = await requireRetryable(ctx, workspaceId, messageId);
    // A failed message sent from the phone is retried from this app.
    const source: OutgoingSource = message.source === "mcp" ? "mcp" : "app";
    return {
      contactId: message.contactId,
      text: message.text,
      source,
      ...(source === "mcp" && message.clientName !== undefined
        ? { clientName: message.clientName }
        : {}),
    };
  },
});

export const retry = action({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<SendResult> => {
    const workspaceId = await requireWorkspaceId(ctx);
    const original = await ctx.runQuery(internal.sending.retryable, { workspaceId, messageId });
    return await runSend(ctx, {
      workspaceId,
      contactId: original.contactId,
      text: original.text,
      source: original.source,
      ...(original.clientName !== undefined ? { clientName: original.clientName } : {}),
      retryOf: messageId,
    });
  },
});
