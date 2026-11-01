import { expect, test } from "vitest";
import { makeT } from "../tests/helpers";

test("schema accepts a conversation", async () => {
  const t = makeT();
  const mode = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId: "u1",
      name: "Acme",
      instructions: "",
      faq: "",
      idleMinutes: 30,
    });
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: "pn_1",
      phoneNumber: "+5511999990000",
      displayName: "Acme",
      connectedAt: 1,
      aiEnabled: false,
    });
    const id = await ctx.db.insert("conversations", {
      workspaceId,
      numberId,
      waId: "5511988887777",
      mode: "ai",
      modeChangedAt: 1,
      aiTurn: 0,
      lastFrom: "customer",
      lastMessageAt: 1,
      lastPreview: "hi",
      aiReplies: { windowStart: 0, count: 0 },
    });
    return (await ctx.db.get(id))?.mode;
  });
  expect(mode).toBe("ai");
});
