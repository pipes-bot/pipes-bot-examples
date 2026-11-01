import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { makeT, seedUser, type TestConvex } from "../tests/helpers";

const ENV = {
  PIPES_API_KEY: "pk_smoke_test_key",
  PIPES_APP_SLUG: "acme",
  SITE_URL: "https://crm.example.com",
  PIPES_API_BASE_URL: "https://api.test",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function addNumber(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  poolNumberId: string,
  extra: { connectedAt?: number; isDemo?: boolean } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId,
      phoneNumber: "+5511999990000",
      displayName: poolNumberId,
      connectedAt: extra.connectedAt ?? 1000,
      isDemo: extra.isDemo,
    }),
  );
}

async function healthOf(t: TestConvex, id: Id<"numbers">) {
  return (await t.run((ctx) => ctx.db.get(id)))?.health;
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of Object.keys(ENV)) delete process.env[name];
});

describe("createSignupLink", () => {
  it("sends workspace metadata", async () => {
    const t = makeT();
    const { workspaceId, asUser } = await seedUser(t, "user_a");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ token: "jwt.abc", expiresAt: "2026-10-31T12:00:00.000Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await asUser.action(api.numbers.createSignupLink, {});

    expect(result).toEqual({ url: "https://app.pipes.bot/apps/acme?token=jwt.abc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/apps/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer pk_smoke_test_key",
    );
    const body = JSON.parse(init.body as string);
    expect(body.metadata).toEqual({ workspaceId });
    expect(body.redirectUrl).toBe("https://crm.example.com/numbers/connected");
  });

  it("surfaces API errors", async () => {
    const t = makeT();
    const { asUser } = await seedUser(t, "user_a");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("redirectUrl must use HTTPS protocol", { status: 400 })),
    );

    await expect(asUser.action(api.numbers.createSignupLink, {})).rejects.toThrow(
      /400.*redirectUrl must use HTTPS protocol/,
    );
  });

  it("reports missing configuration", async () => {
    const t = makeT();
    const { asUser } = await seedUser(t, "user_a");
    delete process.env.PIPES_APP_SLUG;
    vi.stubGlobal("fetch", vi.fn());

    await expect(asUser.action(api.numbers.createSignupLink, {})).rejects.toThrow(
      /PIPES_APP_SLUG is not set/,
    );
  });
});

describe("queries", () => {
  it("findByPoolNumberId hides other workspaces", async () => {
    const t = makeT();
    const a = await seedUser(t, "user_a");
    const b = await seedUser(t, "user_b");
    await addNumber(t, a.workspaceId, "pool_user_a");
    const args = { poolNumberId: "pool_user_a" };

    expect(await b.asUser.query(api.numbers.findByPoolNumberId, args)).toBeNull();
    const found = await a.asUser.query(api.numbers.findByPoolNumberId, args);
    expect(found?.poolNumberId).toBe("pool_user_a");
    expect(
      await a.asUser.query(api.numbers.findByPoolNumberId, { poolNumberId: "nope" }),
    ).toBeNull();
  });

  it("list returns the workspace numbers newest first", async () => {
    const t = makeT();
    const a = await seedUser(t, "user_a");
    const b = await seedUser(t, "user_b");
    await addNumber(t, a.workspaceId, "pool_older", { connectedAt: 1000 });
    await addNumber(t, a.workspaceId, "pool_newer", { connectedAt: 2000 });
    await addNumber(t, b.workspaceId, "pool_other", { connectedAt: 3000 });

    const rows = await a.asUser.query(api.numbers.list, {});
    expect(rows.map((n) => n.poolNumberId)).toEqual(["pool_newer", "pool_older"]);
  });
});

describe("checkHealth", () => {
  it("maps states and skips demo numbers", async () => {
    const t = makeT();
    const { workspaceId } = await seedUser(t, "user_a");
    const ids = {
      ok: await addNumber(t, workspaceId, "pool_ok"),
      blocked: await addNumber(t, workspaceId, "pool_blocked"),
      broken: await addNumber(t, workspaceId, "pool_broken"),
      limited: await addNumber(t, workspaceId, "pool_limited"),
      demo: await addNumber(t, workspaceId, "pool_demo", { isDemo: true }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer pk_smoke_test_key",
      );
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
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.numbers.checkHealth, {});

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("pool_demo"))).toBe(false);
    expect(urls).toContain("https://api.test/v1/pool-numbers/pool_ok/health");

    expect(await healthOf(t, ids.ok)).toMatchObject({ state: "healthy" });
    expect(await healthOf(t, ids.blocked)).toMatchObject({
      state: "unhealthy",
      detail: "Calling cannot use SIP",
    });
    expect(await healthOf(t, ids.limited)).toMatchObject({
      state: "unhealthy",
      detail: "LIMITED",
    });
    expect(await healthOf(t, ids.broken)).toMatchObject({ state: "unknown", detail: "HTTP 500" });
    expect(typeof (await healthOf(t, ids.ok))?.checkedAt).toBe("number");
    expect(await healthOf(t, ids.demo)).toBeUndefined();
  });

  it("stores canSendMessage", async () => {
    const t = makeT();
    const { workspaceId } = await seedUser(t, "user_a");
    const blocked = await addNumber(t, workspaceId, "pool_blocked");
    const ok = await addNumber(t, workspaceId, "pool_ok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        jsonResponse({
          canSendMessage: String(input).includes("pool_blocked") ? "BLOCKED" : "AVAILABLE",
        }),
      ),
    );

    await t.action(internal.numbers.checkHealth, {});

    const blockedHealth = await healthOf(t, blocked);
    expect(blockedHealth).toMatchObject({
      state: "unhealthy",
      canSendMessage: "BLOCKED",
    });
    expect(await healthOf(t, ok)).toMatchObject({ state: "healthy", canSendMessage: "AVAILABLE" });
  });

  it("keeps going after a fetch throws", async () => {
    const t = makeT();
    const { workspaceId } = await seedUser(t, "user_a");
    const a = await addNumber(t, workspaceId, "pool_a");
    const b = await addNumber(t, workspaceId, "pool_b");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("pool_a")) throw new Error("network down");
        return jsonResponse({ canSendMessage: "AVAILABLE" });
      }),
    );

    await t.action(internal.numbers.checkHealth, {});

    expect(await healthOf(t, a)).toMatchObject({ state: "unknown", detail: "network down" });
    expect((await healthOf(t, b))?.state).toBe("healthy");
  });

  it("without PIPES_API_KEY: no-op for demo numbers, unknown for real ones", async () => {
    delete process.env.PIPES_API_KEY;
    const t = makeT();
    const { workspaceId } = await seedUser(t, "user_a");
    const numberId = await addNumber(t, workspaceId, "pool_a", { isDemo: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.numbers.checkHealth, {});
    expect(await healthOf(t, numberId)).toBeUndefined();

    await t.run((ctx) => ctx.db.patch(numberId, { isDemo: undefined }));
    await t.action(internal.numbers.checkHealth, {});
    expect(await healthOf(t, numberId)).toMatchObject({
      state: "unknown",
      detail: "PIPES_API_KEY is not set",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
