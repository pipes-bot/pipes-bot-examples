import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeT } from "../tests/helpers";
import type { Id } from "./_generated/dataModel";
import { applyEvent, stateOf } from "./handoff";

const NOW = 1_800_000_000_000;

type T = ReturnType<typeof makeT>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedConversation(t: T, mode: "ai" | "waiting_human" = "ai") {
  return t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId: "user_1",
      name: "Acme",
      instructions: "",
      faq: "",
      idleMinutes: 30,
    });
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: "pn_1",
      phoneNumber: "+15551234567",
      displayName: "Acme Support",
      connectedAt: NOW,
      aiEnabled: true,
    });
    return ctx.db.insert("conversations", {
      workspaceId,
      numberId,
      waId: "16505551234",
      mode,
      modeChangedAt: NOW,
      ...(mode === "waiting_human" ? { handoffReason: "media" as const } : {}),
      aiTurn: 0,
      lastInboundAt: NOW,
      lastMessageAt: NOW,
      lastFrom: "customer",
      lastPreview: "Hi",
      aiReplies: { windowStart: 0, count: 0 },
    });
  });
}

const event = (t: T, id: Id<"conversations">, e: Parameters<typeof applyEvent>[2], at = Date.now()) =>
  t.run(async (ctx) => {
    const conversation = (await ctx.db.get(id))!;
    return applyEvent(ctx, conversation, e, at);
  });

describe("applyEvent", () => {
  it("applyEvent tolerates a finished pending job", async () => {
    const t = makeT();
    const id = await seedConversation(t);

    const scheduled = await event(t, id, { kind: "customer_text", stale: false });
    const jobId = scheduled.pendingReplyJobId!;
    expect(jobId).toBeDefined();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const job = await t.run((ctx) => ctx.db.system.get(jobId));
    expect(job?.state.kind).toBe("success");

    const after = await event(t, id, { kind: "phone_echo" });

    expect(after).toMatchObject({ mode: "human", handoffReason: "phone_reply", aiTurn: 2 });
    expect(after.pendingReplyJobId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(id)))!.pendingReplyJobId).toBeUndefined();
    // The finished job is left as it was.
    expect((await t.run((ctx) => ctx.db.system.get(jobId)))?.state.kind).toBe("success");
  });

  it("a no-op event writes nothing and returns the same doc", async () => {
    const t = makeT();
    const id = await seedConversation(t, "waiting_human");

    const same = await t.run(async (ctx) => {
      const conversation = (await ctx.db.get(id))!;
      const result = await applyEvent(ctx, conversation, { kind: "customer_text", stale: false }, NOW + 1);
      return result === conversation;
    });

    expect(same).toBe(true);
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);
  });

  it("returning to ai removes the cleared fields", async () => {
    const t = makeT();
    const id = await seedConversation(t, "waiting_human");

    const after = await event(t, id, { kind: "hand_back" });

    const stored = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(stored).toEqual(after);
    expect("handoffReason" in stored).toBe(false);
    expect(stateOf(stored)).toMatchObject({ mode: "ai", aiTurn: 1, lastFrom: "customer" });
    // The last message is the customer's, so the AI answers right away.
    const [job] = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(job).toMatchObject({ _id: stored.pendingReplyJobId, scheduledTime: NOW, args: [{ conversationId: id, turn: 1, attempt: 1 }] });
  });
});
