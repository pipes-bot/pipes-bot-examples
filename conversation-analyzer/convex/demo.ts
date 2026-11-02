import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { resolveContact } from "./contactLookup";
import { closeConversation } from "./conversations";
import { buildContact } from "./history";
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

type HistoryTurn = {
  from: "customer" | "phone";
  /** Minutes after the chat starts. */
  at: number;
  text: string;
};

type HistoryChat = {
  /** How many days before the seed the chat starts. */
  daysAgo: number;
  /** Extra hours before that day mark, so the chats do not all start at the same time of day. */
  hoursEarlier: number;
  turns: HistoryTurn[];
};

type HistoryContact = { waId: string; bookName: string; chats: HistoryChat[] };

/**
 * Chat history imported from the business phone. The gaps inside a chat stay
 * under the default 120-minute window and the chats are days apart, so the
 * six chats below become six conversations.
 */
const HISTORY: HistoryContact[] = [
  {
    waId: "15550100001",
    bookName: "Ana Souza",
    chats: [
      {
        daysAgo: 18,
        hoursEarlier: 2,
        turns: [
          { from: "customer", at: 0, text: "Good morning! What are your opening hours on Saturday?" },
          { from: "phone", at: 3, text: "Good morning Ana! On Saturdays we are open from 9am to 2pm." },
          { from: "customer", at: 5, text: "Perfect, I will drop by around noon." },
          { from: "phone", at: 6, text: "See you then!" },
        ],
      },
      {
        daysAgo: 9,
        hoursEarlier: 7,
        turns: [
          { from: "customer", at: 0, text: "Hi, the shoes I bought are too small. Can I return them?" },
          { from: "phone", at: 35, text: "Hi Ana, sorry for the wait. Yes, returns are free within 30 days." },
          { from: "phone", at: 36, text: "Just bring them with the receipt and we will swap the size." },
          { from: "customer", at: 50, text: "Great, I will come by tomorrow." },
        ],
      },
    ],
  },
  {
    waId: "15550100002",
    bookName: "Ben Carter",
    chats: [
      {
        daysAgo: 14,
        hoursEarlier: 5,
        turns: [
          { from: "customer", at: 0, text: "Hello, I ordered a backpack last week. Any news on the delivery?" },
          { from: "customer", at: 30, text: "I still have no tracking number." },
          { from: "phone", at: 95, text: "Hi Ben, apologies for the delay. Your order #47990 shipped this morning." },
          { from: "phone", at: 96, text: "The tracking code is BR449201 and it should arrive in 3 days." },
          { from: "customer", at: 110, text: "Thanks, got it." },
        ],
      },
    ],
  },
  {
    waId: "15550100005",
    bookName: "Eva Lima",
    chats: [
      {
        daysAgo: 12,
        hoursEarlier: 3,
        turns: [
          { from: "customer", at: 0, text: "Hi, my package arrived with a broken lid." },
          { from: "customer", at: 1, text: "I can send a photo if you need." },
          { from: "phone", at: 20, text: "Hi Eva, I am sorry about that. A photo helps, please send it over." },
          { from: "customer", at: 28, text: "Sent it a minute ago, did you see it?" },
          { from: "phone", at: 40, text: "Yes, we will send a replacement at no cost. It ships tomorrow." },
        ],
      },
      {
        daysAgo: 6,
        hoursEarlier: 9,
        turns: [
          { from: "customer", at: 0, text: "Hello! Is my replacement on the way?" },
          { from: "phone", at: 2, text: "Hi Eva! Yes, it left our warehouse yesterday." },
          { from: "phone", at: 3, text: "You will get it by Thursday." },
          { from: "customer", at: 4, text: "Wonderful, thank you." },
        ],
      },
    ],
  },
  {
    waId: "15550100006",
    bookName: "Frank Moss",
    chats: [
      {
        // A complaint nobody answered.
        daysAgo: 3,
        hoursEarlier: 1,
        turns: [
          { from: "customer", at: 0, text: "I was charged twice for order #48105. This is unacceptable." },
          { from: "customer", at: 12, text: "Please refund me today or I will dispute it with my bank." },
        ],
      },
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
 * It also stages imported chat history and an address book, as a number
 * connected with the history and contacts import would receive.
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

    // The address book of the business phone, then the history it shared.
    await ingest({
      id: `evt_demo_${poolNumberId}_book`,
      field: "smb_app_state_sync",
      createdAt: new Date(now).toISOString(),
      pipes: { appId: "app_demo", poolNumberId, media: {} },
      whatsapp: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: BUSINESS_PHONE, phone_number_id: "demo" },
        state_sync: HISTORY.map((contact) => ({
          type: "contact",
          contact: {
            full_name: contact.bookName,
            first_name: contact.bookName.split(" ")[0],
            phone_number: contact.waId,
          },
          action: "add",
          metadata: { timestamp: String(Math.floor(now / 1000)) },
        })),
      },
    });

    let staged = 0;
    const contactIds: Id<"contacts">[] = [];
    for (const contact of HISTORY) {
      const contactId = await resolveContact(ctx, number._id, { waId: contact.waId }, undefined);
      if (!contactId) throw new ConvexError("Could not create the demo contact.");
      contactIds.push(contactId);
      for (const chat of contact.chats) {
        const dayStart = now - chat.daysAgo * DAY_MS - chat.hoursEarlier * 3_600_000;
        for (const turn of chat.turns) {
          await ctx.db.insert("historyMessages", {
            numberId: number._id,
            contactId,
            wamid: `wamid.demo_hist_${poolNumberId}_${++staged}`,
            source: turn.from,
            type: "text",
            text: turn.text,
            sentAt: dayStart + turn.at * 60_000,
            pending: true,
          });
        }
      }
    }
    // The live scenarios are closed by now, so no history segment folds into one.
    let imported = 0;
    for (const contactId of contactIds) imported += await buildContact(ctx, number, contactId);

    await ctx.db.patch(number._id, {
      historyImport: {
        state: "done",
        progress: 100,
        chunks: 3,
        messages: staged,
        conversations: imported,
        updatedAt: now,
      },
      contactsImport: { state: "received", updatedAt: now },
    });
    return { poolNumberId, conversations: open.length, imported };
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
      for (const event of events) {
        if (event.storageId) await ctx.storage.delete(event.storageId);
        await ctx.db.delete(event._id);
      }
      deleted += events.length;

      const history = await ctx.db
        .query("historyMessages")
        .withIndex("by_number_contact_sent_at", (q) => q.eq("numberId", number._id))
        .collect();
      for (const row of history) await ctx.db.delete(row._id);
      deleted += history.length;

      await ctx.db.delete(number._id);
      deleted += 1;
    }
    return { deleted };
  },
});
