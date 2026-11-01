import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ai: the model answers. human: the team took over (idle timer running).
// waiting_human: the AI stopped and a person has to pick the conversation up.
export const modeValidator = v.union(v.literal("ai"), v.literal("human"), v.literal("waiting_human"));

export const reasonValidator = v.union(
  v.literal("phone_reply"),
  v.literal("ai_request"),
  v.literal("manual"),
  v.literal("media"),
  v.literal("limit"),
  v.literal("ai_error"),
);

// customer: the customer wrote; ai: sent by the AI; phone: sent from the WhatsApp Business app.
export const sourceValidator = v.union(v.literal("customer"), v.literal("ai"), v.literal("phone"));

// `queued` is the wait after a 429 from the API.
export const messageStatusValidator = v.union(
  v.literal("pending"),
  v.literal("queued"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("read"),
  v.literal("failed"),
);

export const healthValidator = v.object({
  state: v.union(v.literal("healthy"), v.literal("unhealthy"), v.literal("unknown")),
  canSendMessage: v.optional(v.string()),
  checkedAt: v.number(),
  detail: v.optional(v.string()),
});

export const runOutcomeValidator = v.union(
  v.literal("sent"),
  v.literal("handed_off"),
  v.literal("empty"),
  v.literal("dropped"),
  v.literal("limited"),
  v.literal("error"),
);

export const requestStatusValidator = v.union(v.literal("open"), v.literal("done"));

export default defineSchema({
  workspaces: defineTable({
    ownerId: v.string(),
    name: v.string(),
    instructions: v.string(),
    faq: v.string(),
    idleMinutes: v.number(),
  }).index("by_owner", ["ownerId"]),

  numbers: defineTable({
    workspaceId: v.id("workspaces"),
    poolNumberId: v.string(),
    phoneNumber: v.string(),
    displayName: v.string(),
    connectedAt: v.number(),
    health: v.optional(healthValidator),
    isDemo: v.optional(v.boolean()),
    aiEnabled: v.boolean(),
  })
    .index("by_pool_number", ["poolNumberId"])
    .index("by_workspace", ["workspaceId"]),

  events: defineTable({
    webhookId: v.string(),
    kind: v.string(),
    poolNumberId: v.optional(v.string()),
    payload: v.any(),
    state: v.union(v.literal("processed"), v.literal("parked"), v.literal("ignored")),
    receivedAt: v.number(),
  })
    .index("by_webhook_id", ["webhookId"])
    .index("by_pool_number_state", ["poolNumberId", "state"]),

  conversations: defineTable({
    workspaceId: v.id("workspaces"),
    numberId: v.id("numbers"),
    waId: v.optional(v.string()),
    userId: v.optional(v.string()),
    name: v.optional(v.string()),
    mode: modeValidator,
    modeChangedAt: v.number(),
    handoffReason: v.optional(reasonValidator),
    handoffSummary: v.optional(v.string()),
    humanActiveAt: v.optional(v.number()),
    resumeAt: v.optional(v.number()),
    // Bumped by every event that invalidates a reply in flight.
    aiTurn: v.number(),
    pendingReplyJobId: v.optional(v.id("_scheduled_functions")),
    lastInboundAt: v.optional(v.number()),
    lastMessageAt: v.number(),
    lastFrom: sourceValidator,
    lastPreview: v.string(),
    aiReplies: v.object({ windowStart: v.number(), count: v.number() }),
    lastError: v.optional(v.string()),
  })
    .index("by_number_wa_id", ["numberId", "waId"])
    .index("by_number_user_id", ["numberId", "userId"])
    .index("by_workspace_last_message", ["workspaceId", "lastMessageAt"])
    .index("by_workspace_mode_changed", ["workspaceId", "mode", "modeChangedAt"])
    .index("by_number", ["numberId"]),

  messages: defineTable({
    workspaceId: v.id("workspaces"),
    conversationId: v.id("conversations"),
    numberId: v.id("numbers"),
    wamid: v.optional(v.string()),
    direction: v.union(v.literal("in"), v.literal("out")),
    source: sourceValidator,
    type: v.string(),
    text: v.optional(v.string()),
    status: messageStatusValidator,
    error: v.optional(v.string()),
    attempt: v.optional(v.number()),
    sentAt: v.number(),
  })
    .index("by_wamid", ["wamid"])
    .index("by_conversation_sent_at", ["conversationId", "sentAt"]),

  requests: defineTable({
    workspaceId: v.id("workspaces"),
    conversationId: v.id("conversations"),
    summary: v.string(),
    details: v.string(),
    customerName: v.optional(v.string()),
    status: requestStatusValidator,
    createdAt: v.number(),
    doneAt: v.optional(v.number()),
  })
    .index("by_workspace_status_created", ["workspaceId", "status", "createdAt"])
    .index("by_conversation", ["conversationId"]),

  aiRuns: defineTable({
    workspaceId: v.id("workspaces"),
    conversationId: v.id("conversations"),
    turn: v.number(),
    attempt: v.number(),
    outcome: runOutcomeValidator,
    dropReason: v.optional(
      v.union(
        v.literal("stale"),
        v.literal("ai_disabled"),
        v.literal("window_closed"),
        v.literal("gone"),
      ),
    ),
    toolCalls: v.array(v.object({ name: v.string(), args: v.any() })),
    model: v.string(),
    replyPreview: v.optional(v.string()),
    error: v.optional(v.string()),
    usage: v.optional(v.object({ inputTokens: v.number(), outputTokens: v.number() })),
    startedAt: v.number(),
    finishedAt: v.number(),
  }).index("by_conversation_started", ["conversationId", "startedAt"]),
});
