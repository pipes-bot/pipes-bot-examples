import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import testWebhook from "../tests/fixtures/test-webhook.json";
import { makeT, signedRequest, TEST_WEBHOOK_SECRET } from "../tests/helpers";

const post = (t: ReturnType<typeof makeT>, req: { body: string; headers: Record<string, string> }) =>
  t.fetch("/webhooks/pipes", { method: "POST", headers: req.headers, body: req.body });

const events = (t: ReturnType<typeof makeT>) =>
  t.run((ctx) => ctx.db.query("events").collect());

beforeEach(() => {
  vi.stubEnv("PIPES_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("accepts the Standard Webhooks repo vector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_614_265_330_000);
    try {
      const t = makeT();
      const res = await t.fetch("/webhooks/pipes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
          "webhook-timestamp": "1614265330",
          "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        },
        body: '{"test": 2432232314}',
      });
      expect(res.status).toBe(200);
      const rows = await events(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ webhookId: "msg_p5jXN8AQM9LWM0D4loKWxJek", state: "ignored" });
    } finally {
      vi.useRealTimers();
    }
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
    vi.stubEnv("PIPES_WEBHOOK_SECRET", "");
    const res = await post(t, req);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("whsec_");
    expect(error).toHaveBeenCalledWith("PIPES_WEBHOOK_SECRET is not set");
  });

  it("malformed secret returns 500", async () => {
    const t = makeT();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = await signedRequest(testWebhook);
    vi.stubEnv("PIPES_WEBHOOK_SECRET", "not-a-secret");
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
});
