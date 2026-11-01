import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requireContact, requireDraft, requireWorkspaceId } from "./authz";
import { recordActivity } from "./crm";
import { windowState } from "./lib/crm";
import type { SendError, SendResult } from "./lib/send";
import { deliverMessage, sendableText, sendRefusal, startSend } from "./sending";

const ACTIVITY_DETAIL_LENGTH = 80;
const NOT_PENDING = "Draft is no longer pending";

/** Called by the MCP tools in draft mode, with a contact already checked against the workspace. */
export async function createDraft(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    contact: Doc<"contacts">;
    text: string;
    clientName: string;
    now: number;
  },
): Promise<{ draftId: Id<"drafts"> } | { error: SendError }> {
  const { workspaceId, contact, clientName, now } = args;
  if (contact.workspaceId !== workspaceId) throw new ConvexError("Not found");
  const text = sendableText(args.text);
  if (text === null) return { error: "invalid_text" };
  // The same refusals as a send, so a draft that could never be approved is not created.
  const refusal = await sendRefusal(ctx, workspaceId, contact, now);
  if (refusal !== null) return { error: refusal };
  const draftId = await ctx.db.insert("drafts", {
    workspaceId,
    contactId: contact._id,
    text,
    clientName,
    status: "pending",
    createdAt: now,
  });
  await recordActivity(ctx, {
    workspaceId,
    contactId: contact._id,
    kind: "draft_created",
    actor: clientName,
    detail: text.slice(0, ACTIVITY_DETAIL_LENGTH),
    createdAt: now,
  });
  return { draftId };
}

type Claim =
  | { ok: true; contactId: Id<"contacts">; clientName: string }
  | { ok: false; error: typeof NOT_PENDING };

/** pending → sending in one transaction: of two concurrent approvals, only one gets the draft. */
export const claim = internalMutation({
  args: { draftId: v.id("drafts"), workspaceId: v.id("workspaces") },
  handler: async (ctx, { draftId, workspaceId }): Promise<Claim> => {
    const draft = await ctx.db.get(draftId);
    if (!draft || draft.workspaceId !== workspaceId) throw new ConvexError("Not found");
    if (draft.status !== "pending") return { ok: false, error: NOT_PENDING };
    await ctx.db.patch(draftId, { status: "sending" });
    return { ok: true, contactId: draft.contactId, clientName: draft.clientName };
  },
});

/** sending → pending, when the send was refused before any message was written. */
export const release = internalMutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }) => {
    const draft = await ctx.db.get(draftId);
    if (draft?.status === "sending") await ctx.db.patch(draftId, { status: "pending" });
    return null;
  },
});

export const approve = action({
  args: { draftId: v.id("drafts"), text: v.string() },
  handler: async (ctx, { draftId, text }): Promise<SendResult> => {
    const workspaceId = await requireWorkspaceId(ctx);
    const claimed = await ctx.runMutation(internal.drafts.claim, { draftId, workspaceId });
    if (!claimed.ok) return { status: "failed", error: claimed.error };

    let started: Awaited<ReturnType<typeof startSend>>;
    try {
      started = await startSend(ctx, {
        workspaceId,
        contactId: claimed.contactId,
        text,
        source: "mcp",
        clientName: claimed.clientName,
        draftId,
      });
    } catch (error) {
      await ctx.runMutation(internal.drafts.release, { draftId });
      throw error;
    }
    if ("error" in started) {
      // Nothing was sent, so the draft goes back to pending and can still be discarded.
      await ctx.runMutation(internal.drafts.release, { draftId });
      return { status: "failed", error: started.error };
    }
    // From here the message exists: finish marks the draft sent or failed.
    return await deliverMessage(ctx, started.messageId);
  },
});

export const discard = mutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }) => {
    const { draft } = await requireDraft(ctx, draftId);
    if (draft.status !== "pending") throw new ConvexError(NOT_PENDING);
    const now = Date.now();
    await ctx.db.patch(draftId, { status: "discarded", decidedAt: now });
    await recordActivity(ctx, {
      workspaceId: draft.workspaceId,
      contactId: draft.contactId,
      kind: "draft_decided",
      actor: "you",
      detail: "discarded",
      createdAt: now,
    });
    return null;
  },
});

export const pendingFor = query({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    const { contact } = await requireContact(ctx, contactId);
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_contact_status", (q) => q.eq("contactId", contactId).eq("status", "pending"))
      .order("desc")
      .take(100);
    const window = windowState(contact, Date.now());
    return drafts.map((draft) => ({ ...draft, window }));
  },
});
