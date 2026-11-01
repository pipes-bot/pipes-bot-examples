import { httpAction } from "../_generated/server";
import { MCP_SCOPES } from "../auth";
import { authenticateMcpRequest } from "./auth";
import { handleMcp } from "./server";

export const mcpEndpoint = httpAction(async (ctx, request) => {
  const principal = await authenticateMcpRequest(ctx, request);
  if (principal instanceof Response) return principal;
  return handleMcp(ctx, request, principal);
});

export const mcpMethodNotAllowed = httpAction(async () => {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
});

// RFC 9728 metadata, served at both well-known paths. MCP clients find it through the
// WWW-Authenticate header of a 401 from /mcp.
export const protectedResourceMetadata = httpAction(async () => {
  const site = process.env.CONVEX_SITE_URL!;
  return Response.json({
    resource: `${site}/mcp`,
    authorization_servers: [site],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
  });
});
