import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireConversation, requireNumber, requireWorkspace } from "./authz";
import { summarize } from "./lib/stats";

const DAY_MS = 86_400_000;
export const MAX_CONVERSATIONS = 1000;
const MAX_WAITING = 50;
const MAX_LIST = 100;

function contactLabel(contact: Doc<"contacts"> | null): string {
  return contact?.waId ?? contact?.userId ?? "";
}

export const overview = query({
  args: {
    days: v.union(v.literal(7), v.literal(30)),
    numberId: v.optional(v.id("numbers")),
  },
  handler: async (ctx, { days, numberId }) => {
    const since = Date.now() - days * DAY_MS;
    let closed: Doc<"conversations">[];
    if (numberId) {
      const { workspace } = await requireNumber(ctx, numberId);
      // A number can move between workspaces; its history stays with the old owner.
      closed = await ctx.db
        .query("conversations")
        .withIndex("by_number_closed_at", (q) => q.eq("numberId", numberId).gte("closedAt", since))
        .filter((q) => q.eq(q.field("workspaceId"), workspace._id))
        .order("desc")
        .take(MAX_CONVERSATIONS);
    } else {
      const workspace = await requireWorkspace(ctx);
      closed = await ctx.db
        .query("conversations")
        .withIndex("by_workspace_closed_at", (q) =>
          q.eq("workspaceId", workspace._id).gte("closedAt", since),
        )
        .order("desc")
        .take(MAX_CONVERSATIONS);
    }
    return summarize(closed);
  },
});

async function lastMessageText(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
): Promise<string | undefined> {
  const last = await ctx.db
    .query("messages")
    .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .first();
  return last?.text;
}

export const waiting = query({
  args: { numberId: v.optional(v.id("numbers")) },
  handler: async (ctx, { numberId }) => {
    let open: Doc<"conversations">[];
    if (numberId) {
      const { workspace } = await requireNumber(ctx, numberId);
      open = await ctx.db
        .query("conversations")
        .withIndex("by_number_status_activity", (q) => q.eq("numberId", numberId).eq("status", "open"))
        .filter((q) => q.eq(q.field("workspaceId"), workspace._id))
        .take(MAX_CONVERSATIONS);
    } else {
      const workspace = await requireWorkspace(ctx);
      open = await ctx.db
        .query("conversations")
        .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspace._id).eq("status", "open"))
        .take(MAX_CONVERSATIONS);
    }

    const oldest = open
      .flatMap((c) => (c.waitingSince === undefined ? [] : [{ conversation: c, waitingSince: c.waitingSince }]))
      .sort((a, b) => a.waitingSince - b.waitingSince)
      .slice(0, MAX_WAITING);

    return await Promise.all(
      oldest.map(async ({ conversation, waitingSince }) => {
        const contact = await ctx.db.get(conversation.contactId);
        return {
          conversationId: conversation._id,
          numberId: conversation.numberId,
          contactName: contact?.name,
          contactId: contactLabel(contact),
          waitingSince,
          lastMessage: await lastMessageText(ctx, conversation._id),
        };
      }),
    );
  },
});

export const conversations = query({
  args: {
    numberId: v.id("numbers"),
    status: v.union(v.literal("open"), v.literal("closed")),
  },
  handler: async (ctx, { numberId, status }) => {
    const { workspace } = await requireNumber(ctx, numberId);
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_number_status_activity", (q) => q.eq("numberId", numberId).eq("status", status))
      .filter((q) => q.eq(q.field("workspaceId"), workspace._id))
      .order("desc")
      .take(MAX_LIST);

    return await Promise.all(
      rows.map(async (conversation) => {
        const contact = await ctx.db.get(conversation.contactId);
        return {
          _id: conversation._id,
          status: conversation.status,
          openedAt: conversation.openedAt,
          lastActivityAt: conversation.lastActivityAt,
          contactName: contact?.name,
          contactLabel: contactLabel(contact),
          metrics: conversation.metrics,
          analysisState: conversation.analysis?.state,
          score: conversation.analysis?.score,
        };
      }),
    );
  },
});

export const conversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const { workspace, conversation } = await requireConversation(ctx, conversationId);
    const contact = await ctx.db.get(conversation.contactId);
    const current = await ctx.db.get(conversation.numberId);
    // The number may have moved to another workspace since; don't expose it.
    const number = current?.workspaceId === workspace._id ? current : null;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversationId))
      .collect();
    return { conversation, contact, number, messages };
  },
});
