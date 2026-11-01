/**
 * End-to-end OAuth + MCP check against a running deployment (by default the local one).
 *
 *   pnpm exec convex dev            # SITE_URL and BETTER_AUTH_SECRET set with `npx convex env set`
 *   pnpm smoke:oauth
 *
 * Env: CONVEX_SITE_URL (default http://127.0.0.1:3211), CONVEX_URL (default http://127.0.0.1:3210),
 * SITE_URL (default http://localhost:5173).
 * Needs nothing beyond Node 22.18+ (built-in TypeScript type stripping, fetch, crypto). The browser half of the flow (the SPA's sign-in
 * and consent pages) is simulated with SPA-origin requests that carry the `Better-Auth-Cookie`
 * header, which is what crossDomainClient() sends.
 *
 * Set SMOKE_PRINT_AUTHORIZE=1 to stop after registering a client and print only the authorize URL
 * (open it in a browser to check the SPA pages by hand).
 *
 * Set SMOKE_KEEP=1 to skip step 10 and keep the smoke user and its consent: the script seeds the
 * demo data (demo.seed), checks that `pipeline_summary` over /mcp shows the demo counts (so the
 * signed-in user and the MCP principal share one workspace), and prints the access token and the
 * user's Convex session JWT for manual checks (send_message, workspaces.update, convex data).
 *
 * Steps (each prints `ok <step>`, or prints the response and exits 1):
 *   1. GET /.well-known/oauth-protected-resource/mcp and /.well-known/oauth-authorization-server → 200
 *   2. POST /mcp without a token → 401 with WWW-Authenticate
 *   3. Dynamic client registration (public client, auth method none) → client_id
 *   4. Sign up a random user from the SPA origin → session cookie (set-better-auth-cookie)
 *   5. GET /oauth2/authorize (PKCE S256, resource=<site>/mcp) as a browser navigation (node:http,
 *      `sec-fetch-mode: navigate`; fetch would get JSON instead) → 302 to the SPA sign-in/consent page
 *   6. POST /oauth2/consent { accept: true, oauth_query } with the session → redirect URL with code
 *   7. POST /oauth2/token (code + verifier + resource) → JWT access_token and refresh_token
 *   8. POST /mcp initialize and tools/list with the token → 200; a tampered token → 401
 *   9. Refresh twice with rotation → 200 each (the new access token works on /mcp);
 *      reusing the first refresh token → 4xx
 *  10. Revoke in Settings: connectedApps.list (Convex HTTP API, with the session's Convex JWT from
 *      /api/auth/convex/token) shows the client, connectedApps.revoke removes it, and the newest
 *      access token, which has not expired, now gets 401 on /mcp
 */
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const SITE = (process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3211").replace(/\/$/, "");
const CONVEX = (process.env.CONVEX_URL ?? "http://127.0.0.1:3210").replace(/\/$/, "");
const SPA = (process.env.SITE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const RESOURCE = `${SITE}/mcp`;

function ok(step: string) {
  console.log(`ok ${step}`);
}

async function fail(step: string, response: Response | null, detail?: string): Promise<never> {
  console.error(`FAIL ${step}${detail ? `: ${detail}` : ""}`);
  if (response) {
    console.error(`  HTTP ${response.status} ${response.url}`);
    for (const [key, value] of response.headers) console.error(`  ${key}: ${value}`);
    console.error(`  ${await response.text().catch(() => "<no body>")}`);
  }
  process.exit(1);
}

async function expectStatus(step: string, response: Response, status: number) {
  if (response.status !== status) await fail(step, response, `expected ${status}`);
}

async function json<T>(step: string, response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return await fail(step, null, `HTTP ${response.status}, body is not JSON: ${text}`);
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** `set-better-auth-cookie` carries Set-Cookie values; the client sends back `name=value; ...`. */
function cookieFromSetCookie(header: string): string {
  return header
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((part) => part.trim().split(";")[0])
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

/**
 * A top-level browser navigation (no redirect following). Node's fetch always sends
 * `sec-fetch-mode: cors`, for which Better Auth answers `{ redirect, url }` JSON instead of a 302.
 */
function navigate(url: URL): Promise<{ status: number; location: string | null; body: string }> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

const spaHeaders = (cookie: string) => ({
  "content-type": "application/json",
  origin: SPA,
  "better-auth-cookie": cookie,
});

const mcpHeaders = (accessToken: string) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${accessToken}`,
});

function rpc(id: number, method: string, params: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

type TokenResponse = { access_token?: string; refresh_token?: string; token_type?: string };

function tokenRequest(params: Record<string, string>) {
  return fetch(`${SITE}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
}

function isJwt(token: string | undefined): token is string {
  return typeof token === "string" && token.split(".").length === 3;
}

async function mcpWorks(step: string, accessToken: string) {
  const init = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: mcpHeaders(accessToken),
    body: rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "oauth-smoke", version: "0" },
    }),
  });
  await expectStatus(step, init, 200);
  const list = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: mcpHeaders(accessToken),
    body: rpc(2, "tools/list", {}),
  });
  await expectStatus(step, list, 200);
  const body = await json<{ result?: { tools?: unknown[] } }>(step, list);
  if (!Array.isArray(body.result?.tools)) await fail(step, null, `no tools: ${JSON.stringify(body)}`);
}

async function main() {
  // 1. Discovery.
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
  ]) {
    await expectStatus("discovery", await fetch(`${SITE}${path}`), 200);
  }
  ok("discovery");

  // 2. /mcp without a token.
  const anonymous = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: rpc(1, "tools/list", {}),
  });
  await expectStatus("mcp without token", anonymous, 401);
  const challenge = anonymous.headers.get("www-authenticate") ?? "";
  if (!challenge.includes(`resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`)) {
    await fail("mcp without token", anonymous, "missing WWW-Authenticate resource_metadata");
  }
  ok("mcp without token");

  // 3. Dynamic client registration.
  const registration = await fetch(`${SITE}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "oauth-smoke",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!registration.ok) await fail("register", registration);
  const { client_id: clientId } = await json<{ client_id?: string }>("register", registration);
  if (!clientId) await fail("register", null, "no client_id");
  ok("register");

  // Authorization request parameters (PKCE S256), built before sign-up so they can be printed.
  const verifier = base64url(randomBytes(32));
  const challengeS256 = base64url(createHash("sha256").update(verifier).digest());
  const authorizeUrl = new URL(`${SITE}/api/auth/oauth2/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId!,
    redirect_uri: REDIRECT_URI,
    scope: "openid offline_access crm:read crm:write",
    state: "st",
    code_challenge: challengeS256,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();
  if (process.env.SMOKE_PRINT_AUTHORIZE) {
    // For a manual browser check of the SPA's sign-in and consent pages: open this URL, sign in or
    // sign up, click Allow, and the browser lands on REDIRECT_URI with `code=`.
    console.log(authorizeUrl.toString());
    return;
  }

  // 4. Sign up from the SPA origin.
  const email = `smoke+${randomBytes(6).toString("hex")}@example.com`;
  const signUp = await fetch(`${SITE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: spaHeaders(""),
    body: JSON.stringify({ email, password: `pw-${randomBytes(12).toString("hex")}`, name: "Smoke" }),
  });
  await expectStatus("sign up", signUp, 200);
  const cookie = cookieFromSetCookie(signUp.headers.get("set-better-auth-cookie") ?? "");
  if (!cookie.includes(".session_token=")) {
    await fail("sign up", signUp, "no session cookie in set-better-auth-cookie");
  }
  ok("sign up");

  // 5. Authorization request (the browser would follow this redirect to the SPA).
  const authorize = await navigate(authorizeUrl);
  const location = authorize.location ?? "";
  if (
    authorize.status !== 302 ||
    !(location.startsWith(`${SPA}/sign-in?`) || location.startsWith(`${SPA}/consent?`))
  ) {
    await fail(
      "authorize",
      null,
      `expected 302 to ${SPA}/sign-in or /consent, got ${authorize.status} ${location} ${authorize.body}`,
    );
  }
  const oauthQuery = new URL(location).search.slice(1);
  ok("authorize");

  // 6. The SPA's consent page accepts with the user's session.
  const consent = await fetch(`${SITE}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: spaHeaders(cookie),
    body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
  });
  await expectStatus("consent", consent, 200);
  const consentBody = await json<{ redirect?: boolean; url?: string }>("consent", consent);
  if (!consentBody.redirect || !consentBody.url?.startsWith(REDIRECT_URI)) {
    await fail("consent", null, `unexpected body ${JSON.stringify(consentBody)}`);
  }
  const callback = new URL(consentBody.url!);
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.get("state") !== "st") {
    await fail("consent", null, `no code/state in ${consentBody.url}`);
  }
  ok("consent");

  // 7. Code exchange.
  const exchange = await tokenRequest({
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: REDIRECT_URI,
    client_id: clientId!,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  await expectStatus("token", exchange, 200);
  const tokens = await json<TokenResponse>("token", exchange);
  if (!isJwt(tokens.access_token) || !tokens.refresh_token) {
    await fail("token", null, `expected a JWT access_token and a refresh_token: ${JSON.stringify(tokens)}`);
  }
  ok("token");

  // 8. MCP with the token, and with a tampered one.
  await mcpWorks("mcp with token", tokens.access_token!);
  const [header, payload, signature] = tokens.access_token!.split(".");
  const tampered = `${header}.${payload}.${signature.slice(0, -4)}AAAA`;
  const rejected = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: mcpHeaders(tampered),
    body: rpc(1, "tools/list", {}),
  });
  await expectStatus("mcp with tampered token", rejected, 401);
  ok("mcp with token");

  // 9. Refresh with rotation; the old refresh token stops working.
  const first = tokens.refresh_token!;
  let current = first;
  let latestAccessToken = tokens.access_token!;
  for (const round of [1, 2]) {
    const step = `refresh ${round}`;
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: current,
      client_id: clientId!,
      resource: RESOURCE,
    });
    await expectStatus(step, refresh, 200);
    const refreshed = await json<TokenResponse>(step, refresh);
    if (!isJwt(refreshed.access_token) || !refreshed.refresh_token || refreshed.refresh_token === current) {
      await fail(step, null, `expected a JWT and a rotated refresh_token: ${JSON.stringify(refreshed)}`);
    }
    await mcpWorks(step, refreshed.access_token!);
    current = refreshed.refresh_token!;
    latestAccessToken = refreshed.access_token!;
    ok(step);
  }
  const reuse = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: first,
    client_id: clientId!,
    resource: RESOURCE,
  });
  if (reuse.status < 400 || reuse.status >= 500) {
    await fail("refresh reuse rejected", reuse, "expected 4xx");
  }
  ok("refresh reuse rejected");

  const convexToken = await fetch(`${SITE}/api/auth/convex/token`, { headers: spaHeaders(cookie) });
  await expectStatus("convex token", convexToken, 200);
  const { token: sessionJwt } = await json<{ token?: string }>("convex token", convexToken);
  if (!isJwt(sessionJwt)) await fail("convex token", null, "no Convex JWT from /api/auth/convex/token");

  if (process.env.SMOKE_KEEP) {
    // Keep the user and the consent. Seed the demo data as the signed-in user, then read it back
    // as the MCP principal: both must resolve to the same workspace.
    await convexCall("mutation", "demo:seed", {}, sessionJwt!);
    const summary = await fetch(`${SITE}/mcp`, {
      method: "POST",
      headers: mcpHeaders(latestAccessToken),
      body: rpc(3, "tools/call", { name: "pipeline_summary", arguments: {} }),
    });
    await expectStatus("pipeline summary", summary, 200);
    const result = await mcpResult<{ counts?: Record<string, number> }>("pipeline summary", summary);
    const counts = result.structuredContent?.counts;
    const expected = { lead: 5, qualified: 3, customer: 2, lost: 2 };
    if (!counts || Object.entries(expected).some(([stage, n]) => counts[stage] !== n)) {
      await fail("pipeline summary", null, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(counts)}`);
    }
    ok("pipeline summary");
    console.log(`ACCESS_TOKEN=${latestAccessToken}`);
    console.log(`CONVEX_JWT=${sessionJwt}`);
    return;
  }

  // 10. Revoke from Settings; the access token is still unexpired but /mcp must refuse it.
  const before = await convexCall<{ clientId: string }[]>("query", "connectedApps:list", {}, sessionJwt!);
  if (!before.some((app) => app.clientId === clientId)) {
    await fail("revoke", null, `connectedApps.list does not show the client: ${JSON.stringify(before)}`);
  }
  await mcpWorks("revoke", latestAccessToken);
  await convexCall("mutation", "connectedApps:revoke", { clientId: clientId! }, sessionJwt!);
  const after = await convexCall<{ clientId: string }[]>("query", "connectedApps:list", {}, sessionJwt!);
  if (after.some((app) => app.clientId === clientId)) {
    await fail("revoke", null, `client still listed after revoke: ${JSON.stringify(after)}`);
  }
  const revoked = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: mcpHeaders(latestAccessToken),
    body: rpc(1, "tools/list", {}),
  });
  await expectStatus("revoke", revoked, 401);
  ok("revoke");
}

type ToolResult<S> = { isError?: boolean; structuredContent?: S };

/** Parses a `tools/call` response (plain JSON or a single SSE event) into its result. */
async function mcpResult<S>(step: string, response: Response): Promise<ToolResult<S>> {
  const text = await response.text();
  const data = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
    ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? ""
    : text;
  try {
    return (JSON.parse(data) as { result: ToolResult<S> }).result;
  } catch {
    return await fail(step, null, `unparseable MCP response: ${text}`);
  }
}

/** Calls a public Convex function through the HTTP API as the signed-in user. */
async function convexCall<T = unknown>(
  kind: "query" | "mutation",
  path: string,
  args: Record<string, unknown>,
  jwt: string,
): Promise<T> {
  const response = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await json<{ status?: string; value?: T; errorMessage?: string }>(path, response);
  if (!response.ok || body.status !== "success") {
    return await fail(path, null, `HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.value as T;
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
