import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import { DEFAULT_METHODOLOGY } from "./lib/methodology";
import { makeT } from "../tests/helpers";

const settings = {
  name: "Acme support",
  inactivityMinutes: 60,
  methodology: [
    { id: "greet", name: "Greet", description: "Say hello." },
    { name: "Wrap up", description: "Ask if anything else is needed." },
  ],
};

describe("workspaces", () => {
  it("ensureWorkspace is idempotent", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    const first = await user.mutation(api.workspaces.ensureWorkspace, {});
    const second = await user.mutation(api.workspaces.ensureWorkspace, {});
    expect(second).toBe(first);
    const rows = await t.run((ctx) => ctx.db.query("workspaces").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerId).toBe("user_a");
    expect(rows[0].methodology).toEqual(DEFAULT_METHODOLOGY);
    expect(rows[0].inactivityMinutes).toBe(120);
  });

  it("current is null before ensure", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    expect(await user.query(api.workspaces.current, {})).toBeNull();
  });

  it("updateSettings saves and assigns ids", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    await user.mutation(api.workspaces.ensureWorkspace, {});
    await user.mutation(api.workspaces.updateSettings, settings);
    const current = await user.query(api.workspaces.current, {});
    expect(current?.name).toBe("Acme support");
    expect(current?.inactivityMinutes).toBe(60);
    expect(current?.methodology).toHaveLength(2);
    expect(current?.methodology[0].id).toBe("greet");
    expect(current?.methodology[1].id).toMatch(/^wrap-up-[a-z0-9]{4}$/);
    expect(current?.methodology[1].name).toBe("Wrap up");
  });

  it("updateSettings rejects invalid input", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    await user.mutation(api.workspaces.ensureWorkspace, {});
    const before = await user.query(api.workspaces.current, {});
    await expect(
      user.mutation(api.workspaces.updateSettings, { ...settings, methodology: [] }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      user.mutation(api.workspaces.updateSettings, { ...settings, inactivityMinutes: 5000 }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await user.query(api.workspaces.current, {})).toEqual(before);
  });

  it("signed-out calls are rejected", async () => {
    const t = makeT();
    expect(await t.query(api.workspaces.current, {})).toBeNull();
    await expect(t.mutation(api.workspaces.updateSettings, settings)).rejects.toThrow(
      "Not signed in",
    );
  });

  it("workspaces are isolated per user", async () => {
    const t = makeT();
    const a = t.withIdentity({ subject: "user_a" });
    const b = t.withIdentity({ subject: "user_b" });
    await a.mutation(api.workspaces.ensureWorkspace, {});
    await a.mutation(api.workspaces.updateSettings, settings);
    expect(await b.query(api.workspaces.current, {})).toBeNull();
    await expect(b.mutation(api.workspaces.updateSettings, settings)).rejects.toThrow(
      "Workspace not found",
    );
  });
});
