import { verifyAccessToken } from "better-auth/oauth2";
import { afterEach, expect, test, vi } from "vitest";
import { makeT, seedConsent } from "../../tests/helpers";

vi.mock("better-auth/oauth2", () => ({ verifyAccessToken: vi.fn() }));

const verify = vi.mocked(verifyAccessToken);

const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: "Bearer jwt",
};

function rpc(id: number, method: string, params: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

afterEach(() => {
  verify.mockReset();
});

test("initialize and tools/list over JSON", async () => {
  const t = makeT();
  await seedConsent(t, { userId: "user_1", clientId: "client_1", clientName: "Claude" });
  verify.mockResolvedValue({ sub: "user_1", azp: "client_1", scope: "crm:read crm:write" });

  const init = await t.fetch("/mcp", {
    method: "POST",
    headers,
    body: rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }),
  });
  expect(init.status).toBe(200);
  const initBody = await init.json();
  expect(initBody.result.serverInfo.name).toBe("mini-crm");

  const list = await t.fetch("/mcp", {
    method: "POST",
    headers,
    body: rpc(2, "tools/list", {}),
  });
  expect(list.status).toBe(200);
  const listBody = await list.json();
  expect(listBody.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["ping"]);

  const get = await t.fetch("/mcp", { method: "GET" });
  expect(get.status).toBe(405);
  expect(get.headers.get("allow")).toBe("POST");
});

test("POST /mcp without a token is 401", async () => {
  const t = makeT();
  const response = await t.fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rpc(1, "tools/list", {}),
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toMatch(
    /^Bearer resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"$/,
  );
  expect(verify).not.toHaveBeenCalled();
});
