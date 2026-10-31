import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const stepValidator = v.object({
  id: v.string(),
  name: v.string(),
  description: v.string(),
});

export const metricsValidator = v.object({
  firstResponseSeconds: v.optional(v.number()),
  avgResponseSeconds: v.optional(v.number()),
  maxResponseSeconds: v.optional(v.number()),
  unansweredTurns: v.number(),
  answered: v.boolean(),
  durationSeconds: v.number(),
  counts: v.object({ customer: v.number(), phone: v.number(), api: v.number() }),
});

export const analysisValidator = v.object({
  state: v.union(
    v.literal("pending"),
    v.literal("running"),
    v.literal("done"),
    v.literal("failed"),
    v.literal("skipped"),
  ),
  reason: v.optional(v.string()),
  methodology: v.array(stepValidator),
  requestedAt: v.number(),
  summary: v.optional(v.string()),
  steps: v.optional(
    v.array(
      v.object({
        stepId: v.string(),
        verdict: v.union(v.literal("met"), v.literal("not_met"), v.literal("not_applicable")),
        evidence: v.union(v.string(), v.null()),
        reason: v.string(),
      }),
    ),
  ),
  score: v.optional(v.number()),
  model: v.optional(v.string()),
  analyzedAt: v.optional(v.number()),
});

export const healthValidator = v.object({
  state: v.union(v.literal("healthy"), v.literal("unhealthy"), v.literal("unknown")),
  checkedAt: v.number(),
  detail: v.optional(v.string()),
});

export const sourceValidator = v.union(v.literal("customer"), v.literal("phone"), v.literal("api"));

export default defineSchema({
  workspaces: defineTable({
    ownerId: v.string(),
    name: v.string(),
    inactivityMinutes: v.number(),
    methodology: v.array(stepValidator),
  }).index("by_owner", ["ownerId"]),

  numbers: defineTable({
    workspaceId: v.id("workspaces"),
    poolNumberId: v.string(),
    phoneNumber: v.string(),
    displayName: v.string(),
    connectedAt: v.number(),
    health: v.optional(healthValidator),
    isDemo: v.optional(v.boolean()),
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

  contacts: defineTable({
    numberId: v.id("numbers"),
    waId: v.optional(v.string()),
    userId: v.optional(v.string()),
    name: v.optional(v.string()),
  })
    .index("by_number_wa_id", ["numberId", "waId"])
    .index("by_number_user_id", ["numberId", "userId"]),

  conversations: defineTable({
    workspaceId: v.id("workspaces"),
    numberId: v.id("numbers"),
    contactId: v.id("contacts"),
    status: v.union(v.literal("open"), v.literal("closed")),
    initiatedBy: v.union(v.literal("customer"), v.literal("business")),
    openedAt: v.number(),
    lastActivityAt: v.number(),
    lastTurn: v.union(v.literal("customer"), v.literal("business")),
    waitingSince: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    closeJobId: v.optional(v.id("_scheduled_functions")),
    metrics: v.optional(metricsValidator),
    analysis: v.optional(analysisValidator),
  })
    .index("by_contact_status", ["contactId", "status"])
    .index("by_workspace_closed_at", ["workspaceId", "closedAt"])
    .index("by_number_closed_at", ["numberId", "closedAt"])
    .index("by_number_status_activity", ["numberId", "status", "lastActivityAt"])
    .index("by_workspace_status", ["workspaceId", "status"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    wamid: v.string(),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    source: sourceValidator,
    type: v.string(),
    text: v.optional(v.string()),
    sentAt: v.number(),
    deliveredAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
  })
    .index("by_wamid", ["wamid"])
    .index("by_conversation_sent_at", ["conversationId", "sentAt"]),

  statuses: defineTable({
    numberId: v.id("numbers"),
    wamid: v.string(),
    status: v.string(),
    timestamp: v.number(),
    recipient: v.string(),
  })
    .index("by_wamid", ["wamid"])
    .index("by_number_recipient", ["numberId", "recipient", "timestamp"]),
});
