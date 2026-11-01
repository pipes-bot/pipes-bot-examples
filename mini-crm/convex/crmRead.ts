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

export async function conversation(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  contactId: Id<"contacts">,
  opts: { limit: number; before?: number },
): Promise<{ messages: (Doc<"messages"> & { from: string })[]; nextBefore?: number } | null> {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.workspaceId !== workspaceId) return null;
  const { before } = opts;
  // One extra row tells whether older messages exist.
  const newestFirst = await ctx.db
    .query("messages")
    .withIndex("by_contact_sent_at", (q) =>
      before === undefined ? q.eq("contactId", contactId) : q.eq("contactId", contactId).lt("sentAt", before),
    )
    .order("desc")
    .take(opts.limit + 1);
  const hasMore = newestFirst.length > opts.limit;
  const page = newestFirst.slice(0, opts.limit).reverse();
  return {
    messages: page.map((message) => ({ ...message, from: fromLabel(message) })),
    nextBefore: hasMore ? page[0]?.sentAt : undefined,
  };
}

/** Contacts whose last message is theirs, longest wait first (scans the oldest 1000 contacts). */
export async function unanswered(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  limit: number,
  now: number,
): Promise<ContactSummary[]> {
  const waiting: Doc<"contacts">[] = [];
  let scanned = 0;
  const oldestFirst = ctx.db
    .query("contacts")
    .withIndex("by_workspace_last_message", (q) => q.eq("workspaceId", workspaceId))
    .order("asc");
  for await (const contact of oldestFirst) {
    if (contact.lastDirection === "in") waiting.push(contact);
    if (waiting.length >= limit || ++scanned >= UNANSWERED_SCAN) break;
  }
  return summarizeAll(ctx, waiting, now);
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
