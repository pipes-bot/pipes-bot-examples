import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeT } from "../tests/helpers";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getModel } from "./lib/model";

vi.mock("./lib/model", () => ({ getModel: vi.fn() }));

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

type T = ReturnType<typeof makeT>;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(getModel).mockReset();
  vi.mocked(getModel).mockReturnValue(null);
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function seedWorkspace(t: T, ownerId: string, opts: { aiEnabled?: boolean; isDemo?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId,
      name: "Acme",
      instructions: "",
      faq: "",
      idleMinutes: 30,
    });
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: `pn_${ownerId}`,
      phoneNumber: "+15550001111",
      displayName: `Shop ${ownerId}`,
      connectedAt: NOW,
      aiEnabled: opts.aiEnabled ?? true,
      ...(opts.isDemo ? { isDemo: true } : {}),
    });
    return { workspaceId, numberId };
  });
}

let seq = 0;

function addConversation(
  t: T,
  seed: { workspaceId: Id<"workspaces">; numberId: Id<"numbers"> },
  patch: Partial<Doc<"conversations">> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("conversations", {
      workspaceId: seed.workspaceId,
      numberId: seed.numberId,
      waId: `1650555${String(++seq).padStart(4, "0")}`,
      mode: "ai",
      modeChangedAt: NOW,
      aiTurn: 0,
      lastInboundAt: NOW,
      lastMessageAt: NOW,
      lastFrom: "customer",
      lastPreview: "hi",
      aiReplies: { windowStart: NOW, count: 0 },
      ...patch,
    }),
  );
}

function addMessage(t: T, conversationId: Id<"conversations">, sentAt: number, text: string) {
  return t.run(async (ctx) => {
    const c = (await ctx.db.get(conversationId))!;
    return ctx.db.insert("messages", {
      workspaceId: c.workspaceId,
      conversationId,
      numberId: c.numberId,
      direction: "in",
      source: "customer",
      type: "text",
      text,
      status: "delivered",
      sentAt,
    });
  });
}

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

describe("conversations.list", () => {
  it("tabs filter and order", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a", { isDemo: true });
    const w1 = await addConversation(t, seed, { mode: "waiting_human", modeChangedAt: NOW - 1000, name: "B" });
    const w2 = await addConversation(t, seed, { mode: "waiting_human", modeChangedAt: NOW - 3000, name: "A" });
    const w3 = await addConversation(t, seed, { mode: "waiting_human", modeChangedAt: NOW - 2000, name: "C" });
    const h1 = await addConversation(t, seed, { mode: "human", modeChangedAt: NOW - 500 });
    const h2 = await addConversation(t, seed, { mode: "human", modeChangedAt: NOW - 100 });
    const a1 = await addConversation(t, seed, { mode: "ai", modeChangedAt: NOW - 700, lastMessageAt: NOW - 700 });
    const other = await seedWorkspace(t, "user_b");
    await addConversation(t, other, { mode: "waiting_human" });

    const user = t.withIdentity({ subject: "user_a" });
    const ids = async (tab: "needs_human" | "with_staff" | "ai" | "all") =>
      (await user.query(api.conversations.list, { tab })).map((r) => r.id);

    expect(await ids("needs_human")).toEqual([w2, w3, w1]);
    expect(await ids("with_staff")).toEqual([h2, h1]);
    expect(await ids("ai")).toEqual([a1]);
    const everything = await ids("all");
    expect(everything).toHaveLength(6);
    expect(new Set(everything)).toEqual(new Set([w1, w2, w3, h1, h2, a1]));

    const [first] = await user.query(api.conversations.list, { tab: "needs_human" });
    expect(first).toMatchObject({
      id: w2,
      name: "A",
      mode: "waiting_human",
      numberName: "Shop user_a",
      aiEnabled: true,
      isDemo: true,
      lastPreview: "hi",
      lastFrom: "customer",
      window: { open: true, closesAt: NOW + 24 * HOUR },
    });
    expect(first.phone).toMatch(/^1650555/);
  });

  it("all is newest message first", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    const old = await addConversation(t, seed, { lastMessageAt: NOW - 5000 });
    const recent = await addConversation(t, seed, { lastMessageAt: NOW - 10 });
    const user = t.withIdentity({ subject: "user_a" });
    const rows = await user.query(api.conversations.list, { tab: "all" });
    expect(rows.map((r) => r.id)).toEqual([recent, old]);
    expect(rows[0].isDemo).toBe(false);
  });
});

describe("a number moved to another workspace", () => {
  it("shows the old workspace's conversations with the AI off", async () => {
    const t = makeT();
    const a = await seedWorkspace(t, "user_a");
    const b = await seedWorkspace(t, "user_b");
    const id = await addConversation(t, a);
    // Re-onboarded into workspace b, where the AI is on.
    await t.run((ctx) => ctx.db.patch(a.numberId, { workspaceId: b.workspaceId, aiEnabled: true }));

    const user = t.withIdentity({ subject: "user_a" });
    const [row] = await user.query(api.conversations.list, { tab: "all" });
    expect(row).toMatchObject({ id, aiEnabled: false });
    const { conversation } = await user.query(api.conversations.get, { conversationId: id });
    expect(conversation.aiEnabled).toBe(false);
  });
});

describe("conversations.get", () => {
  it("get returns messages in order", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    const id = await addConversation(t, seed, { lastError: "boom", userId: "US.1" });
    await addMessage(t, id, NOW - 300, "third");
    await addMessage(t, id, NOW - 100, "fifth");
    await addMessage(t, id, NOW - 200, "fourth");
    await addMessage(t, id, NOW - 400, "second");
    await addMessage(t, id, NOW - 500, "first");

    const user = t.withIdentity({ subject: "user_a" });
    const result = await user.query(api.conversations.get, { conversationId: id });
    expect(result.messages.map((m) => m.text)).toEqual(["first", "second", "third", "fourth", "fifth"]);
    expect(result.conversation).toMatchObject({ id, lastError: "boom", userId: "US.1", numberName: "Shop user_a" });
  });

  it("returns only the last 100 messages", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    const id = await addConversation(t, seed);
    for (let i = 0; i < 105; i++) await addMessage(t, id, NOW - 1000 + i, `m${i}`);
    const user = t.withIdentity({ subject: "user_a" });
    const { messages } = await user.query(api.conversations.get, { conversationId: id });
    expect(messages).toHaveLength(100);
    expect(messages[0].text).toBe("m5");
    expect(messages[99].text).toBe("m104");
  });
});

describe("conversations.aiRuns", () => {
  it("aiRuns newest first, max 50", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    const id = await addConversation(t, seed);
    await t.run(async (ctx) => {
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("aiRuns", {
          workspaceId: seed.workspaceId,
          conversationId: id,
          turn: i,
          attempt: 1,
          outcome: "sent",
          toolCalls: [],
          model: "demo",
          startedAt: NOW + i,
          finishedAt: NOW + i,
        });
      }
    });
    const user = t.withIdentity({ subject: "user_a" });
    const runs = await user.query(api.conversations.aiRuns, { conversationId: id });
    expect(runs).toHaveLength(50);
    expect(runs[0].turn).toBe(54);
    expect(runs[49].turn).toBe(5);
  });
});

describe("take over and hand back", () => {
  it("take over then hand back schedules a reply", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    const id = await addConversation(t, seed, { lastFrom: "customer" });
    const user = t.withIdentity({ subject: "user_a" });

    await user.mutation(api.conversations.takeOver, { conversationId: id });
    let c = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(c).toMatchObject({ mode: "human", handoffReason: "manual" });
    expect(c.pendingReplyJobId).toBeUndefined();

    await user.mutation(api.conversations.handBack, { conversationId: id });
    c = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(c.mode).toBe("ai");
    expect(c.pendingReplyJobId).toBeDefined();
    await drain(t);
  });

  it("hand back in ai mode is a no-op", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    const id = await addConversation(t, seed);
    const user = t.withIdentity({ subject: "user_a" });
    const before = await t.run((ctx) => ctx.db.get(id));
    await user.mutation(api.conversations.handBack, { conversationId: id });
    expect(await t.run((ctx) => ctx.db.get(id))).toEqual(before);
  });

  it("hand back with a closed window drops the reply", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    const id = await addConversation(t, seed, { lastInboundAt: NOW - 25 * HOUR, lastFrom: "customer" });
    const user = t.withIdentity({ subject: "user_a" });

    await user.mutation(api.conversations.takeOver, { conversationId: id });
    await user.mutation(api.conversations.handBack, { conversationId: id });
    await drain(t);

    const runs = await t.run((ctx) => ctx.db.query("aiRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ conversationId: id, outcome: "dropped", dropReason: "window_closed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("authorization", () => {
  it("other workspace is not found", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    await seedWorkspace(t, "user_b");
    const id = await addConversation(t, seed, { mode: "human" });
    const intruder = t.withIdentity({ subject: "user_b" });

    await expect(intruder.query(api.conversations.get, { conversationId: id })).rejects.toThrow("Not found");
    await expect(intruder.query(api.conversations.aiRuns, { conversationId: id })).rejects.toThrow("Not found");
    await expect(intruder.mutation(api.conversations.takeOver, { conversationId: id })).rejects.toThrow("Not found");
    await expect(intruder.mutation(api.conversations.handBack, { conversationId: id })).rejects.toThrow("Not found");
  });
});
