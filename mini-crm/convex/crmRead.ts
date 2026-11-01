import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  fromLabel,
  normalizeTag,
  STAGES,
  windowState,
  type Stage,
  type Window,
} from "./lib/crm";

// Read helpers shared by the public queries (contacts.ts) and the MCP tools (mcp/data.ts).
// They take a workspaceId and report a contact of another workspace as `null`; every list is
// bounded, so a large workspace never makes a query read its whole contact table.

export type ContactSummary = {
  id: Id<"contacts">;
  name?: string;
  phone?: string;
  userId?: string;
  stage: Stage;
  tags: string[];
  lastMessageAt: number;
  lastPreview?: string;
  waitingForReply: boolean;
  unread: number;
  window: Window;
  pendingDrafts: number;
};

const LIST_LIMIT = 100;
const WAITING_SCAN = 200;
const TAG_SCAN = 200;
const UNANSWERED_SCAN = 1000;
const STAGE_COUNT_CAP = 1000;
const DETAIL_LIMIT = 20;
const RECENT_STAGE_CHANGES = 10;

export async function summarize(
  ctx: QueryCtx,
  contact: Doc<"contacts">,
  now: number,
): Promise<ContactSummary> {
  const pending = await ctx.db
    .query("drafts")
    .withIndex("by_contact_status", (q) => q.eq("contactId", contact._id).eq("status", "pending"))
    .take(100);
  return {
    id: contact._id,
    name: contact.name,
    phone: contact.waId,
    userId: contact.userId,
    stage: contact.stage,
    tags: contact.tags,
    lastMessageAt: contact.lastMessageAt,
    lastPreview: contact.lastPreview,
    waitingForReply: contact.lastDirection === "in",
    unread: contact.unread,
    window: windowState(contact, now),
    pendingDrafts: pending.length,
  };
}

function summarizeAll(ctx: QueryCtx, contacts: Doc<"contacts">[], now: number) {
  return Promise.all(contacts.map((contact) => summarize(ctx, contact, now)));
}

function recentContacts(ctx: QueryCtx, workspaceId: Id<"workspaces">, stage: Stage, limit: number) {
  return ctx.db
    .query("contacts")
    .withIndex("by_workspace_stage_last_message", (q) =>
      q.eq("workspaceId", workspaceId).eq("stage", stage),
    )
    .order("desc")
    .take(limit);
}

function latestContacts(ctx: QueryCtx, workspaceId: Id<"workspaces">, limit: number) {
  return ctx.db
    .query("contacts")
    .withIndex("by_workspace_last_message", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")
    .take(limit);
}

export async function pipeline(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  now: number,
): Promise<Record<Stage, ContactSummary[]>> {
  const entries = await Promise.all(
    STAGES.map(async (stage) => {
      const contacts = await recentContacts(ctx, workspaceId, stage, LIST_LIMIT);
      return [stage, await summarizeAll(ctx, contacts, now)] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Stage, ContactSummary[]>;
}

export async function inbox(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  filter: "all" | "waiting" | "drafts",
  now: number,
): Promise<ContactSummary[]> {
  if (filter === "all") {
    return summarizeAll(ctx, await latestContacts(ctx, workspaceId, LIST_LIMIT), now);
  }
  if (filter === "waiting") {
    const recent = await latestContacts(ctx, workspaceId, WAITING_SCAN);
    return summarizeAll(
      ctx,
      recent.filter((contact) => contact.lastDirection === "in"),
      now,
    );
  }
  // Newest pending draft first; a contact with several drafts is listed once.
  const drafts = await ctx.db
    .query("drafts")
    .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "pending"))
    .order("desc")
    .take(LIST_LIMIT);
  const contactIds = [...new Set(drafts.map((draft) => draft.contactId))];
  const found = await Promise.all(contactIds.map((id) => ctx.db.get(id)));
  const contacts = found.filter(
    (contact): contact is Doc<"contacts"> => contact !== null && contact.workspaceId === workspaceId,
  );
  return summarizeAll(ctx, contacts, now);
}

export async function searchContacts(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  opts: { query?: string; stage?: Stage; tag?: string; limit: number },
  now: number,
): Promise<ContactSummary[]> {
  const { stage, limit } = opts;
  const text = opts.query?.trim();
  let tag: string | undefined;
  if (opts.tag !== undefined) {
    const normalized = normalizeTag(opts.tag);
    if (normalized === null) return [];
    tag = normalized;
  }

  let candidates: Doc<"contacts">[];
  if (text) {
    candidates = await ctx.db
      .query("contacts")
      .withSearchIndex("search_text", (q) => q.search("searchText", text).eq("workspaceId", workspaceId))
      .take(TAG_SCAN);
    if (stage !== undefined) candidates = candidates.filter((contact) => contact.stage === stage);
  } else {
    const scan = tag !== undefined ? TAG_SCAN : limit;
    candidates =
      stage !== undefined
        ? await recentContacts(ctx, workspaceId, stage, scan)
        : await latestContacts(ctx, workspaceId, scan);
  }
  if (tag !== undefined) candidates = candidates.filter((contact) => contact.tags.includes(tag));
  return summarizeAll(ctx, candidates.slice(0, limit), now);
}

export async function contactDetail(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  contactId: Id<"contacts">,
  now: number,
): Promise<{
  contact: ContactSummary;
  notes: Doc<"notes">[];
  activities: Doc<"activities">[];
} | null> {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.workspaceId !== workspaceId) return null;
  const [summary, notes, activities] = await Promise.all([
    summarize(ctx, contact, now),
    ctx.db
      .query("notes")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .order("desc")
      .take(DETAIL_LIMIT),
    ctx.db
      .query("activities")
      .withIndex("by_contact_created", (q) => q.eq("contactId", contactId))
      .order("desc")
      .take(DETAIL_LIMIT),
  ]);
  return { contact: summary, notes, activities };
}

/** `"<sentAt>:<messageId>"`, as returned in `nextBefore`. A bare `sentAt` (number) is still accepted. */
export type ConversationCursor = string | number;

const CURSOR = /^(\d+)(?::(.+))?$/;

function parseCursor(before: ConversationCursor): { sentAt: number; messageId?: string } {
  if (typeof before === "number") return { sentAt: before };
  const match = CURSOR.exec(before.trim());
  if (!match) throw new ConvexError("Invalid cursor: pass the nextBefore of the previous page.");
  return { sentAt: Number(match[1]), ...(match[2] !== undefined ? { messageId: match[2] } : {}) };
}

/**
 * Messages before the cursor, newest first. WhatsApp timestamps are whole seconds, so several
 * messages can share a `sentAt`; the cursor names the oldest message already returned, and the rest
 * of its `sentAt` comes next in index order (`_creationTime` breaks the tie).
 */
async function messagesBefore(
  ctx: QueryCtx,
  contactId: Id<"contacts">,
  before: ConversationCursor | undefined,
  take: number,
): Promise<Doc<"messages">[]> {
  if (before === undefined) {
    return ctx.db
      .query("messages")
      .withIndex("by_contact_sent_at", (q) => q.eq("contactId", contactId))
      .order("desc")
      .take(take);
  }
  const { sentAt, messageId } = parseCursor(before);
  const id = messageId === undefined ? null : ctx.db.normalizeId("messages", messageId);
  const last = id === null ? null : await ctx.db.get(id);
  const ties =
    last !== null && last.contactId === contactId && last.sentAt === sentAt
      ? await ctx.db
          .query("messages")
          .withIndex("by_contact_sent_at", (q) =>
            q.eq("contactId", contactId).eq("sentAt", sentAt).lt("_creationTime", last._creationTime),
          )
          .order("desc")
          .take(take)
      : [];
  const older = await ctx.db
    .query("messages")
    .withIndex("by_contact_sent_at", (q) => q.eq("contactId", contactId).lt("sentAt", sentAt))
    .order("desc")
    .take(take);
  return [...ties, ...older].slice(0, take);
}

export async function conversation(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  contactId: Id<"contacts">,
  opts: { limit: number; before?: ConversationCursor },
): Promise<{ messages: (Doc<"messages"> & { from: string })[]; nextBefore?: string } | null> {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.workspaceId !== workspaceId) return null;
  // One extra row tells whether older messages exist.
  const newestFirst = await messagesBefore(ctx, contactId, opts.before, opts.limit + 1);
  const hasMore = newestFirst.length > opts.limit;
  const page = newestFirst.slice(0, opts.limit).reverse();
  const oldest = page[0];
  return {
    messages: page.map((message) => ({ ...message, from: fromLabel(message) })),
    nextBefore: hasMore && oldest ? `${oldest.sentAt}:${oldest._id}` : undefined,
  };
}

/**
 * Contacts whose last message is theirs. Those that can still get a reply (window open) come first,
 * longest wait first; then the closed-window ones, most recent first. Reads the 1000 most recent
 * contacts, so stale conversations never crowd out today's.
 */
export async function unanswered(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  limit: number,
  now: number,
): Promise<ContactSummary[]> {
  const recent = await latestContacts(ctx, workspaceId, UNANSWERED_SCAN);
  const waiting = recent.filter((contact) => contact.lastDirection === "in");
  const open = waiting.filter((contact) => windowState(contact, now).open);
  const closed = waiting.filter((contact) => !windowState(contact, now).open);
  // `recent` is newest first: reversed, the open ones are longest wait first.
  return summarizeAll(ctx, [...open.reverse(), ...closed].slice(0, limit), now);
}

export async function pipelineSummary(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<{
  counts: Record<Stage, number>;
  recentStageChanges: {
    contactId: Id<"contacts">;
    name?: string;
    detail: string;
    actor: string;
    createdAt: number;
  }[];
}> {
  const countEntries = await Promise.all(
    STAGES.map(async (stage) => {
      const rows = await recentContacts(ctx, workspaceId, stage, STAGE_COUNT_CAP);
      return [stage, rows.length] as const;
    }),
  );
  const changes = await ctx.db
    .query("activities")
    .withIndex("by_workspace_kind_created", (q) =>
      q.eq("workspaceId", workspaceId).eq("kind", "stage_changed"),
    )
    .order("desc")
    .take(RECENT_STAGE_CHANGES);
  const recentStageChanges = await Promise.all(
    changes.map(async (activity) => ({
      contactId: activity.contactId,
      name: (await ctx.db.get(activity.contactId))?.name,
      detail: activity.detail,
      actor: activity.actor,
      createdAt: activity.createdAt,
    })),
  );
  return { counts: Object.fromEntries(countEntries) as Record<Stage, number>, recentStageChanges };
}
