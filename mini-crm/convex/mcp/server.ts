// Outcome of the Task 2 spike: the official MCP SDK runs as-is in a Convex httpAction (no plan B needed).
// Verified on the real local runtime, not only in convex-test.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ActionCtx } from "../_generated/server";
import type { Principal } from "./auth";

export function buildServer(_ctx: ActionCtx, _principal: Principal): McpServer {
  const server = new McpServer({ name: "mini-crm", version: "1.0.0" });
  // Temporary tool for the spike; Task 9 replaces it.
  server.registerTool(
    "ping",
    { description: "Health check. Returns pong." },
    async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
  );
  return server;
}

// Stateless: one server + transport per request, JSON responses instead of SSE.
export async function handleMcp(
  ctx: ActionCtx,
  request: Request,
  principal: Principal,
): Promise<Response> {
  const server = buildServer(ctx, principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
