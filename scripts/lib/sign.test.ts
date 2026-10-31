import { test } from "node:test";
import assert from "node:assert/strict";
import { signSandbox, signStandardWebhook } from "./sign.ts";

test("signStandardWebhook matches the Standard Webhooks reference vector", () => {
  assert.equal(
    signStandardWebhook(
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1614265330,
      '{"test": 2432232314}',
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    ),
    "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  );
});

test("signSandbox returns lowercase hex HMAC-SHA256", () => {
  assert.equal(
    signSandbox("hello", "secret"),
    "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
  );
});
