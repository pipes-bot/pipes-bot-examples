import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { contactsImportValidator, historyImportValidator } from "./schema";
import { requireNumber } from "./authz";
import { resolveContact } from "./contactLookup";
import { DEFAULT_INACTIVITY_MINUTES, requestAnalysis } from "./conversations";
import { flattenHistory, segmentMessages, type HistorySummary } from "./lib/history";
import { computeMetrics, type Source } from "./lib/metrics";

/** Rows per `history.stage` call, so one mutation stays well under the Convex transaction limits. */
export const STAGE_BATCH = 500;

/** The build waits this long after the last staged chunk, since chunks arrive out of order. */
export const BUILD_DEBOUNCE_MS = 600_000;

/** Conversations `history.analyzeImported` queues per call. */
export const ANALYZE_BATCH = 100;

/** Gap between two queued analyses, to stay clear of the OpenRouter rate limit. */
export const ANALYZE_SPACING_MS = 3000;

/** A contact's build imports only its newest staged rows, so one mutation stays within the Convex limits. */
export const HISTORY_CONTACT_CAP = 3000;

/** Older rows of a contact past the cap that one `history.skipOlder` run clears. */
export const SKIP_BATCH = 1000;

/** `history.importStatus` stops counting unanalyzed conversations here. */
export const UNANALYZED_COUNT_CAP = 1000;

export const historySummaryValidator = v.object({
  declined: v.boolean(),
  progress: v.optional(v.number()),
  phase: v.optional(v.number()),
  chunkOrder: v.optional(v.number()),
  messageCount: v.number(),
  mediaFollowUp: v.boolean(),
});

export const historyRowValidator = v.object({
  threadId: v.string(),
  wamid: v.string(),
  source: v.union(v.literal("customer"), v.literal("phone")),
  type: v.string(),
  text: v.optional(v.string()),
  sentAt: v.number(),
});

/**
 * Applies a history event to a known number: records the declined state, or
 * counts the chunk and schedules its staging. The blob is deleted whenever the
 * event is ignored; a processed chunk keeps it, like `events.payload`.
 */
export async function applyHistoryEvent(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  summary: HistorySummary,
  storageId: Id<"_storage"> | undefined,
  now: number,
): Promise<"processed" | "ignored"> {
  // Parked replays apply several events in a row, so read the current state.
  const current = await ctx.db.get(number._id);
  const history = current?.historyImport;
  if (!current || !history) return ignore(ctx, storageId);

  if (summary.declined) {
    await ctx.db.patch(current._id, {
      historyImport: { ...history, state: "declined", updatedAt: now },
    });
    return "processed";
  }
  if (summary.mediaFollowUp) return ignore(ctx, storageId);
  if (summary.messageCount === 0 && summary.progress !== undefined) {
    // A chunk that only reports progress: record it and let the build's final
    // run decide whether the import is done.
    if (storageId) await ctx.storage.delete(storageId);
    const buildJobId =
      history.buildJobId ??
      (await ctx.scheduler.runAfter(0, internal.history.build, { numberId: current._id }));
    await ctx.db.patch(current._id, {
      historyImport: {
        ...history,
        progress: Math.max(history.progress, summary.progress),
        updatedAt: now,
        buildJobId,
      },
    });
    return "processed";
  }
  if (summary.messageCount === 0 || !storageId) return ignore(ctx, storageId);

  await ctx.db.patch(current._id, {
    historyImport: {
      ...history,
      state: history.state === "declined" ? "declined" : "importing",
      progress: Math.max(history.progress, summary.progress ?? 0),
      chunks: history.chunks + 1,
      updatedAt: now,
    },
  });
  await ctx.scheduler.runAfter(0, internal.history.processChunk, {
    numberId: current._id,
    storageId,
  });
  return "processed";
}

async function ignore(ctx: MutationCtx, storageId: Id<"_storage"> | undefined): Promise<"ignored"> {
  if (storageId) await ctx.storage.delete(storageId);
  return "ignored";
}

/** Stores a history event (summary only; the raw body lives in file storage) and applies it. */
export const receive = internalMutation({
  args: {
    webhookId: v.string(),
    poolNumberId: v.optional(v.string()),
    summary: historySummaryValidator,
    storageId: v.optional(v.id("_storage")),
  },
  returns: v.union(
    v.literal("duplicate"),
    v.literal("processed"),
    v.literal("parked"),
    v.literal("ignored"),
  ),
  handler: async (
    ctx,
    { webhookId, poolNumberId, summary, storageId },
  ): Promise<"duplicate" | "processed" | "parked" | "ignored"> => {
    const seen = await ctx.db
      .query("events")
      .withIndex("by_webhook_id", (q) => q.eq("webhookId", webhookId))
      .first();
    if (seen) {
      if (storageId) await ctx.storage.delete(storageId);
      return "duplicate";
    }

    const now = Date.now();
    const number = poolNumberId
      ? await ctx.db
          .query("numbers")
          .withIndex("by_pool_number", (q) => q.eq("poolNumberId", poolNumberId))
          .first()
      : null;
    let state: "processed" | "parked" | "ignored";
    if (number) {
      state = await applyHistoryEvent(ctx, number, summary, storageId, now);
    } else if (poolNumberId) {
      state = "parked";
    } else {
      state = await ignore(ctx, storageId);
    }

    await ctx.db.insert("events", {
      webhookId,
      kind: "history",
      poolNumberId,
      payload: { field: "history", pipes: { poolNumberId }, summary },
      storageId,
      state,
      receivedAt: now,
    });
    return state;
  },
});

/** Reads a stored chunk and stages its messages in batches. */
export const processChunk = internalAction({
  args: { numberId: v.id("numbers"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { numberId, storageId }): Promise<null> => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) return null;

    let rows;
    try {
      rows = flattenHistory(JSON.parse(await blob.text()));
    } catch (error) {
      // Meta does not resend an accepted event, so an unreadable chunk is lost.
      console.error(`history chunk ${storageId} could not be parsed`, error);
      return null;
    }
    for (let i = 0; i < rows.length; i += STAGE_BATCH) {
      await ctx.runMutation(internal.history.stage, {
        numberId,
        rows: rows.slice(i, i + STAGE_BATCH),
      });
    }
    return null;
  },
});

/** Stages rows as pending and pushes the debounced build back. */
export const stage = internalMutation({
  args: { numberId: v.id("numbers"), rows: v.array(historyRowValidator) },
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx, { numberId, rows }): Promise<{ inserted: number }> => {
    const number = await ctx.db.get(numberId);
    if (!number?.historyImport) return { inserted: 0 };

    let inserted = 0;
    for (const { threadId, ...row } of rows) {
      const contactId = await resolveContact(ctx, numberId, { waId: threadId }, undefined);
      if (!contactId) continue;
      const exists = await ctx.db
        .query("historyMessages")
        .withIndex("by_wamid", (q) => q.eq("wamid", row.wamid))
        .first();
      if (exists) continue;
      await ctx.db.insert("historyMessages", { numberId, contactId, ...row, pending: true });
      inserted++;
    }

    const history = number.historyImport;
    if (history.buildJobId) {
      try {
        await ctx.scheduler.cancel(history.buildJobId);
      } catch {
        // The job already ran or was canceled; nothing to cancel.
      }
    }
    const buildJobId = await ctx.scheduler.runAfter(BUILD_DEBOUNCE_MS, internal.history.build, {
      numberId,
    });
    await ctx.db.patch(numberId, {
      historyImport: {
        ...history,
        messages: history.messages + inserted,
        buildJobId,
        updatedAt: Date.now(),
      },
    });
    return { inserted };
  },
});

const turnOf = (source: Source): "customer" | "business" =>
  source === "customer" ? "customer" : "business";

/**
 * The contact's conversations (open and closed), split into the ones in the
 * number's current workspace and the ones a previous workspace kept.
 */
async function contactConversations(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  contactId: Id<"contacts">,
): Promise<{ current: Doc<"conversations">[]; elsewhere: Doc<"conversations">[] }> {
  const all: Doc<"conversations">[] = [];
  for (const status of ["open", "closed"] as const) {
    all.push(
      ...(await ctx.db
        .query("conversations")
        .withIndex("by_contact_status", (q) => q.eq("contactId", contactId).eq("status", status))
        .collect()),
    );
  }
  const inCurrent = (c: Doc<"conversations">) =>
    c.numberId === number._id && c.workspaceId === number.workspaceId;
  return { current: all.filter(inCurrent), elsewhere: all.filter((c) => !inCurrent(c)) };
}

/**
 * Undoes the previous build of a contact: deletes its imported conversations
 * with their messages, and the imported messages folded into live
 * conversations. Returns the live conversations as they are afterwards and
 * the wamids of the messages they still hold.
 */
async function undoBuild(
  ctx: MutationCtx,
  conversations: Doc<"conversations">[],
): Promise<{ live: Doc<"conversations">[]; liveWamids: Set<string> }> {
  const live: Doc<"conversations">[] = [];
  const liveWamids = new Set<string>();
  for (const conversation of conversations) {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversation._id))
      .collect();
    if (conversation.imported) {
      for (const message of messages) await ctx.db.delete(message._id);
      await ctx.db.delete(conversation._id);
      continue;
    }
    const folded = messages.filter((m) => m.imported);
    const kept = messages.filter((m) => !m.imported);
    // A live conversation always holds a live message; one without any is left as is.
    if (folded.length === 0 || kept.length === 0) {
      for (const message of messages) liveWamids.add(message.wamid);
      live.push(conversation);
      continue;
    }
    for (const message of folded) await ctx.db.delete(message._id);
    for (const message of kept) liveWamids.add(message.wamid);
    const patch: Partial<Doc<"conversations">> = {
      openedAt: kept[0].sentAt,
      initiatedBy: turnOf(kept[0].source),
    };
    // The live conversation may have closed with the folded messages counted.
    if (conversation.metrics) patch.metrics = computeMetrics(kept);
    await ctx.db.patch(conversation._id, patch);
    live.push({ ...conversation, ...patch });
  }
  return { live, liveWamids };
}

async function insertImportedMessages(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  rows: Doc<"historyMessages">[],
): Promise<void> {
  for (const row of rows) {
    await ctx.db.insert("messages", {
      conversationId,
      wamid: row.wamid,
      direction: row.source === "customer" ? "inbound" : "outbound",
      source: row.source,
      type: row.type,
      text: row.text,
      sentAt: row.sentAt,
      imported: true,
    });
  }
}

/**
 * Rebuilds one contact's imported conversations from its newest
 * HISTORY_CONTACT_CAP staged rows and clears their pending flag. `created` is
 * how many imported conversations it made; a segment folded into a live
 * conversation is not counted. `olderFrom` is set when the contact has older
 * rows: the `sentAt` of the oldest built row, at and below which
 * `history.skipOlder` clears the rest.
 */
async function rebuildContact(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  contactId: Id<"contacts">,
): Promise<{ created: number; olderFrom?: number }> {
  const workspace = await ctx.db.get(number.workspaceId);
  const inactivityMs = (workspace?.inactivityMinutes ?? DEFAULT_INACTIVITY_MINUTES) * 60_000;

  const { current, elsewhere } = await contactConversations(ctx, number, contactId);
  const { live, liveWamids } = await undoBuild(ctx, current);

  const newest = await ctx.db
    .query("historyMessages")
    .withIndex("by_number_contact_sent_at", (q) =>
      q.eq("numberId", number._id).eq("contactId", contactId),
    )
    .order("desc")
    .take(HISTORY_CONTACT_CAP + 1);
  const staged = newest.slice(0, HISTORY_CONTACT_CAP);
  const olderFrom =
    newest.length > HISTORY_CONTACT_CAP ? staged[staged.length - 1].sentAt : undefined;

  // After the undo, the current workspace holds no imported message of this
  // contact, so the wamids it still has came from live traffic. The messages
  // of conversations a previous workspace kept are not loaded, so when the
  // contact has any, each remaining row is looked up by wamid; the cap keeps
  // that to HISTORY_CONTACT_CAP lookups.
  const fresh: Doc<"historyMessages">[] = [];
  for (const row of staged) {
    if (liveWamids.has(row.wamid)) continue;
    if (elsewhere.length > 0) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_wamid", (q) => q.eq("wamid", row.wamid))
        .first();
      if (existing) continue;
    }
    fresh.push(row);
  }
  const segments = segmentMessages(fresh, inactivityMs);

  // The last segment joins the live conversation that continues it.
  const last = segments[segments.length - 1];
  if (last) {
    const end = last[last.length - 1].sentAt;
    const next = live
      .filter((c) => c.openedAt >= end)
      .sort((a, b) => a.openedAt - b.openedAt)[0];
    if (next?.status === "open" && next.openedAt - end <= inactivityMs) {
      segments.pop();
      await insertImportedMessages(ctx, next._id, last);
      // lastTurn and waitingSince stay decided by the live traffic.
      await ctx.db.patch(next._id, {
        openedAt: last[0].sentAt,
        initiatedBy: turnOf(last[0].source),
      });
    }
  }

  for (const segment of segments) {
    const first = segment[0];
    const end = segment[segment.length - 1];
    const conversationId = await ctx.db.insert("conversations", {
      workspaceId: number.workspaceId,
      numberId: number._id,
      contactId,
      imported: true,
      status: "closed",
      initiatedBy: turnOf(first.source),
      openedAt: first.sentAt,
      lastActivityAt: end.sentAt,
      closedAt: end.sentAt,
      lastTurn: turnOf(end.source),
      metrics: computeMetrics(segment),
    });
    await insertImportedMessages(ctx, conversationId, segment);
  }

  for (const row of staged) {
    if (row.pending) await ctx.db.patch(row._id, { pending: undefined });
  }
  return { created: segments.length, olderFrom };
}

/**
 * Rebuilds one contact's imported conversations from its newest
 * HISTORY_CONTACT_CAP staged rows and clears their pending flag. Returns how
 * many imported conversations it created. Older rows are left as they are;
 * `history.build` clears them through `history.skipOlder`.
 */
export async function buildContact(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  contactId: Id<"contacts">,
): Promise<number> {
  return (await rebuildContact(ctx, number, contactId)).created;
}

/**
 * Builds one contact with pending rows per run and chains the next run; a
 * contact with more than HISTORY_CONTACT_CAP rows goes through
 * `history.skipOlder` first. The run that finds nothing pending recounts the
 * imported conversations, clears the debounced job and marks the import done
 * once progress reached 100.
 */
export const build = internalMutation({
  args: { numberId: v.id("numbers") },
  returns: v.null(),
  handler: async (ctx, { numberId }): Promise<null> => {
    const number = await ctx.db.get(numberId);
    if (!number?.historyImport) return null;

    const pending = await ctx.db
      .query("historyMessages")
      .withIndex("by_number_pending", (q) => q.eq("numberId", numberId).eq("pending", true))
      .first();
    if (pending) {
      const { olderFrom } = await rebuildContact(ctx, number, pending.contactId);
      if (olderFrom === undefined) {
        await ctx.scheduler.runAfter(0, internal.history.build, { numberId });
      } else {
        await ctx.scheduler.runAfter(0, internal.history.skipOlder, {
          numberId,
          contactId: pending.contactId,
          olderFrom,
          cursor: null,
        });
      }
      return null;
    }

    const imported = await ctx.db
      .query("conversations")
      .withIndex("by_number_imported", (q) => q.eq("numberId", numberId).eq("imported", true))
      .filter((q) => q.eq(q.field("workspaceId"), number.workspaceId))
      .collect();
    const { buildJobId: _done, ...history } = number.historyImport;
    const finished = history.state === "importing" && history.progress === 100;
    await ctx.db.patch(numberId, {
      historyImport: {
        ...history,
        conversations: imported.length,
        ...(finished ? { state: "done" as const, updatedAt: Date.now() } : {}),
      },
    });
    return null;
  },
});

/**
 * Clears the pending flag of a contact's rows older than its newest
 * HISTORY_CONTACT_CAP, SKIP_BATCH rows per run, without building them; the
 * rows stay staged. The last run hands back to `history.build`, so the other
 * contacts and the final bookkeeping still run.
 */
export const skipOlder = internalMutation({
  args: {
    numberId: v.id("numbers"),
    contactId: v.id("contacts"),
    olderFrom: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { numberId, contactId, olderFrom, cursor }): Promise<null> => {
    // The range starts at the oldest built row's sentAt, so it can also hold
    // built rows with that same sentAt; their pending flag is already cleared.
    const page = await ctx.db
      .query("historyMessages")
      .withIndex("by_number_contact_sent_at", (q) =>
        q.eq("numberId", numberId).eq("contactId", contactId).lte("sentAt", olderFrom),
      )
      .order("desc")
      .paginate({ numItems: SKIP_BATCH, cursor });
    for (const row of page.page) {
      if (row.pending) await ctx.db.patch(row._id, { pending: undefined });
    }
    if (page.isDone) {
      await ctx.scheduler.runAfter(0, internal.history.build, { numberId });
    } else {
      await ctx.scheduler.runAfter(0, internal.history.skipOlder, {
        numberId,
        contactId,
        olderFrom,
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

/** Queues the analysis of the newest unanalyzed imported conversations, one every few seconds. */
export const analyzeImported = mutation({
  args: { numberId: v.id("numbers") },
  returns: v.object({ requested: v.number(), remaining: v.number() }),
  handler: async (ctx, { numberId }): Promise<{ requested: number; remaining: number }> => {
    const { workspace } = await requireNumber(ctx, numberId);
    // Without a key every queued analysis ends as skipped and leaves the bulk path.
    if (!process.env.OPENROUTER_API_KEY) {
      throw new ConvexError("Set OPENROUTER_API_KEY to analyze conversations");
    }
    // The scan is bounded: only the first UNANALYZED_COUNT_CAP matches are read, so
    // `remaining` is capped by that window and the batch is the newest of it.
    const window = await unanalyzedImported(ctx, workspace._id, numberId).take(
      UNANALYZED_COUNT_CAP,
    );
    window.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

    const batch = window.slice(0, ANALYZE_BATCH);
    for (const [i, conversation] of batch.entries()) {
      await requestAnalysis(ctx, conversation._id, workspace.methodology, i * ANALYZE_SPACING_MS);
    }
    return { requested: batch.length, remaining: window.length - batch.length };
  },
});

/** Imported, closed conversations of the workspace that were never analyzed. */
function unanalyzedImported(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  numberId: Id<"numbers">,
) {
  return ctx.db
    .query("conversations")
    .withIndex("by_number_imported", (q) => q.eq("numberId", numberId).eq("imported", true))
    .filter((q) =>
      q.and(
        q.eq(q.field("workspaceId"), workspaceId),
        q.eq(q.field("status"), "closed"),
        q.eq(q.field("analysis"), undefined),
      ),
    );
}

/** The numbers page's view of an import; null when nothing was requested. */
export const importStatus = query({
  args: { numberId: v.id("numbers") },
  returns: v.union(
    v.null(),
    v.object({
      historyImport: v.optional(historyImportValidator),
      contactsImport: v.optional(contactsImportValidator),
      building: v.boolean(),
      importedConversations: v.number(),
      unanalyzed: v.number(),
      bookContacts: v.number(),
    }),
  ),
  handler: async (ctx, { numberId }) => {
    const { workspace, number } = await requireNumber(ctx, numberId);
    const { historyImport, contactsImport } = number;
    if (!historyImport && !contactsImport) return null;

    const pending = await ctx.db
      .query("historyMessages")
      .withIndex("by_number_pending", (q) => q.eq("numberId", numberId).eq("pending", true))
      .first();

    // Both counts stop at the cap, so the query stays cheap however large the import is.
    const unanalyzed = await unanalyzedImported(ctx, workspace._id, numberId).take(
      UNANALYZED_COUNT_CAP,
    );
    const bookContacts = await ctx.db
      .query("contacts")
      .withIndex("by_number", (q) => q.eq("numberId", numberId))
      .filter((q) => q.neq(q.field("bookName"), undefined))
      .take(UNANALYZED_COUNT_CAP);

    return {
      historyImport,
      contactsImport,
      building: !!historyImport?.buildJobId || !!pending,
      // The build's final run keeps this count current.
      importedConversations: historyImport?.conversations ?? 0,
      unanalyzed: unanalyzed.length,
      bookContacts: bookContacts.length,
    };
  },
});
