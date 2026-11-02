import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import historyChunk from "../tests/fixtures/history-chunk.json";
import testWebhook from "../tests/fixtures/test-webhook.json";
import { makeT, signedRequest, TEST_WEBHOOK_SECRET } from "../tests/helpers";

const post = (t: ReturnType<typeof makeT>, req: { body: string; headers: Record<string, string> }) =>
  t.fetch("/webhooks/pipes", { method: "POST", headers: req.headers, body: req.body });

const events = (t: ReturnType<typeof makeT>) =>
  t.run((ctx) => ctx.db.query("events").collect());

beforeEach(() => {
  process.env.PIPES_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});

afterEach(() => {
  delete process.env.PIPES_WEBHOOK_SECRET;
  vi.restoreAllMocks();
});

describe("POST /webhooks/pipes", () => {
  it("accepts a valid signed test webhook", async () => {
    const t = makeT();
    const res = await post(t, await signedRequest(testWebhook));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const rows = await events(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("ignored");
    expect(rows[0].kind).toBe("test");
  });

  it("rejects a tampered body", async () => {
    const t = makeT();
    const res = await post(t, await signedRequest(testWebhook, { tamper: true }));
    expect(res.status).toBe(401);
    expect(await events(t)).toHaveLength(0);
  });

  it("rejects a request without signature headers", async () => {
    const t = makeT();
    const res = await t.fetch("/webhooks/pipes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testWebhook),
    });
    expect(res.status).toBe(401);
  });

  it.each([["null"], ["[1]"], ["not json"], ['"text"']])(
    "rejects signed body %s that is not a JSON object",
    async (body) => {
      const t = makeT();
      const res = await post(t, await signedRequest(body));
      expect(res.status).toBe(400);
      expect(await events(t)).toHaveLength(0);
    },
  );

  it("missing secret returns 500", async () => {
    const t = makeT();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = await signedRequest(testWebhook);
    delete process.env.PIPES_WEBHOOK_SECRET;
    const res = await post(t, req);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("whsec_");
    expect(error).toHaveBeenCalledWith("PIPES_WEBHOOK_SECRET is not set");
  });

  it("malformed secret returns 500", async () => {
    const t = makeT();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = await signedRequest(testWebhook);
    process.env.PIPES_WEBHOOK_SECRET = "not-a-secret";
    const res = await post(t, req);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("not-a-secret");
    expect(error).toHaveBeenCalledWith("PIPES_WEBHOOK_SECRET is invalid");
  });

  it("stores the same delivery once", async () => {
    const t = makeT();
    const req = await signedRequest(testWebhook, { id: "msg_same" });
    expect((await post(t, req)).status).toBe(200);
    expect((await post(t, req)).status).toBe(200);
    const rows = await events(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].webhookId).toBe("msg_same");
  });

  it("sends history to storage, not ingest", async () => {
    const t = makeT();
    const res = await post(t, await signedRequest(historyChunk));
    expect(res.status).toBe(200);
    const rows = await events(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("history");
    expect(rows[0].storageId).toBeDefined();
    expect(rows[0].payload.whatsapp).toBeUndefined();
    expect(rows[0].payload.summary).toMatchObject({ messageCount: 2, progress: 40 });
    const stored = await t.run(async (ctx) => (await ctx.storage.get(rows[0].storageId!))?.text());
    expect(JSON.parse(stored!).field).toBe("history");
  });

  it("accepts a history chunk over 1 MiB", async () => {
    const t = makeT();
    const chunk = structuredClone(historyChunk) as any;
    chunk.whatsapp.history[0].threads[0].messages = Array.from({ length: 6000 }, (_, i) => ({
      from: "16505551234",
      id: `wamid.BIG${i}`,
      timestamp: String(1_760_400_000 + i),
      type: "text",
      text: { body: "hello there, this is a message with some filler text to add weight" },
      history_context: { status: "READ" },
    }));
    const req = await signedRequest(chunk);
    expect(req.body.length).toBeGreaterThan(1024 * 1024);
    const res = await post(t, req);
    expect(res.status).toBe(200);
    const rows = await events(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].storageId).toBeDefined();
    expect(rows[0].payload.summary.messageCount).toBe(6000);
  });

  it("does not store a blob for a history event without messages", async () => {
    const t = makeT();
    const declined = { ...structuredClone(historyChunk), id: "evt_declined" } as any;
    declined.whatsapp.history = [{ errors: [{ code: 2593109 }] }];
    expect((await post(t, await signedRequest(declined))).status).toBe(200);
    const rows = await events(t);
    expect(rows[0].kind).toBe("history");
    expect(rows[0].storageId).toBeUndefined();
  });
});
