import { ConvexError, v } from "convex/values";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { applyContactUpdate, insertNote } from "../crm";
import * as crmRead from "../crmRead";
import { createDraft as createDraftRow } from "../drafts";
import { stageValidator } from "../schema";

const CLIENT_NAME_LENGTH = 60;
// Authors the UI shows with their own meaning; a client must not be able to pose as them.
const RESERVED_CLIENT_NAMES = new Set(["you", "system"]);

/**
 * The name a client is shown with as author and actor. Dynamic client registration is open, so the
 * name is chosen by whoever registered the client: trimmed, capped, and never "you" or "system".
 */
export function clientDisplayName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim().slice(0, CLIENT_NAME_LENGTH).trim();
  if (name === "" || RESERVED_CLIENT_NAMES.has(name.toLowerCase())) return "MCP";
  return name;
}

/**
 * The consent `userId` gave to OAuth client `clientId`, plus the client's display name.
 * Null when there is no consent (never granted, or revoked in Settings): access tokens are
 * verified offline and live for an hour, so this is what makes a revocation take effect now.
 */
export const consentAndClient = internalQuery({
  args: { userId: v.string(), clientId: v.string() },
  handler: async (ctx, { userId, clientId }) => {
    const consent = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "oauthConsent",
      where: [
        { field: "clientId", value: clientId },
        { field: "userId", value: userId },
      ],
    });
    if (!consent) return null;
    const client = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    });
    return { scopes: consent.scopes as string[], clientName: clientDisplayName(client?.name) };
  },
});

// Everything below backs the MCP tools. Tool arguments carry the contact id as a plain string, so a
// malformed id or a contact of another workspace is reported as NOT_FOUND instead of throwing.
// ConvexErrors from validation come back as `{ error: message }` for the tool to turn into `isError`.

export const NOT_FOUND = "Contact not found";

type Failure = { error: string };

async function findContact(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  rawId: string,
): Promise<Doc<"contacts"> | null> {
  const id = ctx.db.normalizeId("contacts", rawId);
  const contact = id === null ? null : await ctx.db.get(id);
  return contact !== null && contact.workspaceId === workspaceId ? contact : null;
}

async function failing<T>(run: () => Promise<T>): Promise<T | Failure> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConvexError && typeof error.data === "string") return { error: error.data };
    throw error;
  }
}

export const searchContacts = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.optional(v.string()),
    stage: v.optional(stageValidator),
    tag: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, { workspaceId, limit, ...filters }) =>
    crmRead.searchContacts(ctx, workspaceId, { ...filters, limit }, Date.now()),
});

export const getContact = internalQuery({
  args: { workspaceId: v.id("workspaces"), contactId: v.string() },
  handler: async (ctx, { workspaceId, contactId }) => {
    const id = ctx.db.normalizeId("contacts", contactId);
    const detail = id === null ? null : await crmRead.contactDetail(ctx, workspaceId, id, Date.now());
    return detail ?? ({ error: NOT_FOUND } satisfies Failure);
  },
});

export const getConversation = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    contactId: v.string(),
    limit: v.number(),
    before: v.optional(v.union(v.string(), v.number())),
  },
  handler: async (ctx, { workspaceId, contactId, limit, before }) => {
    const id = ctx.db.normalizeId("contacts", contactId);
    if (id === null) return { error: NOT_FOUND } satisfies Failure;
    // A malformed cursor comes back as a tool error.
    const page = await failing(() => crmRead.conversation(ctx, workspaceId, id, { limit, before }));
    return page ?? ({ error: NOT_FOUND } satisfies Failure);
  },
});

export const listUnanswered = internalQuery({
  args: { workspaceId: v.id("workspaces"), limit: v.number() },
  handler: async (ctx, { workspaceId, limit }) =>
    crmRead.unanswered(ctx, workspaceId, limit, Date.now()),
});

export const pipelineSummary = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => crmRead.pipelineSummary(ctx, workspaceId),
});

/** `workspaces.mcpSendMode`: whether `send_message` saves a draft or sends right away. */
export const sendMode = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }): Promise<"draft" | "direct"> => {
    const workspace = await ctx.db.get(workspaceId);
    return workspace?.mcpSendMode ?? "draft";
  },
});

/** The contact id as an `Id`, or null for a malformed id or a contact of another workspace. */
export const resolveContact = internalQuery({
  args: { workspaceId: v.id("workspaces"), contactId: v.string() },
  handler: async (ctx, { workspaceId, contactId }): Promise<Id<"contacts"> | null> =>
    (await findContact(ctx, workspaceId, contactId))?._id ?? null,
});

type ContactView = Pick<Doc<"contacts">, "name" | "stage" | "tags"> & {
  id: Id<"contacts">;
  phone?: string;
};

function contactView(contact: Doc<"contacts">): ContactView {
  return {
    id: contact._id,
    name: contact.name,
    phone: contact.waId,
    stage: contact.stage,
    tags: contact.tags,
  };
}

async function withContact<T>(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  contactId: string,
  run: (contact: Doc<"contacts">) => Promise<T>,
): Promise<T | Failure> {
  const contact = await findContact(ctx, workspaceId, contactId);
  if (contact === null) return { error: NOT_FOUND };
  return failing(() => run(contact));
}

export const updateContact = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actor: v.string(),
    contactId: v.string(),
    stage: v.optional(v.string()),
    name: v.optional(v.string()),
    addTags: v.optional(v.array(v.string())),
    removeTags: v.optional(v.array(v.string())),
  },
  handler: (ctx, { workspaceId, actor, contactId, ...patch }) =>
    withContact(ctx, workspaceId, contactId, async (contact) => {
      // `stage` stays a string here so applyContactUpdate rejects an unknown one with its own message.
      const updated = await applyContactUpdate(
        ctx,
        contact,
        patch as Parameters<typeof applyContactUpdate>[2],
        actor,
        Date.now(),
      );
      return contactView(updated);
    }),
});

export const addNote = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actor: v.string(),
    contactId: v.string(),
    body: v.string(),
  },
  handler: (ctx, { workspaceId, actor, contactId, body }) =>
    withContact(ctx, workspaceId, contactId, async (contact) => {
      const noteId = await insertNote(ctx, contact, body, actor, Date.now());
      const note = (await ctx.db.get(noteId))!;
      return { id: note._id, body: note.body, author: note.author, createdAt: note.createdAt };
    }),
});

export const createDraft = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    contactId: v.string(),
    text: v.string(),
    clientName: v.string(),
  },
  handler: (ctx, { workspaceId, contactId, text, clientName }) =>
    withContact(ctx, workspaceId, contactId, async (contact) => {
      const result = await createDraftRow(ctx, { workspaceId, contact, text, clientName, now: Date.now() });
      // `error` here is a SendError code; only NOT_FOUND (from withContact) is a message.
      return "error" in result ? result : { ...result, contactLabel: contact.name ?? contact.waId ?? "the contact" };
    }),
});
