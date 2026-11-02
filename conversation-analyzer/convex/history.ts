import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { resolveContact } from "./contactLookup";
import { flattenHistory, type HistorySummary } from "./lib/history";

/** Rows per `history.stage` call, so one mutation stays well under the Convex transaction limits. */
export const STAGE_BATCH = 500;

/** The build waits this long after the last staged chunk, since chunks arrive out of order. */
export const BUILD_DEBOUNCE_MS = 600_000;

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
  if (summary.mediaFollowUp || summary.messageCount === 0 || !storageId) {
    return ignore(ctx, storageId);
  }

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
    if (history.buildJobId) await ctx.scheduler.cancel(history.buildJobId);
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

/** Stub; the real build replaces it. */
export const build = internalMutation({
  args: { numberId: v.id("numbers") },
  returns: v.null(),
  handler: async (): Promise<null> => null,
});
