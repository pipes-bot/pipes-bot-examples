import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
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

/** The contact's conversations (open and closed) on this number, in its current workspace. */
async function contactConversations(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  contactId: Id<"contacts">,
): Promise<Doc<"conversations">[]> {
  const all: Doc<"conversations">[] = [];
  for (const status of ["open", "closed"] as const) {
    all.push(
      ...(await ctx.db
        .query("conversations")
        .withIndex("by_contact_status", (q) => q.eq("contactId", contactId).eq("status", status))
        .collect()),
    );
  }
  return all.filter((c) => c.numberId === number._id && c.workspaceId === number.workspaceId);
}

/**
 * Undoes the previous build of a contact: deletes its imported conversations
 * with their messages, and the imported messages folded into live
 * conversations. Returns the live conversations as they are afterwards.
 */
async function undoBuild(
  ctx: MutationCtx,
  conversations: Doc<"conversations">[],
): Promise<Doc<"conversations">[]> {
  const live: Doc<"conversations">[] = [];
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
      live.push(conversation);
      continue;
    }
    for (const message of folded) await ctx.db.delete(message._id);
    const patch: Partial<Doc<"conversations">> = {
      openedAt: kept[0].sentAt,
      initiatedBy: turnOf(kept[0].source),
    };
    // The live conversation may have closed with the folded messages counted.
    if (conversation.metrics) patch.metrics = computeMetrics(kept);
    await ctx.db.patch(conversation._id, patch);
    live.push({ ...conversation, ...patch });
  }
  return live;
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
 * Rebuilds one contact's imported conversations from its staged history and
 * clears its pending rows. Returns how many imported conversations it created;
 * a segment folded into a live conversation is not counted.
 */
export async function buildContact(
  ctx: MutationCtx,
  number: Doc<"numbers">,
  contactId: Id<"contacts">,
): Promise<number> {
  const workspace = await ctx.db.get(number.workspaceId);
  const inactivityMs = (workspace?.inactivityMinutes ?? DEFAULT_INACTIVITY_MINUTES) * 60_000;

  const live = await undoBuild(ctx, await contactConversations(ctx, number, contactId));

  const staged = await ctx.db
    .query("historyMessages")
    .withIndex("by_number_contact_sent_at", (q) =>
      q.eq("numberId", number._id).eq("contactId", contactId),
    )
    .collect();
  // After the undo, any wamid still in `messages` came from live traffic.
  const fresh: Doc<"historyMessages">[] = [];
  for (const row of staged) {
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_wamid", (q) => q.eq("wamid", row.wamid))
      .first();
    if (!existing) fresh.push(row);
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
  return segments.length;
}

/**
 * Builds one contact with pending rows per run and chains the next run. The
 * run that finds nothing pending recounts the imported conversations, clears
 * the debounced job and marks the import done once progress reached 100.
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
      await buildContact(ctx, number, pending.contactId);
      await ctx.scheduler.runAfter(0, internal.history.build, { numberId });
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

/** Queues the analysis of the newest unanalyzed imported conversations, one every few seconds. */
export const analyzeImported = mutation({
  args: { numberId: v.id("numbers") },
  returns: v.object({ requested: v.number(), remaining: v.number() }),
  handler: async (ctx, { numberId }): Promise<{ requested: number; remaining: number }> => {
    const { workspace } = await requireNumber(ctx, numberId);
    const unanalyzed = await ctx.db
      .query("conversations")
      .withIndex("by_number_imported", (q) => q.eq("numberId", numberId).eq("imported", true))
      .filter((q) =>
        q.and(
          q.eq(q.field("workspaceId"), workspace._id),
          q.eq(q.field("status"), "closed"),
          q.eq(q.field("analysis"), undefined),
        ),
      )
      .collect();
    unanalyzed.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

    const batch = unanalyzed.slice(0, ANALYZE_BATCH);
    for (const [i, conversation] of batch.entries()) {
      await requestAnalysis(ctx, conversation._id, workspace.methodology, i * ANALYZE_SPACING_MS);
    }
    return { requested: batch.length, remaining: unanalyzed.length - batch.length };
  },
});

/** The numbers page's view of an import; null when nothing was requested. */
export const importStatus = query({
  args: { numberId: v.id("numbers") },
  handler: async (ctx, { numberId }) => {
    const { workspace, number } = await requireNumber(ctx, numberId);
    const { historyImport, contactsImport } = number;
    if (!historyImport && !contactsImport) return null;

    const pending = await ctx.db
      .query("historyMessages")
      .withIndex("by_number_pending", (q) => q.eq("numberId", numberId).eq("pending", true))
      .first();

    let importedConversations = 0;
    let unanalyzed = 0;
    const imported = ctx.db
      .query("conversations")
      .withIndex("by_number_imported", (q) => q.eq("numberId", numberId).eq("imported", true))
      .filter((q) => q.eq(q.field("workspaceId"), workspace._id));
    for await (const conversation of imported) {
      importedConversations++;
      if (!conversation.analysis && unanalyzed < UNANALYZED_COUNT_CAP) unanalyzed++;
    }

    let bookContacts = 0;
    const contacts = ctx.db
      .query("contacts")
      .withIndex("by_number", (q) => q.eq("numberId", numberId));
    for await (const contact of contacts) {
      if (contact.bookName) bookContacts++;
    }

    return {
      historyImport,
      contactsImport,
      building: !!historyImport?.buildJobId || !!pending,
      importedConversations,
      unanalyzed,
      bookContacts,
    };
  },
});
