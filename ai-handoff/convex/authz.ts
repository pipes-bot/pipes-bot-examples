import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export async function requireWorkspace(ctx: QueryCtx | MutationCtx): Promise<Doc<"workspaces">> {
  const ownerId = (await ctx.auth.getUserIdentity())?.subject;
  if (!ownerId) throw new ConvexError("Not signed in");
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .first();
  if (!workspace) throw new ConvexError("Workspace not found");
  return workspace;
}

export async function requireNumber(
  ctx: QueryCtx | MutationCtx,
  numberId: Id<"numbers">,
): Promise<{ workspace: Doc<"workspaces">; number: Doc<"numbers"> }> {
  const workspace = await requireWorkspace(ctx);
  const number = await ctx.db.get(numberId);
  if (!number || number.workspaceId !== workspace._id) throw new ConvexError("Not found");
  return { workspace, number };
}

export async function requireConversation(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
): Promise<{ workspace: Doc<"workspaces">; conversation: Doc<"conversations"> }> {
  const workspace = await requireWorkspace(ctx);
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.workspaceId !== workspace._id) {
    throw new ConvexError("Not found");
  }
  return { workspace, conversation };
}

export async function requireRequest(
  ctx: QueryCtx | MutationCtx,
  requestId: Id<"requests">,
): Promise<{ workspace: Doc<"workspaces">; request: Doc<"requests"> }> {
  const workspace = await requireWorkspace(ctx);
  const request = await ctx.db.get(requestId);
  if (!request || request.workspaceId !== workspace._id) throw new ConvexError("Not found");
  return { workspace, request };
}
