import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messageText from "../tests/fixtures/message-text.json";
import numberOnboarded from "../tests/fixtures/number-onboarded.json";
import smbMessageEcho from "../tests/fixtures/smb-message-echo.json";
import { makeT } from "../tests/helpers";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { applyEvent } from "./handoff";
import { ingestPayload } from "./ingest";
import { getModel } from "./lib/model";

vi.mock("./lib/model", () => ({ getModel: vi.fn() }));

const NOW = 1_800_000_000_000;
const POOL = "pn_1";
const CUSTOMER = { waId: "16505551234", userId: "US.13491208655302741918" };
const SEND_URL = "https://api.pipes.bot/v1/messages/app/send";

type T = ReturnType<typeof makeT>;

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

const emptyResult = () => ({
  content: [],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

const toolResult = (calls: { name: string; args: unknown }[]) => ({
  content: calls.map((c, i) => ({
    type: "tool-call" as const,
    toolCallId: `call_${i}`,
    toolName: c.name,
    input: JSON.stringify(c.args),
  })),
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

type Result = ReturnType<typeof textResult | typeof toolResult | typeof emptyResult>;

/** The mock model answers with `results` in order, repeating the last one. */
function useModel(...results: Result[]) {
  let i = 0;
  return useModelFn(async () => results[Math.min(i++, results.length - 1)]);
}

function useModelFn(doGenerate: () => Promise<Result>) {
  const model = new MockLanguageModelV4({ doGenerate: doGenerate as never });
  vi.mocked(getModel).mockReturnValue({ model, id: "mock/model" });
  return model;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A model whose first call waits until the test opens the gate; later calls answer at once.
 * `entered` resolves when the first call starts.
 */
function useGatedModel(first: Result, rest: Result) {
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const model = useModelFn(async () => {
    if (calls++ === 0) {
      entered.resolve();
      await gate.promise;
      return first;
    }
    return rest;
  });
  return { model, entered: entered.promise, open: gate.resolve };
}

function stubFetch() {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ messageId: "wamid.ai", contacts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Deep copy of an envelope fixture addressed to the pool number, timestamped now. */
function envelope(fixture: object): any {
  const copy = structuredClone(fixture) as any;
  copy.pipes.poolNumberId = POOL;
  const seconds = String(Math.floor(Date.now() / 1000));
  for (const item of [...(copy.whatsapp.messages ?? []), ...(copy.whatsapp.message_echoes ?? [])]) {
    item.timestamp = seconds;
  }
  return copy;
}

let seq = 0;

function customerText(body: string, id = `wamid.in_${++seq}`): any {
  const copy = envelope(messageText);
  copy.whatsapp.messages[0].id = id;
  copy.whatsapp.messages[0].text.body = body;
  return copy;
}

function echoToCustomer(): any {
  const echo = envelope(smbMessageEcho);
  echo.whatsapp.message_echoes[0].to = CUSTOMER.waId;
  echo.whatsapp.message_echoes[0].to_user_id = CUSTOMER.userId;
  echo.whatsapp.message_echoes[0].id = `wamid.echo_${++seq}`;
  return echo;
}

const ingest = (t: T, payload: any) =>
  t.run((ctx) => ingestPayload(ctx, `wh_${++seq}`, payload, Date.now()));

/** A workspace with the pool number onboarded into it and the AI on. */
async function seedNumber(t: T) {
  const workspaceId = await t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerId: "user_1",
      name: "Acme",
      instructions: "Be nice.",
      faq: "We open at 9.",
      idleMinutes: 30,
    }),
  );
  const onboarded = structuredClone(numberOnboarded) as any;
  onboarded.data.numberId = POOL;
  onboarded.data.metadata = { ...onboarded.data.metadata, workspaceId };
  expect(await ingest(t, onboarded)).toBe("processed");
  await t.run(async (ctx) => {
    const number = (await ctx.db.query("numbers").first())!;
    await ctx.db.patch(number._id, { aiEnabled: true });
  });
  return workspaceId;
}

/** Re-onboards the pool number into a new workspace and turns the AI on there. */
async function moveNumberToNewWorkspace(t: T) {
  const other = await t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerId: "user_2",
      name: "Other",
      instructions: "",
      faq: "",
      idleMinutes: 30,
    }),
  );
  const onboarded = structuredClone(numberOnboarded) as any;
  onboarded.data.numberId = POOL;
  onboarded.data.metadata = { ...onboarded.data.metadata, workspaceId: other };
  expect(await ingest(t, onboarded)).toBe("processed");
  await t.run(async (ctx) => {
    const number = (await ctx.db.query("numbers").first())!;
    expect(number.workspaceId).toBe(other);
    await ctx.db.patch(number._id, { aiEnabled: true });
  });
  return other;
}

const pendingReplies = async (t: T) =>
  (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
    (j) => j.name === "responder:respond" && j.state.kind === "pending",
  );

/** Seeds the number and a conversation whose customer just wrote `text`. */
async function seedConversation(t: T, text = "Does it come in another color?") {
  await seedNumber(t);
  expect(await ingest(t, customerText(text))).toBe("processed");
  return (await conversation(t))._id;
}

const conversation = async (t: T) => {
  const rows = await t.run((ctx) => ctx.db.query("conversations").collect());
  expect(rows).toHaveLength(1);
  return rows[0];
};

const all = <K extends "messages" | "aiRuns" | "requests">(t: T, table: K) =>
  t.run((ctx) => ctx.db.query(table).collect());

const aiMessages = async (t: T) =>
  (await all(t, "messages")).filter((m: Doc<"messages">) => m.source === "ai");

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const patchConversation = (t: T, id: Id<"conversations">, patch: Partial<Doc<"conversations">>) =>
  t.run((ctx) => ctx.db.patch(id, patch));

const promptText = (model: MockLanguageModelV4, call: number) =>
  JSON.stringify(model.doGenerateCalls[call].prompt);

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("PIPES_API_KEY", "pk_smoke_test_key");
  vi.mocked(getModel).mockReset();
  fetchMock = stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("respond", () => {
  it("customer text gets an AI reply", async () => {
    const model = useModel(textResult("  Yes, it also comes in blue.  "));
    const t = makeT();
    const id = await seedConversation(t);

    await drain(t);

    const messages = await aiMessages(t);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      source: "ai",
      direction: "out",
      text: "Yes, it also comes in blue.",
      status: "sent",
      wamid: "wamid.ai",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(SEND_URL);

    const runs = await all(t, "aiRuns");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      conversationId: id,
      turn: 1,
      attempt: 1,
      outcome: "sent",
      model: "mock/model",
      replyPreview: "Yes, it also comes in blue.",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(runs[0].finishedAt).toBeGreaterThanOrEqual(runs[0].startedAt);

    const after = await conversation(t);
    expect(after).toMatchObject({ mode: "ai", lastFrom: "ai", aiTurn: 1 });
    expect(after.aiReplies.count).toBe(1);
    expect(after.pendingReplyJobId).toBeUndefined();

    // One user message with the labelled conversation, and the workspace system prompt.
    expect(model.doGenerateCalls).toHaveLength(1);
    const prompt = model.doGenerateCalls[0].prompt;
    const system = prompt.find((m) => m.role === "system")!.content as string;
    expect(system).toContain("We open at 9.");
    expect(system).toContain("Be nice.");
    const users = prompt.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(JSON.stringify(users[0].content)).toContain(
      "<conversation>\\nCustomer: Does it come in another color?\\n</conversation>",
    );
  });

  it("request_human hands off with a summary", async () => {
    useModel(
      toolResult([
        { name: "request_human", args: { reason: "asked for a person", summary: "Wants a refund" } },
      ]),
      textResult("Someone from our team will continue here."),
    );
    const t = makeT();
    await seedConversation(t, "I want a refund");

    await drain(t);

    const after = await conversation(t);
    expect(after).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_request",
      handoffSummary: "Wants a refund",
      lastFrom: "ai",
      aiTurn: 2,
    });
    expect(after.pendingReplyJobId).toBeUndefined();
    const messages = await aiMessages(t);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "Someone from our team will continue here.", status: "sent" });
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({
      outcome: "handed_off",
      toolCalls: [
        { name: "request_human", args: { reason: "asked for a person", summary: "Wants a refund" } },
      ],
    });
  });

  it("save_request creates a request and stays in ai", async () => {
    useModel(
      toolResult([
        {
          name: "save_request",
          args: { summary: "2 blue shirts", details: "Size M, deliver Friday", customerName: "Sheena" },
        },
      ]),
      textResult("Got it, the team will confirm."),
    );
    const t = makeT();
    const id = await seedConversation(t, "I want to order 2 blue shirts");

    await drain(t);

    const requests = await all(t, "requests");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversationId: id,
      workspaceId: (await conversation(t)).workspaceId,
      summary: "2 blue shirts",
      details: "Size M, deliver Friday",
      customerName: "Sheena",
      status: "open",
    });
    expect(requests[0].createdAt).toBeGreaterThanOrEqual(NOW);
    expect(await conversation(t)).toMatchObject({ mode: "ai", aiTurn: 1 });
    expect(await aiMessages(t)).toHaveLength(1);
    const [run] = await all(t, "aiRuns");
    expect(run.outcome).toBe("sent");
  });

  it("five save_request calls keep three", async () => {
    const save = (n: number) => ({
      name: "save_request",
      args: { summary: "x".repeat(900), details: `details ${n}` },
    });
    useModel(
      toolResult([save(1), save(2), save(3), save(4), save(5)]),
      textResult("Saved."),
    );
    const t = makeT();
    await seedConversation(t, "Five orders please");

    await drain(t);

    const requests = await all(t, "requests");
    expect(requests.map((r: Doc<"requests">) => r.details)).toEqual(["details 1", "details 2", "details 3"]);
    for (const r of requests) {
      expect(r.summary).toHaveLength(500);
      expect(r.customerName).toBeUndefined();
    }
    const [run] = await all(t, "aiRuns");
    expect(run.outcome).toBe("sent");
    expect(run.toolCalls).toHaveLength(5);
    expect(await aiMessages(t)).toHaveLength(1);
  });

  it("empty reply sends nothing", async () => {
    useModel(emptyResult());
    const t = makeT();
    await seedConversation(t);

    await drain(t);

    expect(await aiMessages(t)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "empty", toolCalls: [] });
    expect(run.replyPreview).toBeUndefined();
    const after = await conversation(t);
    expect(after).toMatchObject({ mode: "ai", aiTurn: 1, lastFrom: "customer" });
    expect(after.pendingReplyJobId).toBeUndefined();
  });

  it("model error retries once then hands off", async () => {
    const model = useModelFn(async () => {
      throw new Error("upstream exploded");
    });
    const t = makeT();
    await seedConversation(t);

    await drain(t);

    expect(model.doGenerateCalls).toHaveLength(2);
    const runs = (await all(t, "aiRuns")).sort((a: Doc<"aiRuns">, b: Doc<"aiRuns">) => a.attempt - b.attempt);
    expect(runs.map((r: Doc<"aiRuns">) => [r.attempt, r.outcome])).toEqual([
      [1, "error"],
      [2, "error"],
    ]);
    // The retry waits 10 s.
    expect(runs[1].startedAt - runs[0].startedAt).toBeGreaterThanOrEqual(10_000);
    const after = await conversation(t);
    expect(after).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_error",
      lastError: "The AI could not answer: upstream exploded",
    });
    expect(runs[1].error).toBe("The AI could not answer: upstream exploded");
    expect(await aiMessages(t)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("model error message is cut to 200 characters", async () => {
    useModelFn(async () => {
      throw new Error("e".repeat(500));
    });
    const t = makeT();
    await seedConversation(t);

    await drain(t);

    expect((await conversation(t)).lastError).toBe(`The AI could not answer: ${"e".repeat(200)}`);
  });

  it("echo while the model thinks drops the turn", async () => {
    const { model, entered, open } = useGatedModel(textResult("Too late."), textResult("unused"));
    const t = makeT();
    const id = await seedConversation(t);

    // Run the turn directly: convex-test cannot cancel an in-progress scheduled action.
    vi.setSystemTime(NOW + 4000);
    const running = t.action(internal.responder.respond, { conversationId: id, turn: 1, attempt: 1 });
    await entered;
    vi.setSystemTime(NOW + 6000);
    await ingest(t, echoToCustomer());
    open();
    await running;
    await drain(t);

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(await aiMessages(t)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const runs = await all(t, "aiRuns");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "dropped", dropReason: "stale", turn: 1 });
    expect(await conversation(t)).toMatchObject({ mode: "human", handoffReason: "phone_reply" });
  });

  it("message during a model call supersedes the turn", async () => {
    const { model, entered, open } = useGatedModel(
      textResult("First answer."),
      textResult("Second answer."),
    );
    const t = makeT();
    const id = await seedConversation(t, "Does it come in another color?");

    // Message 1 at t=0, the model call starts at t=4 s, message 2 at t=7 s, the call ends at t=10 s.
    vi.setSystemTime(NOW + 4000);
    const running = t.action(internal.responder.respond, { conversationId: id, turn: 1, attempt: 1 });
    await entered;
    vi.setSystemTime(NOW + 7000);
    await ingest(t, customerText("And in red?"));
    vi.setSystemTime(NOW + 10_000);
    open();
    await running;
    await drain(t);

    expect(model.doGenerateCalls).toHaveLength(2);
    const runs = (await all(t, "aiRuns")).sort((a: Doc<"aiRuns">, b: Doc<"aiRuns">) => a.turn - b.turn);
    expect(runs.map((r: Doc<"aiRuns">) => [r.turn, r.outcome, r.dropReason])).toEqual([
      [1, "dropped", "stale"],
      [2, "sent", undefined],
    ]);
    const messages = await aiMessages(t);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Second answer.");
    const second = promptText(model, 1);
    expect(second).toContain("Does it come in another color?");
    expect(second).toContain("And in red?");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("take over during a turn drops it", async () => {
    const { entered, open } = useGatedModel(textResult("Too late."), textResult("unused"));
    const t = makeT();
    const id = await seedConversation(t);

    vi.setSystemTime(NOW + 4000);
    const running = t.action(internal.responder.respond, { conversationId: id, turn: 1, attempt: 1 });
    await entered;
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(id))!;
      await applyEvent(ctx, c, { kind: "take_over" }, Date.now());
    });
    open();
    await running;
    await drain(t);

    expect(await aiMessages(t)).toHaveLength(0);
    const runs = await all(t, "aiRuns");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "dropped", dropReason: "stale" });
    expect(await conversation(t)).toMatchObject({ mode: "human", handoffReason: "manual" });
  });

  it("twenty replies in an hour hands off", async () => {
    const model = useModel(textResult("unused"));
    const t = makeT();
    const id = await seedConversation(t);
    await patchConversation(t, id, { aiReplies: { windowStart: NOW - 1000, count: 20 } });

    await drain(t);

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await aiMessages(t)).toHaveLength(0);
    const after = await conversation(t);
    expect(after).toMatchObject({ mode: "waiting_human", handoffReason: "limit" });
    expect(after.pendingReplyJobId).toBeUndefined();
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "limited", model: "mock/model", toolCalls: [] });
  });

  it("AI disabled drops the turn", async () => {
    const model = useModel(textResult("unused"));
    const t = makeT();
    await seedConversation(t);
    await t.run(async (ctx) => {
      const number = (await ctx.db.query("numbers").first())!;
      await ctx.db.patch(number._id, { aiEnabled: false });
    });

    await drain(t);

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await aiMessages(t)).toHaveLength(0);
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "dropped", dropReason: "ai_disabled" });
    expect((await conversation(t)).mode).toBe("ai");
  });

  it("AI switched off while the model thinks drops the turn", async () => {
    const { entered, open } = useGatedModel(textResult("Too late."), textResult("unused"));
    const t = makeT();
    const id = await seedConversation(t);

    vi.setSystemTime(NOW + 4000);
    const running = t.action(internal.responder.respond, { conversationId: id, turn: 1, attempt: 1 });
    await entered;
    await t.run(async (ctx) => {
      const number = (await ctx.db.query("numbers").first())!;
      await ctx.db.patch(number._id, { aiEnabled: false });
    });
    open();
    await running;

    expect(await aiMessages(t)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const runs = await all(t, "aiRuns");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "dropped", dropReason: "ai_disabled", turn: 1 });
    const after = await conversation(t);
    expect(after).toMatchObject({ mode: "ai", aiTurn: 1, lastFrom: "customer" });
    expect(after.aiReplies.count).toBe(0);
  });

  it("a number moved to another workspace drops the old workspace's turn", async () => {
    const model = useModel(textResult("unused"));
    const t = makeT();
    await seedConversation(t);
    await moveNumberToNewWorkspace(t);

    await drain(t);

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await aiMessages(t)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "dropped", dropReason: "ai_disabled" });
  });

  it("hand back in the old workspace after the number moved schedules and sends nothing", async () => {
    const model = useModel(textResult("unused"));
    const t = makeT();
    const id = await seedConversation(t);
    const owner = t.withIdentity({ subject: "user_1" });
    await owner.mutation(api.conversations.takeOver, { conversationId: id });
    await moveNumberToNewWorkspace(t);

    await owner.mutation(api.conversations.handBack, { conversationId: id });

    expect(await conversation(t)).toMatchObject({ mode: "ai", lastFrom: "customer" });
    expect(await pendingReplies(t)).toHaveLength(0);
    await drain(t);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await aiMessages(t)).toHaveLength(0);
    expect(await all(t, "aiRuns")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("failed AI messages are left out of the model's history", async () => {
    const model = useModel(textResult("Yes, in blue."));
    const t = makeT();
    const id = await seedConversation(t, "Does it come in another color?");
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(id))!;
      for (const [text, status] of [
        ["This one never arrived.", "failed"],
        ["This one arrived.", "sent"],
      ] as const) {
        await ctx.db.insert("messages", {
          workspaceId: c.workspaceId,
          conversationId: id,
          numberId: c.numberId,
          direction: "out",
          source: "ai",
          type: "text",
          text,
          status,
          sentAt: NOW + 1,
        });
      }
    });

    await drain(t);

    const prompt = promptText(model, 0);
    expect(prompt).toContain("Customer: Does it come in another color?");
    expect(prompt).toContain("Assistant: This one arrived.");
    expect(prompt).not.toContain("This one never arrived.");
  });

  it("closed window drops the turn", async () => {
    const model = useModel(textResult("unused"));
    const t = makeT();
    const id = await seedConversation(t);
    await patchConversation(t, id, { lastInboundAt: NOW - 25 * 3_600_000 });

    await drain(t);

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await aiMessages(t)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "dropped", dropReason: "window_closed" });
  });

  it("stale turn drops without calling the model", async () => {
    const model = useModel(textResult("unused"));
    const t = makeT();
    const id = await seedConversation(t);

    await t.action(internal.responder.respond, { conversationId: id, turn: 0, attempt: 1 });

    expect(model.doGenerateCalls).toHaveLength(0);
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "dropped", dropReason: "stale", turn: 0 });
  });

  it("respond after the conversation is gone is a no-op", async () => {
    const model = useModel(textResult("unused"));
    const t = makeT();
    const id = await seedConversation(t);
    const jobId = (await conversation(t)).pendingReplyJobId!;
    await t.run(async (ctx) => {
      for (const m of await ctx.db.query("messages").collect()) await ctx.db.delete(m._id);
      await ctx.db.delete(id);
    });

    await drain(t);

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await all(t, "aiRuns")).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.system.get(jobId)))?.state.kind).toBe("success");
  });

  it("demo responder without a key", async () => {
    vi.mocked(getModel).mockReturnValue(null);
    const t = makeT();
    await seedConversation(t, "I want a person");

    await drain(t);

    const after = await conversation(t);
    expect(after).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_request",
      handoffSummary: "I want a person",
    });
    const messages = await aiMessages(t);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: "Sure — someone from our team will take it from here.",
      status: "sent",
    });
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "handed_off", model: "demo" });
    expect(run.usage).toBeUndefined();
  });
});

describe("lazy resume through ingest", () => {
  it("a customer text after the idle timeout brings the AI back and gets a reply", async () => {
    vi.mocked(getModel).mockReturnValue(null);
    const t = makeT();
    await seedNumber(t);
    // The team wrote first from the phone: the conversation starts in `human` with a timer.
    await ingest(t, echoToCustomer());
    const before = await conversation(t);
    expect(before).toMatchObject({ mode: "human", handoffReason: "phone_reply" });
    expect(before.resumeAt! - NOW).toBeGreaterThanOrEqual(30 * 60_000);
    expect(before.resumeAt! - NOW).toBeLessThan(31 * 60_000);

    vi.setSystemTime(NOW + 31 * 60_000);
    expect(await ingest(t, customerText("Is the shop open today?"))).toBe("processed");
    expect(await conversation(t)).toMatchObject({ mode: "ai" });

    await drain(t);

    const messages = await aiMessages(t);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: "sent", wamid: "wamid.ai" });
    expect(messages[0].text).toContain("This is a demo reply");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(SEND_URL);
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "sent", model: "demo" });
    const after = await conversation(t);
    expect(after).toMatchObject({ mode: "ai", lastFrom: "ai" });
    expect(after.resumeAt).toBeUndefined();
  });
});

describe("commitReply", () => {
  const decision = (text: string) => ({ text, requests: [], toolCalls: [] });

  it("a stale turn writes only a dropped run", async () => {
    const t = makeT();
    const id = await seedConversation(t);

    await t.mutation(internal.responder.commitReply, {
      conversationId: id,
      turn: 0,
      attempt: 1,
      model: "mock/model",
      startedAt: NOW,
      result: {
        kind: "decision",
        decision: {
          text: "Hi",
          handoff: { reason: "r", summary: "s" },
          requests: [{ summary: "s", details: "d" }],
          toolCalls: [],
        },
      },
    });

    expect(await aiMessages(t)).toHaveLength(0);
    expect(await all(t, "requests")).toHaveLength(0);
    const after = await conversation(t);
    expect(after).toMatchObject({ mode: "ai", aiTurn: 1 });
    expect(after.pendingReplyJobId).toBeDefined();
    const [run] = await all(t, "aiRuns");
    expect(run).toMatchObject({ outcome: "dropped", dropReason: "stale", turn: 0 });
  });

  it("a long reply is cut and previewed", async () => {
    const t = makeT();
    const id = await seedConversation(t);
    const long = `${"a".repeat(300)}. ${"b".repeat(400)}`;

    await t.mutation(internal.responder.commitReply, {
      conversationId: id,
      turn: 1,
      attempt: 1,
      model: "mock/model",
      startedAt: NOW,
      result: { kind: "decision", decision: decision(long) },
    });

    const [message] = await aiMessages(t);
    expect(message.text).toBe(`${"a".repeat(300)}.`);
    const [run] = await all(t, "aiRuns");
    expect(run.replyPreview).toBe("a".repeat(120));
  });

  it("a missing conversation is a no-op", async () => {
    const t = makeT();
    const id = await seedConversation(t);
    await t.run((ctx) => ctx.db.delete(id));

    await t.mutation(internal.responder.commitReply, {
      conversationId: id,
      turn: 1,
      attempt: 1,
      model: "mock/model",
      startedAt: NOW,
      result: { kind: "event", event: { kind: "ai_limit" } },
    });
    await t.mutation(internal.responder.recordRun, {
      conversationId: id,
      turn: 1,
      attempt: 1,
      outcome: "error",
      toolCalls: [],
      model: "mock/model",
      startedAt: NOW,
      finishedAt: NOW,
    });

    expect(await all(t, "aiRuns")).toHaveLength(0);
  });
});
