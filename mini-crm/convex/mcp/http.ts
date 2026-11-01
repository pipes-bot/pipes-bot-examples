import { httpAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { handleMcp, type Principal } from "./server";

// Temporary principal for the spike; Task 4 replaces this with real auth and drops MCP_SPIKE.
const SPIKE_PRINCIPAL: Principal = {
  userId: "spike",
  workspaceId: "spike" as Id<"workspaces">,
  scopes: ["crm:read", "crm:write"],
  clientId: "spike",
  clientName: "spike",
};

export const mcpEndpoint = httpAction(async (ctx, request) => {
  if (process.env.MCP_SPIKE !== "1") {
    return new Response("Unauthorized", { status: 401 });
  }
  return handleMcp(ctx, request, SPIKE_PRINCIPAL);
});

export const mcpMethodNotAllowed = httpAction(async () => {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
});
