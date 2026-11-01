import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireWorkspace } from "./authz";

const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
const MAX_INSTRUCTIONS = 4000;
const MAX_FAQ = 16000;

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
      instructions: "",
      faq: "",
      idleMinutes: 30,
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

export const update = mutation({
  args: {
    name: v.optional(v.string()),
    instructions: v.optional(v.string()),
    faq: v.optional(v.string()),
    idleMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspace(ctx);
    // Validate every field before writing anything.
    const patch: { name?: string; instructions?: string; faq?: string; idleMinutes?: number } = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name.length < 1 || name.length > 80) throw new ConvexError("Name must be 1–80 characters");
      patch.name = name;
    }
    if (args.instructions !== undefined) {
      const instructions = args.instructions.trim();
      if (instructions.length > MAX_INSTRUCTIONS) {
        throw new ConvexError(`Instructions must be at most ${MAX_INSTRUCTIONS} characters`);
      }
      patch.instructions = instructions;
    }
    if (args.faq !== undefined) {
      const faq = args.faq.trim();
      if (faq.length > MAX_FAQ) throw new ConvexError(`FAQ must be at most ${MAX_FAQ} characters`);
      patch.faq = faq;
    }
    if (args.idleMinutes !== undefined) {
      const minutes = args.idleMinutes;
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
        throw new ConvexError("Minutes must be a whole number from 5 to 1440");
      }
      patch.idleMinutes = minutes;
    }
    await ctx.db.patch(workspace._id, patch);
    return null;
  },
});

// Without an OpenRouter key the app runs on the built-in demo replies.
export const modelStatus = query({
  args: {},
  handler: async (ctx): Promise<{ kind: "openrouter"; model: string } | { kind: "demo" }> => {
    if (!(await ctx.auth.getUserIdentity())) throw new ConvexError("Not signed in");
    if (!process.env.OPENROUTER_API_KEY) return { kind: "demo" };
    return { kind: "openrouter", model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL };
  },
});

export const byOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => await findByOwner(ctx, ownerId),
});
