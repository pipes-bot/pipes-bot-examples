import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireWorkspace } from "./authz";
import { cleanText } from "./lib/crm";

const mcpSendModeValidator = v.union(v.literal("draft"), v.literal("direct"));

async function findByOwner(ctx: QueryCtx | MutationCtx, ownerId: string) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .first();
}

/** One workspace per user. MCP uses it too, so a user who authorizes a client before ever opening the app still gets one. */
export async function findOrCreateWorkspace(
  ctx: MutationCtx,
  ownerId: string,
): Promise<Id<"workspaces">> {
  const existing = await findByOwner(ctx, ownerId);
  if (existing) return existing._id;
  return await ctx.db.insert("workspaces", {
    ownerId,
    name: "My workspace",
    mcpSendMode: "draft",
  });
}

export const ensureWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = (await ctx.auth.getUserIdentity())?.subject;
    if (!ownerId) throw new ConvexError("Not signed in");
    return await findOrCreateWorkspace(ctx, ownerId);
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = (await ctx.auth.getUserIdentity())?.subject;
    if (!ownerId) return null;
    return await findByOwner(ctx, ownerId);
  },
});

export const update = mutation({
  args: { name: v.optional(v.string()), mcpSendMode: v.optional(mcpSendModeValidator) },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspace(ctx);
    await ctx.db.patch(workspace._id, {
      ...(args.name !== undefined ? { name: cleanText(args.name, 80, "name") } : {}),
      ...(args.mcpSendMode !== undefined ? { mcpSendMode: args.mcpSendMode } : {}),
    });
    return null;
  },
});

export const byOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => await findByOwner(ctx, ownerId),
});

export const forOwner = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => await findOrCreateWorkspace(ctx, ownerId),
});
