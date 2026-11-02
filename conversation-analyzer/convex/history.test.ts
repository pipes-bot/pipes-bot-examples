import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import historyChunk from "../tests/fixtures/history-chunk.json";
import historyComplete from "../tests/fixtures/history-complete.json";
import historyDeclined from "../tests/fixtures/history-declined.json";
import historyMedia from "../tests/fixtures/history-media.json";
import numberOnboarded from "../tests/fixtures/number-onboarded.json";
import { makeT } from "../tests/helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { summarizeHistory } from "./lib/history";
import { DEFAULT_METHODOLOGY } from "./lib/methodology";

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
    await receive(t, historyChunk, "wh_1");
    await t.finishAllScheduledFunctions(vi.runAllTimers);

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
