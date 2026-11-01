import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { makeT } from "../tests/helpers";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspaces", () => {
  it("ensureWorkspace is idempotent", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    const first = await user.mutation(api.workspaces.ensureWorkspace, {});
    const second = await user.mutation(api.workspaces.ensureWorkspace, {});
    expect(second).toBe(first);
    const rows = await t.run((ctx) => ctx.db.query("workspaces").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: "user_a",
      name: "My workspace",
      instructions: "",
      faq: "",
      idleMinutes: 30,
    });
  });

  it("current is null before ensure", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    expect(await user.query(api.workspaces.current, {})).toBeNull();
  });

  it("update saves the given fields and trims text", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    await user.mutation(api.workspaces.ensureWorkspace, {});
    await user.mutation(api.workspaces.update, {
      name: "  Acme  ",
      instructions: " Be brief. ",
      faq: "Q: Hours?\nA: 9 to 5.",
      idleMinutes: 45,
    });
    expect(await user.query(api.workspaces.current, {})).toMatchObject({
      name: "Acme",
      instructions: "Be brief.",
      faq: "Q: Hours?\nA: 9 to 5.",
      idleMinutes: 45,
    });
    await user.mutation(api.workspaces.update, { idleMinutes: 10 });
    expect(await user.query(api.workspaces.current, {})).toMatchObject({
      name: "Acme",
      idleMinutes: 10,
    });
  });

  it("update validates before writing", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    await user.mutation(api.workspaces.ensureWorkspace, {});
    await expect(
      user.mutation(api.workspaces.update, { name: "Renamed", instructions: "x".repeat(4001) }),
    ).rejects.toThrow("Instructions must be at most 4000 characters");
    expect((await user.query(api.workspaces.current, {}))?.name).toBe("My workspace");
    await expect(
      user.mutation(api.workspaces.update, { name: "   " }),
    ).rejects.toThrow("Name must be 1–80 characters");
    await expect(
      user.mutation(api.workspaces.update, { name: "x".repeat(81) }),
    ).rejects.toThrow("Name must be 1–80 characters");
    await expect(
      user.mutation(api.workspaces.update, { name: "Renamed", faq: "x".repeat(16001) }),
    ).rejects.toThrow("FAQ must be at most 16000 characters");
    await expect(
      user.mutation(api.workspaces.update, { name: "Renamed", faq: "x".repeat(16000), instructions: "x".repeat(4000) }),
    ).resolves.toBeNull();
  });

  it("idleMinutes bounds", async () => {
    const t = makeT();
    const user = t.withIdentity({ subject: "user_a" });
    await user.mutation(api.workspaces.ensureWorkspace, {});
    const message = "Minutes must be a whole number from 5 to 1440";
    for (const idleMinutes of [4, 1441, 30.5]) {
      await expect(user.mutation(api.workspaces.update, { idleMinutes })).rejects.toThrow(message);
    }
    for (const idleMinutes of [5, 1440]) {
      await user.mutation(api.workspaces.update, { idleMinutes });
      expect((await user.query(api.workspaces.current, {}))?.idleMinutes).toBe(idleMinutes);
    }
  });

  it("modelStatus without a key is demo", async () => {
    const t = makeT();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const user = t.withIdentity({ subject: "user_a" });
    expect(await user.query(api.workspaces.modelStatus, {})).toEqual({ kind: "demo" });
  });

  it("modelStatus with a key reports the model", async () => {
    const t = makeT();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    vi.stubEnv("OPENROUTER_MODEL", "");
    const user = t.withIdentity({ subject: "user_a" });
    expect(await user.query(api.workspaces.modelStatus, {})).toEqual({
      kind: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
    });
    vi.stubEnv("OPENROUTER_MODEL", "openai/gpt-test");
    expect(await user.query(api.workspaces.modelStatus, {})).toEqual({
      kind: "openrouter",
      model: "openai/gpt-test",
    });
  });

  it("signed out is refused", async () => {
    const t = makeT();
    expect(await t.query(api.workspaces.current, {})).toBeNull();
    await expect(t.mutation(api.workspaces.ensureWorkspace, {})).rejects.toThrow("Not signed in");
    await expect(t.mutation(api.workspaces.update, { name: "x" })).rejects.toThrow("Not signed in");
    await expect(t.query(api.workspaces.modelStatus, {})).rejects.toThrow("Not signed in");
  });

  it("workspaces are isolated per user", async () => {
    const t = makeT();
    const a = t.withIdentity({ subject: "user_a" });
    const b = t.withIdentity({ subject: "user_b" });
    await a.mutation(api.workspaces.ensureWorkspace, {});
    await a.mutation(api.workspaces.update, { name: "A only" });
    expect(await b.query(api.workspaces.current, {})).toBeNull();
    await expect(b.mutation(api.workspaces.update, { name: "x" })).rejects.toBeInstanceOf(ConvexError);
  });
});
