import { describe, expect, it } from "vitest";
import { makeT, seedUser, type TestConvex } from "../tests/helpers";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import * as read from "./crmRead";

const NOW = Date.now();
const HOUR = 3_600_000;

async function seed() {
  const t = makeT();
  const { workspaceId, asUser } = await seedUser(t);
  const numberId = await insertNumber(t, workspaceId, "pn_1");
  return { t, workspaceId, asUser, numberId };
}

function insertNumber(t: TestConvex, workspaceId: Id<"workspaces">, poolNumberId: string) {
  return t.run((ctx) =>
    ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId,
      phoneNumber: "+15550001111",
      displayName: "Support",
      connectedAt: 0,
    }),
  );
}

function insertContact(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  numberId: Id<"numbers">,
  overrides: Partial<Doc<"contacts">> = {},
) {
  return t.run((ctx) => {
    const name = overrides.name ?? "Ana";
    const waId = overrides.waId ?? "5511900000000";
    return ctx.db.insert("contacts", {
      workspaceId,
      waId,
      name,
      stage: "lead",
      tags: [],
      lastNumberId: numberId,
      lastMessageAt: NOW,
      lastDirection: "in",
      unread: 0,
      searchText: `${name} ${waId}`,
      ...overrides,
    });
  });
}

describe("contacts queries", () => {
  it("pipeline groups by stage", async () => {
    const { t, workspaceId, asUser, numberId } = await seed();
    await insertContact(t, workspaceId, numberId, { name: "Ana", waId: "1" });
    await insertContact(t, workspaceId, numberId, { name: "Bia", waId: "2", stage: "customer" });
    await insertContact(t, workspaceId, numberId, {
      name: "Caio",
      waId: "3",
      stage: "customer",
      lastMessageAt: NOW - HOUR,
    });

    const board = await asUser.query(api.contacts.pipeline, {});

    expect(board.lead.map((c) => c.name)).toEqual(["Ana"]);
    expect(board.customer.map((c) => c.name)).toEqual(["Bia", "Caio"]);
    expect(board.qualified).toEqual([]);
    expect(board.lost).toEqual([]);
    expect(board.lead[0]).toMatchObject({ phone: "1", stage: "lead", pendingDrafts: 0 });
  });

  it("inbox waiting filter", async () => {
    const { t, workspaceId, asUser, numberId } = await seed();
    await insertContact(t, workspaceId, numberId, { name: "Ana", waId: "1", lastDirection: "in" });
    await insertContact(t, workspaceId, numberId, {
      name: "Bia",
      waId: "2",
      lastDirection: "out",
      lastMessageAt: NOW + 1,
    });

    const all = await asUser.query(api.contacts.inbox, { filter: "all" });
    const waiting = await asUser.query(api.contacts.inbox, { filter: "waiting" });

    expect(all.map((c) => c.name)).toEqual(["Bia", "Ana"]);
    expect(waiting.map((c) => c.name)).toEqual(["Ana"]);
    expect(waiting[0].waitingForReply).toBe(true);
  });

  it("inbox drafts filter", async () => {
    const { t, workspaceId, asUser, numberId } = await seed();
    const withDraft = await insertContact(t, workspaceId, numberId, { name: "Ana", waId: "1" });
    await insertContact(t, workspaceId, numberId, { name: "Bia", waId: "2" });
    await t.run(async (ctx) => {
      for (const status of ["pending", "pending", "discarded"] as const) {
        await ctx.db.insert("drafts", {
          workspaceId,
          contactId: withDraft,
          text: "Hello",
          clientName: "Claude",
          status,
          createdAt: NOW,
        });
      }
    });

    const drafts = await asUser.query(api.contacts.inbox, { filter: "drafts" });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: withDraft, pendingDrafts: 2 });
  });

  it("search by name and phone", async () => {
    const { t, workspaceId, numberId } = await seed();
    await insertContact(t, workspaceId, numberId, { name: "Ana Souza", waId: "5511911111111", tags: ["vip"] });
    await insertContact(t, workspaceId, numberId, {
      name: "Bruno Lima",
      waId: "5521922222222",
      stage: "customer",
    });
    const other = await seedUser(t, "user_2");
    const otherNumber = await insertNumber(t, other.workspaceId, "pn_2");
    await insertContact(t, other.workspaceId, otherNumber, { name: "Ana Other", waId: "9" });

    const search = (opts: { query?: string; stage?: "customer"; tag?: string }) =>
      t.run(async (ctx) =>
        (await read.searchContacts(ctx, workspaceId, { limit: 20, ...opts }, NOW)).map((c) => c.name),
      );

    expect(await search({ query: "ana" })).toEqual(["Ana Souza"]);
    expect(await search({ query: "5521922222222" })).toEqual(["Bruno Lima"]);
    expect(await search({ query: "  ", stage: "customer" })).toEqual(["Bruno Lima"]);
    expect(await search({ query: "bruno", stage: "customer" })).toEqual(["Bruno Lima"]);
    expect(await search({ query: "ana", stage: "customer" })).toEqual([]);
    expect(await search({ tag: " VIP " })).toEqual(["Ana Souza"]);
    expect(await search({ tag: "" })).toEqual([]);
    expect((await search({})).sort()).toEqual(["Ana Souza", "Bruno Lima"]);
  });

  it("conversation pages with nextBefore", async () => {
    const { t, workspaceId, asUser, numberId } = await seed();
    const contactId = await insertContact(t, workspaceId, numberId);
    await t.run(async (ctx) => {
      for (let i = 1; i <= 105; i++) {
        await ctx.db.insert("messages", {
          workspaceId,
          contactId,
          numberId,
          direction: i % 2 ? "in" : "out",
          source: i % 2 ? "contact" : "app",
          type: "text",
          text: `m${i}`,
          status: "sent",
          sentAt: i,
        });
      }
    });

    const first = await asUser.query(api.contacts.conversation, { contactId });
    expect(first!.messages).toHaveLength(100);
    expect(first!.messages[0].text).toBe("m6");
    expect(first!.messages[99].text).toBe("m105");
    expect(first!.messages[99].from).toBe("contact");
    expect(first!.messages[98].from).toBe("you");
    expect(first!.nextBefore).toBe(6);

    const second = await asUser.query(api.contacts.conversation, {
      contactId,
      before: first!.nextBefore,
    });
    expect(second!.messages.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(second!.nextBefore).toBeUndefined();
  });

  it("detail returns the newest notes and activities", async () => {
    const { t, workspaceId, asUser, numberId } = await seed();
    const contactId = await insertContact(t, workspaceId, numberId, { lastInboundAt: Date.now() });

    await asUser.mutation(api.contacts.addNote, { contactId, body: "first" });
    await asUser.mutation(api.contacts.addNote, { contactId, body: "second" });
    const detail = await asUser.query(api.contacts.detail, { contactId });

    expect(detail!.contact.window.open).toBe(true);
    expect(detail!.notes.map((n) => n.body)).toEqual(["second", "first"]);
    expect(detail!.activities.map((a) => a.kind)).toEqual(["note_added", "note_added"]);
  });
});

describe("crmRead helpers", () => {
  it("unanswered lists the longest wait first", async () => {
    const { t, workspaceId, numberId } = await seed();
    await insertContact(t, workspaceId, numberId, { name: "Recent", waId: "1", lastMessageAt: NOW });
    await insertContact(t, workspaceId, numberId, { name: "Old", waId: "2", lastMessageAt: NOW - 5 * HOUR });
    await insertContact(t, workspaceId, numberId, {
      name: "Answered",
      waId: "3",
      lastMessageAt: NOW - 9 * HOUR,
      lastDirection: "out",
    });

    const names = await t.run(async (ctx) =>
      (await read.unanswered(ctx, workspaceId, 10, NOW)).map((c) => c.name),
    );
    expect(names).toEqual(["Old", "Recent"]);

    const limited = await t.run(async (ctx) => (await read.unanswered(ctx, workspaceId, 1, NOW)).length);
    expect(limited).toBe(1);
  });

  it("pipelineSummary counts stages and lists recent stage changes", async () => {
    const { t, workspaceId, asUser, numberId } = await seed();
    const ana = await insertContact(t, workspaceId, numberId, { name: "Ana", waId: "1" });
    await insertContact(t, workspaceId, numberId, { name: "Bia", waId: "2", stage: "lost" });
    await asUser.mutation(api.contacts.update, { contactId: ana, stage: "qualified" });

    const summary = await t.run((ctx) => read.pipelineSummary(ctx, workspaceId));

    expect(summary.counts).toEqual({ lead: 0, qualified: 1, customer: 0, lost: 1 });
    expect(summary.recentStageChanges).toEqual([
      expect.objectContaining({
        contactId: ana,
        name: "Ana",
        detail: "lead → qualified",
        actor: "you",
      }),
    ]);
  });
});

describe("contacts mutations", () => {
  it("update moves stage and logs it", async () => {
    const { t, workspaceId, asUser, numberId } = await seed();
    const contactId = await insertContact(t, workspaceId, numberId, { tags: ["cold"] });

    await asUser.mutation(api.contacts.update, {
      contactId,
      stage: "qualified",
      name: " Ana Souza ",
      addTags: ["VIP"],
      removeTags: ["cold"],
    });

    const { contact, activities } = await t.run(async (ctx) => ({
      contact: (await ctx.db.get(contactId))!,
      activities: await ctx.db.query("activities").collect(),
    }));
    expect(contact).toMatchObject({ stage: "qualified", name: "Ana Souza", tags: ["vip"] });
    expect(activities.map((a) => [a.kind, a.actor, a.detail]).sort()).toEqual([
      ["renamed", "you", "Ana → Ana Souza"],
      ["stage_changed", "you", "lead → qualified"],
      ["tags_changed", "you", "+vip −cold"],
    ]);
  });

  it("markRead zeroes unread", async () => {
    const { t, workspaceId, asUser, numberId } = await seed();
    const contactId = await insertContact(t, workspaceId, numberId, { unread: 3 });

    await asUser.mutation(api.contacts.markRead, { contactId });

    expect((await t.run((ctx) => ctx.db.get(contactId)))!.unread).toBe(0);
  });

  it("other workspace is not found", async () => {
    const { t, workspaceId, numberId } = await seed();
    const contactId = await insertContact(t, workspaceId, numberId, { unread: 2 });
    const intruder = (await seedUser(t, "user_2")).asUser;

    await expect(intruder.query(api.contacts.detail, { contactId })).rejects.toThrow("Not found");
    await expect(intruder.query(api.contacts.conversation, { contactId })).rejects.toThrow("Not found");
    await expect(
      intruder.mutation(api.contacts.update, { contactId, stage: "lost" }),
    ).rejects.toThrow("Not found");
    await expect(
      intruder.mutation(api.contacts.addNote, { contactId, body: "hi" }),
    ).rejects.toThrow("Not found");
    await expect(intruder.mutation(api.contacts.markRead, { contactId })).rejects.toThrow("Not found");

    const after = await t.run(async (ctx) => ({
      contact: (await ctx.db.get(contactId))!,
      notes: await ctx.db.query("notes").collect(),
    }));
    expect(after.contact).toMatchObject({ stage: "lead", unread: 2 });
    expect(after.notes).toEqual([]);
  });
});
