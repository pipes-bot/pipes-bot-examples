import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { recordActivity } from "./crm";
import { previewOf, searchTextOf } from "./lib/crm";
import {
  contactName,
  contentOf,
  echoRecipientOf,
  list,
  senderOf,
  waTimestampMs,
} from "./lib/payload";

type EventState = Doc<"events">["state"];
type Outcome = "duplicate" | EventState;
type Ids = { waId?: string; userId?: string };
type Direction = Doc<"contacts">["lastDirection"];

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

async function contactByUserId(ctx: MutationCtx, workspaceId: Id<"workspaces">, userId: string) {
  return ctx.db
    .query("contacts")
    .withIndex("by_workspace_user_id", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
    .first();
}

async function contactByWaId(ctx: MutationCtx, workspaceId: Id<"workspaces">, waId: string) {
  return ctx.db
    .query("contacts")
    .withIndex("by_workspace_wa_id", (q) => q.eq("workspaceId", workspaceId).eq("waId", waId))
    .first();
}

/**
 * Finds the workspace's contact by BSUID, then by phone, filling the id that was missing; or
 * creates it as a lead. A new contact starts with no inbound message, so its window is closed
 * until the customer writes.
 */
async function resolveContact(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  ids: Ids,
  name: string | undefined,
  sentAt: number,
  direction: Direction,
): Promise<Doc<"contacts"> | null> {
  if (!ids.waId && !ids.userId) return null;
  const { workspaceId } = number;
  const contact =
    (ids.userId ? await contactByUserId(ctx, workspaceId, ids.userId) : null) ??
    (ids.waId ? await contactByWaId(ctx, workspaceId, ids.waId) : null);

  if (!contact) {
    const id = await ctx.db.insert("contacts", {
      workspaceId,
      ...ids,
      ...(name ? { name } : {}),
      stage: "lead",
      tags: [],
      lastNumberId: number._id,
      lastMessageAt: sentAt,
      lastDirection: direction,
      unread: 0,
      searchText: searchTextOf({ ...ids, name }),
    });
    await recordActivity(ctx, {
      workspaceId,
      contactId: id,
      kind: "contact_created",
      actor: "system",
      detail: direction === "in" ? "Started by a WhatsApp message" : "Started from the phone",
      createdAt: sentAt,
    });
    return (await ctx.db.get(id))!;
  }

  const patch: Partial<Doc<"contacts">> = {};
  if (!contact.waId && ids.waId) patch.waId = ids.waId;
  if (!contact.userId && ids.userId) patch.userId = ids.userId;
  if (!contact.name && name) patch.name = name;
  if (Object.keys(patch).length === 0) return contact;
  const updated = { ...contact, ...patch };
  patch.searchText = searchTextOf(updated);
  await ctx.db.patch(contact._id, patch);
  return { ...updated, searchText: patch.searchText };
}

/** `system` messages report a phone number or BSUID change; they are not conversation messages. */
async function applySystemChange(ctx: MutationCtx, workspaceId: Id<"workspaces">, system: any) {
  const previousUserId = str(system?.previous_user_id);
  const userId = str(system?.user_id);
  const waId = str(system?.wa_id);

  let contact: Doc<"contacts"> | null = null;
  const patch: Partial<Doc<"contacts">> = {};
  if (system?.type === "user_changed_number") {
    contact =
      (previousUserId ? await contactByUserId(ctx, workspaceId, previousUserId) : null) ??
      (userId ? await contactByUserId(ctx, workspaceId, userId) : null);
    if (waId) patch.waId = waId;
    if (userId) patch.userId = userId;
  } else if (system?.type === "user_changed_user_id") {
    if (!previousUserId || !userId) return;
    contact = await contactByUserId(ctx, workspaceId, previousUserId);
    patch.userId = userId;
  }
  if (!contact || Object.keys(patch).length === 0) return;
  patch.searchText = searchTextOf({ ...contact, ...patch });
  await ctx.db.patch(contact._id, patch);
}

async function projectMessage(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  whatsapp: any,
  msg: any,
  now: number,
) {
  if (msg?.type === "system") return applySystemChange(ctx, number.workspaceId, msg.system);
  const wamid = str(msg?.id);
  if (!wamid || (await messageByWamid(ctx, wamid))) return;

  const sentAt = waTimestampMs(msg.timestamp, now);
  const ids = senderOf(msg);
  const contact = await resolveContact(ctx, number, ids, contactName(whatsapp, ids), sentAt, "in");
  if (!contact) return;

  const content = contentOf(msg);
  await ctx.db.insert("messages", {
    workspaceId: number.workspaceId,
    contactId: contact._id,
    numberId: number._id,
    wamid,
    direction: "in",
    source: "contact",
    ...content,
    status: "delivered",
    sentAt,
  });
  // A webhook that arrives late must not roll the conversation summary back.
  const latest = sentAt >= contact.lastMessageAt;
  await ctx.db.patch(contact._id, {
    lastNumberId: number._id,
    lastInboundAt: Math.max(contact.lastInboundAt ?? 0, sentAt),
    lastMessageAt: Math.max(contact.lastMessageAt, sentAt),
    ...(latest ? { lastDirection: "in" as const, lastPreview: previewOf(content) } : {}),
    unread: contact.unread + 1,
  });
}

/** Returns false when the message is unknown (e.g. the status raced the send that stores its wamid). */
async function projectStatus(ctx: MutationCtx, status: any): Promise<boolean> {
  const wamid = str(status?.id);
  const state = str(status?.status);
  if (!wamid || !state) return false;
  const message = await messageByWamid(ctx, wamid);
  if (!message) return false;

  if (state === "failed") {
    const code = status.errors?.[0]?.code;
    await ctx.db.patch(message._id, {
      status: "failed",
      ...(code !== undefined && code !== null ? { error: `meta_${code}` } : {}),
    });
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
  now: number,
) {
  const wamid = str(echo?.id);
  if (!wamid || (await messageByWamid(ctx, wamid))) return;

  const sentAt = waTimestampMs(echo.timestamp, now);
  const ids = echoRecipientOf(echo);
  const contact = await resolveContact(ctx, number, ids, contactName(whatsapp, ids), sentAt, "out");
  if (!contact) return;

  const content = contentOf(echo);
  await ctx.db.insert("messages", {
    workspaceId: number.workspaceId,
    contactId: contact._id,
    numberId: number._id,
    wamid,
    direction: "out",
    source: "phone",
    ...content,
    status: "sent",
    sentAt,
  });
  // `lastInboundAt` is untouched: an echo does not open the 24h window. Replying from the
  // phone counts as reading the conversation.
  const latest = sentAt >= contact.lastMessageAt;
  await ctx.db.patch(contact._id, {
    lastNumberId: number._id,
    lastMessageAt: Math.max(contact.lastMessageAt, sentAt),
    ...(latest ? { lastDirection: "out" as const, lastPreview: previewOf(content), unread: 0 } : {}),
  });
}

/** Projects an envelope (`messages` or `smb_message_echoes`) for a known number. */
async function projectEnvelope(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  payload: any,
  now: number,
): Promise<EventState> {
  const whatsapp = payload.whatsapp;
  let applied = false;
  if (payload.field === "messages") {
    for (const msg of list(whatsapp?.messages)) {
      await projectMessage(ctx, number, whatsapp, msg, now);
      applied = true;
    }
    for (const status of list(whatsapp?.statuses)) {
      if (await projectStatus(ctx, status)) applied = true;
    }
  } else if (payload.field === "smb_message_echoes") {
    for (const echo of list(whatsapp?.message_echoes)) {
      await projectEcho(ctx, number, whatsapp, echo, now);
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

  // A re-onboarding into another workspace just repoints the number: contacts are
  // per workspace, so the old workspace keeps its history and new messages start fresh
  // contacts in the new one.
  const existing = await numberByPoolId(ctx, poolNumberId);
  const fields = {
    workspaceId: workspace._id,
    phoneNumber: str(data?.phoneNumber) ?? existing?.phoneNumber ?? "",
    displayName: str(data?.displayName) ?? existing?.displayName ?? "",
  };
  let number: Doc<"numbers">;
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    number = { ...existing, ...fields };
  } else {
    const id = await ctx.db.insert("numbers", { ...fields, poolNumberId, connectedAt: now });
    number = (await ctx.db.get(id))!;
  }

  // Replay what arrived before the number had a workspace, in arrival order.
  // Parked `number.onboarded` events carry no envelope and stay parked.
  const parked = await ctx.db
    .query("events")
    .withIndex("by_pool_number_state", (q) => q.eq("poolNumberId", poolNumberId).eq("state", "parked"))
    .collect();
  parked.sort((a, b) => a.receivedAt - b.receivedAt);
  for (const event of parked) {
    if (!ENVELOPE_FIELDS.has(event.payload?.field)) continue;
    const state = await projectEnvelope(ctx, number, event.payload, event.receivedAt);
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
  return projectEnvelope(ctx, number, payload, now);
}

/**
 * Dedups a webhook delivery, routes it and stores it raw with its final state.
 * Also called directly by the demo seed.
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
