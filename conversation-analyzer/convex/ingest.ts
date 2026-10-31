import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { closeConversation, recordMessage } from "./conversations";
import {
  contactName,
  contentOf,
  echoRecipientOf,
  list,
  senderOf,
  statusRecipientOf,
  waTimestampMs,
} from "./lib/payload";

type EventState = Doc<"events">["state"];
type Outcome = "duplicate" | EventState;
type Ids = { waId?: string; userId?: string };

/** Envelope fields that are projected; any other field is ignored. */
const ENVELOPE_FIELDS = new Set(["messages", "smb_message_echoes"]);

/** Status values that set a timestamp on the message; `sent` sets nothing. */
const STATUS_FIELDS = {
  delivered: "deliveredAt",
  read: "readAt",
  failed: "failedAt",
} as const;

type StatusTimes = Partial<Record<(typeof STATUS_FIELDS)[keyof typeof STATUS_FIELDS], number>>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function statusTime(status: string, timestamp: number): StatusTimes {
  const field = STATUS_FIELDS[status as keyof typeof STATUS_FIELDS];
  return field ? { [field]: timestamp } : {};
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

async function contactByUserId(ctx: MutationCtx, numberId: Id<"numbers">, userId: string) {
  return ctx.db
    .query("contacts")
    .withIndex("by_number_user_id", (q) => q.eq("numberId", numberId).eq("userId", userId))
    .first();
}

async function contactByWaId(ctx: MutationCtx, numberId: Id<"numbers">, waId: string) {
  return ctx.db
    .query("contacts")
    .withIndex("by_number_wa_id", (q) => q.eq("numberId", numberId).eq("waId", waId))
    .first();
}

/** Finds the contact by BSUID, then by phone; creates it or fills what was missing. */
async function resolveContact(
  ctx: MutationCtx,
  numberId: Id<"numbers">,
  ids: Ids,
  name: string | undefined,
): Promise<Id<"contacts"> | null> {
  if (!ids.waId && !ids.userId) return null;
  const contact =
    (ids.userId ? await contactByUserId(ctx, numberId, ids.userId) : null) ??
    (ids.waId ? await contactByWaId(ctx, numberId, ids.waId) : null);
  if (!contact) return ctx.db.insert("contacts", { numberId, ...ids, ...(name ? { name } : {}) });

  const patch: Partial<Doc<"contacts">> = {};
  if (!contact.waId && ids.waId) patch.waId = ids.waId;
  if (!contact.userId && ids.userId) patch.userId = ids.userId;
  if (!contact.name && name) patch.name = name;
  if (Object.keys(patch).length > 0) await ctx.db.patch(contact._id, patch);
  return contact._id;
}

/** `system` messages report a phone number or BSUID change; they are not conversation messages. */
async function applySystemChange(ctx: MutationCtx, numberId: Id<"numbers">, system: any) {
  const previousUserId = str(system?.previous_user_id);
  const userId = str(system?.user_id);
  const waId = str(system?.wa_id);

  if (system?.type === "user_changed_number") {
    const contact =
      (previousUserId ? await contactByUserId(ctx, numberId, previousUserId) : null) ??
      (userId ? await contactByUserId(ctx, numberId, userId) : null);
    if (!contact) return;
    await ctx.db.patch(contact._id, { ...(waId ? { waId } : {}), ...(userId ? { userId } : {}) });
  } else if (system?.type === "user_changed_user_id") {
    if (!previousUserId || !userId) return;
    const contact = await contactByUserId(ctx, numberId, previousUserId);
    if (contact) await ctx.db.patch(contact._id, { userId });
  }
}

async function projectMessage(ctx: MutationCtx, number: Doc<"numbers">, whatsapp: any, msg: any, now: number) {
  if (msg?.type === "system") return applySystemChange(ctx, number._id, msg.system);
  const wamid = str(msg?.id);
  if (!wamid) return;
  const ids = senderOf(msg);
  const contactId = await resolveContact(ctx, number._id, ids, contactName(whatsapp, ids));
  if (!contactId) return;
  await recordMessage(ctx, {
    number,
    contactId,
    wamid,
    source: "customer",
    ...contentOf(msg),
    sentAt: waTimestampMs(msg.timestamp, now),
  });
}

async function projectStatus(ctx: MutationCtx, number: Doc<"numbers">, status: any, now: number) {
  const wamid = str(status?.id);
  const state = str(status?.status);
  if (!wamid || !state) return;
  const timestamp = waTimestampMs(status.timestamp, now);

  const message = await messageByWamid(ctx, wamid);
  if (message) {
    const patch = statusTime(state, timestamp);
    if (Object.keys(patch).length > 0) await ctx.db.patch(message._id, patch);
    return;
  }
  const recipient = statusRecipientOf(status);
  if (!recipient) return;
  await ctx.db.insert("statuses", { numberId: number._id, wamid, status: state, timestamp, recipient });
}

async function projectEcho(ctx: MutationCtx, number: Doc<"numbers">, whatsapp: any, echo: any, now: number) {
  const wamid = str(echo?.id);
  if (!wamid) return;
  const ids = echoRecipientOf(echo);
  const contactId = await resolveContact(ctx, number._id, ids, contactName(whatsapp, ids));
  if (!contactId) return;
  await recordMessage(ctx, {
    number,
    contactId,
    wamid,
    source: "phone",
    ...contentOf(echo),
    sentAt: waTimestampMs(echo.timestamp, now),
  });

  // Statuses can arrive before their echo; fold them into the message now.
  const message = await messageByWamid(ctx, wamid);
  if (!message) return;
  const early = await ctx.db
    .query("statuses")
    .withIndex("by_wamid", (q) => q.eq("wamid", wamid))
    .collect();
  if (early.length === 0) return;
  let patch: StatusTimes = {};
  for (const row of early) patch = { ...patch, ...statusTime(row.status, row.timestamp) };
  if (Object.keys(patch).length > 0) await ctx.db.patch(message._id, patch);
  for (const row of early) await ctx.db.delete(row._id);
}

/** Projects an envelope (`messages` or `smb_message_echoes`) for a known number. */
async function projectEnvelope(ctx: MutationCtx, number: Doc<"numbers">, payload: any, now: number) {
  const whatsapp = payload.whatsapp;
  if (payload.field === "messages") {
    for (const msg of list(whatsapp?.messages)) await projectMessage(ctx, number, whatsapp, msg, now);
    for (const status of list(whatsapp?.statuses)) await projectStatus(ctx, number, status, now);
  } else if (payload.field === "smb_message_echoes") {
    for (const echo of list(whatsapp?.message_echoes)) await projectEcho(ctx, number, whatsapp, echo, now);
  }
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

  const existing = await numberByPoolId(ctx, poolNumberId);
  const fields = {
    workspaceId: workspace._id,
    phoneNumber: str(data?.phoneNumber) ?? existing?.phoneNumber ?? "",
    displayName: str(data?.displayName) ?? existing?.displayName ?? "",
  };
  let number: Doc<"numbers">;
  if (existing) {
    if (existing.workspaceId !== workspace._id) {
      // The number moved: close what the old workspace had open so new messages
      // start conversations in the new workspace.
      const open = await ctx.db
        .query("conversations")
        .withIndex("by_number_status_activity", (q) =>
          q.eq("numberId", existing._id).eq("status", "open"),
        )
        .collect();
      for (const conversation of open) await closeConversation(ctx, conversation._id, now);
    }
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
    await projectEnvelope(ctx, number, event.payload, event.receivedAt);
    await ctx.db.patch(event._id, { state: "processed" });
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
  await projectEnvelope(ctx, number, payload, now);
  return "processed";
}

/**
 * Dedups a webhook delivery, routes it and stores it raw with its final state.
 * Also called directly by the demo seed.
 */
export async function ingestPayload(
  ctx: MutationCtx,
  webhookId: string,
  payload: Record<string, unknown>,
  now = Date.now(),
): Promise<Outcome> {
  const seen = await ctx.db
    .query("events")
    .withIndex("by_webhook_id", (q) => q.eq("webhookId", webhookId))
    .first();
  if (seen) return "duplicate";

  const body = payload as any;
  const kind = str(body.field) ?? str(body.event) ?? "unknown";
  const poolNumberId =
    body.event === "number.onboarded" ? str(body.data?.numberId) : str(body.pipes?.poolNumberId);

  // Route before inserting so the onboarding replay never sees this event as parked.
  const state = await route(ctx, body, poolNumberId, now);
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
