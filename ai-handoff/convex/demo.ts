import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { requireConversation, requireWorkspace } from "./authz";
import { cancelJob } from "./handoff";
import { ingestPayload } from "./ingest";

const BUSINESS_PHONE = "15550100000";
const MINUTE_MS = 60_000;
const MAX_TEXT = 4096;
const FIRST_MESSAGE = "Hi! Do you deliver on weekends?";

// "Maya", "Leo", "Ana" and "Sam" are the seeded customers; the rest are for new conversations.
const NAMES = ["Maya", "Leo", "Ana", "Sam", "Chloe", "Noah", "Zoe", "Max"];

const DEMO_INSTRUCTIONS = `You answer customers of Golden Crumb, a small neighborhood bakery. Be warm and brief.
Take orders for the menu below and save each one as a request for the team to confirm.
Hand the conversation to a person for complaints, refunds, custom cakes and anything you are not sure about.`;

const DEMO_FAQ = `Hours: Tuesday to Saturday 7am-6pm, Sunday 8am-1pm. Closed on Monday.
Delivery: free within 3 km of the shop (downtown and Riverside), Tuesday to Saturday. No Sunday delivery.

Menu:
- Sourdough loaf: $7
- Butter croissant: $3.50
- Cinnamon roll: $4
- Blueberry muffin: $3`;

function randomSuffix(length = 6): string {
  let text = "";
  while (text.length < length) text += Math.random().toString(36).slice(2);
  return text.slice(0, length);
}

function envelope(poolNumberId: string, id: string, field: string, createdAt: number, whatsapp: object) {
  return {
    id,
    field,
    createdAt: new Date(createdAt).toISOString(),
    pipes: { appId: "app_demo", poolNumberId, media: {} },
    whatsapp: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: BUSINESS_PHONE, phone_number_id: "demo" },
      ...whatsapp,
    },
  };
}

type Party = { waId: string; name?: string };

/** A synthetic v2 envelope for a customer text, image or phone echo sent at `sentAt`. */
function messageEnvelope(
  poolNumberId: string,
  party: Party,
  kind: "customer" | "phone" | "image",
  text: string,
  sentAt: number,
) {
  const id = `wamid.demo_${randomSuffix(12)}`;
  const timestamp = String(Math.floor(sentAt / 1000));
  const contacts = [{ wa_id: party.waId, ...(party.name ? { profile: { name: party.name } } : {}) }];
  const evt = `evt_demo_${randomSuffix(12)}`;
  if (kind === "phone") {
    return envelope(poolNumberId, evt, "smb_message_echoes", sentAt, {
      contacts,
      message_echoes: [{ from: BUSINESS_PHONE, to: party.waId, id, timestamp, type: "text", text: { body: text } }],
    });
  }
  const message =
    kind === "image"
      ? { type: "image", image: { id: "demo_image", mime_type: "image/jpeg", caption: text } }
      : { type: "text", text: { body: text } };
  return envelope(poolNumberId, evt, "messages", sentAt, {
    contacts,
    messages: [{ from: party.waId, id, timestamp, ...message }],
  });
}

const ingest = (ctx: MutationCtx, payload: Record<string, unknown>, now: number) =>
  ingestPayload(ctx, `demo_${randomSuffix(12)}`, payload, now);

async function demoNumbers(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  const numbers = await ctx.db
    .query("numbers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return numbers.filter((number) => number.isDemo);
}

async function conversationOf(ctx: MutationCtx, number: Doc<"numbers">, waId: string) {
  const conversation = await ctx.db
    .query("conversations")
    .withIndex("by_number_wa_id", (q) => q.eq("numberId", number._id).eq("waId", waId))
    .first();
  if (!conversation) throw new ConvexError(`Demo conversation ${waId} was not created.`);
  return conversation;
}

async function addMessage(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  fields: { source: "ai" | "phone"; text: string; sentAt: number },
) {
  await ctx.db.insert("messages", {
    workspaceId: conversation.workspaceId,
    conversationId: conversation._id,
    numberId: conversation.numberId,
    wamid: `wamid.demo_${randomSuffix(12)}`,
    direction: "out",
    type: "text",
    status: "sent",
    ...fields,
  });
}

/** Seed conversations are written through the real ingestion path, then patched to their state. */
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const workspace = await requireWorkspace(ctx);
    if ((await demoNumbers(ctx, workspace._id)).length > 0) {
      throw new ConvexError("Demo data is already loaded");
    }

    const now = Date.now();
    const poolNumberId = `pn_demo_${randomSuffix()}`;
    await ingest(
      ctx,
      {
        event: "number.onboarded",
        timestamp: new Date(now - 60 * MINUTE_MS).toISOString(),
        data: {
          numberId: poolNumberId,
          phoneNumber: `+${BUSINESS_PHONE}`,
          displayName: "Demo Support",
          appId: "app_demo",
          metadata: { workspaceId: workspace._id },
        },
      },
      now,
    );
    const number = await ctx.db
      .query("numbers")
      .withIndex("by_pool_number", (q) => q.eq("poolNumberId", poolNumberId))
      .first();
    if (!number) throw new ConvexError("Could not create the demo number.");
    await ctx.db.patch(number._id, { isDemo: true, aiEnabled: true });

    if (workspace.instructions === "" && workspace.faq === "") {
      await ctx.db.patch(workspace._id, { instructions: DEMO_INSTRUCTIONS, faq: DEMO_FAQ });
    }

    // Every customer message is older than the stale limit, so nothing is scheduled.
    const maya: Party = { waId: "15550120001", name: "Maya" };
    const leo: Party = { waId: "15550120002", name: "Leo" };
    const ana: Party = { waId: "15550120003", name: "Ana" };
    const sam: Party = { waId: "15550120004", name: "Sam" };
    const send = (party: Party, kind: "customer" | "phone" | "image", text: string, ago: number) =>
      ingest(ctx, messageEnvelope(poolNumberId, party, kind, text, now - ago), now);

    // Maya: the AI answered and saved an order.
    const mayaAsked = 40 * MINUTE_MS;
    await send(maya, "customer", "Hi! Could I order 2 sourdough loaves for Saturday?", mayaAsked);
    let conversation = await conversationOf(ctx, number, maya.waId);
    const mayaReply = "Of course! I noted 2 sourdough loaves for Saturday. The team will confirm the pickup time.";
    const mayaReplyAt = now - mayaAsked + 20_000;
    await addMessage(ctx, conversation, { source: "ai", text: mayaReply, sentAt: mayaReplyAt });
    await ctx.db.patch(conversation._id, {
      lastMessageAt: mayaReplyAt,
      lastFrom: "ai",
      lastPreview: mayaReply,
      aiReplies: { windowStart: mayaReplyAt, count: 1 },
    });
    const mayaSummary = "Order: 2 sourdough loaves for Saturday";
    await ctx.db.insert("requests", {
      workspaceId: workspace._id,
      conversationId: conversation._id,
      summary: mayaSummary,
      details: "Pickup on Saturday. Two sourdough loaves ($14 in total).",
      customerName: "Maya",
      status: "open",
      createdAt: mayaReplyAt,
    });
    await ctx.db.insert("aiRuns", {
      workspaceId: workspace._id,
      conversationId: conversation._id,
      turn: conversation.aiTurn,
      attempt: 1,
      outcome: "sent",
      toolCalls: [{ name: "save_request", args: { summary: mayaSummary, customerName: "Maya" } }],
      model: "demo",
      replyPreview: mayaReply,
      usage: { inputTokens: 412, outputTokens: 38 },
      startedAt: mayaReplyAt - 4_000,
      finishedAt: mayaReplyAt,
    });

    // Leo: the AI asked for a person.
    const leoAsked = 30 * MINUTE_MS;
    await send(leo, "customer", "I need to change the address of my order #1042", leoAsked);
    conversation = await conversationOf(ctx, number, leo.waId);
    const leoReply = "Sure, someone from our team will take it from here.";
    const leoReplyAt = now - leoAsked + 20_000;
    const leoSummary = "Wants to change the address of order #1042";
    await addMessage(ctx, conversation, { source: "ai", text: leoReply, sentAt: leoReplyAt });
    await ctx.db.patch(conversation._id, {
      mode: "waiting_human",
      modeChangedAt: leoReplyAt,
      handoffReason: "ai_request",
      handoffSummary: leoSummary,
      aiTurn: conversation.aiTurn + 1,
      lastMessageAt: leoReplyAt,
      lastFrom: "ai",
      lastPreview: leoReply,
      aiReplies: { windowStart: leoReplyAt, count: 1 },
    });
    await ctx.db.insert("aiRuns", {
      workspaceId: workspace._id,
      conversationId: conversation._id,
      turn: conversation.aiTurn,
      attempt: 1,
      outcome: "handed_off",
      toolCalls: [
        { name: "request_human", args: { reason: "Order changes need a person", summary: leoSummary } },
      ],
      model: "demo",
      replyPreview: leoReply,
      usage: { inputTokens: 398, outputTokens: 61 },
      startedAt: leoReplyAt - 4_000,
      finishedAt: leoReplyAt,
    });

    // Ana: the team answered from the phone 10 minutes ago.
    await send(ana, "customer", "Can I pick up my cake today at 5pm?", 50 * MINUTE_MS);
    await send(ana, "phone", "Yes, 5pm works. See you then!", 10 * MINUTE_MS);
    conversation = await conversationOf(ctx, number, ana.waId);
    await ctx.db.patch(conversation._id, {
      modeChangedAt: now - 10 * MINUTE_MS,
      humanActiveAt: now - 10 * MINUTE_MS,
      resumeAt: now + 20 * MINUTE_MS,
    });

    // Sam: sent a photo, which the AI does not read.
    const samAsked = 25 * MINUTE_MS;
    await send(sam, "image", "Can you make a cake like this one?", samAsked);
    conversation = await conversationOf(ctx, number, sam.waId);
    await ctx.db.patch(conversation._id, { modeChangedAt: now - samAsked });

    return { poolNumberId };
  },
});

/** Deletes the workspace's demo numbers and everything hanging off them. Other data is untouched. */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    const workspace = await requireWorkspace(ctx);
    let deleted = 0;

    for (const number of await demoNumbers(ctx, workspace._id)) {
      const conversations = await ctx.db
        .query("conversations")
        .withIndex("by_number", (q) => q.eq("numberId", number._id))
        .collect();
      for (const conversation of conversations) {
        if (conversation.pendingReplyJobId) await cancelJob(ctx, conversation.pendingReplyJobId);
        const children = [
          await ctx.db
            .query("messages")
            .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversation._id))
            .collect(),
          await ctx.db
            .query("requests")
            .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
            .collect(),
          await ctx.db
            .query("aiRuns")
            .withIndex("by_conversation_started", (q) => q.eq("conversationId", conversation._id))
            .collect(),
        ].flat();
        for (const row of children) await ctx.db.delete(row._id);
        await ctx.db.delete(conversation._id);
        deleted += children.length + 1;
      }

      const events = await ctx.db
        .query("events")
        .withIndex("by_pool_number_state", (q) => q.eq("poolNumberId", number.poolNumberId))
        .collect();
      for (const event of events) await ctx.db.delete(event._id);
      await ctx.db.delete(number._id);
      deleted += events.length + 1;
    }
    return { deleted };
  },
});

export const newConversation = mutation({
  args: {},
  handler: async (ctx): Promise<Id<"conversations">> => {
    const workspace = await requireWorkspace(ctx);
    const [number] = await demoNumbers(ctx, workspace._id);
    if (!number) throw new ConvexError("Load the demo data first");

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_number", (q) => q.eq("numberId", number._id))
      .collect();
    const used = new Set(existing.map((c) => c.name));
    const name = NAMES.find((candidate) => !used.has(candidate)) ?? `Demo customer ${existing.length + 1}`;
    const phones = new Set(existing.map((c) => c.waId));
    let waId: string;
    do {
      waId = `1555012${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
    } while (phones.has(waId));

    const now = Date.now();
    await ingest(ctx, messageEnvelope(number.poolNumberId, { waId, name }, "customer", FIRST_MESSAGE, now), now);
    return (await conversationOf(ctx, number, waId))._id;
  },
});

async function simulate(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  rawText: string,
  kind: "customer" | "phone",
) {
  const { conversation } = await requireConversation(ctx, conversationId);
  const number = await ctx.db.get(conversation.numberId);
  if (!number?.isDemo) throw new ConvexError("Only demo conversations can be simulated");
  const text = rawText.trim();
  if (text.length < 1 || text.length > MAX_TEXT) {
    throw new ConvexError(`Text must be 1–${MAX_TEXT} characters`);
  }
  if (!conversation.waId) throw new ConvexError("Only demo conversations can be simulated");

  const now = Date.now();
  const party = { waId: conversation.waId, name: conversation.name };
  await ingest(ctx, messageEnvelope(number.poolNumberId, party, kind, text, now), now);
  return null;
}

/** Plays a customer message arriving on a demo number. */
export const simulateInbound = mutation({
  args: { conversationId: v.id("conversations"), text: v.string() },
  handler: (ctx, { conversationId, text }) => simulate(ctx, conversationId, text, "customer"),
});

/** Plays the team answering from the WhatsApp Business app on a demo number. */
export const simulateEcho = mutation({
  args: { conversationId: v.id("conversations"), text: v.string() },
  handler: (ctx, { conversationId, text }) => simulate(ctx, conversationId, text, "phone"),
});
