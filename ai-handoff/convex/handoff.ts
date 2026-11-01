import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { transition, type HandoffEvent, type HandoffState } from "./lib/handoff";

const DEFAULT_IDLE_MINUTES = 30;

const STATE_FIELDS = [
  "mode",
  "modeChangedAt",
  "aiTurn",
  "lastFrom",
  "handoffReason",
  "handoffSummary",
  "humanActiveAt",
  "resumeAt",
  "lastError",
] as const satisfies readonly (keyof HandoffState)[];

export function stateOf(c: Doc<"conversations">): HandoffState {
  return {
    mode: c.mode,
    modeChangedAt: c.modeChangedAt,
    aiTurn: c.aiTurn,
    lastFrom: c.lastFrom,
    handoffReason: c.handoffReason,
    handoffSummary: c.handoffSummary,
    humanActiveAt: c.humanActiveAt,
    resumeAt: c.resumeAt,
    lastError: c.lastError,
  };
}

/**
 * The conversation's number, or null when it is gone or was re-onboarded into another
 * workspace. A moved number belongs to its new owner: the old workspace's conversations treat
 * it as off, so they never reply or send through it.
 */
export function ownedNumber(
  conversation: Doc<"conversations">,
  number: Doc<"numbers"> | null,
): Doc<"numbers"> | null {
  return number && number.workspaceId === conversation.workspaceId ? number : null;
}

/** Cancels a scheduled reply unless it already ran (or was canceled). */
export async function cancelJob(ctx: MutationCtx, jobId: Id<"_scheduled_functions">) {
  const job = await ctx.db.system.get(jobId);
  if (job && (job.state.kind === "pending" || job.state.kind === "inProgress")) {
    await ctx.scheduler.cancel(jobId);
  }
}

/**
 * Runs `event` through the state machine and applies the result: patches only the state fields
 * that changed (`undefined` removes a field), then cancels or schedules the reply.
 * `conversation` must be fresh: re-read it if this mutation already patched it.
 */
export async function applyEvent(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  event: HandoffEvent,
  now: number,
): Promise<Doc<"conversations">> {
  const number = ownedNumber(conversation, await ctx.db.get(conversation.numberId));
  const workspace = await ctx.db.get(conversation.workspaceId);
  const before = stateOf(conversation);
  const { state, effects } = transition(before, event, {
    now,
    idleMinutes: workspace?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    aiEnabled: number?.aiEnabled ?? false,
  });
  if (state === before) return conversation;

  const patch: Partial<Doc<"conversations">> = {};
  for (const field of STATE_FIELDS) {
    if (state[field] !== before[field]) (patch as Record<string, unknown>)[field] = state[field];
  }

  let pending = conversation.pendingReplyJobId;
  for (const effect of effects) {
    if (pending) {
      await cancelJob(ctx, pending);
      pending = undefined;
      patch.pendingReplyJobId = undefined;
    }
    if (effect.kind === "schedule_reply") {
      pending = await ctx.scheduler.runAfter(effect.delayMs, internal.responder.respond, {
        conversationId: conversation._id,
        turn: state.aiTurn,
        attempt: 1,
      });
      patch.pendingReplyJobId = pending;
    }
  }

  if (Object.keys(patch).length > 0) await ctx.db.patch(conversation._id, patch);
  return (await ctx.db.get(conversation._id))!;
}
