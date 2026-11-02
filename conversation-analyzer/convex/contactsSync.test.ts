import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messageText from "../tests/fixtures/message-text.json";
import smbAppStateSync from "../tests/fixtures/smb-app-state-sync.json";
import { makeT } from "../tests/helpers";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_METHODOLOGY } from "./lib/methodology";

const NOW = 1_800_000_000_000;
const POOL = "pn_abc123";
const ADDED_WA_ID = "16505551234";
const REMOVED_WA_ID = "16505550000";

type T = ReturnType<typeof makeT>;
type Item = {
  action: "add" | "remove";
  phone?: string;
  fullName?: string;
  firstName?: string;
  at: number;
  type?: string;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let seq = 0;
const ingest = (t: T, payload: any) =>
  t.mutation(internal.ingest.ingest, { webhookId: `wh_${++seq}`, payload });

async function seedNumber(t: T, contactsImport?: { state: "requested" | "received"; updatedAt: number }) {
  return t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId: "owner_a",
      name: "Acme",
      inactivityMinutes: 120,
      methodology: DEFAULT_METHODOLOGY,
    });
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: POOL,
      phoneNumber: "+15550001111",
      displayName: "Support",
      connectedAt: 0,
      ...(contactsImport ? { contactsImport } : {}),
    });
    return { workspaceId, numberId };
  });
}

/** The fixture envelope with `state_sync` replaced by the given items. */
function sync(items: Item[]): any {
  const copy = structuredClone(smbAppStateSync) as any;
  copy.whatsapp.state_sync = items.map((item) => ({
    type: item.type ?? "contact",
    contact: {
      ...(item.fullName ? { full_name: item.fullName } : {}),
      ...(item.firstName ? { first_name: item.firstName } : {}),
      ...(item.phone ? { phone_number: item.phone } : {}),
    },
    action: item.action,
    metadata: { timestamp: String(item.at) },
  }));
  return copy;
}

const contacts = (t: T) => t.run((ctx) => ctx.db.query("contacts").collect());
const contactsImportOf = (t: T, numberId: Id<"numbers">) =>
  t.run(async (ctx) => (await ctx.db.get(numberId))!.contactsImport ?? null);

describe("contacts sync", () => {
  it("add creates a contact with bookName", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, smbAppStateSync);

    const rows = await contacts(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      waId: ADDED_WA_ID,
      bookName: "Sheena Nelson",
      bookUpdatedAt: 1760400000 * 1000,
    });
    expect(rows[0].name).toBeUndefined();
  });

  it("add falls back to first_name and keeps only the timestamp when unnamed", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(
      t,
      sync([
        { action: "add", phone: "111", firstName: "Ana", at: 100 },
        { action: "add", phone: "222", at: 100 },
      ]),
    );

    const rows = await contacts(t);
    expect(rows.find((c) => c.waId === "111")).toMatchObject({ bookName: "Ana", bookUpdatedAt: 100_000 });
    const unnamed = rows.find((c) => c.waId === "222")!;
    expect(unnamed.bookName).toBeUndefined();
    expect(unnamed.bookUpdatedAt).toBe(100_000);
  });

  it("an unnamed add keeps the existing bookName", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, sync([{ action: "add", phone: "111", fullName: "Ana", at: 50 }]));
    await ingest(t, sync([{ action: "add", phone: "111", at: 60 }]));

    expect(await contacts(t)).toMatchObject([{ bookName: "Ana", bookUpdatedAt: 60_000 }]);
  });

  it("add fills bookName on an existing contact", async () => {
    const t = makeT();
    await seedNumber(t);
    const live = structuredClone(messageText) as any;
    live.pipes.poolNumberId = POOL;
    live.whatsapp.messages[0].from = ADDED_WA_ID;
    live.whatsapp.contacts = [{ wa_id: ADDED_WA_ID, profile: { name: "Sheena" } }];
    await ingest(t, live);
    expect(await contacts(t)).toMatchObject([{ waId: ADDED_WA_ID, name: "Sheena" }]);

    await ingest(t, smbAppStateSync);

    const rows = await contacts(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Sheena", bookName: "Sheena Nelson" });
  });

  it("remove clears bookName but keeps the contact", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    const contactId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("contacts", {
        numberId,
        waId: REMOVED_WA_ID,
        name: "Old",
        bookName: "Old Contact",
        bookUpdatedAt: 1,
      });
      await ctx.db.insert("conversations", {
        workspaceId,
        numberId,
        contactId: id,
        status: "open",
        initiatedBy: "customer",
        openedAt: 1,
        lastActivityAt: 1,
        lastTurn: "customer",
      });
      return id;
    });

    await ingest(t, smbAppStateSync);

    const removed = (await contacts(t)).find((c) => c._id === contactId)!;
    expect(removed.bookName).toBeUndefined();
    expect(removed.bookRemovedAt).toBe(1760400100 * 1000);
    expect(removed.bookUpdatedAt).toBe(1760400100 * 1000);
    expect(removed.name).toBe("Old");
    expect(await t.run((ctx) => ctx.db.query("conversations").collect())).toHaveLength(1);
  });

  it("remove for an unknown contact creates nothing", async () => {
    const t = makeT();
    await seedNumber(t);

    await ingest(t, sync([{ action: "remove", phone: "999", at: 100 }]));

    expect(await contacts(t)).toHaveLength(0);
  });

  it("older add after a remove is ignored", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, sync([{ action: "add", phone: "111", fullName: "Ana", at: 50 }]));
    await ingest(t, sync([{ action: "remove", phone: "111", at: 200 }]));
    await ingest(t, sync([{ action: "add", phone: "111", fullName: "Ana Late", at: 100 }]));

    const [contact] = await contacts(t);
    expect(contact.bookName).toBeUndefined();
    expect(contact.bookUpdatedAt).toBe(200_000);
    expect(contact.bookRemovedAt).toBe(200_000);
  });

  it("a newer add after a remove restores the name and clears bookRemovedAt", async () => {
    const t = makeT();
    await seedNumber(t);
    await ingest(t, sync([{ action: "add", phone: "111", fullName: "Ana", at: 50 }]));
    await ingest(t, sync([{ action: "remove", phone: "111", at: 200 }]));
    await ingest(t, sync([{ action: "add", phone: "111", fullName: "Ana B", at: 300 }]));

    const [contact] = await contacts(t);
    expect(contact.bookName).toBe("Ana B");
    expect(contact.bookRemovedAt).toBeUndefined();
    expect(contact.bookUpdatedAt).toBe(300_000);
  });

  it("first event marks contacts received", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t, { state: "requested", updatedAt: 1 });

    await ingest(t, smbAppStateSync);
    expect(await contactsImportOf(t, numberId)).toEqual({ state: "received", updatedAt: NOW });

    vi.setSystemTime(NOW + 5000);
    await ingest(t, sync([{ action: "add", phone: "111", fullName: "Ana", at: 50 }]));
    expect(await contactsImportOf(t, numberId)).toEqual({ state: "received", updatedAt: NOW + 5000 });
  });

  it("applies events even when the number never requested contacts", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);

    await ingest(t, smbAppStateSync);

    expect(await contacts(t)).toHaveLength(1);
    expect((await contactsImportOf(t, numberId))?.state).toBe("received");
  });

  it("items without phone_number or with another type are skipped", async () => {
    const t = makeT();
    const { numberId } = await seedNumber(t);

    await ingest(
      t,
      sync([
        { action: "add", fullName: "No Phone", at: 100 },
        { action: "add", phone: "333", fullName: "Group", at: 100, type: "group" },
      ]),
    );

    expect(await contacts(t)).toHaveLength(0);
    expect(await contactsImportOf(t, numberId)).toBeNull();
  });

  it("parks before onboarding and replays through the same projection", async () => {
    const t = makeT();
    const workspaceId = await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        ownerId: "owner_a",
        name: "Acme",
        inactivityMinutes: 120,
        methodology: DEFAULT_METHODOLOGY,
      }),
    );
    expect(await ingest(t, smbAppStateSync)).toBe("parked");

    await ingest(t, {
      event: "number.onboarded",
      data: { numberId: POOL, phoneNumber: "+15550001111", displayName: "Support", metadata: { workspaceId } },
    });

    expect(await contacts(t)).toMatchObject([{ waId: ADDED_WA_ID, bookName: "Sheena Nelson" }]);
  });
});

describe("display name", () => {
  it("prefers the address book name over the profile name", async () => {
    const t = makeT();
    const { workspaceId, numberId } = await seedNumber(t);
    await t.run(async (ctx) => {
      const both = await ctx.db.insert("contacts", { numberId, waId: "111", name: "Profile", bookName: "Book" });
      const profileOnly = await ctx.db.insert("contacts", { numberId, waId: "222", name: "Profile Only" });
      const open = (contactId: typeof both, lastActivityAt: number) =>
        ctx.db.insert("conversations", {
          workspaceId,
          numberId,
          contactId,
          status: "open",
          initiatedBy: "customer",
          openedAt: lastActivityAt,
          lastActivityAt,
          lastTurn: "customer",
          waitingSince: lastActivityAt,
        });
      await open(both, NOW - 2000);
      await open(profileOnly, NOW - 1000);
    });
    const asOwner = t.withIdentity({ subject: "owner_a" });

    const waiting = await asOwner.query(api.dashboard.waiting, {});
    expect(waiting.map((r) => [r.contactId, r.contactName])).toEqual([
      ["111", "Book"],
      ["222", "Profile Only"],
    ]);

    const open = await asOwner.query(api.dashboard.conversations, { numberId, status: "open" });
    expect(open.map((r) => [r.contactLabel, r.contactName]).sort()).toEqual([
      ["111", "Book"],
      ["222", "Profile Only"],
    ]);
  });
});
