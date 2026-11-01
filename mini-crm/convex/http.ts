import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { mcpEndpoint, mcpMethodNotAllowed, protectedResourceMetadata } from "./mcp/http";

const http = httpRouter();

// Also owns /.well-known/openid-configuration (legacy oidc metadata from convex()); it cannot be
// overridden. MCP clients read the RFC 8414 document below first.
authComponent.registerRoutes(http, createAuth, { cors: true });

http.route({
  path: "/.well-known/oauth-authorization-server",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    oauthProviderAuthServerMetadata(createAuth(ctx))(request),
  ),
});
http.route({
  path: "/.well-known/oauth-protected-resource",
  method: "GET",
  handler: protectedResourceMetadata,
});
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "GET",
  handler: protectedResourceMetadata,
});

http.route({ path: "/mcp", method: "POST", handler: mcpEndpoint });
http.route({ path: "/mcp", method: "GET", handler: mcpMethodNotAllowed });
http.route({ path: "/mcp", method: "DELETE", handler: mcpMethodNotAllowed });

export default http;
