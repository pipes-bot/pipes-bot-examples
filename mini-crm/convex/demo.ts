import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { requireWorkspace } from "./authz";
import { applyContactUpdate, insertNote } from "./crm";
import { createDraft } from "./drafts";
import { ingestPayload } from "./ingest";
import type { Stage } from "./lib/crm";

const BUSINESS_PHONE = "15550100000";
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Turn = {
  from: "customer" | "phone";
  /** How long before the seed ran the message was sent. */
  ago: number;
  text: string;
};

type DemoContact = {
  /** Phone number; omitted for a customer who only exposes a BSUID. */
  waId?: string;
  userId?: string;
  name: string;
  stage: Stage;
  tags?: string[];
  turns: Turn[];
  notes?: Array<{ ago: number; author: string; body: string }>;
  /** A pending draft written by an MCP client; the contact's window must be open. */
  draft?: string;
};

// A small coffee-equipment and furniture shop. Every customer who wrote within a day has an open
// window; Tom Becker wrote three days ago, so his window is closed.
const CONTACTS: DemoContact[] = [
  {
    waId: "15550100001",
    name: "Olivia Bennett",
    stage: "lead",
    tags: ["espresso"],
    turns: [
      { from: "customer", ago: 14 * MINUTE_MS, text: "Hi! Do you have the Barista Pro espresso machine in stock?" },
      { from: "customer", ago: 12 * MINUTE_MS, text: "I would like to pick it up this week if possible." },
    ],
    notes: [{ ago: 10 * MINUTE_MS, author: "you", body: "Found us through the Instagram ad for the Barista Pro." }],
    draft: "Hi Olivia! Yes, the Barista Pro is in stock. You can pick it up at the shop any day from 9am to 6pm. Want me to reserve one for you?",
  },
  {
    waId: "15550100002",
    name: "Marcus Lee",
    stage: "lead",
    turns: [
      { from: "customer", ago: 45 * MINUTE_MS, text: "What is the delivery time to Austin for the oak dining table?" },
    ],
  },
  {
    userId: "US.4801937562018374659",
    name: "Hannah Weber",
    stage: "lead",
    tags: ["furniture"],
    turns: [
      { from: "customer", ago: 70 * MINUTE_MS, text: "Is the walnut sideboard still available?" },
      { from: "customer", ago: 68 * MINUTE_MS, text: "Also, can you deliver on a Saturday?" },
    ],
  },
  {
    waId: "15550100003",
    name: "Daniel Ortiz",
    stage: "lead",
    turns: [
      { from: "customer", ago: 5 * HOUR_MS + 20 * MINUTE_MS, text: "Hello, do you sell replacement burrs for the Mill 200 grinder?" },
    ],
  },
  {
    waId: "15550100004",
    name: "Tom Becker",
    stage: "lead",
    turns: [
      { from: "customer", ago: 3 * DAY_MS, text: "Hi, I bought a hand grinder last week and the handle is loose. Can I return it?" },
    ],
  },
  {
    waId: "15550100005",
    name: "Priya Nair",
    stage: "qualified",
    tags: ["wholesale", "espresso"],
    turns: [
      { from: "customer", ago: 5 * HOUR_MS + 50 * MINUTE_MS, text: "Hello, we run three cafes and want to replace our grinders." },
      { from: "phone", ago: 5 * HOUR_MS + 30 * MINUTE_MS, text: "Hi Priya, happy to help! How many grinders do you need?" },
      { from: "customer", ago: 2 * HOUR_MS, text: "Twelve in total. Can you do a discount for that volume?" },
    ],
    notes: [
      { ago: 90 * MINUTE_MS, author: "you", body: "Chain of 3 cafes, 12 grinders. Ask the owner for a 10% volume discount." },
    ],
  },
  {
    waId: "15550100006",
    name: "Sofia Rossi",
    stage: "qualified",
    tags: ["furniture"],
    turns: [
      { from: "customer", ago: 20 * HOUR_MS, text: "I am looking at the leather sofa. Is the grey one available in the 3-seater?" },
      { from: "phone", ago: 19 * HOUR_MS + 30 * MINUTE_MS, text: "Yes, the grey 3-seater is in stock and ships in 3 days." },
      { from: "customer", ago: 19 * HOUR_MS, text: "Great, I will talk to my partner and come back to you." },
    ],
  },
  {
    waId: "15550100007",
    name: "James Carter",
    stage: "qualified",
    tags: ["furniture", "quote"],
    turns: [
      { from: "customer", ago: 8 * HOUR_MS, text: "Could you send me a quote for the 6-seat oak table with matching chairs?" },
    ],
    notes: [{ ago: 7 * HOUR_MS, author: "Claude", body: "Asked twice about delivery to the second floor. Check the lift access before quoting." }],
  },
  {
    waId: "15550100008",
    name: "Ethan Brooks",
    stage: "customer",
    tags: ["espresso", "vip"],
    turns: [
      { from: "customer", ago: 10 * HOUR_MS, text: "The espresso machine arrived today and it works great, thank you!" },
      { from: "phone", ago: 9 * HOUR_MS + 40 * MINUTE_MS, text: "Great to hear, Ethan! Enjoy it, and tell us if you need anything." },
    ],
  },
  {
    waId: "15550100009",
    name: "Lucy Chen",
    stage: "customer",
    tags: ["furniture"],
    turns: [
      { from: "customer", ago: 6 * HOUR_MS, text: "The dining table was delivered in perfect condition. Thanks!" },
    ],
    notes: [{ ago: 5 * HOUR_MS, author: "you", body: "Paid in full. Ask for a review next week." }],
  },
  {
    waId: "15550100010",
    name: "Greg Wilson",
    stage: "lost",
    turns: [
      { from: "customer", ago: 22 * HOUR_MS, text: "Thanks for the quote, but I found the same grinder cheaper elsewhere." },
    ],
  },
  {
    waId: "15550100011",
    name: "Nina Patel",
    stage: "lost",
    tags: ["furniture"],
    turns: [
      { from: "customer", ago: 15 * HOUR_MS, text: "We decided to postpone the office renovation. I will write again next year." },
    ],
  },
];

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
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

/** Builds the webhook payloads of one contact, oldest first, as pipes.bot would deliver them. */
function conversationPayloads(poolNumberId: string, contact: DemoContact, now: number) {
  const key = contact.waId ?? contact.userId!.replace(/\W/g, "");
  const turns = [...contact.turns].sort((a, b) => b.ago - a.ago);
  const customer = {
    ...(contact.waId ? { wa_id: contact.waId } : {}),
    ...(contact.userId ? { user_id: contact.userId } : {}),
  };
  const contacts = [{ ...customer, profile: { name: contact.name } }];

  return turns.map((turn, index) => {
    const sentAt = now - turn.ago;
    const timestamp = String(Math.floor(sentAt / 1000));
    const id = `evt_demo_${poolNumberId}_${key}_${index + 1}`;
    const wamid = `wamid.demo_${poolNumberId}_${key}_${index + 1}`;
    if (turn.from === "customer") {
      return envelope(poolNumberId, id, "messages", sentAt, {
        contacts,
        messages: [
          {
            ...(contact.waId ? { from: contact.waId } : {}),
            ...(contact.userId ? { from_user_id: contact.userId } : {}),
            id: wamid,
            timestamp,
            type: "text",
            text: { body: turn.text },
          },
        ],
      });
    }
    return envelope(poolNumberId, id, "smb_message_echoes", sentAt, {
      contacts,
      message_echoes: [
        {
          from: BUSINESS_PHONE,
          ...(contact.waId ? { to: contact.waId } : {}),
          ...(contact.userId ? { to_user_id: contact.userId } : {}),
          id: wamid,
          timestamp,
          type: "text",
          text: { body: turn.text },
        },
      ],
    });
  });
}

async function findContact(ctx: MutationCtx, workspace: Doc<"workspaces">, demo: DemoContact) {
  const { userId, waId } = demo;
  const contact = userId
    ? await ctx.db
        .query("contacts")
        .withIndex("by_workspace_user_id", (q) => q.eq("workspaceId", workspace._id).eq("userId", userId))
        .first()
    : await ctx.db
        .query("contacts")
        .withIndex("by_workspace_wa_id", (q) => q.eq("workspaceId", workspace._id).eq("waId", waId))
        .first();
  if (!contact) throw new ConvexError(`Demo contact ${demo.name} was not created.`);
  return contact;
}

async function demoNumbers(ctx: MutationCtx, workspaceId: Doc<"workspaces">["_id"]) {
  const numbers = await ctx.db
    .query("numbers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return numbers.filter((number) => number.isDemo);
}

/**
 * Loads a small sales pipeline into the caller's workspace through the real ingestion path, on a
 * demo number that never reaches pipes.bot. Timestamps are relative to now.
 */
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const workspace = await requireWorkspace(ctx);
    if ((await demoNumbers(ctx, workspace._id)).length > 0) {
      throw new ConvexError("Demo data is already loaded");
    }

    const now = Date.now();
    const poolNumberId = `pn_demo_${randomSuffix()}`;
    let webhookCount = 0;
    const ingest = (payload: Record<string, unknown>) =>
      ingestPayload(ctx, `demo_${poolNumberId}_${++webhookCount}`, payload, now);

    await ingest({
      event: "number.onboarded",
      timestamp: new Date(now - DAY_MS).toISOString(),
      data: {
        numberId: poolNumberId,
        phoneNumber: `+${BUSINESS_PHONE}`,
        displayName: "Demo Sales",
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

    for (const demo of CONTACTS) {
      for (const payload of conversationPayloads(poolNumberId, demo, now)) await ingest(payload);

      const contact = await findContact(ctx, workspace, demo);
      await applyContactUpdate(ctx, contact, { stage: demo.stage, addTags: demo.tags }, "you", now);
      for (const note of demo.notes ?? []) {
        await insertNote(ctx, contact, note.body, note.author, now - note.ago);
      }
      if (demo.draft) {
        const draft = await createDraft(ctx, {
          workspaceId: workspace._id,
          contact,
          text: demo.draft,
          clientName: "Claude",
          now,
        });
        if ("error" in draft) throw new ConvexError(`Could not create the demo draft: ${draft.error}`);
      }
    }
    return { poolNumberId, contacts: CONTACTS.length };
  },
});

/** Deletes the workspace's demo numbers and everything that hangs off them. Other data is untouched. */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    const workspace = await requireWorkspace(ctx);
    let deleted = 0;

    for (const number of await demoNumbers(ctx, workspace._id)) {
      const contacts = await ctx.db
        .query("contacts")
        .withIndex("by_last_number", (q) => q.eq("lastNumberId", number._id))
        .collect();
      for (const contact of contacts) {
        if (contact.workspaceId !== workspace._id) continue;
        const children = [
          await ctx.db
            .query("messages")
            .withIndex("by_contact_sent_at", (q) => q.eq("contactId", contact._id))
            .collect(),
          await ctx.db
            .query("notes")
            .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
            .collect(),
          await ctx.db
            .query("drafts")
            .withIndex("by_contact_status", (q) => q.eq("contactId", contact._id))
            .collect(),
          await ctx.db
            .query("activities")
            .withIndex("by_contact_created", (q) => q.eq("contactId", contact._id))
            .collect(),
        ].flat();
        for (const row of children) await ctx.db.delete(row._id);
        await ctx.db.delete(contact._id);
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
