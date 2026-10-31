import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeT } from "../tests/helpers";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_METHODOLOGY } from "./lib/methodology";

const NOW = 1_800_000_000_000;
const EMAIL = "demo@example.com";

type T = ReturnType<typeof makeT>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Creates a Better Auth user through the component, plus its workspace. */
async function setup(t: T) {
  return t.run(async (ctx) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Demo",
          email: EMAIL,
          emailVerified: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId: user._id,
      name: "Demo workspace",
      inactivityMinutes: 120,
      methodology: DEFAULT_METHODOLOGY,
    });
    return { workspaceId };
  });
}

const seed = (t: T) => t.mutation(internal.demo.seed, { email: EMAIL });

/** The closed conversation of the demo customer ending in `digit`. */
async function conversationOf(t: T, digit: number) {
  return t.run(async (ctx) => {
    const contact = (await ctx.db.query("contacts").collect()).find(
      (c) => c.waId === `1555010000${digit}`,
    );
    const conversation = (await ctx.db.query("conversations").collect()).find(
      (c) => c.contactId === contact?._id,
    );
    return conversation!;
  });
}

describe("demo.seed", () => {
  it("creates four closed conversations pending analysis", async () => {
    const t = makeT();
    const { workspaceId } = await setup(t);

    const result = await seed(t);

    expect(result.conversations).toBe(4);
    expect(result.poolNumberId).toMatch(/^pn_demo_[a-z0-9]{6}$/);
    const { number, conversations } = await t.run(async (ctx) => ({
      number: await ctx.db.query("numbers").first(),
      conversations: await ctx.db.query("conversations").collect(),
    }));
    expect(number).toMatchObject({
      workspaceId,
      poolNumberId: result.poolNumberId,
      displayName: "Demo Support",
      isDemo: true,
    });
    expect(conversations).toHaveLength(4);
    for (const conversation of conversations) {
      expect(conversation.status).toBe("closed");
      expect(conversation.analysis?.state).toBe("pending");
    }
  });

  it("answers the on-method conversation within a minute", async () => {
    const t = makeT();
    await setup(t);
    await seed(t);
    const conversation = await conversationOf(t, 1);
    expect(conversation.metrics?.firstResponseSeconds).toBeLessThanOrEqual(60);
    expect(conversation.metrics?.answered).toBe(true);
  });

  it("answers the slow conversation after 45 minutes", async () => {
    const t = makeT();
    await setup(t);
    await seed(t);
    const conversation = await conversationOf(t, 2);
    expect(conversation.metrics?.firstResponseSeconds).toBeGreaterThanOrEqual(2700);
  });

  it("leaves the third conversation unanswered", async () => {
    const t = makeT();
    await setup(t);
    await seed(t);
    const conversation = await conversationOf(t, 3);
    expect(conversation.metrics?.answered).toBe(false);
    expect(conversation.metrics?.counts.customer).toBe(2);
  });

  it("turns the API statuses of the fourth conversation into one api message", async () => {
    const t = makeT();
    await setup(t);
    await seed(t);
    const conversation = await conversationOf(t, 4);
    expect(conversation.metrics?.counts.api).toBe(1);
    expect(conversation.metrics?.counts.phone).toBeGreaterThanOrEqual(1);
  });

  it("rejects an email without a workspace", async () => {
    const t = makeT();
    await expect(seed(t)).rejects.toThrow("No workspace");
    await setup(t);
    await t.run(async (ctx) => {
      for (const workspace of await ctx.db.query("workspaces").collect()) await ctx.db.delete(workspace._id);
    });
    await expect(seed(t)).rejects.toThrow("No workspace for demo@example.com");
  });
});

describe("demo.reset", () => {
  it("removes the demo data and keeps other numbers", async () => {
    const t = makeT();
    const { workspaceId } = await setup(t);
    const realNumberId: Id<"numbers"> = await t.run((ctx) =>
      ctx.db.insert("numbers", {
        workspaceId,
        poolNumberId: "pn_real",
        phoneNumber: "+15559990000",
        displayName: "Real",
        connectedAt: NOW,
      }),
    );
    await seed(t);

    const { deleted } = await t.mutation(internal.demo.reset, { email: EMAIL });

    expect(deleted).toBeGreaterThan(0);
    const left = await t.run(async (ctx) => ({
      numbers: await ctx.db.query("numbers").collect(),
      conversations: await ctx.db.query("conversations").collect(),
      messages: await ctx.db.query("messages").collect(),
      contacts: await ctx.db.query("contacts").collect(),
      statuses: await ctx.db.query("statuses").collect(),
      events: await ctx.db.query("events").collect(),
    }));
    expect(left.numbers.map((n) => n._id)).toEqual([realNumberId]);
    expect(left.conversations).toHaveLength(0);
    expect(left.messages).toHaveLength(0);
    expect(left.contacts).toHaveLength(0);
    expect(left.statuses).toHaveLength(0);
    expect(left.events).toHaveLength(0);
  });

  it("cancels pending close jobs of open demo conversations", async () => {
    const t = makeT();
    await setup(t);
    const { poolNumberId } = await seed(t);
    // Reopen one conversation with a live close job, as if a customer wrote again.
    const jobId = await t.run(async (ctx) => {
      const conversation = (await ctx.db.query("conversations").first())!;
      const jobId = await ctx.scheduler.runAt(NOW + 3_600_000, internal.conversations.closeIfIdle, {
        conversationId: conversation._id,
      });
      await ctx.db.patch(conversation._id, { status: "open", closeJobId: jobId });
      return jobId;
    });

    await t.mutation(internal.demo.reset, { email: EMAIL });

    const job = await t.run((ctx) => ctx.db.system.get(jobId));
    expect(job?.state.kind).toBe("canceled");
    const events = await t.run((ctx) =>
      ctx.db
        .query("events")
        .collect()
        .then((rows) => rows.filter((e) => e.poolNumberId === poolNumberId)),
    );
    expect(events).toHaveLength(0);
  });

  it("is a no-op without demo numbers", async () => {
    const t = makeT();
    await setup(t);
    expect(await t.mutation(internal.demo.reset, { email: EMAIL })).toEqual({ deleted: 0 });
  });
});
