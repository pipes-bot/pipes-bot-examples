import { APIError } from "better-auth/api";
import { verifyAccessToken } from "better-auth/oauth2";
import { afterEach, expect, test, vi } from "vitest";
import { makeT, seedConsent, seedUser, type TestConvex } from "../../tests/helpers";
import { api } from "../_generated/api";
import { authenticateMcpRequest } from "./auth";

vi.mock("better-auth/oauth2", () => ({ verifyAccessToken: vi.fn() }));

const SITE = process.env.CONVEX_SITE_URL!; // set in vitest.config.ts
const verify = vi.mocked(verifyAccessToken);

// Action results must be Convex values, so a Response is flattened inside the action.
async function authenticate(t: TestConvex, authorization?: string) {
  return await t.action(async (ctx) => {
    const request = new Request(`${SITE}/mcp`, {
      method: "POST",
      headers: authorization ? { authorization } : {},
    });
    const result = await authenticateMcpRequest(ctx, request);
    if (!(result instanceof Response)) return { principal: result };
    return {
      status: result.status,
      wwwAuthenticate: result.headers.get("www-authenticate"),
      body: await result.json(),
    };
  });
}

function expectUnauthorized(result: Awaited<ReturnType<typeof authenticate>>) {
  expect(result).toEqual({
    status: 401,
    wwwAuthenticate: `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`,
    body: { error: "invalid_token" },
  });
}

afterEach(() => {
  verify.mockReset();
  vi.restoreAllMocks();
});

function joseError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

test("missing header → 401 with WWW-Authenticate", async () => {
  const t = makeT();
  expectUnauthorized(await authenticate(t));
  expectUnauthorized(await authenticate(t, "Basic dXNlcjpwYXNz"));
  expect(verify).not.toHaveBeenCalled();
});

test("verify throws → 401", async () => {
  const t = makeT();
  verify.mockRejectedValue(new APIError("UNAUTHORIZED", { message: "invalid access token" }));
  expectUnauthorized(await authenticate(t, "Bearer tampered"));
  // The token is checked against this deployment's JWKS, issuer and MCP audience.
  expect(verify).toHaveBeenCalledWith("tampered", {
    jwksUrl: `${SITE}/api/auth/convex/jwks`,
    verifyOptions: { issuer: SITE, audience: `${SITE}/mcp` },
  });

  verify.mockRejectedValue(new APIError("UNAUTHORIZED", { message: "token expired" }));
  expectUnauthorized(await authenticate(t, "Bearer expired"));
  // An unmapped JOSE token error is still the token's fault.
  verify.mockRejectedValue(joseError("ERR_JWT_EXPIRED", '"exp" claim timestamp check failed'));
  expectUnauthorized(await authenticate(t, "Bearer expired"));
});

test("verification infrastructure failure → 503 without a challenge, logged", async () => {
  const t = makeT();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const failure of [
    new Error("Jwks failed: 500"),
    joseError("ERR_JWKS_TIMEOUT", "request timed out"),
  ]) {
    logged.mockClear();
    verify.mockRejectedValue(failure);
    expect(await authenticate(t, "Bearer jwt")).toEqual({
      status: 503,
      wwwAuthenticate: null,
      body: { error: "temporarily_unavailable" },
    });
    expect(logged).toHaveBeenCalledWith("MCP access token verification failed:", failure);
  }
});

test("no consent → 401", async () => {
  const t = makeT();
  verify.mockResolvedValue({ sub: "user_1", azp: "client_1", scope: "crm:read" });
  // A consent for another client does not count.
  await seedConsent(t, { userId: "user_1", clientId: "client_2" });
  expectUnauthorized(await authenticate(t, "Bearer jwt"));
});

test("revoked consent → 401", async () => {
  const t = makeT();
  await seedUser(t, "user_1");
  await seedConsent(t, { userId: "user_1", clientId: "client_1", clientName: "Claude" });
  // The JWT is still valid (verified offline); only the consent is gone.
  verify.mockResolvedValue({ sub: "user_1", azp: "client_1", scope: "crm:read" });
  expect(await authenticate(t, "Bearer jwt")).toHaveProperty("principal");

  await t.withIdentity({ subject: "user_1" }).mutation(api.connectedApps.revoke, {
    clientId: "client_1",
  });
  expectUnauthorized(await authenticate(t, "Bearer jwt"));
});

test("token without sub or azp → 401", async () => {
  const t = makeT();
  await seedConsent(t, { userId: "user_1", clientId: "client_1" });
  verify.mockResolvedValue({ azp: "client_1", scope: "crm:read" });
  expectUnauthorized(await authenticate(t, "Bearer jwt"));
  verify.mockResolvedValue({ sub: "user_1", scope: "crm:read" });
  expectUnauthorized(await authenticate(t, "Bearer jwt"));
});

test("valid token resolves principal", async () => {
  const t = makeT();
  const { workspaceId } = await seedUser(t, "user_1");
  await seedConsent(t, { userId: "user_1", clientId: "client_1", clientName: "Claude" });
  verify.mockResolvedValue({ sub: "user_1", azp: "client_1", scope: "crm:read" });

  const { principal } = await authenticate(t, "Bearer jwt");
  expect(principal).toEqual({
    userId: "user_1",
    workspaceId,
    scopes: ["crm:read"],
    clientId: "client_1",
    clientName: "Claude",
  });
});

test("client without a name is labelled MCP, and a first-time user gets a workspace", async () => {
  const t = makeT();
  await seedConsent(t, { userId: "user_2", clientId: "client_1" });
  verify.mockResolvedValue({ sub: "user_2", azp: "client_1", scope: "crm:read crm:write" });

  const { principal } = await authenticate(t, "Bearer jwt");
  expect(principal).toMatchObject({ clientName: "MCP", scopes: ["crm:read", "crm:write"] });
  const workspaces = await t.run((ctx) => ctx.db.query("workspaces").collect());
  expect(workspaces).toHaveLength(1);
  expect(workspaces[0]).toMatchObject({ ownerId: "user_2", mcpSendMode: "draft" });
  expect(principal?.workspaceId).toBe(workspaces[0]._id);
});
