import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { closeConversation } from "./conversations";
import { DEFAULT_METHODOLOGY, type Step } from "./lib/methodology";
import { makeT } from "../tests/helpers";

const T0 = 1_700_000_000_000;
const WA_ID = "5511999990000";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 3_600_000);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seed(overrides: { lastActivityAt?: number; analysis?: object } = {}) {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId: "user_a",
      name: "Acme",
      inactivityMinutes: 120,
      methodology: DEFAULT_METHODOLOGY,
    });
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: "pool_1",
      phoneNumber: "+15550000001",
      displayName: "Support",
      connectedAt: 0,
    });
    const contactId = await ctx.db.insert("contacts", { numberId, waId: WA_ID });
    const conversationId = await ctx.db.insert("conversations", {
      workspaceId,
      numberId,
      contactId,
      status: "open",
      initiatedBy: "customer",
      openedAt: T0,
      lastActivityAt: overrides.lastActivityAt ?? T0 + 60_000,
      lastTurn: "business",
    });
    await ctx.db.insert("messages", {
      conversationId,
      wamid: "wamid.c1",
      direction: "inbound",
      source: "customer",
      type: "text",
      text: "Hi",
      sentAt: T0,
    });
    await ctx.db.insert("messages", {
      conversationId,
      wamid: "wamid.p1",
      direction: "outbound",
      source: "phone",
      type: "text",
      text: "Hello",
      sentAt: T0 + 60_000,
    });
    return { workspaceId, numberId, contactId, conversationId };
  });
  return { t, ...ids };
}

const scheduled = (t: ReturnType<typeof makeT>) =>
  t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

describe("closeConversation", () => {
  it("closes and schedules analysis", async () => {
    const { t, conversationId } = await seed();
    await t.run((ctx) => closeConversation(ctx, conversationId, T0 + 3_600_000));

    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation?.status).toBe("closed");
    expect(conversation?.closedAt).toBe(T0 + 3_600_000);
    expect(conversation?.metrics?.firstResponseSeconds).toBe(60);
    expect(conversation?.analysis?.state).toBe("pending");
    expect(conversation?.analysis?.methodology).toEqual(DEFAULT_METHODOLOGY);

    const jobs = await scheduled(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("analysis:analyzeConversation");
  });

  it("orphan statuses become api messages", async () => {
    const { t, numberId, conversationId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("statuses", {
        numberId,
        wamid: "wamid.X",
        status: "sent",
        timestamp: T0 + 30_000,
        recipient: WA_ID,
      });
      await ctx.db.insert("statuses", {
        numberId,
        wamid: "wamid.X",
        status: "delivered",
        timestamp: T0 + 35_000,
        recipient: WA_ID,
      });
      await ctx.db.insert("statuses", {
        numberId,
        wamid: "wamid.other",
        status: "sent",
        timestamp: T0 + 40_000,
        recipient: "5511888880000",
      });
    });

    await t.run((ctx) => closeConversation(ctx, conversationId, T0 + 3_600_000));

    const { messages, statuses, conversation } = await t.run(async (ctx) => ({
      messages: await ctx.db
        .query("messages")
        .withIndex("by_wamid", (q) => q.eq("wamid", "wamid.X"))
        .collect(),
      statuses: await ctx.db.query("statuses").collect(),
      conversation: await ctx.db.get(conversationId),
    }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      conversationId,
      source: "api",
      direction: "outbound",
      type: "text",
      sentAt: T0 + 30_000,
      deliveredAt: T0 + 35_000,
    });
    expect(messages[0].readAt).toBeUndefined();
    expect(statuses.map((s) => s.wamid)).toEqual(["wamid.other"]);
    expect(conversation?.metrics?.counts.api).toBe(1);
  });

  it("is a no-op for a closed conversation", async () => {
    const { t, conversationId } = await seed();
    await t.run((ctx) => closeConversation(ctx, conversationId, T0 + 3_600_000));
    await t.run((ctx) => closeConversation(ctx, conversationId, T0 + 7_200_000));
    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation?.closedAt).toBe(T0 + 3_600_000);
    expect(await scheduled(t)).toHaveLength(1);
  });
});

describe("closeIfIdle", () => {
  it("skips after new activity", async () => {
    const { t, conversationId } = await seed({ lastActivityAt: Date.now() });
    await t.mutation(internal.conversations.closeIfIdle, { conversationId });
    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation?.status).toBe("open");
  });

  it("closes when idle", async () => {
    const { t, conversationId } = await seed({ lastActivityAt: Date.now() - 121 * 60_000 });
    await t.mutation(internal.conversations.closeIfIdle, { conversationId });
    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation?.status).toBe("closed");
  });
});

describe("retryAnalysis and reanalyze", () => {
  const oldMethodology: Step[] = [{ id: "old", name: "Old step", description: "" }];

  async function seedClosed(state: "failed" | "done") {
    const s = await seed();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.conversationId, {
        status: "closed",
        closedAt: T0,
        analysis: { state, methodology: oldMethodology, requestedAt: 1, reason: "boom" },
      });
    });
    return s;
  }

  it("retryAnalysis only when failed", async () => {
    const failed = await seedClosed("failed");
    const asOwner = failed.t.withIdentity({ subject: "user_a" });
    await asOwner.mutation(api.conversations.retryAnalysis, {
      conversationId: failed.conversationId,
    });
    const retried = await failed.t.run((ctx) => ctx.db.get(failed.conversationId));
    expect(retried?.analysis?.state).toBe("pending");
    expect(retried?.analysis?.methodology).toEqual(oldMethodology);
    expect(retried?.analysis?.requestedAt).toBeGreaterThanOrEqual(T0);
    expect(await scheduled(failed.t)).toHaveLength(1);

    const done = await seedClosed("done");
    const result = await done.t
      .withIdentity({ subject: "user_a" })
      .mutation(api.conversations.retryAnalysis, { conversationId: done.conversationId });
    expect(result).toBeNull();
    const untouched = await done.t.run((ctx) => ctx.db.get(done.conversationId));
    expect(untouched?.analysis?.state).toBe("done");
    expect(await scheduled(done.t)).toHaveLength(0);
  });

  it("reanalyze uses current methodology", async () => {
    const { t, workspaceId, conversationId } = await seedClosed("done");
    const current: Step[] = [{ id: "new", name: "New step", description: "Do the new thing" }];
    await t.run((ctx) => ctx.db.patch(workspaceId, { methodology: current }));

    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.conversations.reanalyze, { conversationId });
    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation?.analysis?.state).toBe("pending");
    expect(conversation?.analysis?.methodology).toEqual(current);
    expect(await scheduled(t)).toHaveLength(1);

    await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        ownerId: "user_b",
        name: "Other",
        inactivityMinutes: 120,
        methodology: DEFAULT_METHODOLOGY,
      }),
    );
    await expect(
      t
        .withIdentity({ subject: "user_b" })
        .mutation(api.conversations.reanalyze, { conversationId }),
    ).rejects.toThrow("Not found");
  });

  it("reanalyze is a no-op while the conversation is open", async () => {
    const { t, conversationId } = await seed();
    const result = await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.conversations.reanalyze, { conversationId });
    expect(result).toBeNull();
    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation?.analysis).toBeUndefined();
  });
});

