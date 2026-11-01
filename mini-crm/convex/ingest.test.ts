import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messageImage from "../tests/fixtures/message-image.json";
import messageTextBsuidOnly from "../tests/fixtures/message-text-bsuid-only.json";
import messageText from "../tests/fixtures/message-text.json";
import numberOnboarded from "../tests/fixtures/number-onboarded.json";
import smbMessageEcho from "../tests/fixtures/smb-message-echo.json";
import statusDeliveredBsuid from "../tests/fixtures/status-delivered-bsuid.json";
import statusFailed from "../tests/fixtures/status-failed.json";
import systemUserChangedNumber from "../tests/fixtures/system-user-changed-number.json";
import templateStatusUpdate from "../tests/fixtures/template-status-update.json";
import { makeT, seedUser } from "../tests/helpers";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ingestPayload } from "./ingest";
import { windowState } from "./lib/crm";

const NOW = 1_749_416_400_000; // 17 s after the message fixtures' timestamp (1749416383)
const POOL = "pn_1";
const MESSAGE_SENT_AT = 1_749_416_383_000;

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

function onboarded(numberId: string, workspaceId?: string): any {
  const copy = structuredClone(numberOnboarded) as any;
  copy.data.numberId = numberId;
  if (workspaceId) copy.data.metadata = { ...copy.data.metadata, workspaceId };
  return copy;
}

let seq = 0;
const ingest = (t: T, payload: any) =>
  t.mutation(internal.ingest.ingest, { webhookId: `wh_${++seq}`, payload });

/** A workspace with the fixture's pool number onboarded into it. */
async function seedNumber(t: T, ownerId = "user_1") {
  const { workspaceId } = await seedUser(t, ownerId);
  expect(await ingest(t, onboarded(POOL, workspaceId))).toBe("processed");
  return workspaceId;
}

const all = <K extends "events" | "numbers" | "contacts" | "messages" | "activities">(
  t: T,
  table: K,
) => t.run((ctx) => ctx.db.query(table).collect());

describe("ingest", () => {
  it("new sender becomes a lead", async () => {
    const t = makeT();
    const workspaceId = await seedNumber(t);

    expect(await ingest(t, envelope(messageText))).toBe("processed");

    const [contact] = await all(t, "contacts");
    expect(await all(t, "contacts")).toHaveLength(1);
    expect(contact).toMatchObject({
      workspaceId,
      waId: "16505551234",
      userId: "US.13491208655302741918",
      name: "Sheena Nelson",
      stage: "lead",
      tags: [],
      unread: 1,
      lastDirection: "in",
      lastPreview: "Does it come in another color?",
      lastInboundAt: MESSAGE_SENT_AT,
      lastMessageAt: MESSAGE_SENT_AT,
    });
    expect(contact.searchText).toBe("Sheena Nelson 16505551234 US.13491208655302741918");
    expect(windowState(contact, NOW).open).toBe(true);

    const [number] = await all(t, "numbers");
    expect(contact.lastNumberId).toBe(number._id);

    const [message] = await all(t, "messages");
    expect(message).toMatchObject({
      workspaceId,
      contactId: contact._id,
      numberId: number._id,
      direction: "in",
      source: "contact",
      status: "delivered",
      type: "text",
      text: "Does it come in another color?",
      sentAt: MESSAGE_SENT_AT,
    });

    const activities = await all(t, "activities");
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      workspaceId,
      contactId: contact._id,
      kind: "contact_created",
      actor: "system",
    });
  });

  it("a second message keeps the contact and counts unread", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    await ingest(t, envelope(messageImage));

    const contacts = await all(t, "contacts");
    expect(contacts).toHaveLength(1);
    expect(contacts[0].unread).toBe(2);
    expect(contacts[0].lastPreview).toBe("Do you have this one in blue?");
    expect(await all(t, "messages")).toHaveLength(2);
    expect(await all(t, "activities")).toHaveLength(1);
  });

  it("BSUID-only sender", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageTextBsuidOnly));

    const [contact] = await all(t, "contacts");
    expect(contact.userId).toBe("US.13491208655302741918");
    expect(contact.waId).toBeUndefined();
    expect(contact.name).toBe("Sheena Nelson");
    expect(contact.searchText).toBe("Sheena Nelson US.13491208655302741918");
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
    expect(contacts[0].searchText).toContain("16505551234");
  });

  it("same wamid in another event is recorded once", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    await ingest(t, envelope(messageText));

    expect(await all(t, "messages")).toHaveLength(1);
    expect((await all(t, "contacts"))[0].unread).toBe(1);
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
    const events = await all(t, "events");
    expect(events.at(-1)?.receivedAt).toBe(arrival);
  });

  it("echo is phone and does not open the window", async () => {
    const t = makeT();
    await seedNumber(t);
    const echo = envelope(smbMessageEcho);
    echo.whatsapp.message_echoes[0].to = "16505551234";
    echo.whatsapp.message_echoes[0].to_user_id = "US.13491208655302741918";

    await ingest(t, envelope(messageText));
    expect(await ingest(t, echo)).toBe("processed");

    const contacts = await all(t, "contacts");
    expect(contacts).toHaveLength(1);
    const [contact] = contacts;
    expect(contact).toMatchObject({
      lastInboundAt: MESSAGE_SENT_AT,
      lastDirection: "out",
      lastPreview: "Oi",
      lastMessageAt: 1_792_852_737_000,
      unread: 0,
    });
    const messages = await all(t, "messages");
    const sent = messages.find((m) => m.source === "phone");
    expect(sent).toMatchObject({
      direction: "out",
      status: "sent",
      text: "Oi",
      contactId: contact._id,
      wamid: smbMessageEcho.whatsapp.message_echoes[0].id,
    });
  });

  it("a late webhook does not roll the summary back", async () => {
    const t = makeT();
    await seedNumber(t);
    const echo = envelope(smbMessageEcho);
    echo.whatsapp.message_echoes[0].to = "16505551234";
    echo.whatsapp.message_echoes[0].to_user_id = "US.13491208655302741918";

    await ingest(t, echo);
    await ingest(t, envelope(messageText)); // sent a year before the echo

    const [contact] = await all(t, "contacts");
    expect(contact).toMatchObject({
      lastDirection: "out",
      lastPreview: "Oi",
      lastMessageAt: 1_792_852_737_000,
      lastInboundAt: MESSAGE_SENT_AT,
    });
  });

  it("echo to unknown recipient creates a closed-window lead", async () => {
    const t = makeT();
    await seedNumber(t);

    expect(await ingest(t, envelope(smbMessageEcho))).toBe("processed");

    const [contact] = await all(t, "contacts");
    expect(contact).toMatchObject({
      waId: "5511987654321",
      userId: "BR.10293847561029384",
      stage: "lead",
      unread: 0,
      lastDirection: "out",
      lastPreview: "Oi",
    });
    expect(contact.lastInboundAt).toBeUndefined();
    expect(windowState(contact, NOW)).toEqual({ open: false });
    const activities = await all(t, "activities");
    expect(activities.map((a) => [a.kind, a.actor])).toEqual([["contact_created", "system"]]);
  });

  it("repeated echo wamid is ignored", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(smbMessageEcho));
    await ingest(t, envelope(smbMessageEcho));

    expect(await all(t, "messages")).toHaveLength(1);
    expect(await all(t, "contacts")).toHaveLength(1);
    expect(await all(t, "activities")).toHaveLength(1);
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

    expect(await ingest(t, status("read"))).toBe("processed");
    expect(await current()).toBe("read");
    await ingest(t, status("delivered"));
    expect(await current()).toBe("read");
    await ingest(t, status("sent"));
    expect(await current()).toBe("read");
  });

  it("status advances sent to delivered", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, envelope(smbMessageEcho));
    const status = envelope(statusDeliveredBsuid);
    status.whatsapp.statuses[0].id = smbMessageEcho.whatsapp.message_echoes[0].id;

    await ingest(t, status);

    expect((await all(t, "messages"))[0].status).toBe("delivered");
  });

  it("failed status records the error", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, envelope(smbMessageEcho));
    const status = envelope(statusFailed);
    status.whatsapp.statuses[0].id = smbMessageEcho.whatsapp.message_echoes[0].id;
    const code = statusFailed.whatsapp.statuses[0].errors[0].code;

    await ingest(t, status);

    const [message] = await all(t, "messages");
    expect(message.status).toBe("failed");
    expect(message.error).toBe(`meta_${code}`);
  });

  it("failed wins over read", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, envelope(smbMessageEcho));
    const read = envelope(statusDeliveredBsuid);
    read.whatsapp.statuses[0].id = smbMessageEcho.whatsapp.message_echoes[0].id;
    read.whatsapp.statuses[0].status = "read";
    const failed = envelope(statusFailed);
    failed.whatsapp.statuses[0].id = smbMessageEcho.whatsapp.message_echoes[0].id;

    await ingest(t, read);
    await ingest(t, failed);

    expect((await all(t, "messages"))[0].status).toBe("failed");
  });

  it("status for an unknown wamid is ignored", async () => {
    const t = makeT();
    await seedNumber(t);

    expect(await ingest(t, envelope(statusFailed))).toBe("ignored");

    expect(await all(t, "messages")).toHaveLength(0);
    const events = await all(t, "events");
    expect(events.at(-1)).toMatchObject({ kind: "messages", state: "ignored" });
  });

  it("user_changed_number migrates the contact", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, envelope(messageText));
    expect(await ingest(t, envelope(systemUserChangedNumber))).toBe("processed");

    const contacts = await all(t, "contacts");
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ waId: "16505559999", userId: "US.99999999999999999999" });
    expect(contacts[0].searchText).toBe("Sheena Nelson 16505559999 US.99999999999999999999");
    expect(await all(t, "messages")).toHaveLength(1);
  });

  it("events for an unknown number are parked and replayed", async () => {
    const t = makeT();
    const { workspaceId } = await seedUser(t);

    expect(await ingest(t, envelope(messageText, "pn_new"))).toBe("parked");
    expect(await ingest(t, envelope(smbMessageEcho, "pn_new"))).toBe("parked");
    expect(await all(t, "messages")).toHaveLength(0);
    expect(await all(t, "contacts")).toHaveLength(0);

    expect(await ingest(t, onboarded("pn_new", workspaceId))).toBe("processed");

    expect((await all(t, "events")).map((e) => e.state)).toEqual([
      "processed",
      "processed",
      "processed",
    ]);
    const [number] = await all(t, "numbers");
    expect(number).toMatchObject({
      workspaceId,
      poolNumberId: "pn_new",
      phoneNumber: "+15551234567",
      displayName: "Acme Support",
    });
    expect(await all(t, "contacts")).toHaveLength(2);
    const messages = await all(t, "messages");
    expect(messages.map((m) => m.source).sort()).toEqual(["contact", "phone"]);
  });

  it("onboarded without a workspace is parked", async () => {
    const t = makeT();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await ingest(t, onboarded("pn_x"))).toBe("parked");
    expect(await ingest(t, onboarded("pn_x", "not-a-workspace-id"))).toBe("parked");

    expect(await all(t, "numbers")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("unassigned number pn_x");
    expect((await all(t, "events")).map((e) => [e.kind, e.poolNumberId, e.state])).toEqual([
      ["number.onboarded", "pn_x", "parked"],
      ["number.onboarded", "pn_x", "parked"],
    ]);
  });

  it("reonboarding moves the number", async () => {
    const t = makeT();
    const a = await seedNumber(t, "user_a");
    const { workspaceId: b } = await seedUser(t, "user_b");

    await ingest(t, envelope(messageText));
    expect(await ingest(t, onboarded(POOL, b))).toBe("processed");
    await ingest(t, envelope(messageImage));

    const numbers = await all(t, "numbers");
    expect(numbers).toHaveLength(1);
    expect(numbers[0].workspaceId).toBe(b);

    const contacts = await all(t, "contacts");
    expect(contacts).toHaveLength(2);
    const inWorkspace = (id: Id<"workspaces">) => contacts.filter((c) => c.workspaceId === id);
    expect(inWorkspace(a)).toHaveLength(1);
    expect(inWorkspace(a)[0].unread).toBe(1);
    expect(inWorkspace(b)).toHaveLength(1);
    expect(inWorkspace(b)[0]).toMatchObject({ unread: 1, lastPreview: "Do you have this one in blue?" });
    const messages = await all(t, "messages");
    expect(messages.filter((m) => m.workspaceId === a)).toHaveLength(1);
    expect(messages.filter((m) => m.workspaceId === b)).toHaveLength(1);
  });

  it("duplicate webhook id is skipped", async () => {
    const t = makeT();
    await seedNumber(t);
    const payload = envelope(messageText);

    await t.mutation(internal.ingest.ingest, { webhookId: "wh_dup", payload });
    const second = await t.mutation(internal.ingest.ingest, { webhookId: "wh_dup", payload });

    expect(second).toBe("duplicate");
    expect(await all(t, "messages")).toHaveLength(1);
    expect((await all(t, "events")).filter((e) => e.webhookId === "wh_dup")).toHaveLength(1);
  });

  it("template status is ignored", async () => {
    const t = makeT();
    await seedNumber(t);

    expect(await ingest(t, envelope(templateStatusUpdate))).toBe("ignored");
    expect((await all(t, "events")).at(-1)).toMatchObject({
      kind: "message_template_status_update",
      poolNumberId: POOL,
      state: "ignored",
    });
  });
});
