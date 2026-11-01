import { afterEach, expect, test, vi } from "vitest";
import { makeT } from "../../tests/helpers";

const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function rpc(id: number, method: string, params: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("initialize and tools/list over JSON", async () => {
  vi.stubEnv("MCP_SPIKE", "1");
  const t = makeT();

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
