import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { makeT, seedUser } from "../tests/helpers";
import type { Doc } from "./_generated/dataModel";
import { applyContactUpdate, insertNote } from "./crm";

const NOW = 1_800_000_000_000;

async function seedContact(overrides: Partial<Doc<"contacts">> = {}) {
  const t = makeT();
  const { workspaceId } = await seedUser(t);
  const contact = await t.run(async (ctx) => {
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: "pn_1",
      phoneNumber: "+15550001111",
      displayName: "Support",
      connectedAt: 0,
    });
    const id = await ctx.db.insert("contacts", {
      workspaceId,
      waId: "5511900000000",
      name: "Ana",
      stage: "lead",
      tags: ["cold"],
      lastNumberId: numberId,
      lastMessageAt: 0,
      lastDirection: "in",
      unread: 0,
      searchText: "Ana 5511900000000",
      ...overrides,
    });
    return (await ctx.db.get(id))!;
  });
  return { t, contact };
}

const activities = (t: Awaited<ReturnType<typeof seedContact>>["t"]) =>
  t.run((ctx) => ctx.db.query("activities").collect());

describe("applyContactUpdate", () => {
  it("writes one activity per change", async () => {
    const { t, contact } = await seedContact();

    const updated = await t.run((ctx) =>
      applyContactUpdate(
        ctx,
        contact,
        { stage: "qualified", name: "  Ana Souza ", addTags: [" Big Deal "], removeTags: ["cold"] },
        "you",
        NOW,
      ),
    );

    expect(updated).toMatchObject({
      stage: "qualified",
      name: "Ana Souza",
      tags: ["big-deal"],
      searchText: "Ana Souza 5511900000000",
    });
    expect(await t.run((ctx) => ctx.db.get(contact._id))).toEqual(updated);
    const rows = await activities(t);
    expect(rows.map((a) => [a.kind, a.detail])).toEqual([
      ["stage_changed", "lead → qualified"],
      ["renamed", "Ana → Ana Souza"],
      ["tags_changed", "+big-deal −cold"],
    ]);
    expect(rows.every((a) => a.actor === "you" && a.createdAt === NOW)).toBe(true);
    expect(rows.every((a) => a.contactId === contact._id)).toBe(true);
  });

  it("writes nothing when nothing changes", async () => {
    const { t, contact } = await seedContact();

    const updated = await t.run((ctx) =>
      applyContactUpdate(
        ctx,
        contact,
        { stage: "lead", name: "Ana", addTags: ["COLD"], removeTags: ["missing"] },
        "you",
        NOW,
      ),
    );

    expect(updated).toEqual(contact);
    expect(await activities(t)).toHaveLength(0);
  });

  it("invalid tag writes nothing", async () => {
    const { t, contact } = await seedContact();

    await expect(
      t.run((ctx) =>
        applyContactUpdate(
          ctx,
          contact,
          { stage: "customer", name: "New name", addTags: ["ok", "x".repeat(33)] },
          "Claude",
          NOW,
        ),
      ),
    ).rejects.toThrow(ConvexError);

    expect(await t.run((ctx) => ctx.db.get(contact._id))).toEqual(contact);
    expect(await activities(t)).toHaveLength(0);
  });

  it("rejects an unknown stage and an empty name without writing", async () => {
    const { t, contact } = await seedContact();

    await expect(
      t.run((ctx) => applyContactUpdate(ctx, contact, { stage: "won" as never }, "you", NOW)),
    ).rejects.toThrow(ConvexError);
    await expect(
      t.run((ctx) => applyContactUpdate(ctx, contact, { name: "   " }, "you", NOW)),
    ).rejects.toThrow(ConvexError);

    expect(await t.run((ctx) => ctx.db.get(contact._id))).toEqual(contact);
    expect(await activities(t)).toHaveLength(0);
  });
});

describe("insertNote", () => {
  it("stores the note and an activity with the first 80 characters", async () => {
    const { t, contact } = await seedContact();
    const body = `  ${"a".repeat(100)}  `;

    const noteId = await t.run((ctx) => insertNote(ctx, contact, body, "Claude", NOW));

    const note = await t.run((ctx) => ctx.db.get(noteId));
    expect(note).toMatchObject({ contactId: contact._id, body: "a".repeat(100), author: "Claude", createdAt: NOW });
    const [activity] = await activities(t);
    expect(activity).toMatchObject({ kind: "note_added", actor: "Claude", detail: "a".repeat(80) });
  });

  it("rejects an empty or oversized note without writing", async () => {
    const { t, contact } = await seedContact();

    await expect(t.run((ctx) => insertNote(ctx, contact, "  ", "you", NOW))).rejects.toThrow(ConvexError);
    await expect(t.run((ctx) => insertNote(ctx, contact, "x".repeat(2001), "you", NOW))).rejects.toThrow(
      ConvexError,
    );

    expect(await t.run((ctx) => ctx.db.query("notes").collect())).toHaveLength(0);
    expect(await activities(t)).toHaveLength(0);
  });
});
