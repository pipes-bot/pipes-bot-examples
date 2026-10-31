import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { signSandbox, signStandardWebhook } from "./lib/sign.ts";
import { simulate } from "./simulate-webhook.ts";

type Received = { headers: Record<string, string | string[] | undefined>; body: string };
const received: Received[] = [];

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
after(() => server.close());

const byonSecret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

test("byon message-text is signed with Standard Webhooks headers", async () => {
  received.length = 0;
  const results = await simulate({ fixture: "byon-v2/message-text", url, secret: byonSecret });
  assert.deepEqual(results, [{ status: 200, body: "ok" }]);
  const { headers, body } = received[0];
  assert.equal(headers["webhook-id"], "evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(
    headers["webhook-signature"],
    signStandardWebhook(
      headers["webhook-id"] as string,
      Number(headers["webhook-timestamp"]),
      body,
      byonSecret,
    ),
  );
});

test("idSuffix changes the envelope id and the webhook-id header", async () => {
  received.length = 0;
  await simulate({ fixture: "byon-v2/message-text", url, secret: byonSecret, idSuffix: "_x" });
  const { headers, body } = received[0];
  assert.ok((headers["webhook-id"] as string).endsWith("_x"));
  assert.equal(JSON.parse(body).id, headers["webhook-id"]);
});

test("extraSignature sends a bogus signature first and the valid one second", async () => {
  received.length = 0;
  await simulate({ fixture: "byon-v2/message-text", url, secret: byonSecret, extraSignature: true });
  const { headers, body } = received[0];
  const parts = (headers["webhook-signature"] as string).split(" ");
  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => part.startsWith("v1,")));
  assert.equal(
    parts[1],
    signStandardWebhook(
      headers["webhook-id"] as string,
      Number(headers["webhook-timestamp"]),
      body,
      byonSecret,
    ),
  );
  assert.notEqual(parts[0], parts[1]);
});

test("sandbox message-text with unicode text is signed over the raw body", async () => {
  received.length = 0;
  await simulate({ fixture: "sandbox/message-text", url, secret: "s3cret", text: "Olá 👋" });
  const { headers, body } = received[0];
  assert.equal(JSON.parse(body).entry[0].changes[0].value.messages[0].text.body, "Olá 👋");
  assert.equal(headers["x-pipes-signature"], signSandbox(body, "s3cret"));
  assert.equal(headers["webhook-id"], undefined);
});

test("times sends the same webhook-id on every attempt", async () => {
  received.length = 0;
  const results = await simulate({ fixture: "byon-v2/message-text", url, secret: byonSecret, times: 2 });
  assert.equal(results.length, 2);
  assert.equal(received.length, 2);
  assert.equal(received[0].headers["webhook-id"], received[1].headers["webhook-id"]);
  assert.equal(received[0].body, received[1].body);
});

test("fixtures without an id fall back to evt_fixture_<name>", async () => {
  received.length = 0;
  await simulate({ fixture: "byon-v2/number-onboarded", url, secret: byonSecret });
  assert.equal(received[0].headers["webhook-id"], "evt_fixture_number_onboarded");
});

test("noSignature omits signature headers", async () => {
  received.length = 0;
  await simulate({ fixture: "byon-v2/message-text", url, secret: byonSecret, noSignature: true });
  assert.equal(received[0].headers["webhook-signature"], undefined);
  assert.equal(received[0].headers["x-pipes-signature"], undefined);
});

test("badSignature does not verify with the real secret", async () => {
  received.length = 0;
  await simulate({ fixture: "byon-v2/message-text", url, secret: byonSecret, badSignature: true });
  const { headers, body } = received[0];
  assert.notEqual(
    headers["webhook-signature"],
    signStandardWebhook(headers["webhook-id"] as string, Number(headers["webhook-timestamp"]), body, byonSecret),
  );
  received.length = 0;
  await simulate({ fixture: "sandbox/message-text", url, secret: "s3cret", badSignature: true });
  assert.notEqual(received[0].headers["x-pipes-signature"], signSandbox(received[0].body, "s3cret"));
});

test("timestampOffset shifts webhook-timestamp and rawBody is sent verbatim", async () => {
  received.length = 0;
  const raw = "not json {";
  const before = Math.floor(Date.now() / 1000);
  await simulate({ fixture: "byon-v2/message-text", url, secret: byonSecret, timestampOffset: -600, rawBody: raw });
  const { headers, body } = received[0];
  assert.equal(body, raw);
  assert.ok(Number(headers["webhook-timestamp"]) <= before - 599);
  assert.equal(headers["webhook-id"], "evt_fixture_message_text");
  assert.equal(
    headers["webhook-signature"],
    signStandardWebhook(headers["webhook-id"] as string, Number(headers["webhook-timestamp"]), raw, byonSecret),
  );
});
