import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireConversation, requireWorkspace } from "./authz";
import { applyEvent, ownedNumber } from "./handoff";
import { windowState, type HandoffReason, type Mode, type Source, type Window } from "./lib/handoff";

const LIST_LIMIT = 100;
const MESSAGE_LIMIT = 100;
const AI_RUN_LIMIT = 50;

export type ConversationRow = {
  id: Id<"conversations">;
  name?: string;
  phone?: string;
  mode: Mode;
  handoffReason?: HandoffReason;
  handoffSummary?: string;
  resumeAt?: number;
  modeChangedAt: number;
  lastMessageAt: number;
  lastPreview: string;
  lastFrom: Source;
  numberName: string;
  aiEnabled: boolean;
  isDemo: boolean;
  window: Window;
};

function toRow(c: Doc<"conversations">, number: Doc<"numbers"> | null, now: number): ConversationRow {
  return {
    id: c._id,
    name: c.name,
    phone: c.waId,
    mode: c.mode,
    handoffReason: c.handoffReason,
    handoffSummary: c.handoffSummary,
    resumeAt: c.resumeAt,
    modeChangedAt: c.modeChangedAt,
    lastMessageAt: c.lastMessageAt,
    lastPreview: c.lastPreview,
    lastFrom: c.lastFrom,
    numberName: number?.displayName ?? "",
    // A number re-onboarded into another workspace is off for this one.
    aiEnabled: ownedNumber(c, number)?.aiEnabled ?? false,
    isDemo: number?.isDemo ?? false,
    window: windowState(c, now),
  };
}

async function toRows(ctx: QueryCtx, conversations: Doc<"conversations">[]): Promise<ConversationRow[]> {
  const now = Date.now();
  const numbers = new Map<Id<"numbers">, Doc<"numbers"> | null>();
  for (const c of conversations) {
    if (!numbers.has(c.numberId)) numbers.set(c.numberId, await ctx.db.get(c.numberId));
  }
  return conversations.map((c) => toRow(c, numbers.get(c.numberId) ?? null, now));
}

const tabValidator = v.union(
  v.literal("needs_human"),
  v.literal("with_staff"),
  v.literal("ai"),
  v.literal("all"),
);

export const list = query({
  args: { tab: tabValidator },
  handler: async (ctx, { tab }) => {
    const workspace = await requireWorkspace(ctx);
    const byMode = (mode: Mode, order: "asc" | "desc") =>
      ctx.db
        .query("conversations")
        .withIndex("by_workspace_mode_changed", (q) => q.eq("workspaceId", workspace._id).eq("mode", mode))
        .order(order)
        .take(LIST_LIMIT);

    let conversations: Doc<"conversations">[];
    if (tab === "needs_human") conversations = await byMode("waiting_human", "asc");
    else if (tab === "with_staff") conversations = await byMode("human", "desc");
    else if (tab === "ai") conversations = await byMode("ai", "desc");
    else {
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_workspace_last_message", (q) => q.eq("workspaceId", workspace._id))
        .order("desc")
        .take(LIST_LIMIT);
    }
    return await toRows(ctx, conversations);
  },
});

export const get = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const { conversation } = await requireConversation(ctx, conversationId);
    const [row] = await toRows(ctx, [conversation]);
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(MESSAGE_LIMIT);
    return {
      conversation: { ...row, lastError: conversation.lastError, userId: conversation.userId },
      messages: newest.reverse(),
    };
  },
});

export const aiRuns = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    await requireConversation(ctx, conversationId);
    return await ctx.db
      .query("aiRuns")
      .withIndex("by_conversation_started", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(AI_RUN_LIMIT);
  },
});

export const takeOver = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const { conversation } = await requireConversation(ctx, conversationId);
    await applyEvent(ctx, conversation, { kind: "take_over" }, Date.now());
    return null;
  },
});

export const handBack = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const { conversation } = await requireConversation(ctx, conversationId);
    await applyEvent(ctx, conversation, { kind: "hand_back" }, Date.now());
    return null;
  },
});
