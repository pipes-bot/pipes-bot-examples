import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import historyChunk from "../tests/fixtures/history-chunk.json";
import historyComplete from "../tests/fixtures/history-complete.json";
import historyDeclined from "../tests/fixtures/history-declined.json";
import historyMedia from "../tests/fixtures/history-media.json";
import numberOnboarded from "../tests/fixtures/number-onboarded.json";
import { makeT } from "../tests/helpers";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { flattenHistory, summarizeHistory } from "./lib/history";
import { DEFAULT_METHODOLOGY } from "./lib/methodology";
import { computeMetrics } from "./lib/metrics";

const NOW = 1_800_000_000_000;
const POOL = "pn_abc123";

type T = ReturnType<typeof makeT>;
type HistoryImport = NonNullable<Doc<"numbers">["historyImport"]>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const requested: HistoryImport = {
  state: "requested",
  progress: 0,
  chunks: 0,
  messages: 0,
  conversations: 0,
  updatedAt: 0,
};

async function seedWorkspace(t: T) {
  return t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerId: "owner_1",
      name: "Acme",
      inactivityMinutes: 120,
      methodology: DEFAULT_METHODOLOGY,
    }),
  );
}

async function seedNumber(t: T, historyImport: HistoryImport | null = requested) {
  const workspaceId = await seedWorkspace(t);
  const numberId = await t.run((ctx) =>
    ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: POOL,
      phoneNumber: "+15550001111",
      displayName: "Support",
      connectedAt: 0,
      ...(historyImport ? { historyImport } : {}),
    }),
  );
  return { workspaceId, numberId };
}

const getNumber = (t: T, id: Id<"numbers">) => t.run((ctx) => ctx.db.get(id));
const rows = (t: T) => t.run((ctx) => ctx.db.query("historyMessages").collect());
const events = (t: T) => t.run((ctx) => ctx.db.query("events").collect());
const jobs = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
const blobExists = (t: T, id: Id<"_storage">) =>
  t.run(async (ctx) => (await ctx.storage.get(id)) !== null);

/** Stores the payload as a blob when it has messages, then calls `history.receive` like the webhook does. */
async function receive(t: T, payload: any, webhookId: string) {
  const summary = summarizeHistory(payload);
  const storageId =
    summary.messageCount > 0
      ? await t.run((ctx) => ctx.storage.store(new Blob([JSON.stringify(payload)])))
      : undefined;
  const outcome = await t.mutation(internal.history.receive, {
    webhookId,
    poolNumberId: payload.pipes.poolNumberId,
    summary,
    storageId,
  });
  return { outcome, storageId };
}

const row = (wamid: string, sentAt: number) => ({
  threadId: "16505551234",
  wamid,
  source: "customer" as const,
  type: "text",
  text: "hi",
  sentAt,
});

function onboardingFor(workspaceId: Id<"workspaces">, importHistory: boolean): any {
  const onboarded = structuredClone(numberOnboarded) as any;
  onboarded.data.numberId = POOL;
  onboarded.data.metadata = { workspaceId };
  if (importHistory) onboarded.data.importHistory = true;
  return onboarded;
}

describe("history.receive", () => {
  it("parks the event for an unknown number and keeps the blob", async () => {
    const t = makeT();
    const { outcome, storageId } = await receive(t, historyChunk, "wh_1");
    expect(outcome).toBe("parked");
    const [event] = await events(t);
    expect(event).toMatchObject({
      webhookId: "wh_1",
      kind: "history",
      poolNumberId: POOL,
      state: "parked",
      storageId,
      receivedAt: NOW,
    });
    expect(event.payload).toMatchObject({
      field: "history",
      pipes: { poolNumberId: POOL },
      summary: { messageCount: 2, progress: 40 },
    });
    expect(event.payload.whatsapp).toBeUndefined();
    expect(await blobExists(t, storageId!)).toBe(true);
  });

  it("replays parked history on onboarding", async () => {
    const t = makeT();
    const workspaceId = await seedWorkspace(t);
    await receive(t, historyChunk, "wh_1");

    await t.mutation(internal.ingest.ingest, {
      webhookId: "wh_2",
      payload: onboardingFor(workspaceId, true),
    });

    const history = (await events(t)).find((e) => e.kind === "history")!;
    expect(history.state).toBe("processed");
    expect(await blobExists(t, history.storageId!)).toBe(true);
    const [number] = await t.run((ctx) => ctx.db.query("numbers").collect());
    expect(number.historyImport).toMatchObject({ state: "importing", progress: 40, chunks: 1 });
    const scheduled = await jobs(t);
    expect(scheduled.filter((j) => j.name.includes("history:processChunk"))).toHaveLength(1);
  });

  it("replays several parked chunks without losing counts", async () => {
    const t = makeT();
    const workspaceId = await seedWorkspace(t);
    await receive(t, historyChunk, "wh_1");
    await receive(t, historyComplete, "wh_2");

    await t.mutation(internal.ingest.ingest, {
      webhookId: "wh_3",
      payload: onboardingFor(workspaceId, true),
    });

    const [number] = await t.run((ctx) => ctx.db.query("numbers").collect());
    expect(number.historyImport).toMatchObject({ state: "importing", progress: 100, chunks: 2 });
  });

  it("ignores parked history on replay when no import was requested and deletes the blob", async () => {
    const t = makeT();
    const workspaceId = await seedWorkspace(t);
    const { storageId } = await receive(t, historyChunk, "wh_1");

    await t.mutation(internal.ingest.ingest, {
      webhookId: "wh_2",
      payload: onboardingFor(workspaceId, false),
    });

    const history = (await events(t)).find((e) => e.kind === "history")!;
    expect(history.state).toBe("ignored");
    expect(await blobExists(t, storageId!)).toBe(false);
  });

  it("ignores a chunk without a requested import and deletes the blob", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t, null);
    const { outcome, storageId } = await receive(t, historyChunk, "wh_1");
    expect(outcome).toBe("ignored");
    expect(await blobExists(t, storageId!)).toBe(false);
    expect((await events(t))[0]).toMatchObject({ state: "ignored", storageId });
    expect((await getNumber(t, numberId))!.historyImport).toBeUndefined();
    expect(await jobs(t)).toHaveLength(0);
  });

  it("marks the import declined", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const { outcome } = await receive(t, historyDeclined, "wh_1");
    expect(outcome).toBe("processed");
    expect((await getNumber(t, numberId))!.historyImport!.state).toBe("declined");
  });

  it("keeps declined after a later chunk", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await receive(t, historyDeclined, "wh_1");
    await receive(t, historyChunk, "wh_2");
    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({
      state: "declined",
      chunks: 1,
      progress: 40,
    });
  });

  it("ignores the media follow-up", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const { outcome } = await receive(t, historyMedia, "wh_1");
    expect(outcome).toBe("ignored");
    expect((await getNumber(t, numberId))!.historyImport).toEqual(requested);
    expect(await jobs(t)).toHaveLength(0);
  });

  /** The chunk fixture with its threads emptied and the given progress (or none). */
  function emptyChunk(progress: number | undefined): any {
    const payload = structuredClone(historyChunk) as any;
    const item = payload.whatsapp.history[0];
    item.threads = [];
    if (progress === undefined) delete item.metadata.progress;
    else item.metadata.progress = progress;
    return payload;
  }

  it("an empty progress-100 chunk after built rows marks the import done", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await receive(t, historyChunk, "wh_1");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({
      state: "importing",
      progress: 40,
      conversations: 1,
    });

    const { outcome, storageId } = await receive(t, emptyChunk(100), "wh_2");
    expect(outcome).toBe("processed");
    expect(storageId).toBeUndefined();
    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({
      state: "importing",
      progress: 100,
      chunks: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const history = (await getNumber(t, numberId))!.historyImport!;
    expect(history).toMatchObject({ state: "done", progress: 100, chunks: 1, conversations: 1 });
    expect(history.buildJobId).toBeUndefined();
  });

  it("an empty progress chunk leaves a pending build alone", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t, { ...requested, state: "importing", progress: 40 });
    await t.mutation(internal.history.stage, { numberId, rows: [row("w1", 1_000)] });
    const buildJobId = (await getNumber(t, numberId))!.historyImport!.buildJobId;

    expect((await receive(t, emptyChunk(100), "wh_1")).outcome).toBe("processed");

    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({ progress: 100, buildJobId });
    expect((await jobs(t)).filter((j) => j.name.includes("history:build"))).toHaveLength(1);
  });

  it("ignores an empty chunk without progress", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const { outcome } = await receive(t, emptyChunk(undefined), "wh_1");
    expect(outcome).toBe("ignored");
    expect((await getNumber(t, numberId))!.historyImport).toEqual(requested);
    expect(await jobs(t)).toHaveLength(0);
  });

  it("marks importing and keeps the max progress", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    expect((await receive(t, historyComplete, "wh_1")).outcome).toBe("processed");
    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({
      state: "importing",
      progress: 100,
      chunks: 1,
    });
    expect((await getNumber(t, numberId))!.historyImport!.updatedAt - NOW).toBeLessThan(1_000);
    await receive(t, historyChunk, "wh_2");
    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({
      state: "importing",
      progress: 100,
      chunks: 2,
    });
  });

  it("moves a done import back to importing on a late chunk", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t, { ...requested, state: "done", progress: 100 });
    await receive(t, historyChunk, "wh_1");
    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({
      state: "importing",
      progress: 100,
    });
  });

  it("deletes the new blob for a duplicate webhook id", async () => {
    const t = makeT();
    await seedNumber(t);
    const first = await receive(t, historyChunk, "wh_1");
    const second = await receive(t, historyChunk, "wh_1");
    expect(second.outcome).toBe("duplicate");
    expect(await blobExists(t, second.storageId!)).toBe(false);
    expect(await blobExists(t, first.storageId!)).toBe(true);
    expect(await events(t)).toHaveLength(1);
  });
});

describe("history.processChunk", () => {
  it("stages the rows", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const { storageId } = await receive(t, historyChunk, "wh_1");
    // Run the action directly so the debounced build does not consume the rows.
    await t.action(internal.history.processChunk, { numberId, storageId: storageId! });

    const staged = await rows(t);
    expect(staged).toHaveLength(2);
    expect(staged.every((r) => r.pending === true)).toBe(true);
    expect(staged.map((r) => r.source).sort()).toEqual(["customer", "phone"]);
    expect(staged.find((r) => r.wamid === "wamid.HIST1")).toMatchObject({
      type: "text",
      text: "do you deliver on sundays?",
      sentAt: 1_760_400_000_000,
    });
    const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ numberId, waId: "16505551234" });
    expect(staged.every((r) => r.contactId === contacts[0]._id)).toBe(true);
    expect((await getNumber(t, numberId))!.historyImport!.messages).toBe(2);
  });

  it("stages a repeated chunk once", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await receive(t, historyChunk, "wh_1");
    await receive(t, historyChunk, "wh_2");
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await rows(t)).toHaveLength(2);
    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({ messages: 2, chunks: 2 });
  });

  it("the debounced build turns the staged chunk into conversations", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await receive(t, historyComplete, "wh_1");
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await rows(t)).some((r) => r.pending)).toBe(false);
    const conversations = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversations).toHaveLength(2);
    const history = (await getNumber(t, numberId))!.historyImport!;
    expect(history).toMatchObject({ state: "done", conversations: 2 });
    expect(history.buildJobId).toBeUndefined();
  });

  it("does nothing when the blob is gone", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
    await t.run((ctx) => ctx.storage.delete(storageId));

    await t.action(internal.history.processChunk, { numberId, storageId });

    expect(await rows(t)).toHaveLength(0);
    expect((await getNumber(t, numberId))!.historyImport).toEqual(requested);
  });

  it("drops a blob that is not JSON without throwing", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["not json"])));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await t.action(internal.history.processChunk, { numberId, storageId });

    expect(await rows(t)).toHaveLength(0);
  });
});

describe("history.stage", () => {
  it("reschedules the build on every call", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);

    await t.mutation(internal.history.stage, { numberId, rows: [row("w1", 1_000)] });
    const first = (await getNumber(t, numberId))!.historyImport!.buildJobId!;
    expect(first).toBeDefined();

    await t.mutation(internal.history.stage, { numberId, rows: [row("w2", 2_000)] });
    const second = (await getNumber(t, numberId))!.historyImport!.buildJobId!;
    expect(second).not.toBe(first);

    const all = await jobs(t);
    expect(all.find((j) => j._id === first)!.state.kind).toBe("canceled");
    const next = all.find((j) => j._id === second)!;
    expect(next.state.kind).toBe("pending");
    expect(next.name).toContain("history:build");
    expect(next.scheduledTime - NOW - 600_000).toBeGreaterThanOrEqual(0);
    expect(next.scheduledTime - NOW - 600_000).toBeLessThan(1_000);
    expect((await getNumber(t, numberId))!.historyImport!.messages).toBe(2);
  });

  it("reschedules after the previous build already ran", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await t.mutation(internal.history.stage, { numberId, rows: [row("w1", 1_000)] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.mutation(internal.history.stage, { numberId, rows: [row("w2", 2_000)] });

    expect((await getNumber(t, numberId))!.historyImport!.messages).toBe(2);
    expect((await rows(t)).map((r) => r.wamid).sort()).toEqual(["w1", "w2"]);
  });

  it("returns the number of rows inserted", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const result = await t.mutation(internal.history.stage, {
      numberId,
      rows: [row("w1", 1_000), row("w1", 1_000), row("w2", 2_000)],
    });
    expect(result).toEqual({ inserted: 2 });
  });
});

describe("build", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WA = "16505551234";

  const at = (wamid: string, sentAt: number, source: "customer" | "phone" = "customer") => ({
    ...row(wamid, sentAt),
    source,
    text: wamid,
  });

  const pendingRow = (t: T, numberId: Id<"numbers">) =>
    t.run((ctx) =>
      ctx.db
        .query("historyMessages")
        .withIndex("by_number_pending", (q) => q.eq("numberId", numberId).eq("pending", true))
        .first(),
    );

  /** Runs the build chain by hand (no timers, so the debounced job never fires), then the final run. */
  async function buildAll(t: T, numberId: Id<"numbers">) {
    for (let i = 0; i < 50 && (await pendingRow(t, numberId)); i++) {
      await t.mutation(internal.history.build, { numberId });
    }
    expect(await pendingRow(t, numberId)).toBeNull();
    await t.mutation(internal.history.build, { numberId });
  }

  const conversationsOf = (t: T) => t.run((ctx) => ctx.db.query("conversations").collect());
  const allMessages = (t: T) => t.run((ctx) => ctx.db.query("messages").collect());
  const messagesOf = (t: T, conversationId: Id<"conversations">) =>
    t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", conversationId))
        .collect(),
    );
  const imported = async (t: T) =>
    (await conversationsOf(t)).filter((c) => c.imported).sort((a, b) => a.openedAt - b.openedAt);

  const seedContact = (t: T, numberId: Id<"numbers">) =>
    t.run((ctx) => ctx.db.insert("contacts", { numberId, waId: WA }));

  /** A live (not imported) conversation with its live messages. */
  async function seedLive(
    t: T,
    ids: { workspaceId: Id<"workspaces">; numberId: Id<"numbers">; contactId: Id<"contacts"> },
    status: "open" | "closed",
    messages: { wamid: string; sentAt: number; source: "customer" | "phone" }[],
  ) {
    return t.run(async (ctx) => {
      const first = messages[0];
      const last = messages[messages.length - 1];
      const conversationId = await ctx.db.insert("conversations", {
        ...ids,
        status,
        initiatedBy: first.source === "customer" ? "customer" : "business",
        openedAt: first.sentAt,
        lastActivityAt: last.sentAt,
        lastTurn: last.source === "customer" ? "customer" : "business",
        ...(status === "closed" ? { closedAt: last.sentAt } : {}),
      });
      for (const m of messages) {
        await ctx.db.insert("messages", {
          conversationId,
          wamid: m.wamid,
          direction: m.source === "customer" ? "inbound" : "outbound",
          source: m.source,
          type: "text",
          text: m.wamid,
          sentAt: m.sentAt,
        });
      }
      return conversationId;
    });
  }

  it("builds closed imported conversations with metrics", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    await t.mutation(internal.history.stage, { numberId, rows: flattenHistory(historyComplete) });
    await buildAll(t, numberId);

    const built = await imported(t);
    expect(built).toHaveLength(2);
    expect(await conversationsOf(t)).toHaveLength(2);
    for (const c of built) {
      expect(c).toMatchObject({
        workspaceId,
        numberId,
        imported: true,
        status: "closed",
        initiatedBy: "customer",
        lastTurn: "business",
      });
      expect(c.analysis).toBeUndefined();
      expect(c.closeJobId).toBeUndefined();
      expect(c.waitingSince).toBeUndefined();
      expect(c.metrics!.firstResponseSeconds).toBe(300);
    }
    expect(built[0]).toMatchObject({
      openedAt: 1_757_000_000_000,
      lastActivityAt: 1_757_000_300_000,
      closedAt: 1_757_000_300_000,
    });
    expect(built[1]).toMatchObject({
      openedAt: 1_757_086_400_000,
      lastActivityAt: 1_757_086_700_000,
      closedAt: 1_757_086_700_000,
    });

    const first = await messagesOf(t, built[0]._id);
    expect(first.map((m) => [m.wamid, m.direction, m.source, m.imported])).toEqual([
      ["wamid.HIST3", "inbound", "customer", true],
      ["wamid.HIST4", "outbound", "phone", true],
    ]);
    expect(first[0]).toMatchObject({ type: "text", text: "hi, is the blue jacket still available?" });
    expect(await allMessages(t)).toHaveLength(4);

    expect((await jobs(t)).some((j) => j.name.includes("analysis"))).toBe(false);
    const history = (await getNumber(t, numberId))!.historyImport!;
    expect(history.conversations).toBe(2);
    expect(history.buildJobId).toBeUndefined();
  });

  it("builds one contact per run and chains the next", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const base = NOW - 5 * DAY;
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("a1", base), { ...at("b1", base), threadId: "16505550000" }],
    });
    const buildJobId = (await getNumber(t, numberId))!.historyImport!.buildJobId;

    await t.mutation(internal.history.build, { numberId });
    expect(await imported(t)).toHaveLength(1);
    const builds = (await jobs(t)).filter((j) => j.name.includes("history:build"));
    expect(builds).toHaveLength(2);
    expect(builds.find((j) => j._id !== buildJobId)!.scheduledTime - NOW).toBeLessThan(1_000);
    // Chain links leave the debounced job id alone.
    expect((await getNumber(t, numberId))!.historyImport!.buildJobId).toBe(buildJobId);

    await t.mutation(internal.history.build, { numberId });
    expect(await imported(t)).toHaveLength(2);
    expect(await pendingRow(t, numberId)).toBeNull();
  });

  it("a build with nothing pending changes no conversations", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await t.mutation(internal.history.stage, { numberId, rows: flattenHistory(historyComplete) });
    await buildAll(t, numberId);
    const before = await conversationsOf(t);
    const beforeMessages = await allMessages(t);
    const jobCount = (await jobs(t)).length;

    await t.mutation(internal.history.build, { numberId });

    expect(await conversationsOf(t)).toEqual(before);
    expect(await allMessages(t)).toEqual(beforeMessages);
    expect(await jobs(t)).toHaveLength(jobCount);
  });

  it("imported conversations count in the overview", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [
        at("o1", NOW - 40 * DAY),
        at("o2", NOW - 40 * DAY + 2 * MIN, "phone"),
        at("m1", NOW - 3 * DAY),
        at("m2", NOW - 3 * DAY + 5 * MIN, "phone"),
        at("n1", NOW - 2 * DAY),
        at("n2", NOW - 2 * DAY + 5 * MIN, "phone"),
      ],
    });
    await buildAll(t, numberId);
    expect(await imported(t)).toHaveLength(3);

    const asOwner = t.withIdentity({ subject: "owner_1" });
    const month = await asOwner.query(api.dashboard.overview, { days: 30 });
    expect(month.total).toBe(2);
    expect(month.answeredRate).toBe(1);
    expect(month.medianFirstResponseSeconds).toBe(300);
    expect((await asOwner.query(api.dashboard.overview, { days: 30, numberId })).total).toBe(2);
  });

  it("live wamid is not imported again", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    const contactId = await seedContact(t, numberId);
    const base = NOW - 5 * DAY;
    const live = await seedLive(t, { workspaceId, numberId, contactId }, "closed", [
      { wamid: "w_live", sentAt: base + 2 * MIN, source: "phone" },
    ]);
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("w1", base), at("w_live", base + 2 * MIN, "phone"), at("w3", base + 3 * DAY)],
    });
    await buildAll(t, numberId);

    const built = await imported(t);
    expect(built).toHaveLength(2);
    expect((await messagesOf(t, built[0]._id)).map((m) => m.wamid)).toEqual(["w1"]);
    expect((await allMessages(t)).filter((m) => m.wamid === "w_live")).toHaveLength(1);
    expect((await messagesOf(t, live)).map((m) => m.wamid)).toEqual(["w_live"]);
  });

  it("folds the last segment into the open live conversation", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    const contactId = await seedContact(t, numberId);
    const t0 = NOW - 3 * HOUR;
    const live = await seedLive(t, { workspaceId, numberId, contactId }, "open", [
      { wamid: "live1", sentAt: t0 + 35 * MIN, source: "customer" },
    ]);
    await t.run((ctx) => ctx.db.patch(live, { waitingSince: t0 + 35 * MIN }));
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("h0", t0 - DAY), at("h1", t0, "phone"), at("h2", t0 + 5 * MIN)],
    });
    await buildAll(t, numberId);

    const built = await imported(t);
    expect(built).toHaveLength(1);
    expect((await messagesOf(t, built[0]._id)).map((m) => m.wamid)).toEqual(["h0"]);

    const conversation = (await t.run((ctx) => ctx.db.get(live)))!;
    expect(conversation).toMatchObject({
      status: "open",
      openedAt: t0,
      initiatedBy: "business",
      lastTurn: "customer",
      lastActivityAt: t0 + 35 * MIN,
      waitingSince: t0 + 35 * MIN,
    });
    expect(conversation.imported).toBeUndefined();
    expect((await messagesOf(t, live)).map((m) => [m.wamid, m.imported])).toEqual([
      ["h1", true],
      ["h2", true],
      ["live1", undefined],
    ]);
    expect((await getNumber(t, numberId))!.historyImport!.conversations).toBe(1);
  });

  it("does not fold into a closed or distant live conversation", async () => {
    for (const [status, gap] of [
      ["closed", 30 * MIN],
      ["open", 3 * HOUR],
    ] as const) {
      const t = makeT();
      const { workspaceId, numberId } = await seedNumber(t);
      const contactId = await seedContact(t, numberId);
      const t0 = NOW - 6 * HOUR;
      const liveAt = t0 + 5 * MIN + gap;
      const live = await seedLive(t, { workspaceId, numberId, contactId }, status, [
        { wamid: "live1", sentAt: liveAt, source: "customer" },
      ]);
      await t.mutation(internal.history.stage, {
        numberId,
        rows: [at("h1", t0), at("h2", t0 + 5 * MIN, "phone")],
      });
      await buildAll(t, numberId);

      const built = await imported(t);
      expect(built).toHaveLength(1);
      expect((await messagesOf(t, built[0]._id)).map((m) => m.wamid)).toEqual(["h1", "h2"]);
      expect((await messagesOf(t, live)).map((m) => m.wamid)).toEqual(["live1"]);
      expect((await t.run((ctx) => ctx.db.get(live)))!.openedAt).toBe(liveAt);
    }
  });

  it("rebuild after a late chunk is idempotent", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const t0 = NOW - 5 * DAY;
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("a", t0), at("b", t0 + 5 * MIN, "phone")],
    });
    await buildAll(t, numberId);
    expect(await imported(t)).toHaveLength(1);

    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("c", t0 - HOUR), at("d", t0 - 10 * HOUR)],
    });
    await buildAll(t, numberId);

    const built = await imported(t);
    expect(built).toHaveLength(2);
    expect(await conversationsOf(t)).toHaveLength(2);
    expect((await messagesOf(t, built[0]._id)).map((m) => m.wamid)).toEqual(["d"]);
    expect((await messagesOf(t, built[1]._id)).map((m) => m.wamid)).toEqual(["c", "a", "b"]);
    expect(built[1]).toMatchObject({ openedAt: t0 - HOUR, closedAt: t0 + 5 * MIN });
    expect(built[1].metrics!.counts).toEqual({ customer: 2, phone: 1, api: 0 });
    expect((await allMessages(t)).map((m) => m.wamid).sort()).toEqual(["a", "b", "c", "d"]);
    expect((await getNumber(t, numberId))!.historyImport!.conversations).toBe(2);
  });

  it("rebuild after a fold restores the live conversation", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    const contactId = await seedContact(t, numberId);
    const t0 = NOW - 3 * HOUR;
    const live = await seedLive(t, { workspaceId, numberId, contactId }, "open", [
      { wamid: "live1", sentAt: t0 + 35 * MIN, source: "customer" },
      { wamid: "live2", sentAt: t0 + 40 * MIN, source: "phone" },
    ]);
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("h1", t0, "phone"), at("h2", t0 + 5 * MIN)],
    });
    await buildAll(t, numberId);
    expect((await t.run((ctx) => ctx.db.get(live)))!.initiatedBy).toBe("business");

    await t.mutation(internal.history.stage, { numberId, rows: [at("h0", t0 - 30 * MIN)] });
    await buildAll(t, numberId);

    expect(await imported(t)).toHaveLength(0);
    expect(await conversationsOf(t)).toHaveLength(1);
    const messages = await messagesOf(t, live);
    expect(messages.map((m) => m.wamid)).toEqual(["h0", "h1", "h2", "live1", "live2"]);
    expect(messages.filter((m) => m.imported).map((m) => m.wamid)).toEqual(["h0", "h1", "h2"]);
    expect(await allMessages(t)).toHaveLength(5);
    expect((await t.run((ctx) => ctx.db.get(live)))!).toMatchObject({
      openedAt: t0 - 30 * MIN,
      initiatedBy: "customer",
      lastTurn: "business",
      lastActivityAt: t0 + 40 * MIN,
    });
  });

  it("rebuild restores openedAt and initiatedBy when it no longer folds", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    const contactId = await seedContact(t, numberId);
    const t0 = NOW - 3 * HOUR;
    const live = await seedLive(t, { workspaceId, numberId, contactId }, "open", [
      { wamid: "live1", sentAt: t0 + 35 * MIN, source: "customer" },
    ]);
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("h1", t0, "phone"), at("h2", t0 + 5 * MIN)],
    });
    await buildAll(t, numberId);
    expect((await t.run((ctx) => ctx.db.get(live)))!.openedAt).toBe(t0);

    // The live conversation closed since; the rebuild must not fold into it again.
    await t.run((ctx) => ctx.db.patch(live, { status: "closed", closedAt: t0 + 3 * HOUR }));
    await t.mutation(internal.history.stage, { numberId, rows: [at("h0", t0 - DAY)] });
    await buildAll(t, numberId);

    expect((await t.run((ctx) => ctx.db.get(live)))!).toMatchObject({
      openedAt: t0 + 35 * MIN,
      initiatedBy: "customer",
    });
    expect((await messagesOf(t, live)).map((m) => m.wamid)).toEqual(["live1"]);
    const built = await imported(t);
    expect(built).toHaveLength(2);
    expect((await messagesOf(t, built[1]._id)).map((m) => m.wamid)).toEqual(["h1", "h2"]);
  });

  it("rebuild recomputes the metrics of a closed live conversation that loses folded messages", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    const contactId = await seedContact(t, numberId);
    const t0 = NOW - 3 * HOUR;
    const live = await seedLive(t, { workspaceId, numberId, contactId }, "open", [
      { wamid: "live1", sentAt: t0 + 35 * MIN, source: "customer" },
      { wamid: "live2", sentAt: t0 + 45 * MIN, source: "phone" },
    ]);
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("h1", t0), at("h2", t0 + 5 * MIN, "phone")],
    });
    await buildAll(t, numberId);
    expect(await messagesOf(t, live)).toHaveLength(4);

    // The live conversation closes with the folded history counted in its metrics.
    await t.run(async (ctx) => {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_sent_at", (q) => q.eq("conversationId", live))
        .collect();
      await ctx.db.patch(live, {
        status: "closed",
        closedAt: t0 + 3 * HOUR,
        metrics: computeMetrics(messages),
      });
    });
    const closed = (await t.run((ctx) => ctx.db.get(live)))!;
    expect(closed.metrics).toMatchObject({
      firstResponseSeconds: 300,
      counts: { customer: 2, phone: 2, api: 0 },
    });

    await t.mutation(internal.history.stage, { numberId, rows: [at("h0", t0 - DAY)] });
    await buildAll(t, numberId);

    const rebuilt = (await t.run((ctx) => ctx.db.get(live)))!;
    expect((await messagesOf(t, live)).map((m) => m.wamid)).toEqual(["live1", "live2"]);
    expect(rebuilt).toMatchObject({ status: "closed", openedAt: t0 + 35 * MIN });
    expect(rebuilt.metrics).toMatchObject({
      firstResponseSeconds: 600,
      counts: { customer: 1, phone: 1, api: 0 },
    });
    const built = await imported(t);
    expect(built).toHaveLength(2);
    expect((await messagesOf(t, built[1]._id)).map((m) => m.wamid)).toEqual(["h1", "h2"]);

    const all = await conversationsOf(t);
    const customers = all.reduce((sum, c) => sum + (c.metrics?.counts.customer ?? 0), 0);
    expect(customers).toBe(3); // h0, h1, live1: each counted once
    const month = await t
      .withIdentity({ subject: "owner_1" })
      .query(api.dashboard.overview, { days: 30 });
    expect(month.total).toBe(3);
    // h1→h2 (300 s) and live1→live2 (600 s); h0 is unanswered.
    expect(month.medianFirstResponseSeconds).toBe(450);
  });

  it("marks done only at progress 100", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t, { ...requested, state: "importing", progress: 40 });
    await t.mutation(internal.history.stage, { numberId, rows: flattenHistory(historyComplete) });
    await buildAll(t, numberId);
    expect((await getNumber(t, numberId))!.historyImport).toMatchObject({
      state: "importing",
      conversations: 2,
    });

    await t.run(async (ctx) => {
      const number = (await ctx.db.get(numberId))!;
      await ctx.db.patch(numberId, { historyImport: { ...number.historyImport!, progress: 100 } });
    });
    await t.mutation(internal.history.build, { numberId });
    const history = (await getNumber(t, numberId))!.historyImport!;
    expect(history).toMatchObject({ state: "done", conversations: 2 });
    expect(history.buildJobId).toBeUndefined();
  });

  it("only builds and counts in the number's workspace", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const contactId = await seedContact(t, numberId);
    const oldWorkspace = await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        ownerId: "owner_old",
        name: "Old",
        inactivityMinutes: 120,
        methodology: [],
      }),
    );
    // An imported conversation left with the workspace the number moved from.
    const old = await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("conversations", {
        workspaceId: oldWorkspace,
        numberId,
        contactId,
        imported: true,
        status: "closed",
        initiatedBy: "customer",
        openedAt: NOW - 9 * DAY,
        lastActivityAt: NOW - 9 * DAY,
        closedAt: NOW - 9 * DAY,
        lastTurn: "customer",
      });
      await ctx.db.insert("messages", {
        conversationId,
        wamid: "old1",
        direction: "inbound",
        source: "customer",
        type: "text",
        sentAt: NOW - 9 * DAY,
        imported: true,
      });
      return conversationId;
    });
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("old1", NOW - 9 * DAY), at("new1", NOW - 5 * DAY)],
    });
    await buildAll(t, numberId);

    expect(await t.run((ctx) => ctx.db.get(old))).not.toBeNull();
    expect(await messagesOf(t, old)).toHaveLength(1);
    const built = (await imported(t)).filter((c) => c._id !== old);
    expect(built).toHaveLength(1);
    expect((await messagesOf(t, built[0]._id)).map((m) => m.wamid)).toEqual(["new1"]);
    expect((await getNumber(t, numberId))!.historyImport!.conversations).toBe(1);
  });

  it("dashboard.conversations marks imported rows", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    const contactId = await seedContact(t, numberId);
    const live = await seedLive(t, { workspaceId, numberId, contactId }, "closed", [
      { wamid: "live1", sentAt: NOW - DAY, source: "customer" },
    ]);
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [at("h1", NOW - 5 * DAY), at("h2", NOW - 5 * DAY + MIN, "phone")],
    });
    await buildAll(t, numberId);

    const list = await t
      .withIdentity({ subject: "owner_1" })
      .query(api.dashboard.conversations, { numberId, status: "closed" });
    expect(list).toHaveLength(2);
    expect(list.find((c) => c._id === live)!.imported).toBe(false);
    expect(list.find((c) => c._id !== live)!.imported).toBe(true);
  });
});

describe("analyzeImported", () => {
  const OWNER = "owner_1";

  async function seedImported(
    t: T,
    ids: { workspaceId: Id<"workspaces">; numberId: Id<"numbers"> },
    closedAt: number,
    extra: Partial<Doc<"conversations">> = {},
  ) {
    return t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        numberId: ids.numberId,
        waId: `wa${closedAt}`,
      });
      return ctx.db.insert("conversations", {
        ...ids,
        contactId,
        imported: true,
        status: "closed",
        initiatedBy: "customer",
        openedAt: closedAt - 1000,
        lastActivityAt: closedAt,
        closedAt,
        lastTurn: "customer",
        ...extra,
      });
    });
  }

  const analysisJobs = async (t: T) =>
    (await jobs(t))
      .filter((j) => j.name.endsWith("analyzeConversation"))
      .sort((a, b) => a.scheduledTime - b.scheduledTime);

  it("analyzes only unanalyzed imported conversations", async () => {
    const t = makeT();
    const ids = await seedNumber(t);
    const todo = await seedImported(t, ids, NOW - 3000);
    const done = await seedImported(t, ids, NOW - 2000, {
      analysis: { state: "done", methodology: [], requestedAt: 1 },
    });
    const live = await seedImported(t, ids, NOW - 1000, { imported: undefined });

    const result = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.history.analyzeImported, { numberId: ids.numberId });

    expect(result).toEqual({ requested: 1, remaining: 0 });
    const get = (id: Id<"conversations">) => t.run((ctx) => ctx.db.get(id));
    expect((await get(todo))!.analysis?.state).toBe("pending");
    expect((await get(done))!.analysis?.state).toBe("done");
    expect((await get(live))!.analysis).toBeUndefined();
  });

  it("caps at 100 and reports remaining", async () => {
    const t = makeT();
    const ids = await seedNumber(t);
    for (let i = 0; i < 105; i++) await seedImported(t, ids, NOW - 1_000_000 + i);

    const result = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.history.analyzeImported, { numberId: ids.numberId });

    expect(result).toEqual({ requested: 100, remaining: 5 });
    expect(await analysisJobs(t)).toHaveLength(100);
  });

  it("spaces the analysis jobs, newest first, with the workspace methodology", async () => {
    const t = makeT();
    const ids = await seedNumber(t);
    const oldest = await seedImported(t, ids, NOW - 3000);
    const newest = await seedImported(t, ids, NOW - 1000);
    const middle = await seedImported(t, ids, NOW - 2000);

    await t
      .withIdentity({ subject: OWNER })
      .mutation(api.history.analyzeImported, { numberId: ids.numberId });

    const scheduled = await analysisJobs(t);
    // convex-test adds a millisecond or so to the scheduled time.
    const [first] = scheduled.map((j) => j.scheduledTime);
    expect(first - NOW).toBeGreaterThanOrEqual(0);
    expect(first - NOW).toBeLessThan(1_000);
    expect(scheduled.map((j) => j.scheduledTime - first)).toEqual([0, 3000, 6000]);
    expect(scheduled.map((j) => (j.args[0] as any).conversationId)).toEqual([
      newest,
      middle,
      oldest,
    ]);
    const conversation = await t.run((ctx) => ctx.db.get(newest));
    expect(conversation!.analysis!.methodology).toEqual(DEFAULT_METHODOLOGY);
  });

  it("ignores conversations from another workspace", async () => {
    const t = makeT();
    const ids = await seedNumber(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        ownerId: "owner_old",
        name: "Old",
        inactivityMinutes: 120,
        methodology: DEFAULT_METHODOLOGY,
      }),
    );
    await seedImported(t, { workspaceId: other, numberId: ids.numberId }, NOW - 1000);
    const mine = await seedImported(t, ids, NOW - 2000);

    const result = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.history.analyzeImported, { numberId: ids.numberId });

    expect(result).toEqual({ requested: 1, remaining: 0 });
    expect((await analysisJobs(t)).map((j) => (j.args[0] as any).conversationId)).toEqual([mine]);
  });

  it("another workspace gets Not found", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        ownerId: "owner_2",
        name: "Other",
        inactivityMinutes: 120,
        methodology: DEFAULT_METHODOLOGY,
      }),
    );
    await expect(
      t.withIdentity({ subject: "owner_2" }).mutation(api.history.analyzeImported, { numberId }),
    ).rejects.toThrow("Not found");
  });
});

describe("importStatus", () => {
  const OWNER = "owner_1";
  const status = (t: T, numberId: Id<"numbers">) =>
    t.withIdentity({ subject: OWNER }).query(api.history.importStatus, { numberId });

  it("is null when nothing was requested", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t, null);
    expect(await status(t, numberId)).toBeNull();
  });

  it("another workspace gets Not found", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        ownerId: "owner_2",
        name: "Other",
        inactivityMinutes: 120,
        methodology: DEFAULT_METHODOLOGY,
      }),
    );
    await expect(
      t.withIdentity({ subject: "owner_2" }).query(api.history.importStatus, { numberId }),
    ).rejects.toThrow("Not found");
  });

  it("reports counts and building", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t, { ...requested, state: "importing", progress: 100 });
    await t.run(async (ctx) => {
      await ctx.db.insert("contacts", { numberId, waId: "1", bookName: "Ana" });
      await ctx.db.insert("contacts", { numberId, waId: "2" });
    });
    await t.mutation(internal.history.stage, {
      numberId,
      rows: [
        { ...row("a1", NOW - 5 * 86_400_000), threadId: "1" },
        { ...row("a2", NOW - 5 * 86_400_000 + 1000), threadId: "1" },
        { ...row("b1", NOW - 2 * 86_400_000), threadId: "2" },
      ],
    });

    const during = await status(t, numberId);
    expect(during!.building).toBe(true);
    expect(during!.importedConversations).toBe(0);
    expect(during!.bookContacts).toBe(1);

    for (let i = 0; i < 10; i++) await t.mutation(internal.history.build, { numberId });

    const after = await status(t, numberId);
    expect(after).toMatchObject({
      building: false,
      importedConversations: 2,
      unanalyzed: 2,
      bookContacts: 1,
    });
    expect(after!.historyImport!.state).toBe("done");
    expect(after!.contactsImport).toBeUndefined();

    await t.withIdentity({ subject: OWNER }).mutation(api.history.analyzeImported, { numberId });
    expect((await status(t, numberId))!.unanalyzed).toBe(0);
  });

  it("counts unanalyzed up to the cap", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t, { ...requested, conversations: 1005 });
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", { numberId, waId: "1" });
      for (let i = 0; i < 1005; i++) {
        await ctx.db.insert("conversations", {
          workspaceId,
          numberId,
          contactId,
          imported: true,
          status: "closed",
          initiatedBy: "customer",
          openedAt: i,
          lastActivityAt: i,
          closedAt: i,
          lastTurn: "customer",
        });
      }
    });
    const result = await status(t, numberId);
    expect(result!.unanalyzed).toBe(1000);
    // Read from the build's count, not scanned.
    expect(result!.importedConversations).toBe(1005);
  });

  it("counts book contacts up to the cap", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 1003; i++) {
        await ctx.db.insert("contacts", { numberId, waId: `${i}`, bookName: `Name ${i}` });
      }
      await ctx.db.insert("contacts", { numberId, waId: "plain" });
    });
    expect((await status(t, numberId))!.bookContacts).toBe(1000);
  });

  it("is building while a build job is scheduled even without pending rows", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    expect((await status(t, numberId))!.building).toBe(false);
    const buildJobId = await t.run((ctx) =>
      ctx.scheduler.runAfter(600_000, internal.history.build, { numberId }),
    );
    await t.run((ctx) =>
      ctx.db.patch(numberId, { historyImport: { ...requested, buildJobId } }),
    );
    expect((await status(t, numberId))!.building).toBe(true);
  });

  it("does not count a failed analysis as unanalyzed, and analyzeImported skips it", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    const base = {
      workspaceId,
      numberId,
      imported: true as const,
      status: "closed" as const,
      initiatedBy: "customer" as const,
      openedAt: 1,
      lastActivityAt: 2,
      closedAt: 2,
      lastTurn: "customer" as const,
    };
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", { numberId, waId: "1" });
      await ctx.db.insert("conversations", {
        ...base,
        contactId,
        analysis: { state: "failed", methodology: [], requestedAt: 1 },
      });
      await ctx.db.insert("conversations", { ...base, contactId });
    });

    expect((await status(t, numberId))!.unanalyzed).toBe(1);
    const result = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.history.analyzeImported, { numberId });
    expect(result).toEqual({ requested: 1, remaining: 0 });
  });
});
