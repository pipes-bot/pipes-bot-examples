import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { applyEvent } from "./handoff";
import { previewOf, STALE_MESSAGE_MS, type HandoffEvent, type Source } from "./lib/handoff";
import {
  contactName,
  contentOf,
  echoRecipientOf,
  list,
  senderOf,
  waTimestampMs,
} from "./lib/payload";
import { metaSendError, sendErrorMessage } from "./lib/send";

type EventState = Doc<"events">["state"];
type Outcome = "duplicate" | EventState;
type Ids = { waId?: string; userId?: string };
/** `arrivedAt` is the fallback for a missing WhatsApp timestamp; `now` drives the state machine. */
type Clock = { arrivedAt: number; now: number };

/** Envelope fields that are projected; any other field is ignored. */
const ENVELOPE_FIELDS = new Set(["messages", "smb_message_echoes"]);

/** Delivery progress of an outbound message; a status only ever moves it forward. `failed` is handled apart. */
const PROGRESS = { pending: 0, queued: 0, sent: 1, delivered: 2, read: 3 } as const;
type Progress = keyof typeof PROGRESS;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function numberByPoolId(ctx: MutationCtx, poolNumberId: string) {
  return ctx.db
    .query("numbers")
    .withIndex("by_pool_number", (q) => q.eq("poolNumberId", poolNumberId))
    .first();
}

async function messageByWamid(ctx: MutationCtx, wamid: string) {
  return ctx.db
    .query("messages")
    .withIndex("by_wamid", (q) => q.eq("wamid", wamid))
    .first();
}

// Conversations are per number. A number re-onboarded into another workspace starts fresh
// conversations there, so lookups also match the number's current workspace.
async function conversationByUserId(ctx: MutationCtx, number: Doc<"numbers">, userId: string) {
  return ctx.db
    .query("conversations")
    .withIndex("by_number_user_id", (q) => q.eq("numberId", number._id).eq("userId", userId))
    .filter((q) => q.eq(q.field("workspaceId"), number.workspaceId))
    .first();
}

async function conversationByWaId(ctx: MutationCtx, number: Doc<"numbers">, waId: string) {
  return ctx.db
    .query("conversations")
    .withIndex("by_number_wa_id", (q) => q.eq("numberId", number._id).eq("waId", waId))
    .filter((q) => q.eq(q.field("workspaceId"), number.workspaceId))
    .first();
}

/**
 * Finds the number's conversation with the customer by BSUID, then by phone, filling the id
 * that was missing; or creates it in `ai` mode. A new conversation has no inbound message yet,
 * so its window stays closed until the customer writes.
 */
async function resolveConversation(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  ids: Ids,
  name: string | undefined,
  first: { sentAt: number; from: Source; preview: string },
  now: number,
): Promise<Doc<"conversations"> | null> {
  if (!ids.waId && !ids.userId) return null;
  const conversation =
    (ids.userId ? await conversationByUserId(ctx, number, ids.userId) : null) ??
    (ids.waId ? await conversationByWaId(ctx, number, ids.waId) : null);

  if (!conversation) {
    const id = await ctx.db.insert("conversations", {
      workspaceId: number.workspaceId,
      numberId: number._id,
      ...ids,
      ...(name ? { name } : {}),
      mode: "ai",
      modeChangedAt: now,
      aiTurn: 0,
      lastMessageAt: first.sentAt,
      lastFrom: first.from,
      lastPreview: first.preview,
      aiReplies: { windowStart: 0, count: 0 },
    });
    return (await ctx.db.get(id))!;
  }

  const patch: Partial<Doc<"conversations">> = {};
  if (!conversation.waId && ids.waId) patch.waId = ids.waId;
  if (!conversation.userId && ids.userId) patch.userId = ids.userId;
  if (!conversation.name && name) patch.name = name;
  if (Object.keys(patch).length === 0) return conversation;
  await ctx.db.patch(conversation._id, patch);
  return { ...conversation, ...patch };
}

/** `system` messages report a phone number or BSUID change; they are not conversation messages. */
async function applySystemChange(ctx: MutationCtx, number: Doc<"numbers">, system: any) {
  const previousUserId = str(system?.previous_user_id);
  const userId = str(system?.user_id);
  const waId = str(system?.wa_id);

  let conversation: Doc<"conversations"> | null = null;
  const patch: Partial<Doc<"conversations">> = {};
  if (system?.type === "user_changed_number") {
    conversation =
      (previousUserId ? await conversationByUserId(ctx, number, previousUserId) : null) ??
      (userId ? await conversationByUserId(ctx, number, userId) : null);
    if (waId) patch.waId = waId;
    if (userId) patch.userId = userId;
  } else if (system?.type === "user_changed_user_id") {
    if (!previousUserId || !userId) return;
    conversation = await conversationByUserId(ctx, number, previousUserId);
    patch.userId = userId;
  }
  if (!conversation || Object.keys(patch).length === 0) return;
  await ctx.db.patch(conversation._id, patch);
}

async function projectMessage(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  whatsapp: any,
  msg: any,
  clock: Clock,
) {
  if (msg?.type === "system") return applySystemChange(ctx, number, msg.system);
  const wamid = str(msg?.id);
  if (!wamid || (await messageByWamid(ctx, wamid))) return;

  const sentAt = waTimestampMs(msg.timestamp, clock.arrivedAt);
  const ids = senderOf(msg);
  const content = contentOf(msg);
  const preview = previewOf(content);
  const conversation = await resolveConversation(
    ctx,
    number,
    ids,
    contactName(whatsapp, ids),
    { sentAt, from: "customer", preview },
    clock.now,
  );
  if (!conversation) return;

  await ctx.db.insert("messages", {
    workspaceId: number.workspaceId,
    conversationId: conversation._id,
    numberId: number._id,
    wamid,
    direction: "in",
    source: "customer",
    ...content,
    status: "delivered",
    sentAt,
  });
  // A webhook that arrives late must not roll the conversation summary back.
  const latest = sentAt >= conversation.lastMessageAt;
  await ctx.db.patch(conversation._id, {
    lastInboundAt: Math.max(conversation.lastInboundAt ?? 0, sentAt),
    lastMessageAt: Math.max(conversation.lastMessageAt, sentAt),
    ...(latest ? { lastFrom: "customer" as const, lastPreview: preview } : {}),
  });

  // Re-read: the state machine must see the `lastFrom` written above.
  const fresh = (await ctx.db.get(conversation._id))!;
  const event = customerEvent(content, clock.now - sentAt > STALE_MESSAGE_MS);
  if (event) await applyEvent(ctx, fresh, event, clock.now);
}

/** Types that carry no request: stored, but they never hand the conversation over. */
const NO_EVENT_TYPES = new Set(["reaction", "sticker"]);
const REPLY_TYPES = new Set(["button", "interactive"]);

/**
 * Text, and button or list replies that carry their title, are something the AI can answer.
 * Reactions and stickers change nothing. Anything else is media for a person.
 */
function customerEvent(content: { type: string; text?: string }, stale: boolean): HandoffEvent | null {
  if (NO_EVENT_TYPES.has(content.type)) return null;
  if (content.type === "text" || (REPLY_TYPES.has(content.type) && content.text !== undefined)) {
    return { kind: "customer_text", stale };
  }
  return { kind: "customer_media" };
}

/** Returns false when the message is unknown (e.g. the status raced the send that stores its wamid). */
async function projectStatus(ctx: MutationCtx, status: any, now: number): Promise<boolean> {
  const wamid = str(status?.id);
  const state = str(status?.status);
  if (!wamid || !state) return false;
  const message = await messageByWamid(ctx, wamid);
  if (!message) return false;

  if (state === "failed") {
    if (message.status === "failed") return true;
    const code = status.errors?.[0]?.code;
    const error = code !== undefined && code !== null ? `meta_${code}` : undefined;
    await ctx.db.patch(message._id, { status: "failed", ...(error ? { error } : {}) });
    const sendError = typeof code === "number" ? metaSendError(code) : (error ?? "delivery_failed");
    if (message.source === "ai") {
      const conversation = await ctx.db.get(message.conversationId);
      if (conversation?.mode === "ai") {
        await applyEvent(
          ctx,
          conversation,
          { kind: "ai_error", error: sendErrorMessage(sendError) },
          now,
        );
      }
    }
  } else if (state in PROGRESS && message.status !== "failed") {
    const rank = (s: string) => PROGRESS[s as Progress] ?? -1;
    if (rank(state) > rank(message.status)) {
      await ctx.db.patch(message._id, { status: state as Doc<"messages">["status"] });
    }
  }
  return true;
}

/** A message the business sent from the WhatsApp Business app (coexistence echo). */
async function projectEcho(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  whatsapp: any,
  echo: any,
  clock: Clock,
) {
  const wamid = str(echo?.id);
  if (!wamid || (await messageByWamid(ctx, wamid))) return;

  const sentAt = waTimestampMs(echo.timestamp, clock.arrivedAt);
  const ids = echoRecipientOf(echo);
  const content = contentOf(echo);
  const preview = previewOf(content);
  const conversation = await resolveConversation(
    ctx,
    number,
    ids,
    contactName(whatsapp, ids),
    { sentAt, from: "phone", preview },
    clock.now,
  );
  if (!conversation) return;

  await ctx.db.insert("messages", {
    workspaceId: number.workspaceId,
    conversationId: conversation._id,
    numberId: number._id,
    wamid,
    direction: "out",
    source: "phone",
    ...content,
    status: "sent",
    sentAt,
  });
  // `lastInboundAt` is untouched: an echo does not open the 24h window.
  const latest = sentAt >= conversation.lastMessageAt;
  await ctx.db.patch(conversation._id, {
    lastMessageAt: Math.max(conversation.lastMessageAt, sentAt),
    ...(latest ? { lastFrom: "phone" as const, lastPreview: preview } : {}),
  });

  const fresh = (await ctx.db.get(conversation._id))!;
  await applyEvent(ctx, fresh, { kind: "phone_echo" }, clock.now);
}

/** Projects an envelope (`messages` or `smb_message_echoes`) for a known number. */
async function projectEnvelope(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  payload: any,
  clock: Clock,
): Promise<EventState> {
  const whatsapp = payload.whatsapp;
  let applied = false;
  if (payload.field === "messages") {
    for (const msg of list(whatsapp?.messages)) {
      await projectMessage(ctx, number, whatsapp, msg, clock);
      applied = true;
    }
    for (const status of list(whatsapp?.statuses)) {
      if (await projectStatus(ctx, status, clock.now)) applied = true;
    }
  } else if (payload.field === "smb_message_echoes") {
    for (const echo of list(whatsapp?.message_echoes)) {
      await projectEcho(ctx, number, whatsapp, echo, clock);
      applied = true;
    }
  }
  return applied ? "processed" : "ignored";
}

async function onboardNumber(
  ctx: MutationCtx,
  poolNumberId: string | undefined,
  data: any,
  now: number,
): Promise<EventState> {
  if (!poolNumberId) return "ignored";
  const rawWorkspaceId = str(data?.metadata?.workspaceId);
  const workspaceId = rawWorkspaceId ? ctx.db.normalizeId("workspaces", rawWorkspaceId) : null;
  const workspace = workspaceId ? await ctx.db.get(workspaceId) : null;
  if (!workspace) {
    console.warn(`unassigned number ${poolNumberId}`);
    return "parked";
  }

  // A re-onboarding into another workspace just repoints the number, with the AI off until the
  // new owner turns it on: the old workspace keeps its conversations and new messages start
  // fresh ones in the new one. A reconnect to the same workspace keeps the AI switch.
  const existing = await numberByPoolId(ctx, poolNumberId);
  const fields = {
    workspaceId: workspace._id,
    ...(existing && existing.workspaceId !== workspace._id ? { aiEnabled: false } : {}),
    phoneNumber: str(data?.phoneNumber) ?? existing?.phoneNumber ?? "",
    displayName: str(data?.displayName) ?? existing?.displayName ?? "",
  };
  let number: Doc<"numbers">;
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    number = { ...existing, ...fields };
  } else {
    const id = await ctx.db.insert("numbers", {
      ...fields,
      poolNumberId,
      connectedAt: now,
      aiEnabled: false,
    });
    number = (await ctx.db.get(id))!;
  }

  // Replay what arrived before the number had a workspace, in arrival order. The state machine
  // runs at `now`, so a message parked for more than 15 minutes is stale and gets no reply.
  // Parked `number.onboarded` events carry no envelope and stay parked.
  const parked = await ctx.db
    .query("events")
    .withIndex("by_pool_number_state", (q) => q.eq("poolNumberId", poolNumberId).eq("state", "parked"))
    .collect();
  parked.sort((a, b) => a.receivedAt - b.receivedAt);
  for (const event of parked) {
    if (!ENVELOPE_FIELDS.has(event.payload?.field)) continue;
    const state = await projectEnvelope(ctx, number, event.payload, { arrivedAt: event.receivedAt, now });
    await ctx.db.patch(event._id, { state });
  }
  return "processed";
}

async function route(
  ctx: MutationCtx,
  payload: any,
  poolNumberId: string | undefined,
  now: number,
): Promise<EventState> {
  if (payload.event === "number.onboarded") return onboardNumber(ctx, poolNumberId, payload.data, now);
  if (!ENVELOPE_FIELDS.has(payload.field) || !poolNumberId) return "ignored";
  const number = await numberByPoolId(ctx, poolNumberId);
  if (!number) return "parked";
  return projectEnvelope(ctx, number, payload, { arrivedAt: now, now });
}

/**
 * Dedups a webhook delivery, routes it and stores it raw with its final state.
 * Also called directly by the demo.
 */
export async function ingestPayload(
  ctx: MutationCtx,
  webhookId: string,
  payload: any,
  now = Date.now(),
): Promise<Outcome> {
  const seen = await ctx.db
    .query("events")
    .withIndex("by_webhook_id", (q) => q.eq("webhookId", webhookId))
    .first();
  if (seen) return "duplicate";

  const kind = str(payload.field) ?? str(payload.event) ?? "unknown";
  const poolNumberId =
    payload.event === "number.onboarded" ? str(payload.data?.numberId) : str(payload.pipes?.poolNumberId);

  // Route before inserting so the onboarding replay never sees this event as parked.
  const state = await route(ctx, payload, poolNumberId, now);
  await ctx.db.insert("events", { webhookId, kind, poolNumberId, payload, state, receivedAt: now });
  return state;
}

export const ingest = internalMutation({
  args: { webhookId: v.string(), payload: v.any() },
  returns: v.union(
    v.literal("duplicate"),
    v.literal("processed"),
    v.literal("parked"),
    v.literal("ignored"),
  ),
  handler: (ctx, { webhookId, payload }) => ingestPayload(ctx, webhookId, payload),
});
