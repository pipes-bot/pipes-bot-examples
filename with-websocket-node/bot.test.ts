import assert from "node:assert/strict";
import { test } from "node:test";
import { createDedup, modeFromKey, repliesFor, resultLine } from "./bot.ts";

// Frames are inlined (starters never import from ../fixtures).
const sandboxText = (text = "Hello", messageId = "msg_abc123") => ({
  type: "whatsapp_message",
  data: {
    messageId,
    conversationId: "conv_xyz789",
    poolNumberId: "pool_123",
    fromNumber: "+15559876543",
    fromName: "Jane Doe",
    text,
    body: text,
    type: "text",
  },
});

// v2 envelope copied from byon-v2/message-text.
const byonEnvelope = () => ({
  id: "evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  field: "messages",
  createdAt: "2025-06-08T20:59:44.512Z",
  pipes: { appId: "app_abc123", poolNumberId: "pn_abc123", media: {} },
  whatsapp: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550001111", phone_number_id: "106540352242922" },
    contacts: [
      {
        profile: { name: "Sheena Nelson" },
        wa_id: "16505551234",
        user_id: "US.13491208655302741918",
      },
    ],
    messages: [
      {
        from: "16505551234",
        from_user_id: "US.13491208655302741918",
        id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
        timestamp: "1749416383",
        type: "text",
        text: { body: "Does it come in another color?" },
      },
    ],
  },
});
const byonEvent = (data: object = byonEnvelope()) => ({ type: "event", data });
const always = () => true;

test("sandbox text produces exactly one whatsapp_reply", () => {
  const out = repliesFor(sandboxText(), "sandbox", always);
  assert.deepEqual(out, [
    {
      type: "whatsapp_reply",
      data: { conversationId: "conv_xyz789", toNumber: "+15559876543", text: "Echo: Hello" },
    },
  ]);
});

test("sandbox ignores non-text messages and other frames", () => {
  const image = sandboxText();
  image.data.type = "image";
  assert.deepEqual(repliesFor(image, "sandbox", always), []);
  assert.deepEqual(repliesFor({ type: "connected", scope: "user" }, "sandbox", always), []);
  assert.deepEqual(repliesFor(byonEvent(), "sandbox", always), []);
});

test("sandbox drops duplicates by messageId", () => {
  const isNew = createDedup();
  assert.equal(repliesFor(sandboxText(), "sandbox", isNew).length, 1);
  assert.deepEqual(repliesFor(sandboxText(), "sandbox", isNew), []);
  assert.equal(repliesFor(sandboxText("Hi", "msg_other"), "sandbox", isNew).length, 1);
});

test("byon text with from replies to to", () => {
  const out = repliesFor(byonEvent(), "byon", always) as any[];
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "send");
  assert.equal(out[0].poolNumberId, "pn_abc123");
  assert.equal(out[0].requestId, byonEnvelope().whatsapp.messages[0]!.id);
  assert.equal(out[0].message.messaging_product, "whatsapp");
  assert.equal(out[0].message.to, "16505551234");
  assert.equal("recipient" in out[0].message, false);
  assert.equal(out[0].message.type, "text");
  assert.deepEqual(out[0].message.text, { body: "Echo: Does it come in another color?" });
});

test("byon text without from replies to recipient (BSUID)", () => {
  const envelope = byonEnvelope();
  delete (envelope.whatsapp.messages[0] as any).from;
  const out = repliesFor(byonEvent(envelope), "byon", always) as any[];
  assert.equal(out.length, 1);
  assert.equal(out[0].message.recipient, "US.13491208655302741918");
  assert.equal("to" in out[0].message, false);
});

test("byon sends one frame per text message and skips other types", () => {
  const envelope = byonEnvelope();
  const [first] = envelope.whatsapp.messages;
  envelope.whatsapp.messages.push(
    { ...first!, id: "wamid.second", text: { body: "Second" } },
    { ...first!, id: "wamid.image", type: "image" } as any,
  );
  const out = repliesFor(byonEvent(envelope), "byon", always) as any[];
  assert.deepEqual(
    out.map((f) => f.requestId),
    [first!.id, "wamid.second"],
  );
  assert.equal(out[1].message.text.body, "Echo: Second");
});

test("byon smb_message_echoes yields nothing", () => {
  const echo = {
    id: "evt_9704f2252ffc4c0ea3df9122362d4033",
    field: "smb_message_echoes",
    pipes: { appId: "app_123", poolNumberId: "pn_123", media: {} },
    whatsapp: {
      messaging_product: "whatsapp",
      message_echoes: [
        { from: "15550001111", to: "5511987654321", id: "wamid.echo", type: "text", text: { body: "Oi" } },
      ],
    },
  };
  assert.deepEqual(repliesFor(byonEvent(echo), "byon", always), []);
});

test("byon statuses-only event yields nothing", () => {
  const statuses = {
    id: "evt_6f708192a3b4c5d6e7f8091a2b3c4d5e",
    field: "messages",
    pipes: { appId: "app_abc123", poolNumberId: "pn_abc123", media: {} },
    whatsapp: {
      messaging_product: "whatsapp",
      statuses: [{ id: "wamid.status", status: "delivered", timestamp: "1750030073" }],
    },
  };
  assert.deepEqual(repliesFor(byonEvent(statuses), "byon", always), []);
});

test("the same byon event twice only replies once", () => {
  const isNew = createDedup();
  assert.equal(repliesFor(byonEvent(), "byon", isNew).length, 1);
  assert.deepEqual(repliesFor(byonEvent(), "byon", isNew), []);
});

test("malformed frames never throw and yield nothing", () => {
  const bad: unknown[] = [
    null,
    undefined,
    "text",
    42,
    [],
    {},
    { type: "event" },
    { type: "event", data: null },
    { type: "event", data: "x" },
    { type: "event", data: { id: "evt_1", field: "messages", whatsapp: null } },
    { type: "event", data: { id: "evt_1", field: "messages", whatsapp: { messages: "nope" } } },
    { type: "event", data: { id: "evt_1", field: "messages", whatsapp: { messages: [null, 3] } } },
    { type: "whatsapp_message" },
    { type: "whatsapp_message", data: [] },
  ];
  for (const frame of bad) {
    assert.deepEqual(repliesFor(frame, "byon", always), []);
    assert.deepEqual(repliesFor(frame, "sandbox", always), []);
  }
});

test("frames without a string id are skipped and not deduped", () => {
  const logs: string[] = [];
  const isNew = createDedup();
  const noId = byonEvent({ ...byonEnvelope(), id: undefined });
  assert.deepEqual(repliesFor(noId, "byon", isNew, (l) => logs.push(l)), []);
  assert.deepEqual(repliesFor(noId, "byon", isNew, (l) => logs.push(l)), []);
  assert.deepEqual(logs, ["skipped missing-id -", "skipped missing-id -"]);

  const sandbox = sandboxText();
  delete (sandbox.data as any).messageId;
  assert.deepEqual(repliesFor(sandbox, "sandbox", isNew), []);
  assert.deepEqual(repliesFor(sandbox, "sandbox", isNew), []);
});

test("log lines follow the shared formats", () => {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const isNew = createDedup();
  repliesFor(sandboxText(), "sandbox", isNew, log);
  repliesFor(sandboxText(), "sandbox", isNew, log);
  const image = sandboxText("", "msg_img");
  image.data.type = "image";
  repliesFor(image, "sandbox", isNew, log);
  assert.deepEqual(logs, ["received message msg_abc123", "duplicate msg_abc123", "skipped image msg_img"]);
});

test("modeFromKey picks the mode from the prefix", () => {
  assert.equal(modeFromKey("pk_abc"), "sandbox");
  assert.equal(modeFromKey("ak_abc"), "byon");
});

test("modeFromKey rejects missing and unknown keys", () => {
  assert.throws(() => modeFromKey("xk_1"), /PIPES_API_KEY must start with pk_ or ak_/);
  assert.throws(() => modeFromKey(undefined), /PIPES_API_KEY must start with pk_ or ak_/);
  assert.throws(() => modeFromKey(""), /PIPES_API_KEY must start with pk_ or ak_/);
});

test("createDedup evicts the oldest entry past its limit", () => {
  const isNew = createDedup(2);
  assert.equal(isNew("a"), true);
  assert.equal(isNew("b"), true);
  assert.equal(isNew("a"), false);
  assert.equal(isNew("c"), true); // evicts "a"
  assert.equal(isNew("a"), true); // "a" was forgotten (and evicts "b")
  assert.equal(isNew("c"), false);
});

test("resultLine reports send_result and reply_status outcomes", () => {
  assert.deepEqual(resultLine({ type: "send_result", requestId: "r1", success: true, messageId: "wamid.x" }), {
    ok: true,
    line: "replied r1",
  });
  const failed = resultLine({
    type: "send_result",
    requestId: "r1",
    success: false,
    error: { code: "NOT_FOUND", message: "BYON number not found" },
  });
  assert.equal(failed?.ok, false);
  assert.match(failed!.line, /^send failed r1: /);
  assert.match(failed!.line, /NOT_FOUND/);

  assert.deepEqual(resultLine({ type: "reply_status", data: { conversationId: "c1", success: true } }), {
    ok: true,
    line: "replied c1",
  });
  const rejected = resultLine({
    type: "reply_status",
    data: { conversationId: "c1", success: false, error: "Service window expired", code: "SERVICE_WINDOW_EXPIRED" },
  });
  assert.equal(rejected?.ok, false);
  assert.match(rejected!.line, /^send failed c1: Service window expired/);
  assert.match(rejected!.line, /SERVICE_WINDOW_EXPIRED/);

  assert.equal(resultLine({ type: "connected" }), undefined);
  assert.equal(resultLine(null), undefined);
  assert.equal(resultLine({ type: "send_result" }) !== undefined, true); // malformed result still reported, never throws
});
