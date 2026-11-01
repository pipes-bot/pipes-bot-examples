import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOUR,
  makeT,
  seedContact,
  seedNumber,
  seedUser,
  type TestConvex,
} from "../tests/helpers";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { createDraft } from "./drafts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ok = () => jsonResponse({ messageId: "wamid.D", contacts: [] });

async function seed(contact: Partial<Doc<"contacts">> = {}) {
  const t = makeT();
  const { workspaceId, asUser } = await seedUser(t);
  const numberId = await seedNumber(t, workspaceId);
  const contactId = await seedContact(t, workspaceId, numberId, contact);
  return { t, workspaceId, asUser, contactId };
}

function draftOf(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  contactId: Id<"contacts">,
  text: string,
  clientName = "Claude",
) {
  return t.run(async (ctx) => {
    const contact = (await ctx.db.get(contactId))!;
    return await createDraft(ctx, { workspaceId, contact, text, clientName, now: Date.now() });
  });
}

async function newDraft(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  contactId: Id<"contacts">,
  text = "Hi Ana",
) {
  const created = await draftOf(t, workspaceId, contactId, text);
  if (!("draftId" in created)) throw new Error(`draft refused: ${created.error}`);
  return created.draftId;
}

async function activitiesOf(t: TestConvex, contactId: Id<"contacts">, kind: string) {
  const all = await t.run((ctx) =>
    ctx.db
      .query("activities")
      .withIndex("by_contact_created", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  return all.filter((a) => a.kind === kind);
}

function messageCount(t: TestConvex) {
  return t.run(async (ctx) => (await ctx.db.query("messages").collect()).length);
}

beforeEach(() => {
  vi.stubEnv("PIPES_API_KEY", "pk_smoke_test_key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createDraft", () => {
  it("creates a pending draft and its activity", async () => {
    const { t, workspaceId, contactId } = await seed();

    const draftId = await newDraft(t, workspaceId, contactId, "  Hi Ana  ");

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft).toMatchObject({ status: "pending", text: "Hi Ana", clientName: "Claude" });
    const created = await activitiesOf(t, contactId, "draft_created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor: "Claude", detail: "Hi Ana" });
  });

  it("create refuses when the window is closed", async () => {
    const { t, workspaceId, contactId } = await seed({ lastInboundAt: Date.now() - 25 * HOUR });

    expect(await draftOf(t, workspaceId, contactId, "Hi")).toEqual({ error: "window_closed" });

    expect(await t.run((ctx) => ctx.db.query("drafts").collect())).toHaveLength(0);
    expect(await activitiesOf(t, contactId, "draft_created")).toHaveLength(0);
  });

  it("create refuses invalid text", async () => {
    const { t, workspaceId, contactId } = await seed();

    expect(await draftOf(t, workspaceId, contactId, "  ")).toEqual({ error: "invalid_text" });
    expect(await draftOf(t, workspaceId, contactId, "x".repeat(4097))).toEqual({
      error: "invalid_text",
    });
    expect(await t.run((ctx) => ctx.db.query("drafts").collect())).toHaveLength(0);
  });
});

describe("approve", () => {
  it("approve with edited text", async () => {
    const { t, workspaceId, asUser, contactId } = await seed();
    const draftId = await newDraft(t, workspaceId, contactId, "Hi Ana");
    const fetchMock = stubFetch(ok);

    const result = await asUser.action(api.drafts.approve, {
      draftId,
      text: "Hi Ana, welcome aboard!",
    });

    expect(result.status).toBe("sent");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).text).toBe(
      "Hi Ana, welcome aboard!",
    );
    const message = await t.run((ctx) => ctx.db.get(result.messageId!));
    expect(message).toMatchObject({
      text: "Hi Ana, welcome aboard!",
      source: "mcp",
      clientName: "Claude",
      draftId,
      status: "sent",
    });
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft).toMatchObject({ status: "sent", messageId: result.messageId, text: "Hi Ana" });
    expect(draft?.decidedAt).toBeTypeOf("number");
    const decided = await activitiesOf(t, contactId, "draft_decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ detail: "sent (edited)", actor: "you" });
    const sent = await activitiesOf(t, contactId, "message_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].actor).toBe("Claude");
  });

  it("approve twice sends once", async () => {
    const { t, workspaceId, asUser, contactId } = await seed();
    const draftId = await newDraft(t, workspaceId, contactId, "Hi Ana");
    const fetchMock = stubFetch(ok);

    const results = await Promise.all([
      asUser.action(api.drafts.approve, { draftId, text: "Hi Ana" }),
      asUser.action(api.drafts.approve, { draftId, text: "Hi Ana" }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status).sort()).toEqual(["failed", "sent"]);
    expect(results.find((r) => r.status === "failed")).toEqual({
      status: "failed",
      error: "Draft is no longer pending",
    });
    expect(await messageCount(t)).toBe(1);
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.status).toBe("sent");
    const decided = await activitiesOf(t, contactId, "draft_decided");
    expect(decided.map((a) => a.detail)).toEqual(["sent"]);
  });

  it("approve on a closed window releases the draft", async () => {
    const { t, workspaceId, asUser, contactId } = await seed();
    const draftId = await newDraft(t, workspaceId, contactId);
    await t.run((ctx) => ctx.db.patch(contactId, { lastInboundAt: Date.now() - 25 * HOUR }));
    const fetchMock = stubFetch(ok);

    const result = await asUser.action(api.drafts.approve, { draftId, text: "Hi Ana" });

    expect(result).toEqual({ status: "failed", error: "window_closed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await messageCount(t)).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("pending");
    // Still discardable.
    await asUser.mutation(api.drafts.discard, { draftId });
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("discarded");
  });

  it("a failed send marks the draft failed", async () => {
    const { t, workspaceId, asUser, contactId } = await seed();
    const draftId = await newDraft(t, workspaceId, contactId);
    stubFetch(() => jsonResponse({ error: { code: 131026, message: "Undeliverable" } }, 400));

    const result = await asUser.action(api.drafts.approve, { draftId, text: "Hi Ana" });

    expect(result).toMatchObject({ status: "failed", error: "meta_131026" });
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft).toMatchObject({
      status: "failed",
      error: "meta_131026",
      messageId: result.messageId,
    });
    const decided = await activitiesOf(t, contactId, "draft_decided");
    expect(decided.map((a) => a.detail)).toEqual(["failed: meta_131026"]);
  });
});

describe("discard and list", () => {
  it("discard", async () => {
    const { t, workspaceId, asUser, contactId } = await seed();
    const draftId = await newDraft(t, workspaceId, contactId);
    const fetchMock = stubFetch(ok);

    await asUser.mutation(api.drafts.discard, { draftId });

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.status).toBe("discarded");
    expect(draft?.decidedAt).toBeTypeOf("number");
    const decided = await activitiesOf(t, contactId, "draft_decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ detail: "discarded", actor: "you" });

    await expect(asUser.mutation(api.drafts.discard, { draftId })).rejects.toThrow(
      /no longer pending/,
    );
    expect(await asUser.action(api.drafts.approve, { draftId, text: "Hi Ana" })).toEqual({
      status: "failed",
      error: "Draft is no longer pending",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pendingFor lists pending drafts newest first with the window", async () => {
    const { t, workspaceId, asUser, contactId } = await seed();
    const older = await newDraft(t, workspaceId, contactId, "First");
    const newer = await newDraft(t, workspaceId, contactId, "Second");
    const discarded = await newDraft(t, workspaceId, contactId, "Third");
    await asUser.mutation(api.drafts.discard, { draftId: discarded });

    const drafts = await asUser.query(api.drafts.pendingFor, { contactId });

    expect(drafts.map((d) => d._id)).toEqual([newer, older]);
    expect(drafts[0].window.open).toBe(true);
    expect(drafts[0].window.closesAt).toBeTypeOf("number");
  });

  it("other workspace cannot approve or discard", async () => {
    const { t, workspaceId, contactId } = await seed();
    const draftId = await newDraft(t, workspaceId, contactId);
    const { asUser: other } = await seedUser(t, "user_b");
    const fetchMock = stubFetch(ok);

    await expect(
      other.action(api.drafts.approve, { draftId, text: "Hi Ana" }),
    ).rejects.toThrow(/Not found/);
    await expect(other.mutation(api.drafts.discard, { draftId })).rejects.toThrow(/Not found/);
    await expect(other.query(api.drafts.pendingFor, { contactId })).rejects.toThrow(/Not found/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("pending");
  });
});
