import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { makeT } from "../tests/helpers";

test("ensureWorkspace is idempotent", async () => {
  const t = makeT();
  const user = t.withIdentity({ subject: "user_1" });
  const first = await user.mutation(api.workspaces.ensureWorkspace, {});
  const second = await user.mutation(api.workspaces.ensureWorkspace, {});
  expect(second).toBe(first);
  const rows = await t.run((ctx) => ctx.db.query("workspaces").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ownerId: "user_1", name: "My workspace", mcpSendMode: "draft" });
});

test("current is null before ensureWorkspace and when signed out", async () => {
  const t = makeT();
  const user = t.withIdentity({ subject: "user_1" });
  expect(await user.query(api.workspaces.current, {})).toBeNull();
  await user.mutation(api.workspaces.ensureWorkspace, {});
  expect(await user.query(api.workspaces.current, {})).toMatchObject({ ownerId: "user_1" });
  expect(await t.query(api.workspaces.current, {})).toBeNull();
});

test("update validates name", async () => {
  const t = makeT();
  const user = t.withIdentity({ subject: "user_1" });
  await user.mutation(api.workspaces.ensureWorkspace, {});
  await expect(user.mutation(api.workspaces.update, { name: "" })).rejects.toThrow(
    "name must be 1–80 characters",
  );
  await expect(user.mutation(api.workspaces.update, { name: "x".repeat(81) })).rejects.toThrow(
    "name must be 1–80 characters",
  );
  await user.mutation(api.workspaces.update, { name: "  Acme  ", mcpSendMode: "direct" });
  expect(await user.query(api.workspaces.current, {})).toMatchObject({
    name: "Acme",
    mcpSendMode: "direct",
  });
});

test("forOwner creates then reuses", async () => {
  const t = makeT();
  const created = await t.mutation(internal.workspaces.forOwner, { ownerId: "user_1" });
  const reused = await t.mutation(internal.workspaces.forOwner, { ownerId: "user_1" });
  expect(reused).toBe(created);
  // The app later finds the same workspace for the same user.
  const user = t.withIdentity({ subject: "user_1" });
  expect(await user.mutation(api.workspaces.ensureWorkspace, {})).toBe(created);
  expect(await t.query(internal.workspaces.byOwner, { ownerId: "user_1" })).toMatchObject({
    _id: created,
    mcpSendMode: "draft",
  });
});
