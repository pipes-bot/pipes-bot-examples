import { describe, expect, it } from "vitest";
import { requireConversation, requireNumber, requireRequest } from "./authz";
import { makeT } from "../tests/helpers";

async function seed(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const make = async (ownerId: string) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        ownerId,
        name: "W",
        instructions: "",
        faq: "",
        idleMinutes: 30,
      });
      const numberId = await ctx.db.insert("numbers", {
        workspaceId,
        poolNumberId: `pool_${ownerId}`,
        phoneNumber: "+5511999990000",
        displayName: "N",
        connectedAt: 1,
        aiEnabled: true,
      });
      const conversationId = await ctx.db.insert("conversations", {
        workspaceId,
        numberId,
        mode: "ai",
        modeChangedAt: 1,
        aiTurn: 0,
        lastMessageAt: 1,
        lastFrom: "customer",
        lastPreview: "hi",
        aiReplies: { windowStart: 1, count: 0 },
      });
      const requestId = await ctx.db.insert("requests", {
        workspaceId,
        conversationId,
        summary: "s",
        details: "d",
        status: "open",
        createdAt: 1,
      });
      return { workspaceId, numberId, conversationId, requestId };
    };
    return { a: await make("user_a"), b: await make("user_b") };
  });
}

describe("authz", () => {
  it("resolves the caller's own resources", async () => {
    const t = makeT();
    const { a } = await seed(t);
    const user = t.withIdentity({ subject: "user_a" });
    const result = await user.run(async (ctx) => ({
      number: await requireNumber(ctx, a.numberId),
      conversation: await requireConversation(ctx, a.conversationId),
      request: await requireRequest(ctx, a.requestId),
    }));
    expect(result.number.workspace._id).toBe(a.workspaceId);
    expect(result.conversation.conversation._id).toBe(a.conversationId);
    expect(result.request.request._id).toBe(a.requestId);
    expect(result.request.workspace._id).toBe(a.workspaceId);
  });

  it("another workspace's resources are not found", async () => {
    const t = makeT();
    const { b } = await seed(t);
    const user = t.withIdentity({ subject: "user_a" });
    await expect(user.run((ctx) => requireNumber(ctx, b.numberId))).rejects.toThrow("Not found");
    await expect(user.run((ctx) => requireConversation(ctx, b.conversationId))).rejects.toThrow("Not found");
    await expect(user.run((ctx) => requireRequest(ctx, b.requestId))).rejects.toThrow("Not found");
  });

  it("signed out is refused", async () => {
    const t = makeT();
    const { a } = await seed(t);
    await expect(t.run((ctx) => requireRequest(ctx, a.requestId))).rejects.toThrow("Not signed in");
  });
});
