import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messageImage from "../tests/fixtures/message-image.json";
import messageTextBsuidOnly from "../tests/fixtures/message-text-bsuid-only.json";
import messageText from "../tests/fixtures/message-text.json";
import numberOnboarded from "../tests/fixtures/number-onboarded.json";
import smbMessageEcho from "../tests/fixtures/smb-message-echo.json";
import statusDeliveredBsuid from "../tests/fixtures/status-delivered-bsuid.json";
import statusFailed from "../tests/fixtures/status-failed.json";
import systemUserChangedNumber from "../tests/fixtures/system-user-changed-number.json";
import { makeT } from "../tests/helpers";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { sendErrorMessage } from "./lib/send";

const NOW = 1_800_000_000_000;
const POOL = "pn_1";
const CUSTOMER = { waId: "16505551234", userId: "US.13491208655302741918" };

type T = ReturnType<typeof makeT>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Deep copy of an envelope fixture addressed to `poolNumberId`, with its timestamps set to `at`. */
function envelope(fixture: object, opts: { pool?: string; at?: number } = {}): any {
  const copy = structuredClone(fixture) as any;
  copy.pipes.poolNumberId = opts.pool ?? POOL;
  const seconds = String(Math.floor((opts.at ?? Date.now()) / 1000));
  for (const item of [...(copy.whatsapp.messages ?? []), ...(copy.whatsapp.message_echoes ?? [])]) {
    item.timestamp = seconds;
  }
  return copy;
}

/** An echo from the phone to the fixture customer. */
function echoToCustomer(id = smbMessageEcho.whatsapp.message_echoes[0].id): any {
  const echo = envelope(smbMessageEcho);
  echo.whatsapp.message_echoes[0].to = CUSTOMER.waId;
  echo.whatsapp.message_echoes[0].to_user_id = CUSTOMER.userId;
  echo.whatsapp.message_echoes[0].id = id;
  return echo;
}

function onboarded(numberId: string, workspaceId?: string): any {
  const copy = structuredClone(numberOnboarded) as any;
  copy.data.numberId = numberId;
  if (workspaceId) copy.data.metadata = { ...copy.data.metadata, workspaceId };
  return copy;
}

let seq = 0;
const ingest = (t: T, payload: any) =>
  t.mutation(internal.ingest.ingest, { webhookId: `wh_${++seq}`, payload });

async function seedWorkspace(t: T, ownerId = "user_1") {
  return t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerId, name: "Acme", instructions: "", faq: "", idleMinutes: 30 }),
  );
}

/** A workspace with the pool number onboarded into it, AI on unless `aiEnabled` is false. */
async function seedNumber(t: T, opts: { aiEnabled?: boolean; ownerId?: string } = {}) {
  const workspaceId = await seedWorkspace(t, opts.ownerId);
  expect(await ingest(t, onboarded(POOL, workspaceId))).toBe("processed");
  if (opts.aiEnabled !== false) {
    await t.run(async (ctx) => {
      const number = (await ctx.db.query("numbers").first())!;
      await ctx.db.patch(number._id, { aiEnabled: true });
    });
  }
  return workspaceId;
}

const all = <K extends "events" | "numbers" | "conversations" | "messages">(t: T, table: K) =>
  t.run((ctx) => ctx.db.query(table).collect());

const jobs = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

/** An AI reply already sent in `conversation`, as the responder will store it. */
const insertAiMessage = (t: T, conversation: Doc<"conversations">, wamid: string) =>
  t.run((ctx) =>
    ctx.db.insert("messages", {
      workspaceId: conversation.workspaceId,
      conversationId: conversation._id,
      numberId: conversation.numberId,
      wamid,
      direction: "out",
      source: "ai",
      type: "text",
      text: "It also comes in blue.",
      status: "sent",
      sentAt: Date.now(),
    }),
  );

const only = async (t: T) => {
  const rows = await all(t, "conversations");
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe("ingest", () => {
  it("new customer text schedules a reply", async () => {
    const t = makeT();
    const workspaceId = await seedNumber(t);

    expect(await ingest(t, envelope(messageText))).toBe("processed");

    const conversation = await only(t);
    const [number] = await all(t, "numbers");
    expect(conversation).toMatchObject({
      workspaceId,
      numberId: number._id,
      ...CUSTOMER,
      name: "Sheena Nelson",
      mode: "ai",
      aiTurn: 1,
      lastFrom: "customer",
      lastPreview: "Does it come in another color?",
      lastInboundAt: NOW,
      lastMessageAt: NOW,
      aiReplies: { windowStart: 0, count: 0 },
    });
    expect(conversation.pendingReplyJobId).toBeDefined();

    const [message] = await all(t, "messages");
    expect(message).toMatchObject({
      workspaceId,
      conversationId: conversation._id,
      numberId: number._id,
      direction: "in",
      source: "customer",
      status: "delivered",
      type: "text",
      text: "Does it come in another color?",
      sentAt: NOW,
    });

    const scheduled = await jobs(t);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      _id: conversation.pendingReplyJobId,
      name: "responder:respond",
      args: [{ conversationId: conversation._id, turn: 1, attempt: 1 }],
      state: { kind: "pending" },
    });
    // convex-test moves the clock a millisecond per transaction.
    expect(scheduled[0].scheduledTime - conversation.lastInboundAt!).toBeGreaterThanOrEqual(4000);
    expect(scheduled[0].scheduledTime - conversation.lastInboundAt!).toBeLessThan(4100);
  });

  it("second text within 4 s replaces the pending reply", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    const first = (await only(t)).pendingReplyJobId;
    vi.setSystemTime(NOW + 2000);
    const second = envelope(messageText);
    second.whatsapp.messages[0].id = "wamid.second";
    second.whatsapp.messages[0].text.body = "And in red?";
    await ingest(t, second);

    const conversation = await only(t);
    expect(conversation.aiTurn).toBe(2);
    expect(conversation.lastPreview).toBe("And in red?");
    const scheduled = await jobs(t);
    expect(scheduled.find((j) => j._id === first)?.state.kind).toBe("canceled");
    const pending = scheduled.filter((j) => j.state.kind === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]._id).toBe(conversation.pendingReplyJobId);
    expect(pending[0].args).toEqual([{ conversationId: conversation._id, turn: 2, attempt: 1 }]);
  });

  it("image hands to a human", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageImage));

    const conversation = await only(t);
    expect(conversation).toMatchObject({
      mode: "waiting_human",
      handoffReason: "media",
      aiTurn: 1,
      lastFrom: "customer",
      lastPreview: "Do you have this one in blue?",
    });
    expect(conversation.pendingReplyJobId).toBeUndefined();
    expect(await jobs(t)).toHaveLength(0);
    const [message] = await all(t, "messages");
    expect(message).toMatchObject({ type: "image", text: "Do you have this one in blue?", source: "customer" });
  });

  it("echo hands to staff and cancels the reply", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    const pending = (await only(t)).pendingReplyJobId;
    vi.setSystemTime(NOW + 1000);
    expect(await ingest(t, echoToCustomer())).toBe("processed");

    const conversation = await only(t);
    expect(conversation).toMatchObject({
      mode: "human",
      handoffReason: "phone_reply",
      humanActiveAt: NOW + 1000,
      resumeAt: NOW + 1000 + 30 * 60_000,
      aiTurn: 2,
      lastFrom: "phone",
      lastPreview: "Oi",
      lastInboundAt: NOW,
      lastMessageAt: NOW + 1000,
    });
    expect(conversation.pendingReplyJobId).toBeUndefined();
    const scheduled = await jobs(t);
    expect(scheduled.find((j) => j._id === pending)?.state.kind).toBe("canceled");
    expect(scheduled.filter((j) => j.state.kind === "pending")).toHaveLength(0);

    const sent = (await all(t, "messages")).find((m) => m.source === "phone");
    expect(sent).toMatchObject({
      direction: "out",
      status: "sent",
      text: "Oi",
      conversationId: conversation._id,
      wamid: smbMessageEcho.whatsapp.message_echoes[0].id,
    });
  });

  it("repeated echo wamid is ignored", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, echoToCustomer());
    await ingest(t, echoToCustomer());

    expect(await all(t, "messages")).toHaveLength(1);
    expect((await only(t)).aiTurn).toBe(1);
  });

  it("echo to unknown recipient creates a conversation in human mode", async () => {
    const t = makeT();
    await seedNumber(t);

    expect(await ingest(t, envelope(smbMessageEcho))).toBe("processed");

    const conversation = await only(t);
    expect(conversation).toMatchObject({
      waId: "5511987654321",
      userId: "BR.10293847561029384",
      mode: "human",
      handoffReason: "phone_reply",
      aiTurn: 1,
      lastFrom: "phone",
      lastPreview: "Oi",
      lastMessageAt: NOW,
    });
    expect(conversation.lastInboundAt).toBeUndefined();
    expect(await jobs(t)).toHaveLength(0);
  });

  it("old message updates state without scheduling", async () => {
    const t = makeT();
    await seedNumber(t);
    const sentAt = NOW - 16 * 60_000;

    await ingest(t, envelope(messageText, { at: sentAt }));

    const conversation = await only(t);
    expect(conversation).toMatchObject({
      mode: "ai",
      lastFrom: "customer",
      lastInboundAt: sentAt,
      lastMessageAt: sentAt,
    });
    expect(conversation.pendingReplyJobId).toBeUndefined();
    expect(await jobs(t)).toHaveLength(0);
  });

  it("AI off: state tracked, nothing scheduled", async () => {
    const t = makeT();
    await seedNumber(t, { aiEnabled: false });

    await ingest(t, envelope(messageText));

    const conversation = await only(t);
    expect(conversation).toMatchObject({ mode: "ai", aiTurn: 1, lastFrom: "customer" });
    expect(conversation.pendingReplyJobId).toBeUndefined();
    expect(await jobs(t)).toHaveLength(0);

    await ingest(t, echoToCustomer());
    expect(await only(t)).toMatchObject({ mode: "human", handoffReason: "phone_reply", aiTurn: 2 });
  });

  it("BSUID-only sender", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageTextBsuidOnly));

    const conversation = await only(t);
    expect(conversation.userId).toBe(CUSTOMER.userId);
    expect(conversation.waId).toBeUndefined();
    expect(conversation.name).toBe("Sheena Nelson");
    expect(conversation.pendingReplyJobId).toBeDefined();

    // A later message that carries the phone fills it in on the same conversation.
    await ingest(t, envelope(messageImage));
    expect(await only(t)).toMatchObject(CUSTOMER);
  });

  it("status moves forward only", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, envelope(smbMessageEcho));
    const wamid = smbMessageEcho.whatsapp.message_echoes[0].id;
    const status = (state: string) => {
      const payload = envelope(statusDeliveredBsuid);
      payload.whatsapp.statuses[0].id = wamid;
      payload.whatsapp.statuses[0].status = state;
      return payload;
    };
    const current = async () => (await all(t, "messages"))[0].status;

    expect(await ingest(t, status("delivered"))).toBe("processed");
    expect(await current()).toBe("delivered");
    await ingest(t, status("read"));
    expect(await current()).toBe("read");
    await ingest(t, status("delivered"));
    expect(await current()).toBe("read");
    await ingest(t, status("sent"));
    expect(await current()).toBe("read");

    const failed = envelope(statusFailed);
    failed.whatsapp.statuses[0].id = wamid;
    await ingest(t, failed);
    const [message] = await all(t, "messages");
    expect(message).toMatchObject({ status: "failed", error: "meta_131049" });
    // A phone message failing is not an AI error.
    expect(await only(t)).toMatchObject({ mode: "human", handoffReason: "phone_reply" });
  });

  it("status for an unknown wamid is ignored", async () => {
    const t = makeT();
    await seedNumber(t);

    expect(await ingest(t, envelope(statusFailed))).toBe("ignored");
    expect(await all(t, "messages")).toHaveLength(0);
  });

  it("reaction is stored without a handoff", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, envelope(messageText));
    const pending = (await only(t)).pendingReplyJobId;

    const reaction = envelope(messageText);
    const msg = reaction.whatsapp.messages[0];
    msg.id = "wamid.reaction";
    msg.type = "reaction";
    delete msg.text;
    msg.reaction = { message_id: messageText.whatsapp.messages[0].id, emoji: "\u{1F44D}" };
    expect(await ingest(t, reaction)).toBe("processed");

    const conversation = await only(t);
    expect(conversation).toMatchObject({ mode: "ai", aiTurn: 1, pendingReplyJobId: pending, lastFrom: "customer" });
    expect(conversation.handoffReason).toBeUndefined();
    expect((await jobs(t)).find((j) => j._id === pending)?.state.kind).toBe("pending");
    const stored = (await all(t, "messages")).find((m) => m.wamid === "wamid.reaction");
    expect(stored).toMatchObject({ type: "reaction", source: "customer", direction: "in" });
  });

  it("button reply counts as text", async () => {
    const t = makeT();
    await seedNumber(t);

    const button = envelope(messageText);
    const msg = button.whatsapp.messages[0];
    msg.type = "button";
    delete msg.text;
    msg.button = { text: "Yes, blue", payload: "blue" };
    await ingest(t, button);

    const conversation = await only(t);
    expect(conversation).toMatchObject({ mode: "ai", aiTurn: 1, lastPreview: "Yes, blue" });
    expect(conversation.pendingReplyJobId).toBeDefined();
    const [job] = await jobs(t);
    expect(job).toMatchObject({ name: "responder:respond", state: { kind: "pending" } });
  });

  it("failed status of an AI message hands to a human", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, envelope(messageText));
    const conversation = await only(t);
    const wamid = statusFailed.whatsapp.statuses[0].id;
    await insertAiMessage(t, conversation, wamid);

    expect(await ingest(t, envelope(statusFailed))).toBe("processed");

    expect(await only(t)).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_error",
      aiTurn: 2,
      lastError: sendErrorMessage("meta_131049"),
    });
    const message = (await all(t, "messages")).find((m) => m.wamid === wamid);
    expect(message).toMatchObject({ status: "failed", error: "meta_131049" });
  });

  it("failed status with the window-closed code explains it", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, envelope(messageText));
    const conversation = await only(t);
    const wamid = statusFailed.whatsapp.statuses[0].id;
    await insertAiMessage(t, conversation, wamid);

    const failed = envelope(statusFailed);
    failed.whatsapp.statuses[0].errors[0].code = 131047;
    await ingest(t, failed);

    expect(await only(t)).toMatchObject({
      mode: "waiting_human",
      handoffReason: "ai_error",
      lastError: sendErrorMessage("window_closed"),
    });
    const message = (await all(t, "messages")).find((m) => m.wamid === wamid);
    expect(message).toMatchObject({ status: "failed", error: "meta_131047" });
  });

  it("failed status of an AI message while staff has it changes nothing", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, envelope(messageText));
    const conversation = await only(t);
    const wamid = statusFailed.whatsapp.statuses[0].id;
    await insertAiMessage(t, conversation, wamid);
    await ingest(t, echoToCustomer());
    const before = await only(t);
    expect(before).toMatchObject({ mode: "human", handoffReason: "phone_reply" });

    await ingest(t, envelope(statusFailed));

    const after = await only(t);
    expect(after).toEqual(before);
    expect(after.lastError).toBeUndefined();
    const message = (await all(t, "messages")).find((m) => m.wamid === wamid);
    expect(message).toMatchObject({ status: "failed", error: "meta_131049" });
  });

  it("failed status of an old AI message after the number moved leaves the old conversation alone", async () => {
    const t = makeT();
    const a = await seedNumber(t, { ownerId: "user_a" });
    const b = await seedWorkspace(t, "user_b");
    await ingest(t, envelope(messageText));
    const conversation = await only(t);
    const wamid = statusFailed.whatsapp.statuses[0].id;
    await insertAiMessage(t, conversation, wamid);
    expect(await ingest(t, onboarded(POOL, b))).toBe("processed");
    const before = await only(t);
    expect(before.workspaceId).toBe(a);

    expect(await ingest(t, envelope(statusFailed))).toBe("processed");

    const after = await only(t);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ mode: "ai" });
    expect(after.lastError).toBeUndefined();
    const message = (await all(t, "messages")).find((m) => m.wamid === wamid);
    expect(message).toMatchObject({ status: "failed", error: "meta_131049" });
  });

  it("user_changed_number migrates the conversation", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    expect(await ingest(t, envelope(systemUserChangedNumber))).toBe("processed");

    expect(await only(t)).toMatchObject({
      waId: "16505559999",
      userId: "US.99999999999999999999",
      aiTurn: 1,
    });
    expect(await all(t, "messages")).toHaveLength(1);
  });

  it("events for an unknown number are parked and replayed", async () => {
    const t = makeT();
    const workspaceId = await seedWorkspace(t);

    expect(await ingest(t, envelope(messageText, { pool: "pn_new" }))).toBe("parked");
    expect(await ingest(t, envelope(smbMessageEcho, { pool: "pn_new" }))).toBe("parked");
    expect(await all(t, "messages")).toHaveLength(0);
    expect(await all(t, "conversations")).toHaveLength(0);

    expect(await ingest(t, onboarded("pn_new", workspaceId))).toBe("processed");

    expect((await all(t, "events")).map((e) => e.state)).toEqual(["processed", "processed", "processed"]);
    const [number] = await all(t, "numbers");
    expect(number).toMatchObject({
      workspaceId,
      poolNumberId: "pn_new",
      phoneNumber: "+15551234567",
      displayName: "Acme Support",
      aiEnabled: false,
    });
    const conversations = await all(t, "conversations");
    expect(conversations.map((c) => c.mode).sort()).toEqual(["ai", "human"]);
    const messages = await all(t, "messages");
    expect(messages.map((m) => m.source).sort()).toEqual(["customer", "phone"]);
    expect(await jobs(t)).toHaveLength(0);
  });

  it("onboarded without a workspace is parked", async () => {
    const t = makeT();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await ingest(t, onboarded("pn_x"))).toBe("parked");
    expect(await ingest(t, onboarded("pn_x", "not-a-workspace-id"))).toBe("parked");

    expect(await all(t, "numbers")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("unassigned number pn_x");
  });

  it("reonboarding into another workspace moves the number and turns the AI off", async () => {
    const t = makeT();
    const a = await seedNumber(t, { ownerId: "user_a" });
    const b = await seedWorkspace(t, "user_b");

    await ingest(t, envelope(messageText));
    expect(await ingest(t, onboarded(POOL, b))).toBe("processed");
    const second = envelope(messageText);
    second.whatsapp.messages[0].id = "wamid.second";
    await ingest(t, second);

    const numbers = await all(t, "numbers");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ workspaceId: b, aiEnabled: false });
    const conversations = await all(t, "conversations");
    const inWorkspace = (id: Id<"workspaces">) => conversations.filter((c) => c.workspaceId === id);
    expect(inWorkspace(a)).toHaveLength(1);
    expect(inWorkspace(b)).toHaveLength(1);
    expect(inWorkspace(a)[0].aiTurn).toBe(1);
    expect(inWorkspace(b)[0].aiTurn).toBe(1);
    // Only the first message, sent while the AI was on in workspace a, got a reply.
    expect(inWorkspace(b)[0].pendingReplyJobId).toBeUndefined();
    expect((await jobs(t)).filter((j) => j.state.kind === "pending")).toHaveLength(1);
  });

  it("reconnecting to the same workspace keeps the AI switch", async () => {
    const t = makeT();
    const workspaceId = await seedNumber(t);

    expect(await ingest(t, onboarded(POOL, workspaceId))).toBe("processed");

    const numbers = await all(t, "numbers");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ workspaceId, aiEnabled: true });
  });

  it("duplicate webhook id is skipped", async () => {
    const t = makeT();
    await seedNumber(t);
    const payload = envelope(messageText);

    await t.mutation(internal.ingest.ingest, { webhookId: "wh_dup", payload });
    const second = await t.mutation(internal.ingest.ingest, { webhookId: "wh_dup", payload });

    expect(second).toBe("duplicate");
    expect(await all(t, "messages")).toHaveLength(1);
    expect((await only(t)).aiTurn).toBe(1);
  });
});
