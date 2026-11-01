import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeT } from "../tests/helpers";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const NOW = 1_800_000_000_000;

type T = ReturnType<typeof makeT>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedWorkspace(t: T, ownerId: string) {
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
      displayName: "Shop",
      connectedAt: NOW,
      aiEnabled: true,
    });
    return { workspaceId, numberId };
  });
}

let seq = 0;

function addConversation(
  t: T,
  seed: { workspaceId: Id<"workspaces">; numberId: Id<"numbers"> },
  name?: string,
) {
  return t.run((ctx) =>
    ctx.db.insert("conversations", {
      workspaceId: seed.workspaceId,
      numberId: seed.numberId,
      waId: `1650555${String(++seq).padStart(4, "0")}`,
      name,
      mode: "ai",
      modeChangedAt: NOW,
      aiTurn: 0,
      lastMessageAt: NOW,
      lastFrom: "customer",
      lastPreview: "hi",
      aiReplies: { windowStart: NOW, count: 0 },
    }),
  );
}

describe("requests", () => {
  it("requests list and mark done", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    const c1 = await addConversation(t, seed, "Sheena");
    const c2 = await addConversation(t, seed);
    const [r1, r2] = await t.run(async (ctx) => {
      const base = { workspaceId: seed.workspaceId, details: "d", status: "open" as const };
      const a = await ctx.db.insert("requests", { ...base, conversationId: c1, summary: "older", createdAt: NOW - 2000 });
      const b = await ctx.db.insert("requests", { ...base, conversationId: c2, summary: "newer", createdAt: NOW - 1000 });
      return [a, b];
    });
    const user = t.withIdentity({ subject: "user_a" });

    const open = await user.query(api.requests.list, { status: "open" });
    expect(open.map((r) => r.request._id)).toEqual([r2, r1]);
    expect(open[1]).toMatchObject({ conversationName: "Sheena" });
    expect(open[1].phone).toMatch(/^1650555/);
    expect(await user.query(api.requests.list, { status: "done" })).toEqual([]);

    await user.mutation(api.requests.markDone, { requestId: r1 });
    const done = await t.run((ctx) => ctx.db.get(r1));
    expect(done).toMatchObject({ status: "done" });
    expect(done!.doneAt).toBeGreaterThanOrEqual(NOW);

    vi.setSystemTime(NOW + 5000);
    await user.mutation(api.requests.markDone, { requestId: r1 });
    expect((await t.run((ctx) => ctx.db.get(r1)))!.doneAt).toBe(done!.doneAt);

    expect((await user.query(api.requests.list, { status: "open" })).map((r) => r.request._id)).toEqual([r2]);
    expect((await user.query(api.requests.list, { status: "done" })).map((r) => r.request._id)).toEqual([r1]);
  });
});


describe("requests authorization", () => {
  it("other workspace is not found", async () => {
    const t = makeT();
    const seed = await seedWorkspace(t, "user_a");
    await seedWorkspace(t, "user_b");
    const conversationId = await addConversation(t, seed);
    const requestId = await t.run((ctx) =>
      ctx.db.insert("requests", {
        workspaceId: seed.workspaceId,
        conversationId,
        summary: "s",
        details: "d",
        status: "open",
        createdAt: NOW,
      }),
    );
    const intruder = t.withIdentity({ subject: "user_b" });
    await expect(intruder.mutation(api.requests.markDone, { requestId })).rejects.toThrow("Not found");
    expect((await t.run((ctx) => ctx.db.get(requestId)))!.status).toBe("open");
    expect(await intruder.query(api.requests.list, { status: "open" })).toEqual([]);
  });
});
