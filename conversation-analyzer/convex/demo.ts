import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { closeConversation } from "./conversations";
import { ingestPayload } from "./ingest";

const BUSINESS_PHONE = "15550100000";
const DAY_MS = 86_400_000;
const MINUTE = 60;

type Turn = {
  from: "customer" | "phone" | "api";
  /** Seconds after the scenario starts. */
  at: number;
  text: string;
};

type Scenario = { waId: string; name: string; startsAfter: number; turns: Turn[] };

/** `startsAfter` is minutes after `now - 1 day`. Every customer waits on a different clock. */
const SCENARIOS: Scenario[] = [
  {
    waId: "15550100001",
    name: "Ana",
    startsAfter: 0,
    turns: [
      { from: "customer", at: 0, text: "Hi, where is my order? I placed it on Monday." },
      { from: "phone", at: 40, text: "Hi Ana! Let me check that for you." },
      { from: "phone", at: 55, text: "I see order #48213. It is on its way and arrives on Friday." },
      { from: "phone", at: 70, text: "Is there anything else I can help you with?" },
      { from: "customer", at: 3 * MINUTE, text: "No, that's all. Thank you!" },
    ],
  },
  {
    waId: "15550100002",
    name: "Ben",
    startsAfter: 90,
    turns: [
      { from: "customer", at: 0, text: "Hello, do you ship to Canada?" },
      { from: "customer", at: 20 * MINUTE, text: "Hello? Anyone there?" },
      { from: "phone", at: 45 * MINUTE, text: "Yes, we ship to Canada." },
    ],
  },
  {
    waId: "15550100003",
    name: "Carla",
    startsAfter: 180,
    turns: [
      { from: "customer", at: 0, text: "Can I change the delivery address on my order?" },
      { from: "customer", at: 5 * MINUTE, text: "It is order #48377, please answer as soon as you can." },
    ],
  },
  {
    waId: "15550100004",
    name: "Dev",
    startsAfter: 270,
    turns: [
      { from: "customer", at: 0, text: "Is the blue jacket back in stock?" },
      // The reply below went out through the API: only its statuses reach us.
      { from: "api", at: 2 * MINUTE, text: "Thanks for writing! We are checking the stock." },
      { from: "phone", at: 30 * MINUTE, text: "Good news, the blue jacket is back in stock in all sizes." },
    ],
  },
];

async function findWorkspace(ctx: MutationCtx, email: string): Promise<Doc<"workspaces">> {
  const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "email", value: email }],
  });
  const workspace = user
    ? await ctx.db
        .query("workspaces")
        .withIndex("by_owner", (q) => q.eq("ownerId", user._id as string))
        .first()
    : null;
  if (!workspace) {
    throw new ConvexError(`No workspace for ${email}. Sign in to the app once first.`);
  }
  return workspace;
}

function envelope(poolNumberId: string, id: string, createdAt: number, whatsapp: object) {
  return {
    id,
    field: "messages",
    createdAt: new Date(createdAt).toISOString(),
    pipes: { appId: "app_demo", poolNumberId, media: {} },
    whatsapp: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: BUSINESS_PHONE, phone_number_id: "demo" },
      ...whatsapp,
    },
  };
}

/** Builds the webhook payloads of one scenario, in the order pipes.bot would deliver them. */
function scenarioPayloads(poolNumberId: string, scenario: Scenario, startMs: number) {
  const payloads: Record<string, unknown>[] = [];
  const seconds = (turn: Turn) => String(Math.floor(startMs / 1000) + turn.at);
  const contacts = [{ wa_id: scenario.waId, profile: { name: scenario.name } }];
  let n = 0;
  const wamid = () => `wamid.demo_${poolNumberId}_${scenario.waId}_${++n}`;

  for (const turn of scenario.turns) {
    const timestamp = seconds(turn);
    const createdAt = Number(timestamp) * 1000;
    const id = `evt_demo_${poolNumberId}_${scenario.waId}_${n + 1}`;
    if (turn.from === "customer") {
      payloads.push(
        envelope(poolNumberId, id, createdAt, {
          contacts,
          messages: [
            { from: scenario.waId, id: wamid(), timestamp, type: "text", text: { body: turn.text } },
          ],
        }),
      );
    } else if (turn.from === "phone") {
      payloads.push({
        ...envelope(poolNumberId, id, createdAt, {
          contacts,
          message_echoes: [
            {
              from: BUSINESS_PHONE,
              to: scenario.waId,
              id: wamid(),
              timestamp,
              type: "text",
              text: { body: turn.text },
            },
          ],
        }),
        field: "smb_message_echoes",
      });
    } else {
      const apiWamid = wamid();
      payloads.push(
        envelope(poolNumberId, id, createdAt, {
          statuses: [
            { id: apiWamid, status: "sent", timestamp, recipient_id: scenario.waId },
            {
              id: apiWamid,
              status: "delivered",
              timestamp: String(Number(timestamp) + 2),
              recipient_id: scenario.waId,
            },
          ],
        }),
      );
    }
  }
  return payloads;
}

/**
 * Feeds four realistic conversations through the real ingestion path, then
 * closes them so metrics and analysis run as they would for live traffic.
 * Run with: npx convex run demo:seed '{"email":"you@example.com"}'
 */
export const seed = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const workspace = await findWorkspace(ctx, email);
    const now = Date.now();
    const poolNumberId = `pn_demo_${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    let webhookCount = 0;
    const ingest = (payload: Record<string, unknown>) =>
      ingestPayload(ctx, `demo_${poolNumberId}_${++webhookCount}`, payload, now);

    await ingest({
      event: "number.onboarded",
      timestamp: new Date(now - DAY_MS).toISOString(),
      data: {
        numberId: poolNumberId,
        phoneNumber: `+${BUSINESS_PHONE}`,
        displayName: "Demo Support",
        appId: "app_demo",
        metadata: { workspaceId: workspace._id },
      },
    });
    const number = await ctx.db
      .query("numbers")
      .withIndex("by_pool_number", (q) => q.eq("poolNumberId", poolNumberId))
      .first();
    if (!number) throw new ConvexError("Could not create the demo number.");
    await ctx.db.patch(number._id, { isDemo: true });

    const base = now - DAY_MS;
    for (const scenario of SCENARIOS) {
      const startMs = base + scenario.startsAfter * 60_000;
      for (const payload of scenarioPayloads(poolNumberId, scenario, startMs)) await ingest(payload);
    }

    const open = await ctx.db
      .query("conversations")
      .withIndex("by_number_status_activity", (q) => q.eq("numberId", number._id).eq("status", "open"))
      .collect();
    for (const conversation of open) await closeConversation(ctx, conversation._id, now);
    return { poolNumberId, conversations: open.length };
  },
});

/** Deletes the demo numbers of the workspace with everything hanging off them. */
export const reset = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const workspace = await findWorkspace(ctx, email);
    const numbers = await ctx.db
      .query("numbers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    let deleted = 0;

    for (const number of numbers.filter((n) => n.isDemo)) {
      const conversations = await ctx.db
        .query("conversations")
        .withIndex("by_number_closed_at", (q) => q.eq("numberId", number._id))
        .collect();
      for (const conversation of conversations) {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversation._id))
          .collect();
        for (const message of messages) await ctx.db.delete(message._id);
        deleted += messages.length;
        if (conversation.closeJobId) {
          try {
            await ctx.scheduler.cancel(conversation.closeJobId);
          } catch {
            // The job already finished; nothing to cancel.
          }
        }
        await ctx.db.delete(conversation._id);
        deleted += 1;
      }

      const contacts = await ctx.db
        .query("contacts")
        .withIndex("by_number_wa_id", (q) => q.eq("numberId", number._id))
        .collect();
      for (const contact of contacts) await ctx.db.delete(contact._id);
      deleted += contacts.length;

      const statuses = await ctx.db
        .query("statuses")
        .withIndex("by_number_recipient", (q) => q.eq("numberId", number._id))
        .collect();
      for (const status of statuses) await ctx.db.delete(status._id);
      deleted += statuses.length;

      const events = await ctx.db
        .query("events")
        .withIndex("by_pool_number_state", (q) => q.eq("poolNumberId", number.poolNumberId))
        .collect();
      for (const event of events) await ctx.db.delete(event._id);
      deleted += events.length;

      await ctx.db.delete(number._id);
      deleted += 1;
    }
    return { deleted };
  },
});
