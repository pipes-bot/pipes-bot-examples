import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireContact, requireWorkspace } from "./authz";
import { applyContactUpdate, insertNote } from "./crm";
import * as read from "./crmRead";
import { stageValidator } from "./schema";

const CONVERSATION_PAGE = 100;

export const pipeline = query({
  args: {},
  handler: async (ctx) => {
    const workspace = await requireWorkspace(ctx);
    return read.pipeline(ctx, workspace._id, Date.now());
  },
});

export const inbox = query({
  args: { filter: v.union(v.literal("all"), v.literal("waiting"), v.literal("drafts")) },
  handler: async (ctx, { filter }) => {
    const workspace = await requireWorkspace(ctx);
    return read.inbox(ctx, workspace._id, filter, Date.now());
  },
});

export const detail = query({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    const { workspace } = await requireContact(ctx, contactId);
    return read.contactDetail(ctx, workspace._id, contactId, Date.now());
  },
});

export const conversation = query({
  // `before` is the `nextBefore` of the previous page (a bare sentAt number is also accepted).
  args: { contactId: v.id("contacts"), before: v.optional(v.union(v.string(), v.number())) },
  handler: async (ctx, { contactId, before }) => {
    const { workspace } = await requireContact(ctx, contactId);
    return read.conversation(ctx, workspace._id, contactId, { limit: CONVERSATION_PAGE, before });
  },
});

export const update = mutation({
  args: {
    contactId: v.id("contacts"),
    stage: v.optional(stageValidator),
    name: v.optional(v.string()),
    addTags: v.optional(v.array(v.string())),
    removeTags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { contactId, ...patch }) => {
    const { contact } = await requireContact(ctx, contactId);
    await applyContactUpdate(ctx, contact, patch, "you", Date.now());
  },
});

export const addNote = mutation({
  args: { contactId: v.id("contacts"), body: v.string() },
  handler: async (ctx, { contactId, body }) => {
    const { contact } = await requireContact(ctx, contactId);
    await insertNote(ctx, contact, body, "you", Date.now());
  },
});

export const markRead = mutation({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    const { contact } = await requireContact(ctx, contactId);
    if (contact.unread > 0) await ctx.db.patch(contact._id, { unread: 0 });
  },
});
