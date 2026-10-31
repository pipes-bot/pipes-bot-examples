import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { requireConversation } from "./authz";
import type { Step } from "./lib/methodology";
import { computeMetrics } from "./lib/metrics";

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
    if (conversation.lastActivityAt + workspace.inactivityMinutes * 60_000 > now) return null;
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
