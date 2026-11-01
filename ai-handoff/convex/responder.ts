import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { applyEvent } from "./handoff";
import { demoDecision, modelDecision, type ReplyDecision } from "./lib/decide";
import {
  HISTORY_MESSAGES,
  MODEL_RETRY_DELAY_MS,
  replyLimitReached,
  windowState,
} from "./lib/handoff";
import { getModel } from "./lib/model";
import { conversationBlock, systemPrompt, trimReply } from "./lib/prompt";
import { runOutcomeValidator } from "./schema";
import { insertAiMessage } from "./sending";

// The AI responder. `respond` runs a turn scheduled by `applyEvent`: it checks that the turn is
// still worth answering, asks the model (or the demo rules) and hands the decision to
// `commitReply`, which re-checks the turn and applies everything in one transaction. A turn that
// changed while the model was thinking is dropped before anything is written.

const PREVIEW_CHARS = 120;
const ERROR_CHARS = 200;

const dropReasonValidator = v.union(
  v.literal("stale"),
  v.literal("ai_disabled"),
  v.literal("window_closed"),
  v.literal("gone"),
);
const toolCallsValidator = v.array(v.object({ name: v.string(), args: v.any() }));
const usageValidator = v.object({ inputTokens: v.number(), outputTokens: v.number() });

const decisionValidator = v.object({
  text: v.string(),
  handoff: v.optional(v.object({ reason: v.string(), summary: v.string() })),
  requests: v.array(
    v.object({ summary: v.string(), details: v.string(), customerName: v.optional(v.string()) }),
  ),
  toolCalls: toolCallsValidator,
  usage: v.optional(usageValidator),
});

const resultValidator = v.union(
  v.object({ kind: v.literal("decision"), decision: decisionValidator }),
  v.object({
    kind: v.literal("event"),
    event: v.union(
      v.object({ kind: v.literal("ai_limit") }),
      v.object({ kind: v.literal("ai_error"), error: v.string() }),
    ),
  }),
);

const runFields = {
  conversationId: v.id("conversations"),
  turn: v.number(),
  attempt: v.number(),
  outcome: runOutcomeValidator,
  dropReason: v.optional(dropReasonValidator),
  toolCalls: toolCallsValidator,
  model: v.string(),
  replyPreview: v.optional(v.string()),
  error: v.optional(v.string()),
  usage: v.optional(usageValidator),
  startedAt: v.number(),
  finishedAt: v.number(),
};

const runValidator = v.object(runFields);
type RunFields = Infer<typeof runValidator>;

async function insertRun(ctx: MutationCtx, conversation: Doc<"conversations">, run: RunFields) {
  await ctx.db.insert("aiRuns", { ...run, workspaceId: conversation.workspaceId });
}

type Context = {
  conversation: Doc<"conversations">;
  number: Doc<"numbers">;
  workspace: Doc<"workspaces">;
  messages: Doc<"messages">[];
};

/** Everything a turn needs, or null when the conversation (or its number) is gone. */
export const context = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }): Promise<Context | null> => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation) return null;
    const number = await ctx.db.get(conversation.numberId);
    const workspace = await ctx.db.get(conversation.workspaceId);
    if (!number || !workspace) return null;
    const latest = await ctx.db
      .query("messages")
      .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(HISTORY_MESSAGES);
    return { conversation, number, workspace, messages: latest.reverse() };
  },
});

/** Stores an `aiRun` for a turn that ends without `commitReply`. */
export const recordRun = internalMutation({
  args: runFields,
  returns: v.null(),
  handler: async (ctx, run) => {
    const conversation = await ctx.db.get(run.conversationId);
    if (conversation) await insertRun(ctx, conversation, run);
    return null;
  },
});

/**
 * Applies a turn's result in one transaction, only if the turn is still current: the requests,
 * the AI message, the handoff and the `aiRun`. Once written, the message is delivered even if
 * the turn changes afterwards.
 */
export const commitReply = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    turn: v.number(),
    attempt: v.number(),
    model: v.string(),
    startedAt: v.number(),
    result: resultValidator,
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, turn, attempt, model, startedAt, result }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation) return null;
    const now = Date.now();
    const decision = result.kind === "decision" ? result.decision : undefined;
    const base = {
      conversationId,
      turn,
      attempt,
      model,
      startedAt,
      toolCalls: decision?.toolCalls ?? [],
      ...(decision?.usage ? { usage: decision.usage } : {}),
    };

    // A person replied, the button was used or the customer wrote again while the model thought.
    if (conversation.mode !== "ai" || conversation.aiTurn !== turn) {
      await insertRun(ctx, conversation, {
        ...base,
        outcome: "dropped",
        dropReason: "stale",
        ...(result.kind === "event" && result.event.kind === "ai_error"
          ? { error: result.event.error }
          : {}),
        finishedAt: now,
      });
      return null;
    }

    // This turn's job has run, so no reply is pending any more.
    if (conversation.pendingReplyJobId) {
      await ctx.db.patch(conversationId, { pendingReplyJobId: undefined });
    }
    const fresh = async () => (await ctx.db.get(conversationId))!;

    if (result.kind === "event") {
      const { event } = result;
      await applyEvent(ctx, await fresh(), event, now);
      await insertRun(ctx, conversation, {
        ...base,
        outcome: event.kind === "ai_limit" ? "limited" : "error",
        ...(event.kind === "ai_error" ? { error: event.error } : {}),
        finishedAt: now,
      });
      return null;
    }

    const { text: rawText, handoff, requests } = result.decision;
    for (const request of requests) {
      await ctx.db.insert("requests", {
        workspaceId: conversation.workspaceId,
        conversationId,
        summary: request.summary,
        details: request.details,
        ...(request.customerName ? { customerName: request.customerName } : {}),
        status: "open",
        createdAt: now,
      });
    }

    const text = trimReply(rawText);
    if (text) await insertAiMessage(ctx, await fresh(), text, now);
    // Re-read: insertAiMessage patched the conversation.
    if (handoff) await applyEvent(ctx, await fresh(), { kind: "ai_handoff", summary: handoff.summary }, now);

    await insertRun(ctx, conversation, {
      ...base,
      outcome: handoff ? "handed_off" : text ? "sent" : "empty",
      ...(text ? { replyPreview: text.slice(0, PREVIEW_CHARS) } : {}),
      finishedAt: now,
    });
    return null;
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastCustomerText(messages: Doc<"messages">[]): string {
  return messages.findLast((m) => m.source === "customer")?.text ?? "";
}

/** Answers turn `turn` of a conversation. Scheduled by `applyEvent`, and by itself to retry. */
export const respond = internalAction({
  args: { conversationId: v.id("conversations"), turn: v.number(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { conversationId, turn, attempt }): Promise<null> => {
    const startedAt = Date.now();
    // Gone (demo reset, number removed): nothing to answer and nowhere to record a run.
    const found: Context | null = await ctx.runQuery(internal.responder.context, { conversationId });
    if (!found) return null;
    const { conversation, number, workspace, messages } = found;

    const active = getModel();
    const model = active?.id ?? "demo";
    const run = { conversationId, turn, attempt, model, startedAt, toolCalls: [] };
    const drop = async (dropReason: "stale" | "ai_disabled" | "window_closed") => {
      await ctx.runMutation(internal.responder.recordRun, {
        ...run,
        outcome: "dropped",
        dropReason,
        finishedAt: Date.now(),
      });
      return null;
    };
    const commit = async (result: Infer<typeof resultValidator>) => {
      await ctx.runMutation(internal.responder.commitReply, {
        conversationId,
        turn,
        attempt,
        model,
        startedAt,
        result,
      });
      return null;
    };

    if (conversation.mode !== "ai" || conversation.aiTurn !== turn) return drop("stale");
    if (!number.aiEnabled) return drop("ai_disabled");
    if (!windowState(conversation, startedAt).open) return drop("window_closed");
    if (replyLimitReached(conversation.aiReplies, startedAt)) {
      return commit({ kind: "event", event: { kind: "ai_limit" } });
    }

    let decision: ReplyDecision;
    try {
      decision = active
        ? await modelDecision(active.model, systemPrompt(workspace), conversationBlock(messages))
        : demoDecision(lastCustomerText(messages));
    } catch (e) {
      const error = `The AI could not answer: ${errorMessage(e).slice(0, ERROR_CHARS)}`;
      if (attempt === 1) {
        await ctx.runMutation(internal.responder.recordRun, {
          ...run,
          outcome: "error",
          error,
          finishedAt: Date.now(),
        });
        await ctx.scheduler.runAfter(MODEL_RETRY_DELAY_MS, internal.responder.respond, {
          conversationId,
          turn,
          attempt: 2,
        });
        return null;
      }
      return commit({ kind: "event", event: { kind: "ai_error", error } });
    }
    return commit({ kind: "decision", decision });
  },
});
