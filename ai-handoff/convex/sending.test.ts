import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeT } from "../tests/helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { sendErrorMessage } from "./lib/send";
import { insertAiMessage } from "./sending";

const SEND_URL = "https://api.pipes.bot/v1/messages/app/send";
const NOW = 1_800_000_000_000;

type T = ReturnType<typeof makeT>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ok = (messageId = "wamid.X") => () => jsonResponse({ messageId, contacts: [] });

/** Each call gets the next response; the last one repeats. */
function stubFetch(...responses: Array<() => Response>) {
  let call = 0;
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A workspace with a number and an AI conversation that has one customer message. */
async function seed(
  conversation: Partial<Doc<"conversations">> = {},
  number: Partial<Doc<"numbers">> = {},
) {
  const t = makeT();
  const { workspaceId, numberId, conversationId } = await t.run(async (ctx) => {
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
      phoneNumber: "+5511999990000",
      displayName: "Shop",
      connectedAt: 1,
      aiEnabled: true,
      ...number,
    });
    const conversationId = await ctx.db.insert("conversations", {
      workspaceId,
      numberId,
      waId: "5511900000000",
      mode: "ai",
      modeChangedAt: 1,
      aiTurn: 1,
      lastInboundAt: Date.now(),
      lastMessageAt: Date.now(),
      lastFrom: "customer",
      lastPreview: "Hi",
      aiReplies: { windowStart: Date.now(), count: 0 },
      ...conversation,
    });
    return { workspaceId, numberId, conversationId };
  });
  return { t, workspaceId, numberId, conversationId };
}

/** What `commitReply` does: store the pending AI reply and schedule its delivery. */
async function queueReply(t: T, conversationId: Id<"conversations">, text = "Hello Ana") {
  return await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(conversationId))!;
    return await insertAiMessage(ctx, conversation, text, Date.now());
  });
}

const getMessage = (t: T, id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));
const getConversation = (t: T, id: Id<"conversations">) => t.run((ctx) => ctx.db.get(id));
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("PIPES_API_KEY", "pk_smoke_test_key");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("insertAiMessage", () => {
  it("stores a pending AI message and updates the conversation", async () => {
    const { t, conversationId, numberId } = await seed({
      aiReplies: { windowStart: NOW - 1000, count: 2 },
    });

    const messageId = await queueReply(t, conversationId, "Hello Ana");

    expect(await getMessage(t, messageId)).toMatchObject({
      conversationId,
      numberId,
      direction: "out",
      source: "ai",
      type: "text",
      text: "Hello Ana",
      status: "pending",
      attempt: 1,
      sentAt: NOW,
    });
    expect(await getConversation(t, conversationId)).toMatchObject({
      lastMessageAt: NOW,
      lastFrom: "ai",
      lastPreview: "Hello Ana",
      aiReplies: { windowStart: NOW - 1000, count: 3 },
    });
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("sending:deliver");
    expect(jobs[0].args).toEqual([{ messageId }]);
  });
});

describe("deliver", () => {
  it("sent records the wamid", async () => {
    const { t, conversationId } = await seed();
    const fetchMock = stubFetch(ok("wamid.X"));
    const messageId = await queueReply(t, conversationId, "Hello Ana");

    await drain(t);

    expect(await getMessage(t, messageId)).toMatchObject({ status: "sent", wamid: "wamid.X" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SEND_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer pk_smoke_test_key",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      poolNumberId: "pn_1",
      to: "5511900000000",
      text: "Hello Ana",
    });
    expect(await getConversation(t, conversationId)).toMatchObject({
      mode: "ai",
      lastFrom: "ai",
      lastPreview: "Hello Ana",
    });
  });

  it("BSUID-only conversation sends to the user id", async () => {
    const { t, conversationId } = await seed({
      waId: undefined,
      userId: "US.13491208655302741918",
    });
    const fetchMock = stubFetch(ok());
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).to).toBe(
      "US.13491208655302741918",
    );
    expect((await getMessage(t, messageId))?.status).toBe("sent");
  });

  it("blocked number fails without fetch and hands to a human", async () => {
    const { t, conversationId } = await seed(
      {},
      { health: { state: "unhealthy", canSendMessage: "BLOCKED", checkedAt: 0 } },
    );
    const fetchMock = stubFetch(ok());
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getMessage(t, messageId)).toMatchObject({
      status: "failed",
      error: "number_blocked",
    });
    expect(await getConversation(t, conversationId)).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_error",
      lastError: sendErrorMessage("number_blocked"),
    });
  });

  it("limited number still sends", async () => {
    const { t, conversationId } = await seed(
      {},
      { health: { state: "unhealthy", canSendMessage: "LIMITED", checkedAt: 0 } },
    );
    const fetchMock = stubFetch(ok());
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getMessage(t, messageId))?.status).toBe("sent");
  });

  it("SERVICE_WINDOW_EXPIRED fails window_closed", async () => {
    const { t, conversationId } = await seed();
    const fetchMock = stubFetch(() =>
      jsonResponse({ error: "Service window expired", code: "SERVICE_WINDOW_EXPIRED" }, 403),
    );
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getMessage(t, messageId)).toMatchObject({
      status: "failed",
      error: "window_closed",
    });
    expect(await getConversation(t, conversationId)).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_error",
      lastError: sendErrorMessage("window_closed"),
    });
  });

  it("2xx without messageId is a failure", async () => {
    const { t, conversationId } = await seed();
    stubFetch(() => jsonResponse({ contacts: [] }, 201));
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(await getMessage(t, messageId)).toMatchObject({ status: "failed", error: "http_201" });
  });

  it("missing API key fails not_configured", async () => {
    vi.stubEnv("PIPES_API_KEY", undefined);
    const { t, conversationId } = await seed();
    const fetchMock = stubFetch(ok());
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getMessage(t, messageId)).toMatchObject({
      status: "failed",
      error: "not_configured",
    });
  });

  it("429 queues then sends", async () => {
    const { t, conversationId } = await seed();
    const reset = String(Math.floor(Date.now() / 1000) + 5);
    const fetchMock = stubFetch(
      () =>
        jsonResponse({ error: "Too many", code: "RATE_LIMITED" }, 429, {
          "X-RateLimit-Reset": reset,
        }),
      ok("wamid.Y"),
    );
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(await getMessage(t, messageId)).toMatchObject({
      status: "sent",
      wamid: "wamid.Y",
      attempt: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getConversation(t, conversationId))?.mode).toBe("ai");
  });

  it("deliver reports queued after a 429", async () => {
    const { t, conversationId } = await seed();
    stubFetch(() => jsonResponse({ error: "Too many", code: "RATE_LIMITED" }, 429));
    const messageId = await queueReply(t, conversationId);

    expect(await t.action(internal.sending.deliver, { messageId })).toBe("queued");
    expect(await getMessage(t, messageId)).toMatchObject({ status: "queued", attempt: 2 });
  });

  it("429 three times fails rate_limited", async () => {
    const { t, conversationId } = await seed();
    const fetchMock = stubFetch(() =>
      jsonResponse({ error: "Too many", code: "RATE_LIMITED" }, 429),
    );
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(await getMessage(t, messageId)).toMatchObject({
      status: "failed",
      error: "rate_limited",
      attempt: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await getConversation(t, conversationId)).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_error",
    });
  });

  it("timeout fails unknown without another call", async () => {
    const { t, conversationId } = await seed();
    const fetchMock = vi.fn(async () => {
      throw new DOMException("", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(await getMessage(t, messageId)).toMatchObject({ status: "failed", error: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getConversation(t, conversationId)).toMatchObject({
      mode: "waiting_human",
      lastError: sendErrorMessage("unknown"),
    });
  });

  it("network error fails network_error without another call", async () => {
    const { t, conversationId } = await seed();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    expect(await getMessage(t, messageId)).toMatchObject({
      status: "failed",
      error: "network_error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("demo number skips fetch and reaches delivered", async () => {
    vi.stubEnv("PIPES_API_KEY", undefined);
    const { t, conversationId } = await seed({}, { isDemo: true });
    const fetchMock = stubFetch(ok());
    const messageId = await queueReply(t, conversationId);

    await drain(t);

    const message = await getMessage(t, messageId);
    expect(message?.status).toBe("delivered");
    expect(message?.wamid).toMatch(/^wamid\.demo_[0-9a-z]{8}$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("failure after a take over leaves the mode alone", async () => {
    const { t, conversationId } = await seed();
    stubFetch(() => jsonResponse({ error: "boom" }, 500));
    const messageId = await queueReply(t, conversationId);
    await t.run((ctx) => ctx.db.patch(conversationId, { mode: "human", modeChangedAt: NOW }));

    await drain(t);

    expect(await getMessage(t, messageId)).toMatchObject({ status: "failed", error: "http_500" });
    const conversation = await getConversation(t, conversationId);
    expect(conversation?.mode).toBe("human");
    expect(conversation?.lastError).toBeUndefined();
    expect(conversation?.handoffReason).toBeUndefined();
  });

  it("a second call does not send a message twice", async () => {
    const { t, conversationId } = await seed();
    const fetchMock = stubFetch(ok());
    const messageId = await queueReply(t, conversationId);
    await drain(t);

    expect(await t.action(internal.sending.deliver, { messageId })).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deliver for a deleted message is a no-op", async () => {
    const { t, conversationId } = await seed();
    const fetchMock = stubFetch(ok());
    const messageId = await queueReply(t, conversationId);
    await t.run((ctx) => ctx.db.delete(messageId));

    expect(await t.action(internal.sending.deliver, { messageId })).toBe("gone");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deliver for a deleted conversation or number is a no-op", async () => {
    const { t, conversationId, numberId } = await seed();
    const fetchMock = stubFetch(ok());
    const first = await queueReply(t, conversationId);
    await t.run((ctx) => ctx.db.delete(conversationId));
    expect(await t.action(internal.sending.deliver, { messageId: first })).toBe("gone");

    const other = await seed();
    const second = await queueReply(other.t, other.conversationId);
    await other.t.run((ctx) => ctx.db.delete(other.numberId));
    expect(await other.t.action(internal.sending.deliver, { messageId: second })).toBe("gone");
    expect(fetchMock).not.toHaveBeenCalled();
    void numberId;
  });
});

describe("markDelivered", () => {
  it("moves sent to delivered only", async () => {
    const { t, conversationId } = await seed();
    const sent = await queueReply(t, conversationId);
    const read = await queueReply(t, conversationId);
    const failed = await queueReply(t, conversationId);
    await t.run(async (ctx) => {
      await ctx.db.patch(sent, { status: "sent" });
      await ctx.db.patch(read, { status: "read" });
      await ctx.db.patch(failed, { status: "failed", error: "boom" });
    });

    for (const messageId of [sent, read, failed]) {
      await t.mutation(internal.sending.markDelivered, { messageId });
    }

    expect((await getMessage(t, sent))?.status).toBe("delivered");
    expect((await getMessage(t, read))?.status).toBe("read");
    expect((await getMessage(t, failed))?.status).toBe("failed");
  });
});
