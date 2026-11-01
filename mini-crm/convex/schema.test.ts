import { expect, test } from "vitest";
import { makeT } from "../tests/helpers";

test("schema accepts a contact", async () => {
  const t = makeT();
  const stage = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId: "u1",
      name: "Acme",
      mcpSendMode: "draft",
    });
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: "pn_1",
      phoneNumber: "+15550001111",
      displayName: "Acme Support",
      connectedAt: 1,
    });
    const contactId = await ctx.db.insert("contacts", {
      workspaceId,
      waId: "16505551234",
      stage: "lead",
      tags: [],
      lastNumberId: numberId,
      lastMessageAt: 1,
      lastDirection: "in",
      unread: 0,
      searchText: "",
    });
    return (await ctx.db.get(contactId))?.stage;
  });
  expect(stage).toBe("lead");
});
