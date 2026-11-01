import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type Ctx = QueryCtx | MutationCtx;

export async function requireWorkspace(ctx: Ctx): Promise<Doc<"workspaces">> {
  const ownerId = (await ctx.auth.getUserIdentity())?.subject;
  if (!ownerId) throw new ConvexError("Not signed in");
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .first();
  if (!workspace) throw new ConvexError("Workspace not found");
  return workspace;
}

// A document of another workspace is reported exactly like a missing one.
async function requireOwned<T extends "contacts" | "drafts" | "messages">(
  ctx: Ctx,
  id: Id<T>,
): Promise<{ workspace: Doc<"workspaces">; doc: Doc<T> }> {
  const workspace = await requireWorkspace(ctx);
  const doc = (await ctx.db.get(id)) as Doc<T> | null;
  if (!doc || doc.workspaceId !== workspace._id) throw new ConvexError("Not found");
  return { workspace, doc };
}

export async function requireContact(
  ctx: Ctx,
  contactId: Id<"contacts">,
): Promise<{ workspace: Doc<"workspaces">; contact: Doc<"contacts"> }> {
  const { workspace, doc } = await requireOwned(ctx, contactId);
  return { workspace, contact: doc };
}

export async function requireDraft(
  ctx: Ctx,
  draftId: Id<"drafts">,
): Promise<{ workspace: Doc<"workspaces">; draft: Doc<"drafts"> }> {
  const { workspace, doc } = await requireOwned(ctx, draftId);
  return { workspace, draft: doc };
}

export async function requireMessage(
  ctx: Ctx,
  messageId: Id<"messages">,
): Promise<{ workspace: Doc<"workspaces">; message: Doc<"messages"> }> {
  const { workspace, doc } = await requireOwned(ctx, messageId);
  return { workspace, message: doc };
}
