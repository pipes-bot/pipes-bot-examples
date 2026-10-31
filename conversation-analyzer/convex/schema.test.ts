import { expect, test } from "vitest";
import { makeT } from "../tests/helpers";

test("schema accepts a workspace", async () => {
  const t = makeT();
  const name = await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaces", {
      ownerId: "u1",
      name: "Acme",
      inactivityMinutes: 120,
      methodology: [],
    });
    return (await ctx.db.get(id))?.name;
  });
  expect(name).toBe("Acme");
});
