import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const stageValidator = v.union(
  v.literal("lead"),
  v.literal("qualified"),
  v.literal("customer"),
  v.literal("lost"),
);

// contact: the customer wrote; app: sent from this UI; mcp: sent through an MCP client;
// phone: sent from the WhatsApp Business app (coexistence echo).
export const sourceValidator = v.union(
  v.literal("contact"),
  v.literal("app"),
  v.literal("mcp"),
  v.literal("phone"),
);

export const healthValidator = v.object({
  state: v.union(v.literal("healthy"), v.literal("unhealthy"), v.literal("unknown")),
  canSendMessage: v.optional(v.string()),
  checkedAt: v.number(),
  detail: v.optional(v.string()),
});

// `queued` is the wait after a 429 from the API.
export const messageStatusValidator = v.union(
  v.literal("pending"),
  v.literal("queued"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("read"),
  v.literal("failed"),
);

// `sending` locks a draft while it is being approved, so it is sent exactly once.
export const draftStatusValidator = v.union(
  v.literal("pending"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("discarded"),
  v.literal("failed"),
);

export const activityKindValidator = v.union(
  v.literal("contact_created"),
  v.literal("stage_changed"),
  v.literal("tags_changed"),
  v.literal("renamed"),
  v.literal("note_added"),
  v.literal("message_sent"),
  v.literal("draft_created"),
  v.literal("draft_decided"),
);

export default defineSchema({
  workspaces: defineTable({
    ownerId: v.string(),
    name: v.string(),
    mcpSendMode: v.union(v.literal("draft"), v.literal("direct")),
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
    workspaceId: v.id("workspaces"),
    waId: v.optional(v.string()),
    userId: v.optional(v.string()),
    name: v.optional(v.string()),
    stage: stageValidator,
    tags: v.array(v.string()),
    lastNumberId: v.id("numbers"),
    lastInboundAt: v.optional(v.number()),
    lastMessageAt: v.number(),
    lastDirection: v.union(v.literal("in"), v.literal("out")),
    lastPreview: v.optional(v.string()),
    unread: v.number(),
    searchText: v.string(),
  })
    .index("by_workspace_wa_id", ["workspaceId", "waId"])
    .index("by_workspace_user_id", ["workspaceId", "userId"])
    .index("by_workspace_stage_last_message", ["workspaceId", "stage", "lastMessageAt"])
    .index("by_workspace_last_message", ["workspaceId", "lastMessageAt"])
    .index("by_last_number", ["lastNumberId"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["workspaceId"] }),

  messages: defineTable({
    workspaceId: v.id("workspaces"),
    contactId: v.id("contacts"),
    numberId: v.id("numbers"),
    wamid: v.optional(v.string()),
    direction: v.union(v.literal("in"), v.literal("out")),
    source: sourceValidator,
    clientName: v.optional(v.string()),
    type: v.string(),
    text: v.optional(v.string()),
    status: messageStatusValidator,
    error: v.optional(v.string()),
    attempt: v.optional(v.number()),
    retriedBy: v.optional(v.id("messages")),
    draftId: v.optional(v.id("drafts")),
    sentAt: v.number(),
  })
    .index("by_wamid", ["wamid"])
    .index("by_contact_sent_at", ["contactId", "sentAt"])
    .index("by_number", ["numberId"]),

  notes: defineTable({
    workspaceId: v.id("workspaces"),
    contactId: v.id("contacts"),
    body: v.string(),
    author: v.string(),
    createdAt: v.number(),
  }).index("by_contact", ["contactId", "createdAt"]),

  drafts: defineTable({
    workspaceId: v.id("workspaces"),
    contactId: v.id("contacts"),
    text: v.string(),
    clientName: v.string(),
    status: draftStatusValidator,
    error: v.optional(v.string()),
    messageId: v.optional(v.id("messages")),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_contact_status", ["contactId", "status"])
    .index("by_workspace_status", ["workspaceId", "status"]),

  activities: defineTable({
    workspaceId: v.id("workspaces"),
    contactId: v.id("contacts"),
    kind: activityKindValidator,
    actor: v.string(),
    detail: v.string(),
    createdAt: v.number(),
  })
    .index("by_contact_created", ["contactId", "createdAt"])
    .index("by_workspace_kind_created", ["workspaceId", "kind", "createdAt"]),
});
