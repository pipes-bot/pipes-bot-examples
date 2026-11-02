import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messageImage from "../tests/fixtures/message-image.json";
import messageTextBsuidOnly from "../tests/fixtures/message-text-bsuid-only.json";
import messageText from "../tests/fixtures/message-text.json";
import numberOnboarded from "../tests/fixtures/number-onboarded.json";
import smbMessageEcho from "../tests/fixtures/smb-message-echo.json";
import statusDeliveredBsuid from "../tests/fixtures/status-delivered-bsuid.json";
import statusFailed from "../tests/fixtures/status-failed.json";
import systemUserChangedNumber from "../tests/fixtures/system-user-changed-number.json";
import systemUserChangedUserId from "../tests/fixtures/system-user-changed-user-id.json";
import templateStatusUpdate from "../tests/fixtures/template-status-update.json";
import { makeT } from "../tests/helpers";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { closeConversation } from "./conversations";
import { ingestPayload } from "./ingest";
import { DEFAULT_METHODOLOGY } from "./lib/methodology";

const NOW = 1_800_000_000_000;
const POOL = "pn_1";

type T = ReturnType<typeof makeT>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Deep copy of an envelope fixture addressed to `poolNumberId`. */
function envelope(fixture: object, poolNumberId = POOL): any {
  const copy = structuredClone(fixture) as any;
  copy.pipes.poolNumberId = poolNumberId;
  return copy;
}

function onboarded(
  numberId: string,
  workspaceId?: string,
  flags: { importHistory?: boolean; importContacts?: boolean } = {},
): any {
  const copy = structuredClone(numberOnboarded) as any;
  copy.data.numberId = numberId;
  if (workspaceId) copy.data.metadata = { workspaceId };
  Object.assign(copy.data, flags);
  return copy;
}

let seq = 0;
const ingest = (t: T, payload: any) =>
  t.mutation(internal.ingest.ingest, { webhookId: `wh_${++seq}`, payload });

async function seedWorkspace(t: T, name = "Acme") {
  return t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerId: `owner_${name}`,
      name,
      inactivityMinutes: 120,
      methodology: DEFAULT_METHODOLOGY,
    }),
  );
}

async function seedNumber(t: T) {
  const workspaceId = await seedWorkspace(t);
  const numberId = await t.run((ctx) =>
    ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: POOL,
      phoneNumber: "+15550001111",
      displayName: "Support",
      connectedAt: 0,
    }),
  );
  return { workspaceId, numberId };
}

const all = <K extends "events" | "numbers" | "contacts" | "conversations" | "messages" | "statuses">(
  t: T,
  table: K,
) => t.run((ctx) => ctx.db.query(table).collect());

describe("ingest", () => {
  it("parks before onboarding and replays", async () => {
    const t = makeT();
    const workspaceId = await seedWorkspace(t);

    expect(await ingest(t, envelope(messageText, "pn_new"))).toBe("parked");
    expect(await all(t, "messages")).toHaveLength(0);

    expect(await ingest(t, onboarded("pn_new", workspaceId))).toBe("processed");

    const events = await all(t, "events");
    expect(events.map((e) => e.state)).toEqual(["processed", "processed"]);
    const [number] = await all(t, "numbers");
    expect(number).toMatchObject({
      workspaceId,
      poolNumberId: "pn_new",
      phoneNumber: "+15551234567",
      displayName: "Acme Support",
    });
    expect(number.connectedAt - NOW).toBeGreaterThanOrEqual(0);
    expect(number.connectedAt - NOW).toBeLessThan(1_000);
    const conversations = await all(t, "conversations");
    expect(conversations).toHaveLength(1);
    expect(conversations[0].status).toBe("open");
    const messages = await all(t, "messages");
    expect(messages).toHaveLength(1);
    expect(messages[0].source).toBe("customer");
  });

  it("onboarded with import flags records requested states", async () => {
    const t = makeT();
    const workspaceId = await seedWorkspace(t);

    await ingest(t, onboarded("pn_new", workspaceId, { importHistory: true, importContacts: true }));

    const [number] = await all(t, "numbers");
    expect(number.historyImport).toEqual({
      state: "requested",
      progress: 0,
      chunks: 0,
      messages: 0,
      conversations: 0,
      updatedAt: NOW,
    });
    expect(number.contactsImport).toEqual({ state: "requested", updatedAt: NOW });
  });

  it("onboarded without flags records nothing", async () => {
    const t = makeT();
    const workspaceId = await seedWorkspace(t);

    await ingest(t, onboarded("pn_new", workspaceId));

    const [number] = await all(t, "numbers");
    expect(number.historyImport).toBeUndefined();
    expect(number.contactsImport).toBeUndefined();
  });

  it("repeated onboarded does not regress import state", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    await t.run((ctx) =>
      ctx.db.patch(numberId, {
        historyImport: { state: "importing", progress: 40, chunks: 2, messages: 90, conversations: 0, updatedAt: 1 },
        contactsImport: { state: "received", updatedAt: 1 },
      }),
    );

    await ingest(t, onboarded(POOL, workspaceId, { importHistory: true, importContacts: true }));

    const [number] = await all(t, "numbers");
    expect(number.historyImport).toMatchObject({ state: "importing", progress: 40, chunks: 2 });
    expect(number.contactsImport).toEqual({ state: "received", updatedAt: 1 });
  });

  it("onboarded without metadata is parked", async () => {
    const t = makeT();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await ingest(t, onboarded("pn_x"))).toBe("parked");
    expect(await ingest(t, onboarded("pn_x", "not-a-workspace-id"))).toBe("parked");

    expect(await all(t, "numbers")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("unassigned number pn_x");
    const events = await all(t, "events");
    expect(events.map((e) => [e.kind, e.poolNumberId, e.state])).toEqual([
      ["number.onboarded", "pn_x", "parked"],
      ["number.onboarded", "pn_x", "parked"],
    ]);
  });

  it("reonboarding moves the number", async () => {
    const t = makeT();
    const a = await seedWorkspace(t, "A");
    const b = await seedWorkspace(t, "B");

    await ingest(t, onboarded(POOL, a));
    await ingest(t, onboarded(POOL, b));

    const numbers = await all(t, "numbers");
    expect(numbers).toHaveLength(1);
    expect(numbers[0].workspaceId).toBe(b);
    const inA = await t.run((ctx) =>
      ctx.db.query("numbers").withIndex("by_workspace", (q) => q.eq("workspaceId", a)).collect(),
    );
    expect(inA).toHaveLength(0);
  });

  it("moving a number closes the old workspace's open conversations", async () => {
    const t = makeT();
    const a = await seedWorkspace(t, "A");
    const b = await seedWorkspace(t, "B");
    await ingest(t, onboarded(POOL, a));
    await ingest(t, envelope(messageText));
    const [old] = await all(t, "conversations");
    expect(old).toMatchObject({ workspaceId: a, status: "open" });

    await ingest(t, onboarded(POOL, b));
    await ingest(t, envelope(messageImage));

    expect((await t.run((ctx) => ctx.db.get(old._id)))?.status).toBe("closed");
    const openIn = (workspaceId: Id<"workspaces">) =>
      t.run((ctx) =>
        ctx.db
          .query("conversations")
          .withIndex("by_workspace_status", (q) =>
            q.eq("workspaceId", workspaceId).eq("status", "open"),
          )
          .collect(),
      );
    expect(await openIn(a)).toHaveLength(0);
    const [current] = await openIn(b);
    const latest = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_wamid", (q) => q.eq("wamid", messageImage.whatsapp.messages[0].id))
        .first(),
    );
    expect(latest?.conversationId).toBe(current._id);
  });

  it("after a move, the old workspace's history stays with it", async () => {
    const t = makeT();
    const a = await seedWorkspace(t, "A");
    const b = await seedWorkspace(t, "B");
    await ingest(t, onboarded(POOL, a));
    await ingest(t, envelope(messageText));
    const [old] = await all(t, "conversations");
    await ingest(t, onboarded(POOL, b));
    const [number] = await all(t, "numbers");
    expect((await t.run((ctx) => ctx.db.get(old._id)))?.status).toBe("closed");

    const asA = t.withIdentity({ subject: "owner_A" });
    const asB = t.withIdentity({ subject: "owner_B" });
    expect((await asB.query(api.dashboard.overview, { days: 7, numberId: number._id })).total).toBe(0);
    expect(
      await asB.query(api.dashboard.conversations, { numberId: number._id, status: "closed" }),
    ).toEqual([]);
    expect((await asA.query(api.dashboard.overview, { days: 7 })).total).toBe(1);
    const view = await asA.query(api.dashboard.conversation, { conversationId: old._id });
    expect(view.conversation._id).toBe(old._id);
    expect(view.number).toBeNull();
  });

  it("echo is never a customer message", async () => {
    const t = makeT();
    await seedNumber(t);

    expect(await ingest(t, envelope(smbMessageEcho))).toBe("processed");

    const [message] = await all(t, "messages");
    expect(message).toMatchObject({ source: "phone", direction: "outbound", text: "Oi" });
    const [conversation] = await all(t, "conversations");
    expect(conversation.lastTurn).toBe("business");
    expect(conversation.waitingSince).toBeUndefined();
  });

  it("echo to BSUID-only contact opens a business conversation", async () => {
    const t = makeT();
    await seedNumber(t);
    const payload = envelope(smbMessageEcho);
    delete payload.whatsapp.message_echoes[0].to;
    payload.whatsapp.message_echoes[0].to_user_id = "BR.55555555555555555";

    await ingest(t, payload);

    const [contact] = await all(t, "contacts");
    expect(contact.userId).toBe("BR.55555555555555555");
    expect(contact.waId).toBeUndefined();
    const [conversation] = await all(t, "conversations");
    expect(conversation.initiatedBy).toBe("business");

    await t.run((ctx) => closeConversation(ctx, conversation._id));
    const closed = await t.run((ctx) => ctx.db.get(conversation._id));
    expect(closed?.metrics).toBeDefined();
    expect(closed?.metrics?.firstResponseSeconds).toBeUndefined();
  });

  it("status before echo is folded", async () => {
    const t = makeT();
    await seedNumber(t);
    const echo = envelope(smbMessageEcho);
    const status = envelope(statusDeliveredBsuid);
    status.whatsapp.statuses[0].id = echo.whatsapp.message_echoes[0].id;

    expect(await ingest(t, status)).toBe("processed");
    expect(await all(t, "statuses")).toHaveLength(1);

    await ingest(t, echo);

    const [message] = await all(t, "messages");
    expect(message.deliveredAt).toBe(1750030073 * 1000);
    expect(await all(t, "statuses")).toHaveLength(0);
  });

  it("status for known message updates it", async () => {
    const t = makeT();
    await seedNumber(t);
    const message = envelope(messageText);
    const status = envelope(statusFailed);
    status.whatsapp.statuses[0].id = message.whatsapp.messages[0].id;

    await ingest(t, message);
    await ingest(t, status);

    const [row] = await all(t, "messages");
    expect(row.failedAt).toBe(1750030073 * 1000);
    expect(row.deliveredAt).toBeUndefined();
    expect(await all(t, "statuses")).toHaveLength(0);
  });

  it("system change updates contact", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    await ingest(t, envelope(systemUserChangedNumber));

    let [contact] = await all(t, "contacts");
    expect(contact.waId).toBe("16505559999");
    expect(contact.userId).toBe("US.99999999999999999999");

    const changedUserId = envelope(systemUserChangedUserId);
    changedUserId.whatsapp.messages[0].system.previous_user_id = contact.userId;
    changedUserId.whatsapp.messages[0].system.user_id = "US.88888888888888888888";
    await ingest(t, changedUserId);

    const contacts = await all(t, "contacts");
    expect(contacts).toHaveLength(1);
    [contact] = contacts;
    expect(contact.userId).toBe("US.88888888888888888888");
    expect(contact.waId).toBe("16505559999");
    expect(await all(t, "messages")).toHaveLength(1);
  });

  it("bsuid-only sender", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageTextBsuidOnly));

    const [contact] = await all(t, "contacts");
    expect(contact.userId).toBe("US.13491208655302741918");
    expect(contact.waId).toBeUndefined();
    expect(contact.name).toBe("Sheena Nelson");
  });

  it("fills a contact's missing id when it becomes known", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageTextBsuidOnly));
    await ingest(t, envelope(messageImage));

    const contacts = await all(t, "contacts");
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      waId: "16505551234",
      userId: "US.13491208655302741918",
      name: "Sheena Nelson",
    });
  });

  it("malformed timestamp falls back to arrival time", async () => {
    const t = makeT();
    await seedNumber(t);
    const payload = envelope(messageText);
    payload.whatsapp.messages[0].timestamp = "soon";
    const arrival = NOW - 5_000;

    await t.run((ctx) => ingestPayload(ctx, "wh_soon", payload, arrival));

    const [message] = await all(t, "messages");
    expect(message.sentAt).toBe(arrival);
    const [event] = await all(t, "events");
    expect(event.receivedAt).toBe(arrival);
  });

  it("echo without timestamp falls back to arrival time", async () => {
    const t = makeT();
    await seedNumber(t);
    const payload = envelope(smbMessageEcho);
    delete payload.whatsapp.message_echoes[0].timestamp;
    const arrival = NOW - 5_000;

    await t.run((ctx) => ingestPayload(ctx, "wh_echo_no_ts", payload, arrival));

    const [message] = await all(t, "messages");
    expect(message.sentAt).toBe(arrival);
  });

  it("status with a millisecond timestamp falls back to arrival time", async () => {
    const t = makeT();
    await seedNumber(t);
    const message = envelope(messageText);
    const status = envelope(statusDeliveredBsuid);
    status.whatsapp.statuses[0].id = message.whatsapp.messages[0].id;
    status.whatsapp.statuses[0].timestamp = "1750030073000";
    const arrival = NOW - 5_000;

    await ingest(t, message);
    await t.run((ctx) => ingestPayload(ctx, "wh_status_ms", status, arrival));

    const [row] = await all(t, "messages");
    expect(row.deliveredAt).toBe(arrival);
  });

  it("message after close opens a new conversation", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    const [first] = await all(t, "conversations");
    await t.run((ctx) => closeConversation(ctx, first._id));
    await ingest(t, envelope(messageImage));

    const conversations = await all(t, "conversations");
    expect(conversations.map((c) => c.status)).toEqual(["closed", "open"]);
  });

  it("activity reschedules close", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    await ingest(t, envelope(messageImage));

    const jobs = (
      await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
    ).filter((job) => job.name.includes("closeIfIdle"));
    expect(jobs.map((job) => job.state.kind)).toEqual(["canceled", "pending"]);
    // convex-test advances its clock by a millisecond per transaction.
    const delay = jobs[1].scheduledTime - NOW;
    expect(delay).toBeGreaterThanOrEqual(120 * 60_000);
    expect(delay).toBeLessThan(120 * 60_000 + 1_000);
    const [conversation] = await all(t, "conversations");
    expect(conversation.closeJobId).toBe(jobs[1]._id as Id<"_scheduled_functions">);
    expect(conversation.waitingSince).toBe(1749416383 * 1000);
  });

  it("schedules the close with the conversation's workspace inactivity", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        ownerId: "owner_other",
        name: "Other",
        inactivityMinutes: 30,
        methodology: DEFAULT_METHODOLOGY,
      }),
    );
    // The number now points at a 30-minute workspace; the open conversation is in the 120-minute one.
    const conversationWorkspace = (await t.run((ctx) => ctx.db.get(numberId)))!.workspaceId;
    await ingest(t, envelope(messageText));
    await t.run((ctx) => ctx.db.patch(numberId, { workspaceId: other }));
    await ingest(t, envelope(messageImage));

    const [conversation] = await all(t, "conversations");
    expect(conversation.workspaceId).toBe(conversationWorkspace);
    const job = await t.run((ctx) => ctx.db.system.get(conversation.closeJobId!));
    const delay = job!.scheduledTime - NOW;
    expect(delay).toBeGreaterThanOrEqual(120 * 60_000);
    expect(delay).toBeLessThan(120 * 60_000 + 1_000);
  });

  it("same wamid in another event is recorded once", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    await ingest(t, envelope(messageText));

    expect(await all(t, "messages")).toHaveLength(1);
  });

  it("duplicate webhook id is skipped", async () => {
    const t = makeT();
    await seedNumber(t);
    const payload = envelope(messageText);

    await t.mutation(internal.ingest.ingest, { webhookId: "wh_dup", payload });
    const second = await t.mutation(internal.ingest.ingest, { webhookId: "wh_dup", payload });

    expect(second).toBe("duplicate");
    expect(await all(t, "events")).toHaveLength(1);
  });

  it("template status is ignored", async () => {
    const t = makeT();
    await seedNumber(t);

    expect(await ingest(t, envelope(templateStatusUpdate))).toBe("ignored");
    const [event] = await all(t, "events");
    expect(event).toMatchObject({
      kind: "message_template_status_update",
      poolNumberId: POOL,
      state: "ignored",
    });
  });
});
