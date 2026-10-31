import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import { MAX_CONVERSATIONS } from "./dashboard";
import type { Id } from "./_generated/dataModel";
import { makeT } from "../tests/helpers";

const DAY = 86_400_000;

type T = ReturnType<typeof makeT>;

async function seed(t: T, ownerId: string) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId,
      name: "Acme",
      inactivityMinutes: 120,
      methodology: [],
    });
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: `pool_${ownerId}`,
      phoneNumber: "+5511999990000",
      displayName: "Support",
      connectedAt: 1000,
    });
    const contactId = await ctx.db.insert("contacts", {
      numberId,
      waId: "5511988887777",
      name: "Ana",
    });
    return { workspaceId, numberId, contactId };
  });
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function addConversation(
  t: T,
  s: Seeded,
  fields: {
    numberId?: Id<"numbers">;
    status?: "open" | "closed";
    openedAt?: number;
    lastActivityAt?: number;
    lastTurn?: "customer" | "business";
    waitingSince?: number;
    closedAt?: number;
    answered?: boolean;
    firstResponseSeconds?: number;
    score?: number;
  } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      workspaceId: s.workspaceId,
      numberId: fields.numberId ?? s.numberId,
      contactId: s.contactId,
      status: fields.status ?? "closed",
      initiatedBy: "customer",
      openedAt: fields.openedAt ?? now,
      lastActivityAt: fields.lastActivityAt ?? now,
      lastTurn: fields.lastTurn ?? "business",
      ...(fields.waitingSince !== undefined ? { waitingSince: fields.waitingSince } : {}),
      ...(fields.closedAt !== undefined ? { closedAt: fields.closedAt } : {}),
      ...(fields.answered !== undefined
        ? {
            metrics: {
              ...(fields.firstResponseSeconds !== undefined
                ? { firstResponseSeconds: fields.firstResponseSeconds }
                : {}),
              unansweredTurns: 0,
              answered: fields.answered,
              durationSeconds: 60,
              counts: { customer: 1, phone: 1, api: 0 },
            },
          }
        : {}),
      ...(fields.score !== undefined
        ? {
            analysis: {
              state: "done" as const,
              methodology: [],
              requestedAt: now,
              score: fields.score,
            },
          }
        : {}),
    });
  });
}

describe("overview", () => {
  it("counts only closed conversations inside the window", async () => {
    const t = makeT();
    const s = await seed(t, "user_a");
    const now = Date.now();
    await addConversation(t, s, { closedAt: now - 2 * DAY, answered: true, firstResponseSeconds: 60 });
    await addConversation(t, s, { closedAt: now - 10 * DAY, answered: false });
    await addConversation(t, s, { status: "open" });

    const asA = t.withIdentity({ subject: "user_a" });
    const week = await asA.query(api.dashboard.overview, { days: 7 });
    expect(week.total).toBe(1);
    expect(week.answeredRate).toBe(1);
    expect(week.medianFirstResponseSeconds).toBe(60);

    const month = await asA.query(api.dashboard.overview, { days: 30 });
    expect(month.total).toBe(2);
    expect(month.answeredRate).toBe(0.5);
  });

  it("filters by number", async () => {
    const t = makeT();
    const s = await seed(t, "user_a");
    const otherNumberId = await t.run(async (ctx) =>
      ctx.db.insert("numbers", {
        workspaceId: s.workspaceId,
        poolNumberId: "pool_other",
        phoneNumber: "+5511999991111",
        displayName: "Sales",
        connectedAt: 2000,
      }),
    );
    const now = Date.now();
    await addConversation(t, s, { closedAt: now - DAY, score: 80 });
    await addConversation(t, s, { numberId: otherNumberId, closedAt: now - DAY, score: 40 });
    await addConversation(t, s, { numberId: otherNumberId, closedAt: now - DAY, score: 60 });

    const asA = t.withIdentity({ subject: "user_a" });
    expect((await asA.query(api.dashboard.overview, { days: 7 })).total).toBe(3);
    const first = await asA.query(api.dashboard.overview, { days: 7, numberId: s.numberId });
    expect(first.total).toBe(1);
    expect(first.avgScore).toBe(80);
    const other = await asA.query(api.dashboard.overview, { days: 7, numberId: otherNumberId });
    expect(other.total).toBe(2);
    expect(other.avgScore).toBe(50);
  });

  it("keeps the most recent conversations when over the cap", async () => {
    const t = makeT();
    const s = await seed(t, "user_a");
    const now = Date.now();
    await t.run(async (ctx) => {
      const base = {
        workspaceId: s.workspaceId,
        numberId: s.numberId,
        contactId: s.contactId,
        status: "closed" as const,
        initiatedBy: "customer" as const,
        openedAt: now - 5 * DAY,
        lastActivityAt: now - 5 * DAY,
        lastTurn: "business" as const,
      };
      const metrics = (answered: boolean) => ({
        unansweredTurns: 0,
        answered,
        durationSeconds: 60,
        counts: { customer: 1, phone: 1, api: 0 },
      });
      // The cap's worth of older unanswered conversations, then one newer answered one.
      for (let i = 0; i < MAX_CONVERSATIONS; i++) {
        await ctx.db.insert("conversations", {
          ...base,
          closedAt: now - 5 * DAY + i,
          metrics: metrics(false),
        });
      }
      await ctx.db.insert("conversations", {
        ...base,
        closedAt: now - 1000,
        metrics: metrics(true),
      });
    });

    const asA = t.withIdentity({ subject: "user_a" });
    for (const args of [{ days: 7 as const }, { days: 7 as const, numberId: s.numberId }]) {
      const result = await asA.query(api.dashboard.overview, args);
      expect(result.total).toBe(MAX_CONVERSATIONS);
      expect(result.answeredRate).toBe(1 / MAX_CONVERSATIONS);
    }
  });

  it("does not include other workspaces", async () => {
    const t = makeT();
    const a = await seed(t, "user_a");
    const b = await seed(t, "user_b");
    await addConversation(t, a, { closedAt: Date.now() - DAY });
    await addConversation(t, b, { closedAt: Date.now() - DAY });
    const result = await t.withIdentity({ subject: "user_a" }).query(api.dashboard.overview, { days: 7 });
    expect(result.total).toBe(1);
  });
});

describe("waiting", () => {
  it("returns open conversations waiting on the business, oldest first", async () => {
    const t = makeT();
    const s = await seed(t, "user_a");
    const now = Date.now();
    const newer = await addConversation(t, s, {
      status: "open",
      lastTurn: "customer",
      waitingSince: now - 1000,
    });
    const older = await addConversation(t, s, {
      status: "open",
      lastTurn: "customer",
      waitingSince: now - 5000,
    });
    await addConversation(t, s, { status: "open", lastTurn: "business" });
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        conversationId: older,
        wamid: "w1",
        direction: "inbound",
        source: "customer",
        type: "text",
        text: "first",
        sentAt: now - 6000,
      });
      await ctx.db.insert("messages", {
        conversationId: older,
        wamid: "w2",
        direction: "inbound",
        source: "customer",
        type: "text",
        text: "still there?",
        sentAt: now - 5000,
      });
    });

    const asA = t.withIdentity({ subject: "user_a" });
    const rows = await asA.query(api.dashboard.waiting, {});
    expect(rows.map((r) => r.conversationId)).toEqual([older, newer]);
    expect(rows[0]).toMatchObject({
      numberId: s.numberId,
      contactName: "Ana",
      contactId: "5511988887777",
      waitingSince: now - 5000,
      lastMessage: "still there?",
    });
    expect(rows[1].lastMessage).toBeUndefined();

    const byNumber = await asA.query(api.dashboard.waiting, { numberId: s.numberId });
    expect(byNumber).toHaveLength(2);
  });
});

describe("conversations", () => {
  it("orders by last activity, newest first, and maps analysis fields", async () => {
    const t = makeT();
    const s = await seed(t, "user_a");
    const now = Date.now();
    const old = await addConversation(t, s, { lastActivityAt: now - 3000 });
    const recent = await addConversation(t, s, { lastActivityAt: now - 1000, score: 75 });
    const middle = await addConversation(t, s, { lastActivityAt: now - 2000 });
    await addConversation(t, s, { status: "open", lastActivityAt: now });

    const rows = await t
      .withIdentity({ subject: "user_a" })
      .query(api.dashboard.conversations, { numberId: s.numberId, status: "closed" });
    expect(rows.map((r) => r._id)).toEqual([recent, middle, old]);
    expect(rows[0]).toMatchObject({
      status: "closed",
      contactName: "Ana",
      contactLabel: "5511988887777",
      analysisState: "done",
      score: 75,
    });
    expect(rows[1].analysisState).toBeUndefined();
  });
});

describe("conversation", () => {
  it("returns the conversation with contact, number and ordered messages", async () => {
    const t = makeT();
    const s = await seed(t, "user_a");
    const id = await addConversation(t, s);
    await t.run(async (ctx) => {
      for (const [wamid, sentAt] of [["w2", 2000], ["w1", 1000]] as const) {
        await ctx.db.insert("messages", {
          conversationId: id,
          wamid,
          direction: "inbound",
          source: "customer",
          type: "text",
          text: wamid,
          sentAt,
        });
      }
    });
    const result = await t.withIdentity({ subject: "user_a" }).query(api.dashboard.conversation, {
      conversationId: id,
    });
    expect(result.conversation._id).toBe(id);
    expect(result.contact?.name).toBe("Ana");
    expect(result.number.displayName).toBe("Support");
    expect(result.messages.map((m) => m.wamid)).toEqual(["w1", "w2"]);
  });
});

describe("other workspace is not found", () => {
  it("rejects conversation and number-scoped queries", async () => {
    const t = makeT();
    const a = await seed(t, "user_a");
    await seed(t, "user_b");
    const id = await addConversation(t, a);
    const asB = t.withIdentity({ subject: "user_b" });

    await expect(asB.query(api.dashboard.conversation, { conversationId: id })).rejects.toThrow("Not found");
    await expect(asB.query(api.dashboard.overview, { days: 7, numberId: a.numberId })).rejects.toThrow("Not found");
    await expect(asB.query(api.dashboard.waiting, { numberId: a.numberId })).rejects.toThrow("Not found");
    await expect(
      asB.query(api.dashboard.conversations, { numberId: a.numberId, status: "open" }),
    ).rejects.toThrow("Not found");
  });
});
