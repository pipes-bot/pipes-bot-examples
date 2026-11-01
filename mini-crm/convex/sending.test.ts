import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOUR,
  makeT,
  seedContact,
  seedNumber,
  seedUser,
  type TestConvex,
} from "../tests/helpers";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const SEND_URL = "https://api.pipes.bot/v1/messages/app/send";

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

async function seed(
  contact: Partial<Doc<"contacts">> = {},
  number: Partial<Doc<"numbers">> = {},
) {
  const t = makeT();
  const { workspaceId, asUser } = await seedUser(t);
  const numberId = await seedNumber(t, workspaceId, number);
  const contactId = await seedContact(t, workspaceId, numberId, contact);
  return { t, workspaceId, asUser, numberId, contactId };
}

function messagesOf(t: TestConvex, contactId: Id<"contacts">) {
  return t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_contact_sent_at", (q) => q.eq("contactId", contactId))
      .collect(),
  );
}

async function activitiesOf(t: TestConvex, contactId: Id<"contacts">, kind: string) {
  const all = await t.run((ctx) =>
    ctx.db
      .query("activities")
      .withIndex("by_contact_created", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  return all.filter((a) => a.kind === kind);
}

function scheduled(t: TestConvex) {
  return t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

beforeEach(() => {
  vi.stubEnv("PIPES_API_KEY", "pk_smoke_test_key");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("send", () => {
  it("send records wamid and activity", async () => {
    const { t, asUser, contactId } = await seed();
    const fetchMock = stubFetch(ok("wamid.X"));

    const result = await asUser.action(api.sending.send, { contactId, text: "  Hello Ana  " });

    expect(result.status).toBe("sent");
    const [message] = await messagesOf(t, contactId);
    expect(result.messageId).toBe(message._id);
    expect(message).toMatchObject({
      status: "sent",
      wamid: "wamid.X",
      text: "Hello Ana",
      direction: "out",
      source: "app",
      type: "text",
      attempt: 1,
    });
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
    const sent = await activitiesOf(t, contactId, "message_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ actor: "you", detail: "Hello Ana" });
    const contact = await t.run((ctx) => ctx.db.get(contactId));
    expect(contact).toMatchObject({ lastDirection: "out", lastPreview: "Hello Ana" });
  });

  it("BSUID-only contact sends to the user id", async () => {
    const { t, asUser, contactId } = await seed({
      waId: undefined,
      userId: "US.13491208655302741918",
    });
    const fetchMock = stubFetch(ok());

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result.status).toBe("sent");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).to).toBe(
      "US.13491208655302741918",
    );
    expect(await messagesOf(t, contactId)).toHaveLength(1);
  });

  it("window closed refuses without writing", async () => {
    const { t, asUser, contactId } = await seed({ lastInboundAt: Date.now() - 25 * HOUR });
    const fetchMock = stubFetch(ok());

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result).toEqual({ status: "failed", error: "window_closed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await messagesOf(t, contactId)).toHaveLength(0);
    expect(await activitiesOf(t, contactId, "message_sent")).toHaveLength(0);
  });

  it("invalid text refuses without writing", async () => {
    const { t, asUser, contactId } = await seed();
    const fetchMock = stubFetch(ok());

    expect(await asUser.action(api.sending.send, { contactId, text: "   " })).toEqual({
      status: "failed",
      error: "invalid_text",
    });
    expect(await asUser.action(api.sending.send, { contactId, text: "x".repeat(4097) })).toEqual(
      { status: "failed", error: "invalid_text" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await messagesOf(t, contactId)).toHaveLength(0);
  });

  it("blocked number refuses", async () => {
    const { t, asUser, contactId } = await seed(
      {},
      { health: { state: "unhealthy", canSendMessage: "BLOCKED", checkedAt: 0 } },
    );
    const fetchMock = stubFetch(ok());

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result).toEqual({ status: "failed", error: "number_blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await messagesOf(t, contactId)).toHaveLength(0);
  });

  it("number of another workspace is unavailable", async () => {
    const t = makeT();
    const { workspaceId, asUser } = await seedUser(t, "user_a");
    const { workspaceId: otherWorkspaceId } = await seedUser(t, "user_b");
    // The number moved to user_b's workspace through a re-onboarding.
    const movedNumberId = await seedNumber(t, otherWorkspaceId);
    const contactId = await seedContact(t, workspaceId, movedNumberId);
    const fetchMock = stubFetch(ok());

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result).toEqual({ status: "failed", error: "number_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await messagesOf(t, contactId)).toHaveLength(0);
  });

  it("deleted number is unavailable", async () => {
    const { t, asUser, contactId, numberId } = await seed();
    await t.run((ctx) => ctx.db.delete(numberId));
    const fetchMock = stubFetch(ok());

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result).toEqual({ status: "failed", error: "number_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await messagesOf(t, contactId)).toHaveLength(0);
  });

  it("contact of another workspace is not found", async () => {
    const { t, contactId } = await seed();
    const { asUser: other } = await seedUser(t, "user_b");
    const fetchMock = stubFetch(ok());

    await expect(other.action(api.sending.send, { contactId, text: "Hi" })).rejects.toThrow(
      /Not found/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await messagesOf(t, contactId)).toHaveLength(0);
  });

  it("SERVICE_WINDOW_EXPIRED marks failed window_closed", async () => {
    const { t, asUser, contactId } = await seed();
    const fetchMock = stubFetch(() =>
      jsonResponse({ error: "Service window expired", code: "SERVICE_WINDOW_EXPIRED" }, 403),
    );

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result).toMatchObject({ status: "failed", error: "window_closed" });
    const [message] = await messagesOf(t, contactId);
    expect(result.messageId).toBe(message._id);
    expect(message).toMatchObject({ status: "failed", error: "window_closed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await activitiesOf(t, contactId, "message_sent")).toHaveLength(0);
  });

  it("2xx without messageId is a failure", async () => {
    const { t, asUser, contactId } = await seed();
    stubFetch(() => jsonResponse({ contacts: [] }, 201));

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result).toMatchObject({ status: "failed", error: "http_201" });
    const [message] = await messagesOf(t, contactId);
    expect(message).toMatchObject({ status: "failed", error: "http_201" });
  });

  it("429 queues then sends", async () => {
    vi.useFakeTimers();
    const { t, asUser, contactId } = await seed();
    const reset = String(Math.floor(Date.now() / 1000) + 5);
    const fetchMock = stubFetch(
      () =>
        jsonResponse({ error: "Too many", code: "RATE_LIMITED" }, 429, {
          "X-RateLimit-Reset": reset,
        }),
      ok("wamid.Y"),
    );

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });
    expect(result.status).toBe("queued");
    const [queued] = await messagesOf(t, contactId);
    expect(queued).toMatchObject({ status: "queued", attempt: 2 });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [message] = await messagesOf(t, contactId);
    expect(message).toMatchObject({ status: "sent", wamid: "wamid.Y", attempt: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await activitiesOf(t, contactId, "message_sent")).toHaveLength(1);
  });

  it("429 three times fails rate_limited", async () => {
    vi.useFakeTimers();
    const { t, asUser, contactId } = await seed();
    const fetchMock = stubFetch(() =>
      jsonResponse({ error: "Too many", code: "RATE_LIMITED" }, 429),
    );

    await asUser.action(api.sending.send, { contactId, text: "Hi" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [message] = await messagesOf(t, contactId);
    expect(message).toMatchObject({ status: "failed", error: "rate_limited", attempt: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("timeout fails without another call", async () => {
    const { t, asUser, contactId } = await seed();
    const fetchMock = vi.fn(async () => {
      throw new DOMException("", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result).toMatchObject({ status: "failed", error: "timeout" });
    const [message] = await messagesOf(t, contactId);
    expect(message).toMatchObject({ status: "failed", error: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await scheduled(t)).toHaveLength(0);
  });

  it("missing API key fails not_configured", async () => {
    vi.stubEnv("PIPES_API_KEY", undefined);
    const { t, asUser, contactId } = await seed();
    const fetchMock = stubFetch(ok());

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result).toMatchObject({ status: "failed", error: "not_configured" });
    const [message] = await messagesOf(t, contactId);
    expect(message).toMatchObject({ status: "failed", error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("demo number never calls fetch", async () => {
    vi.stubEnv("PIPES_API_KEY", undefined);
    const { t, asUser, contactId } = await seed({}, { isDemo: true });
    const fetchMock = stubFetch(ok());

    const result = await asUser.action(api.sending.send, { contactId, text: "Hi" });

    expect(result.status).toBe("sent");
    const [message] = await messagesOf(t, contactId);
    expect(message.status).toBe("sent");
    expect(message.wamid).toMatch(/^wamid\.demo_[0-9a-z]{8}$/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await activitiesOf(t, contactId, "message_sent")).toHaveLength(1);
  });
});

describe("retry", () => {
  it("retry creates a new message and links it", async () => {
    const { t, workspaceId, asUser, contactId } = await seed();
    const fetchMock = stubFetch(() => jsonResponse({ error: "boom" }, 500), ok("wamid.R"));
    const failed = await t.action(internal.sending.sendMessage, {
      workspaceId,
      contactId,
      text: "Hi there",
      source: "mcp",
      clientName: "Claude",
    });
    expect(failed).toMatchObject({ status: "failed", error: "http_500" });

    const result = await asUser.action(api.sending.retry, { messageId: failed.messageId! });

    expect(result.status).toBe("sent");
    expect(result.messageId).not.toBe(failed.messageId);
    const original = await t.run((ctx) => ctx.db.get(failed.messageId!));
    expect(original).toMatchObject({ status: "failed", retriedBy: result.messageId });
    const retried = await t.run((ctx) => ctx.db.get(result.messageId!));
    expect(retried).toMatchObject({
      status: "sent",
      wamid: "wamid.R",
      text: "Hi there",
      source: "mcp",
      clientName: "Claude",
      attempt: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = await activitiesOf(t, contactId, "message_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].actor).toBe("Claude");
  });

  it("retry twice is refused", async () => {
    const { t, asUser, contactId } = await seed();
    const fetchMock = stubFetch(() => jsonResponse({ error: "boom" }, 500));
    const failed = await asUser.action(api.sending.send, { contactId, text: "Hi" });
    const first = await asUser.action(api.sending.retry, { messageId: failed.messageId! });
    expect(first.status).toBe("failed");

    await expect(
      asUser.action(api.sending.retry, { messageId: failed.messageId! }),
    ).rejects.toThrow(/already retried/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await messagesOf(t, contactId)).toHaveLength(2);

    // The retry failed too, so it can be retried itself; a sent message cannot.
    stubFetch(ok());
    const second = await asUser.action(api.sending.retry, { messageId: first.messageId! });
    expect(second.status).toBe("sent");
    await expect(
      asUser.action(api.sending.retry, { messageId: second.messageId! }),
    ).rejects.toThrow(/Only a failed message/);
  });

  it("retry of another workspace's message is not found", async () => {
    const { t, asUser, contactId } = await seed();
    stubFetch(() => jsonResponse({ error: "boom" }, 500));
    const failed = await asUser.action(api.sending.send, { contactId, text: "Hi" });
    const { asUser: other } = await seedUser(t, "user_b");

    await expect(
      other.action(api.sending.retry, { messageId: failed.messageId! }),
    ).rejects.toThrow(/Not found/);
    expect(await messagesOf(t, contactId)).toHaveLength(1);
  });
});
