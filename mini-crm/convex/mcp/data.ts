import { v } from "convex/values";
import { components } from "../_generated/api";
import { internalQuery } from "../_generated/server";

/**
 * The consent `userId` gave to OAuth client `clientId`, plus the client's display name.
 * Null when there is no consent (never granted, or revoked in Settings): access tokens are
 * verified offline and live for an hour, so this is what makes a revocation take effect now.
 */
export const consentAndClient = internalQuery({
  args: { userId: v.string(), clientId: v.string() },
  handler: async (ctx, { userId, clientId }) => {
    const consent = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "oauthConsent",
      where: [
        { field: "clientId", value: clientId },
        { field: "userId", value: userId },
      ],
    });
    if (!consent) return null;
    const client = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    });
    return { scopes: consent.scopes as string[], clientName: client?.name || "MCP" };
  },
});
