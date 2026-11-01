import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeT } from "../tests/helpers";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getModel } from "./lib/model";

vi.mock("./lib/model", () => ({ getModel: vi.fn() }));

const NOW = 1_800_000_000_000;

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

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function workspaceFor(t: T, ownerId: string, fields: { instructions?: string; faq?: string } = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerId,
      name: "Acme",
      instructions: fields.instructions ?? "",
      faq: fields.faq ?? "",
      idleMinutes: 30,
    }),
  );
}

async function setup(fields: { instructions?: string; faq?: string } = {}) {
  const t = makeT();
  const workspaceId = await workspaceFor(t, "user_a", fields);
  return { t, workspaceId, user: t.withIdentity({ subject: "user_a" }) };
}

const all = <K extends "conversations" | "messages" | "requests" | "aiRuns" | "numbers" | "events">(
  t: T,
  table: K,
) => t.run((ctx) => ctx.db.query(table).collect());

const jobs = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
const pendingJobs = async (t: T) =>
  (await jobs(t)).filter((j) => j.state.kind === "pending" || j.state.kind === "inProgress");

async function demoConversations(t: T) {
  const rows = await all(t, "conversations");
  return Object.fromEntries(rows.map((c) => [c.name ?? "", c])) as Record<string, Doc<"conversations">>;
}

describe("demo.seed", () => {
  it("seed covers every state", async () => {
    const { t, user } = await setup();
    await user.mutation(api.demo.seed, {});

    const conversations = await demoConversations(t);
    expect(conversations.Maya).toMatchObject({ mode: "ai", lastFrom: "ai" });
    expect(conversations.Leo).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_request",
      handoffSummary: "Wants to change the address of order #1042",
    });
    expect(conversations.Sam).toMatchObject({ mode: "waiting_human", handoffReason: "media" });
    expect(conversations.Ana).toMatchObject({ mode: "human", handoffReason: "phone_reply" });
    expect(conversations.Ana.resumeAt).toBe(NOW + 20 * 60_000);

    const modes = Object.values(conversations).map((c) => c.mode);
    expect(modes.filter((m) => m === "ai")).toHaveLength(1);
    expect(modes.filter((m) => m === "waiting_human")).toHaveLength(2);
    expect(modes.filter((m) => m === "human")).toHaveLength(1);

    const numbers = await all(t, "numbers");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ isDemo: true, aiEnabled: true, displayName: "Demo Support" });
    expect(numbers[0].poolNumberId).toMatch(/^pn_demo_/);

    const requests = await all(t, "requests");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      status: "open",
      conversationId: conversations.Maya._id,
      summary: "Order: 2 sourdough loaves for Saturday",
    });

    const runs = await all(t, "aiRuns");
    expect(runs.map((r) => r.outcome).sort()).toEqual(["handed_off", "sent"]);
    const handedOff = runs.find((r) => r.outcome === "handed_off")!;
    expect(handedOff.toolCalls.map((c) => c.name)).toEqual(["request_human"]);

    const messages = await all(t, "messages");
    expect(messages.some((m) => m.conversationId === conversations.Maya._id && m.source === "ai" && m.status === "sent")).toBe(true);
    expect(messages.some((m) => m.conversationId === conversations.Ana._id && m.source === "phone")).toBe(true);
    expect(messages.some((m) => m.conversationId === conversations.Sam._id && m.type === "image")).toBe(true);

    expect(await pendingJobs(t)).toEqual([]);
    expect(Object.values(conversations).every((c) => c.pendingReplyJobId === undefined)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fills empty instructions and FAQ but keeps existing ones", async () => {
    const empty = await setup();
    await empty.user.mutation(api.demo.seed, {});
    const [filled] = await empty.t.run((ctx) => ctx.db.query("workspaces").collect());
    expect(filled.instructions).toContain("bakery");
    expect(filled.faq).toContain("Sourdough loaf: $7");

    const custom = await setup({ instructions: "Mine", faq: "My FAQ" });
    await custom.user.mutation(api.demo.seed, {});
    const [kept] = await custom.t.run((ctx) => ctx.db.query("workspaces").collect());
    expect(kept.instructions).toBe("Mine");
    expect(kept.faq).toBe("My FAQ");
  });

  it("seed twice is refused", async () => {
    const { t, user } = await setup();
    await user.mutation(api.demo.seed, {});
    await expect(user.mutation(api.demo.seed, {})).rejects.toThrow("Demo data is already loaded");
    expect(await all(t, "numbers")).toHaveLength(1);
  });
});

describe("demo.reset", () => {
  it("reset removes only demo data", async () => {
    const { t, workspaceId, user } = await setup();
    // A real number with its own conversation, message, request and run.
    const keep = await t.run(async (ctx) => {
      const numberId = await ctx.db.insert("numbers", {
        workspaceId,
        poolNumberId: "pn_real",
        phoneNumber: "+15550009999",
        displayName: "Real",
        connectedAt: NOW,
        aiEnabled: true,
      });
      const conversationId = await ctx.db.insert("conversations", {
        workspaceId,
        numberId,
        waId: "16505550000",
        name: "Real customer",
        mode: "ai",
        modeChangedAt: NOW,
        aiTurn: 0,
        lastMessageAt: NOW,
        lastFrom: "customer",
        lastPreview: "hi",
        aiReplies: { windowStart: 0, count: 0 },
      });
      await ctx.db.insert("messages", {
        workspaceId,
        conversationId,
        numberId,
        direction: "in",
        source: "customer",
        type: "text",
        text: "hi",
        status: "delivered",
        sentAt: NOW,
      });
      await ctx.db.insert("requests", {
        workspaceId,
        conversationId,
        summary: "real",
        details: "",
        status: "open",
        createdAt: NOW,
      });
      await ctx.db.insert("aiRuns", {
        workspaceId,
        conversationId,
        turn: 1,
        attempt: 1,
        outcome: "sent",
        toolCalls: [],
        model: "x",
        startedAt: NOW,
        finishedAt: NOW,
      });
      await ctx.db.insert("events", {
        webhookId: "wh_real",
        kind: "messages",
        poolNumberId: "pn_real",
        payload: {},
        state: "processed",
        receivedAt: NOW,
      });
      return conversationId;
    });
    const before = {
      messages: (await all(t, "messages")).length,
      requests: (await all(t, "requests")).length,
      runs: (await all(t, "aiRuns")).length,
    };

    await user.mutation(api.demo.seed, {});
    // A simulated message leaves a reply job pending on a demo conversation.
    const created = await user.mutation(api.demo.newConversation, {});
    const withJob = (await all(t, "conversations")).find((c) => c._id === created)!;
    expect(withJob.pendingReplyJobId).toBeDefined();
    const jobId = withJob.pendingReplyJobId!;

    await user.mutation(api.demo.reset, {});

    expect((await t.run((ctx) => ctx.db.system.get(jobId)))?.state.kind).toBe("canceled");
    expect(await all(t, "numbers")).toHaveLength(1);
    const conversations = await all(t, "conversations");
    expect(conversations.map((c) => c._id)).toEqual([keep]);
    expect(await all(t, "messages")).toHaveLength(before.messages);
    expect(await all(t, "requests")).toHaveLength(before.requests);
    expect(await all(t, "aiRuns")).toHaveLength(before.runs);
    const events = await all(t, "events");
    expect(events.map((e) => e.webhookId)).toEqual(["wh_real"]);
    expect((await t.run((ctx) => ctx.db.get(workspaceId)))?.instructions).toContain("bakery");

    await drain(t);
    expect(await all(t, "messages")).toHaveLength(before.messages);

    // The demo can be loaded again.
    await user.mutation(api.demo.seed, {});
    expect(await all(t, "numbers")).toHaveLength(2);
  });
});

describe("demo simulator", () => {
  async function seeded() {
    const ctx = await setup();
    await ctx.user.mutation(api.demo.seed, {});
    const conversations = await demoConversations(ctx.t);
    return { ...ctx, conversations };
  }

  it("simulated message gets the demo reply", async () => {
    const { t, user, conversations } = await seeded();
    const id = conversations.Maya._id;
    await user.mutation(api.demo.simulateInbound, { conversationId: id, text: "  What time do you open?  " });
    await drain(t);

    const messages = (await all(t, "messages")).filter((m) => m.conversationId === id);
    const inbound = messages.find((m) => m.text === "What time do you open?");
    expect(inbound).toMatchObject({ source: "customer", direction: "in" });
    const replies = messages.filter((m) => m.source === "ai" && m.sentAt >= NOW);
    expect(replies).toHaveLength(1);
    expect(replies[0].status).toBe("delivered");
    expect(replies[0].wamid).toMatch(/^wamid\.demo_/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("simulated staff reply hands to staff", async () => {
    const { t, user, conversations } = await seeded();
    const id = conversations.Maya._id;
    await user.mutation(api.demo.simulateEcho, { conversationId: id, text: "Hi, it's Sam from the shop." });
    await drain(t);

    const conversation = (await all(t, "conversations")).find((c) => c._id === id)!;
    expect(conversation).toMatchObject({ mode: "human", handoffReason: "phone_reply", lastFrom: "phone" });
    const messages = (await all(t, "messages")).filter((m) => m.conversationId === id);
    expect(messages.some((m) => m.source === "phone" && m.text === "Hi, it's Sam from the shop.")).toBe(true);
    expect(messages.filter((m) => m.source === "ai" && m.sentAt >= NOW)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("simulating a real conversation is refused", async () => {
    const { t, workspaceId, user } = await setup();
    const id = await t.run(async (ctx) => {
      const numberId = await ctx.db.insert("numbers", {
        workspaceId,
        poolNumberId: "pn_real",
        phoneNumber: "+15550009999",
        displayName: "Real",
        connectedAt: NOW,
        aiEnabled: true,
      });
      return ctx.db.insert("conversations", {
        workspaceId,
        numberId,
        waId: "16505550000",
        mode: "ai",
        modeChangedAt: NOW,
        aiTurn: 0,
        lastMessageAt: NOW,
        lastFrom: "customer",
        lastPreview: "hi",
        aiReplies: { windowStart: 0, count: 0 },
      });
    });
    await expect(user.mutation(api.demo.simulateInbound, { conversationId: id, text: "hello" })).rejects.toThrow(
      "Only demo conversations can be simulated",
    );
    await expect(user.mutation(api.demo.simulateEcho, { conversationId: id, text: "hello" })).rejects.toThrow(
      "Only demo conversations can be simulated",
    );
    expect(await all(t, "messages")).toHaveLength(0);
  });

  it("rejects bad text and other workspaces", async () => {
    const { t, user, conversations } = await seeded();
    const id = conversations.Maya._id;
    await expect(user.mutation(api.demo.simulateInbound, { conversationId: id, text: "   " })).rejects.toThrow();
    await expect(
      user.mutation(api.demo.simulateInbound, { conversationId: id, text: "x".repeat(4097) }),
    ).rejects.toThrow();
    await user.mutation(api.demo.simulateEcho, { conversationId: id, text: "x".repeat(4096) });

    await workspaceFor(t, "user_b");
    const other = t.withIdentity({ subject: "user_b" });
    await expect(other.mutation(api.demo.simulateInbound, { conversationId: id, text: "hi" })).rejects.toThrow("Not found");
    await expect(other.mutation(api.demo.reset, {})).resolves.toBeDefined();
    expect(await all(t, "numbers")).toHaveLength(1);
  });

  it("new conversation gets a first message and a reply", async () => {
    const { t, user } = await seeded();
    const id = (await user.mutation(api.demo.newConversation, {})) as Id<"conversations">;
    const conversation = (await all(t, "conversations")).find((c) => c._id === id)!;
    expect(conversation.name).toBe("Chloe");
    expect(conversation.waId).toMatch(/^1555012\d{4}$/);
    const first = (await all(t, "messages")).filter((m) => m.conversationId === id);
    expect(first.map((m) => m.text)).toEqual(["Hi! Do you deliver on weekends?"]);

    await drain(t);
    const messages = (await all(t, "messages")).filter((m) => m.conversationId === id);
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.source === "ai")?.status).toBe("delivered");
    expect(fetchMock).not.toHaveBeenCalled();

    // The next name on the list is used next.
    const second = (await all(t, "conversations")).length;
    await user.mutation(api.demo.newConversation, {});
    const names = (await all(t, "conversations")).map((c) => c.name);
    expect(names).toHaveLength(second + 1);
    expect(new Set(names).size).toBe(names.length);
  });

  it("new conversation needs the demo data", async () => {
    const { user } = await setup();
    await expect(user.mutation(api.demo.newConversation, {})).rejects.toThrow("Load the demo data first");
  });
});
