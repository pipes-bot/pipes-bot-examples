import { afterEach, describe, expect, it, vi } from "vitest";
import { makeT, seedContact, seedNumber, seedUser, type TestConvex } from "../tests/helpers";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { windowState } from "./lib/crm";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seeded() {
  const t = makeT();
  const { workspaceId, asUser } = await seedUser(t);
  await asUser.mutation(api.demo.seed, {});
  return { t, workspaceId, asUser };
}

function contactsOf(t: TestConvex, workspaceId: Id<"workspaces">) {
  return t.run((ctx) =>
    ctx.db
      .query("contacts")
      .withIndex("by_workspace_last_message", (q) => q.eq("workspaceId", workspaceId))
      .collect(),
  );
}

function allRows(t: TestConvex) {
  return t.run(async (ctx) => ({
    numbers: await ctx.db.query("numbers").collect(),
    contacts: await ctx.db.query("contacts").collect(),
    messages: await ctx.db.query("messages").collect(),
    notes: await ctx.db.query("notes").collect(),
    drafts: await ctx.db.query("drafts").collect(),
    activities: await ctx.db.query("activities").collect(),
    events: await ctx.db.query("events").collect(),
  }));
}

describe("demo.seed", () => {
  it("seed creates the demo pipeline", async () => {
    const { t, workspaceId } = await seeded();
    const now = Date.now();
    const contacts = await contactsOf(t, workspaceId);
    const rows = await allRows(t);

    expect(rows.numbers).toHaveLength(1);
    expect(rows.numbers[0]).toMatchObject({
      isDemo: true,
      phoneNumber: "+15550100000",
      displayName: "Demo Sales",
    });
    expect(rows.numbers[0].poolNumberId).toMatch(/^pn_demo_[0-9a-z]{6}$/);

    const perStage = (stage: Doc<"contacts">["stage"]) =>
      contacts.filter((c) => c.stage === stage).length;
    expect(contacts).toHaveLength(12);
    expect([perStage("lead"), perStage("qualified"), perStage("customer"), perStage("lost")]).toEqual([
      5, 3, 2, 2,
    ]);

    const waiting = contacts.filter((c) => {
      const age = now - (c.lastInboundAt ?? 0);
      return c.lastDirection === "in" && age >= 10 * 60_000 && age <= 6 * 3_600_000;
    });
    expect(waiting.length).toBeGreaterThanOrEqual(4);
    expect(contacts.some((c) => c.tags.length > 0)).toBe(true);

    const withInbound = contacts.filter((c) => c.lastInboundAt !== undefined);
    expect(withInbound.filter((c) => !windowState(c, now).open)).toHaveLength(1);

    expect(contacts.filter((c) => c.userId && !c.waId)).toHaveLength(1);
    expect(contacts.every((c) => !c.waId || /^1555010\d{4}$/.test(c.waId))).toBe(true);

    expect(rows.notes).toHaveLength(4);
    const echoed = new Set(rows.messages.filter((m) => m.source === "phone").map((m) => m.contactId));
    expect(echoed.size).toBe(3);
    expect(rows.events.every((e) => e.webhookId.startsWith("demo_pn_demo_"))).toBe(true);
    expect(rows.activities.some((a) => a.kind === "stage_changed" && a.actor === "you")).toBe(true);
  });

  it("seed leaves one pending draft from Claude on a waiting contact", async () => {
    const { t } = await seeded();
    const { drafts, contacts } = await allRows(t);
    const now = Date.now();

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "pending", clientName: "Claude" });
    const contact = contacts.find((c) => c._id === drafts[0].contactId)!;
    expect(contact.lastDirection).toBe("in");
    expect(windowState(contact, now).open).toBe(true);
  });

  it("seed twice is refused", async () => {
    const { t, asUser } = await seeded();
    await expect(asUser.mutation(api.demo.seed, {})).rejects.toThrow("Demo data is already loaded");
    expect((await allRows(t)).contacts).toHaveLength(12);
  });

  it("seed requires a signed-in user", async () => {
    const t = makeT();
    await expect(t.mutation(api.demo.seed, {})).rejects.toThrow("Not signed in");
  });
});

describe("demo.reset", () => {
  it("reset removes only demo data", async () => {
    const { t, workspaceId, asUser } = await seeded();
    const numberId = await seedNumber(t, workspaceId, { poolNumberId: "pn_real" });
    const contactId = await seedContact(t, workspaceId, numberId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        workspaceId,
        contactId,
        numberId,
        direction: "in",
        source: "contact",
        type: "text",
        text: "Hello",
        status: "delivered",
        sentAt: 1,
      });
      await ctx.db.insert("events", {
        webhookId: "real_1",
        kind: "messages",
        poolNumberId: "pn_real",
        payload: {},
        state: "processed",
        receivedAt: 1,
      });
    });

    await asUser.mutation(api.demo.reset, {});

    const rows = await allRows(t);
    expect(rows.numbers.map((n) => n.poolNumberId)).toEqual(["pn_real"]);
    expect(rows.contacts.map((c) => c._id)).toEqual([contactId]);
    expect(rows.messages).toHaveLength(1);
    expect(rows.notes).toHaveLength(0);
    expect(rows.drafts).toHaveLength(0);
    expect(rows.activities).toHaveLength(0);
    expect(rows.events.map((e) => e.webhookId)).toEqual(["real_1"]);
  });

  it("reset leaves another workspace's demo data alone", async () => {
    const { t, asUser } = await seeded();
    const other = await seedUser(t, "user_2");
    await asUser.mutation(api.demo.reset, {});
    await other.asUser.mutation(api.demo.seed, {});

    await asUser.mutation(api.demo.reset, {});

    const rows = await allRows(t);
    expect(rows.numbers).toHaveLength(1);
    expect(rows.numbers[0].workspaceId).toBe(other.workspaceId);
    expect(rows.contacts).toHaveLength(12);
  });

  it("seed works again after a reset", async () => {
    const { t, asUser } = await seeded();
    await asUser.mutation(api.demo.reset, {});
    await asUser.mutation(api.demo.seed, {});
    expect((await allRows(t)).contacts).toHaveLength(12);
  });
});

describe("demo conversations", () => {
  it("replying to a demo contact is sent without fetch", async () => {
    vi.stubEnv("PIPES_API_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { t, asUser } = await seeded();
    const { contacts } = await allRows(t);
    const waiting = contacts.find((c) => c.lastDirection === "in" && windowState(c, Date.now()).open)!;

    const result = await asUser.action(api.sending.send, { contactId: waiting._id, text: "On it!" });

    expect(result.status).toBe("sent");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
