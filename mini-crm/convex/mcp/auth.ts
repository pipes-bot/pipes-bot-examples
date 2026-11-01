import { isAPIError } from "better-auth/api";
import { verifyAccessToken } from "better-auth/oauth2";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

/** Who is calling the MCP endpoint: the signed-in user, their workspace and the OAuth client. */
export type Principal = {
  userId: string;
  workspaceId: Id<"workspaces">;
  scopes: string[];
  clientId: string;
  clientName: string;
};

function unauthorized(site: string): Response {
  return Response.json(
    { error: "invalid_token" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${site}/.well-known/oauth-protected-resource/mcp"`,
      },
    },
  );
}

// Not the token's fault (JWKS unreachable or invalid, misconfiguration): a 401 would make MCP
// clients drop valid tokens and restart OAuth, so answer 503 without a challenge instead.
function unavailable(): Response {
  return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
}

// JOSE codes that mean the token itself is unacceptable. verifyAccessToken already maps these to
// APIError("UNAUTHORIZED"); the codes cover any that reach us unmapped.
const BAD_TOKEN_JOSE_CODES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
]);

function isBadTokenError(error: unknown): boolean {
  if (isAPIError(error)) {
    return error.status === "UNAUTHORIZED" || error.statusCode === 401;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && BAD_TOKEN_JOSE_CODES.has(code);
}

function bearerToken(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

/**
 * Resolves the caller of `/mcp` or returns the error Response to send back (401, or 503 when the
 * token cannot be checked right now). The access token must be an
 * RS256 JWT from this deployment for the `/mcp` audience, and the user's consent for the
 * client must still exist.
 */
export async function authenticateMcpRequest(
  ctx: ActionCtx,
  request: Request,
): Promise<Principal | Response> {
  const site = process.env.CONVEX_SITE_URL!;
  const token = bearerToken(request);
  if (!token) return unauthorized(site);

  let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    payload = await verifyAccessToken(token, {
      jwksUrl: `${site}/api/auth/convex/jwks`,
      verifyOptions: { issuer: site, audience: `${site}/mcp` },
    });
  } catch (error) {
    if (isBadTokenError(error)) return unauthorized(site);
    console.error("MCP access token verification failed:", error);
    return unavailable();
  }
  const { sub, azp, scope } = payload;
  if (typeof sub !== "string" || !sub || typeof azp !== "string" || !azp) {
    return unauthorized(site);
  }

  const grant = await ctx.runQuery(internal.mcp.data.consentAndClient, {
    userId: sub,
    clientId: azp,
  });
  if (!grant) return unauthorized(site);

  const workspaceId = await ctx.runMutation(internal.workspaces.forOwner, { ownerId: sub });
  return {
    userId: sub,
    workspaceId,
    scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [],
    clientId: azp,
    clientName: grant.clientName,
  };
}
