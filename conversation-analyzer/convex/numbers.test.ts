import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { makeT } from "../tests/helpers";

const realFetch = globalThis.fetch;
const ENV = {
  PIPES_API_KEY: "ak_test",
  PIPES_APP_SLUG: "acme",
  SITE_URL: "https://analyzer.example.com",
  PIPES_API_BASE_URL: "https://api.test",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function seed(t: ReturnType<typeof makeT>, ownerId: string) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId,
      name: "Acme",
      inactivityMinutes: 120,
      methodology: [],
    });
    const numberId = await ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: `pool_${ownerId}`,
      phoneNumber: "+5511999990000",
      displayName: "Support",
      connectedAt: 1000,
    });
    return { workspaceId, numberId };
  });
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of Object.keys(ENV)) delete process.env[name];
});

describe("createSignupLink", () => {
  it("sends workspace metadata", async () => {
    const t = makeT();
    const { workspaceId } = await seed(t, "user_a");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ token: "jwt.abc", expiresAt: "2026-10-31T12:00:00.000Z" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await t
      .withIdentity({ subject: "user_a" })
      .action(api.numbers.createSignupLink, {});

    expect(result).toEqual({ url: "https://app.pipes.bot/apps/acme?token=jwt.abc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/apps/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ak_test");
    const body = JSON.parse(init.body as string);
    expect(body.metadata).toEqual({ workspaceId });
    expect(body.redirectUrl).toBe("https://analyzer.example.com/numbers/connected");
  });

  it("surfaces API errors", async () => {
    const t = makeT();
    await seed(t, "user_a");
    globalThis.fetch = vi.fn(
      async () => new Response("redirectUrl must use HTTPS protocol", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      t.withIdentity({ subject: "user_a" }).action(api.numbers.createSignupLink, {}),
    ).rejects.toThrow(/400.*redirectUrl must use HTTPS protocol/);
  });

  it("reports missing configuration", async () => {
    const t = makeT();
    await seed(t, "user_a");
    delete process.env.PIPES_APP_SLUG;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await expect(
      t.withIdentity({ subject: "user_a" }).action(api.numbers.createSignupLink, {}),
    ).rejects.toThrow(/PIPES_APP_SLUG is not set/);
  });
});

describe("queries", () => {
  it("findByPoolNumberId hides other workspaces", async () => {
    const t = makeT();
    await seed(t, "user_a");
    await seed(t, "user_b");
    const args = { poolNumberId: "pool_user_a" };

    expect(await t.withIdentity({ subject: "user_b" }).query(api.numbers.findByPoolNumberId, args)).toBeNull();
    const found = await t.withIdentity({ subject: "user_a" }).query(api.numbers.findByPoolNumberId, args);
    expect(found?.poolNumberId).toBe("pool_user_a");
    expect(
      await t
        .withIdentity({ subject: "user_a" })
        .query(api.numbers.findByPoolNumberId, { poolNumberId: "nope" }),
    ).toBeNull();
  });

  it("get rejects other workspace", async () => {
    const t = makeT();
    const { numberId } = await seed(t, "user_a");
    await seed(t, "user_b");

    const own = await t.withIdentity({ subject: "user_a" }).query(api.numbers.get, { numberId });
    expect(own._id).toBe(numberId);
    const err = await t
      .withIdentity({ subject: "user_b" })
      .query(api.numbers.get, { numberId })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect(err.data).toBe("Not found");
  });

  it("list returns the workspace numbers newest first", async () => {
    const t = makeT();
    const { workspaceId } = await seed(t, "user_a");
    await seed(t, "user_b");
    await t.run(async (ctx) => {
      await ctx.db.insert("numbers", {
        workspaceId,
        poolNumberId: "pool_newer",
        phoneNumber: "+5511888880000",
        displayName: "Sales",
        connectedAt: 2000,
      });
    });
    const rows = await t.withIdentity({ subject: "user_a" }).query(api.numbers.list, {});
    expect(rows.map((n) => n.poolNumberId)).toEqual(["pool_newer", "pool_user_a"]);
  });
});

describe("checkHealth", () => {
  it("maps states", async () => {
    const t = makeT();
    const { workspaceId } = await seed(t, "user_a");
    const ids = await t.run(async (ctx) => {
      const add = (poolNumberId: string, isDemo?: boolean) =>
        ctx.db.insert("numbers", {
          workspaceId,
          poolNumberId,
          phoneNumber: "+5511000000000",
          displayName: poolNumberId,
          connectedAt: 1,
          isDemo,
        });
      return {
        ok: await add("pool_ok"),
        blocked: await add("pool_blocked"),
        broken: await add("pool_broken"),
        limited: await add("pool_limited"),
        demo: await add("pool_demo", true),
      };
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ak_test");
      if (url.includes("pool_ok")) {
        return jsonResponse({ canSendMessage: "AVAILABLE", entities: [] });
      }
      if (url.includes("pool_blocked")) {
        return jsonResponse({
          canSendMessage: "BLOCKED",
          entities: [
            {
              type: "PHONE_NUMBER",
              id: "1",
              canSendMessage: "LIMITED",
              errors: [{ code: 138024, description: "Calling cannot use SIP", solution: "x" }],
            },
          ],
        });
      }
      if (url.includes("pool_limited")) {
        return jsonResponse({ canSendMessage: "LIMITED", entities: [{ errors: [] }] });
      }
      return new Response("boom", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await t.action(internal.numbers.checkHealth, {});

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("pool_demo"))).toBe(false);
    expect(urls).toContain("https://api.test/v1/pool-numbers/pool_ok/health");

    const health = async (id: Id<"numbers">) =>
      (await t.run((ctx) => ctx.db.get(id)))?.health;
    expect((await health(ids.ok))?.state).toBe("healthy");
    expect(await health(ids.blocked)).toMatchObject({
      state: "unhealthy",
      detail: "Calling cannot use SIP",
    });
    expect(await health(ids.limited)).toMatchObject({ state: "unhealthy", detail: "LIMITED" });
    expect(await health(ids.broken)).toMatchObject({ state: "unknown", detail: "HTTP 500" });
    expect(typeof (await health(ids.ok))?.checkedAt).toBe("number");
    expect(await health(ids.demo)).toBeUndefined();
  });

  it("keeps going after a fetch throws", async () => {
    const t = makeT();
    const { workspaceId } = await seed(t, "user_a");
    const ids = await t.run(async (ctx) => {
      const add = (poolNumberId: string) =>
        ctx.db.insert("numbers", {
          workspaceId,
          poolNumberId,
          phoneNumber: "+5511000000000",
          displayName: poolNumberId,
          connectedAt: 1,
        });
      return { a: await add("pool_a"), b: await add("pool_b") };
    });
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("pool_a")) throw new Error("network down");
      return jsonResponse({ canSendMessage: "AVAILABLE" });
    }) as unknown as typeof fetch;

    await t.action(internal.numbers.checkHealth, {});

    const a = (await t.run((ctx) => ctx.db.get(ids.a)))?.health;
    const b = (await t.run((ctx) => ctx.db.get(ids.b)))?.health;
    expect(a).toMatchObject({ state: "unknown", detail: "network down" });
    expect(b?.state).toBe("healthy");
  });

  it("without PIPES_API_KEY: no-op for demo numbers, unknown for real ones", async () => {
    delete process.env.PIPES_API_KEY;
    const t = makeT();
    const { numberId } = await seed(t, "user_a");
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await t.run((ctx) => ctx.db.patch(numberId, { isDemo: true }));
    await t.action(internal.numbers.checkHealth, {});
    expect((await t.run((ctx) => ctx.db.get(numberId)))?.health).toBeUndefined();

    await t.run((ctx) => ctx.db.patch(numberId, { isDemo: undefined }));
    await t.action(internal.numbers.checkHealth, {});
    expect((await t.run((ctx) => ctx.db.get(numberId)))?.health).toMatchObject({
      state: "unknown",
      detail: "PIPES_API_KEY is not set",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
