import { describe, expect, test } from "vitest";
import { verifyStandardWebhook } from "./signature";

const base = {
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  body: '{"test": 2432232314}',
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  nowMs: 1614265330000,
};

describe("verifyStandardWebhook", () => {
  test("accepts the repo vector", async () => {
    expect(await verifyStandardWebhook(base)).toBe(true);
  });
  test("rejects a timestamp outside the tolerance", async () => {
    expect(
      await verifyStandardWebhook({ ...base, nowMs: base.nowMs + 301_000 }),
    ).toBe(false);
  });
  test("accepts when any listed signature matches", async () => {
    expect(
      await verifyStandardWebhook({
        ...base,
        signature: "v1,AAAA v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      }),
    ).toBe(true);
  });
  test("rejects a changed body", async () => {
    expect(
      await verifyStandardWebhook({ ...base, body: '{"test": 2432232315}' }),
    ).toBe(false);
  });
  test("rejects a missing signature", async () => {
    expect(await verifyStandardWebhook({ ...base, signature: null })).toBe(
      false,
    );
  });
  test("rejects a malformed timestamp", async () => {
    expect(
      await verifyStandardWebhook({ ...base, timestamp: "16142653300000" }),
    ).toBe(false);
  });
  test("throws on an invalid secret", async () => {
    await expect(
      verifyStandardWebhook({ ...base, secret: "nope" }),
    ).rejects.toThrow("Invalid webhook secret");
  });
});
