// Consent API in @better-auth/oauth-provider@1.6.33 (all under /api/auth, all need the user's
// session; each acts only on the current user's consents):
//   GET  /oauth2/get-consents              -> list (oauthConsent rows where userId = session user)
//   GET  /oauth2/get-consent?id=<id>       -> one consent
//   POST /oauth2/update-consent { id, update: { scopes } }
//   POST /oauth2/delete-consent { id }     -> deletes ONLY the oauthConsent row
// Server-side equivalents: auth.api.getOAuthConsents / deleteOAuthConsent (with session headers).
// Caveat for revoke: delete-consent leaves oauthRefreshToken/oauthAccessToken rows alive, and the
// refresh grant does not check consent, so a revoked client can still refresh. /mcp still rejects
// it (authenticateMcpRequest requires the consent), but revoking should also delete that user's
// oauthRefreshToken and oauthAccessToken rows for the client through the component adapter.
//
// So list and revoke read and write the Better Auth component tables directly: revoke deletes the
// consent and both kinds of token rows in one transaction.
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query, type QueryCtx } from "./_generated/server";

const MAX_CONSENTS = 100;
const DELETE_PAGE = 100;

export type ConnectedApp = {
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt?: number;
};

type ConsentRow = { clientId: string; scopes: string[]; createdAt?: number | null };

type DeletePage = {
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: string | null;
};

async function requireUserId(ctx: QueryCtx): Promise<string> {
  const userId = (await ctx.auth.getUserIdentity())?.subject;
  if (!userId) throw new ConvexError("Not signed in");
  return userId;
}

/** The OAuth clients the signed-in user has consented to, newest first. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<ConnectedApp[]> => {
    const userId = await requireUserId(ctx);
    const { page } = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "oauthConsent",
      where: [{ field: "userId", value: userId }],
      paginationOpts: { cursor: null, numItems: MAX_CONSENTS },
    });

    // One consent per client is the norm; merge if the provider ever stored more.
    const byClient = new Map<string, { scopes: Set<string>; createdAt?: number }>();
    for (const consent of page as ConsentRow[]) {
      const entry = byClient.get(consent.clientId) ?? { scopes: new Set<string>() };
      for (const scope of consent.scopes) entry.scopes.add(scope);
      if (typeof consent.createdAt === "number") {
        entry.createdAt = Math.min(entry.createdAt ?? consent.createdAt, consent.createdAt);
      }
      byClient.set(consent.clientId, entry);
    }

    const apps = await Promise.all(
      [...byClient].map(async ([clientId, { scopes, createdAt }]) => {
        const client = await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "oauthClient",
          where: [{ field: "clientId", value: clientId }],
        });
        return {
          clientId,
          // Same label as on /mcp and in activities.
          clientName: (client?.name as string | null | undefined) || "MCP",
          scopes: [...scopes],
          ...(createdAt !== undefined ? { createdAt } : {}),
        };
      }),
    );
    return apps.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  },
});

/**
 * Deletes the caller's consent for `clientId` and the refresh/access tokens issued to it. Access
 * tokens are JWTs verified offline, but `/mcp` also requires the consent, so the next call is a 401.
 */
export const revoke = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const userId = await requireUserId(ctx);
    const where = [
      { field: "clientId" as const, value: clientId },
      { field: "userId" as const, value: userId },
    ];
    for (const model of ["oauthConsent", "oauthRefreshToken", "oauthAccessToken"] as const) {
      let cursor: string | null = null;
      for (;;) {
        const result: DeletePage = await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
          input: { model, where },
          paginationOpts: { cursor, numItems: DELETE_PAGE },
        });
        if (result.isDone) break;
        // Same cursor choice as the component's own adapter.
        const split = result.pageStatus === "SplitRecommended" || result.pageStatus === "SplitRequired";
        cursor = (split ? result.splitCursor : undefined) ?? result.continueCursor;
      }
    }
    return null;
  },
});
