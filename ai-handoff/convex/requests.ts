import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireRequest, requireWorkspace } from "./authz";

const LIST_LIMIT = 100;

export const list = query({
  args: { status: v.union(v.literal("open"), v.literal("done")) },
  handler: async (ctx, { status }) => {
    const workspace = await requireWorkspace(ctx);
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_workspace_status_created", (q) => q.eq("workspaceId", workspace._id).eq("status", status))
      .order("desc")
      .take(LIST_LIMIT);
    return await Promise.all(
      requests.map(async (request) => {
        const conversation = await ctx.db.get(request.conversationId);
        return { request, conversationName: conversation?.name, phone: conversation?.waId };
      }),
    );
  },
});

export const markDone = mutation({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    const { request } = await requireRequest(ctx, requestId);
    if (request.status === "done") return null;
    await ctx.db.patch(requestId, { status: "done", doneAt: Date.now() });
    return null;
  },
});
