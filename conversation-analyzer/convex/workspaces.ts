import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireWorkspace } from "./authz";
import { DEFAULT_METHODOLOGY, validateSettings } from "./lib/methodology";

async function findByOwner(ctx: QueryCtx | MutationCtx, ownerId: string) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .first();
}

export const ensureWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = (await ctx.auth.getUserIdentity())?.subject;
    if (!ownerId) throw new ConvexError("Not signed in");
    const existing = await findByOwner(ctx, ownerId);
    if (existing) return existing._id;
    return await ctx.db.insert("workspaces", {
      ownerId,
      name: "My workspace",
      inactivityMinutes: 120,
      methodology: DEFAULT_METHODOLOGY,
    });
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

export const updateSettings = mutation({
  args: {
    name: v.string(),
    inactivityMinutes: v.number(),
    methodology: v.array(
      v.object({ id: v.optional(v.string()), name: v.string(), description: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspace(ctx);
    const settings = validateSettings(
      args,
      workspace.methodology.map((step) => step.id),
    );
    await ctx.db.patch(workspace._id, settings);
    return null;
  },
});

export const byOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => await findByOwner(ctx, ownerId),
});
