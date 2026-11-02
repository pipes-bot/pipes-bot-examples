import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { requireConversation } from "./authz";
import type { Step } from "./lib/methodology";
import { computeMetrics, type Source } from "./lib/metrics";

export const DEFAULT_INACTIVITY_MINUTES = 120;

/**
 * Stores one message and keeps its conversation's activity in step: opens a
 * conversation when none is open, tracks whose turn it is and reschedules the
 * idle close. A wamid that is already stored is skipped.
 */
export async function recordMessage(
  ctx: MutationCtx,
  input: {
    number: Doc<"numbers">;
    contactId: Id<"contacts">;
    wamid: string;
    source: Source;
    type: string;
    text?: string;
    sentAt: number;
  },
): Promise<void> {
  const { number, contactId, wamid, source, type, text, sentAt } = input;
  const existing = await ctx.db
    .query("messages")
    .withIndex("by_wamid", (q) => q.eq("wamid", wamid))
    .first();
  if (existing) return;

  const turn = source === "customer" ? "customer" : "business";
  let conversation = await ctx.db
    .query("conversations")
    .withIndex("by_contact_status", (q) => q.eq("contactId", contactId).eq("status", "open"))
    .first();
  if (!conversation) {
    const conversationId = await ctx.db.insert("conversations", {
      workspaceId: number.workspaceId,
      numberId: number._id,
      contactId,
      status: "open",
      initiatedBy: turn,
      openedAt: sentAt,
      lastActivityAt: sentAt,
      lastTurn: turn,
    });
    conversation = (await ctx.db.get(conversationId))!;
  }

  await ctx.db.insert("messages", {
    conversationId: conversation._id,
    wamid,
    direction: source === "customer" ? "inbound" : "outbound",
    source,
    type,
    text,
    sentAt,
  });

  if (conversation.closeJobId) {
    try {
      await ctx.scheduler.cancel(conversation.closeJobId);
    } catch {
      // The job already ran or was canceled; nothing to cancel.
    }
  }
  // Same workspace closeIfIdle reads, so the job never fires early.
  const workspace = await ctx.db.get(conversation.workspaceId);
  const inactivityMinutes = workspace?.inactivityMinutes ?? DEFAULT_INACTIVITY_MINUTES;
  const closeJobId = await ctx.scheduler.runAt(
    Date.now() + inactivityMinutes * 60_000,
    internal.conversations.closeIfIdle,
    { conversationId: conversation._id },
  );

  // A message older than the newest stored one (out-of-order delivery) does not
  // decide whose turn it is.
  const isLatest = sentAt >= conversation.lastActivityAt;
  await ctx.db.patch(conversation._id, {
    lastActivityAt: Math.max(conversation.lastActivityAt, sentAt),
    closeJobId,
    ...(isLatest
      ? {
          lastTurn: turn,
          waitingSince:
            turn === "customer" ? (conversation.waitingSince ?? sentAt) : undefined,
        }
      : {}),
  });
}

export async function requestAnalysis(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  methodology: Step[],
): Promise<void> {
  const requestedAt = Date.now();
  await ctx.db.patch(conversationId, {
    analysis: { state: "pending", methodology, requestedAt },
  });
  await ctx.scheduler.runAfter(0, internal.analysis.analyzeConversation, {
    conversationId,
    requestedAt,
  });
}

/** Turns statuses that never matched a message (API sends) into api messages. */
async function adoptOrphanStatuses(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  now: number,
): Promise<void> {
  const contact = await ctx.db.get(conversation.contactId);
  if (!contact) return;
  const recipients = [contact.waId, contact.userId].filter((r): r is string => !!r);

  const byId = new Map<Id<"statuses">, Doc<"statuses">>();
  for (const recipient of recipients) {
    const rows = await ctx.db
      .query("statuses")
      .withIndex("by_number_recipient", (q) =>
        q
          .eq("numberId", conversation.numberId)
          .eq("recipient", recipient)
          .gte("timestamp", conversation.openedAt)
          .lte("timestamp", now),
      )
      .collect();
    for (const row of rows) byId.set(row._id, row);
  }

  const groups = new Map<string, Doc<"statuses">[]>();
  for (const row of byId.values()) {
    groups.set(row.wamid, [...(groups.get(row.wamid) ?? []), row]);
  }

  for (const [wamid, group] of groups) {
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_wamid", (q) => q.eq("wamid", wamid))
      .first();
    if (existing) continue;

    const at = (status: string) => group.find((s) => s.status === status)?.timestamp;
    const earliest = Math.min(...group.map((s) => s.timestamp));
    await ctx.db.insert("messages", {
      conversationId: conversation._id,
      wamid,
      direction: "outbound",
      source: "api",
      type: "text",
      sentAt: at("sent") ?? earliest,
      deliveredAt: at("delivered"),
      readAt: at("read"),
      failedAt: at("failed"),
    });
    for (const row of group) await ctx.db.delete(row._id);
  }
}

export async function closeConversation(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  now = Date.now(),
): Promise<void> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.status !== "open") return;

  await adoptOrphanStatuses(ctx, conversation, now);

  const messages = await ctx.db
    .query("messages")
    .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversationId))
    .collect();
  const workspace = await ctx.db.get(conversation.workspaceId);

  await ctx.db.patch(conversationId, {
    status: "closed",
    closedAt: now,
    waitingSince: undefined,
    closeJobId: undefined,
    metrics: computeMetrics(messages),
  });
  await requestAnalysis(ctx, conversationId, workspace?.methodology ?? []);
}

export const closeIfIdle = internalMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation || conversation.status !== "open") return null;
    const workspace = await ctx.db.get(conversation.workspaceId);
    if (!workspace) return null;
    const now = Date.now();
    const idleAt = conversation.lastActivityAt + workspace.inactivityMinutes * 60_000;
    if (idleAt > now) {
      // Not idle yet (the window was raised, or activity is ahead of the clock):
      // check again when it would be, so the conversation still closes.
      const closeJobId = await ctx.scheduler.runAt(idleAt, internal.conversations.closeIfIdle, {
        conversationId,
      });
      await ctx.db.patch(conversationId, { closeJobId });
      return null;
    }
    await closeConversation(ctx, conversationId, now);
    return null;
  },
});

export const retryAnalysis = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const { conversation } = await requireConversation(ctx, conversationId);
    if (conversation.analysis?.state !== "failed") return null;
    await requestAnalysis(ctx, conversationId, conversation.analysis.methodology);
    return null;
  },
});

export const reanalyze = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const { workspace, conversation } = await requireConversation(ctx, conversationId);
    if (conversation.status !== "closed") return null;
    await requestAnalysis(ctx, conversationId, workspace.methodology);
    return null;
  },
});
