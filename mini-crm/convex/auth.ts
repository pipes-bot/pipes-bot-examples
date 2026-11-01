import { createClient, type AuthFunctions, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { jwt, type Jwk } from "better-auth/plugins/jwt";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";

export const MCP_SCOPES = ["crm:read", "crm:write"] as const;

// Annotated to break the type cycle internal.auth -> triggersApi() -> authComponent.
const authFunctions: AuthFunctions = internal.auth;

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
  authFunctions,
  triggers: {
    oauthRefreshToken: {
      // oauth-provider rotates and revokes refresh tokens with `where revoked eq null`.
      // The Convex adapter's `eq` never matches a missing field, so store an explicit null.
      onCreate: async (ctx, doc) => {
        if (doc.revoked === undefined) {
          await ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: {
              model: "oauthRefreshToken",
              where: [{ field: "_id", value: doc._id }],
              update: { revoked: null },
            },
          });
        }
      },
    },
  },
});

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = process.env.SITE_URL!;
  const convexSiteUrl = process.env.CONVEX_SITE_URL!;
  return {
    baseURL: convexSiteUrl,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    // oauth-provider serves /oauth2/token; the convex() plugin's /token is not used.
    disabledPaths: ["/token"],
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    // Order matters: crossDomain before oauthProvider breaks sign-in with `oauth_query`.
    plugins: [
      oauthProvider({
        loginPage: `${siteUrl}/sign-in`,
        consentPage: `${siteUrl}/consent`,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        validAudiences: [`${convexSiteUrl}/mcp`],
        scopes: ["openid", "profile", "email", "offline_access", ...MCP_SCOPES],
        silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
      }),
      jwt({
        jwt: { issuer: convexSiteUrl },
        // convex() shadows jwt()'s /jwks endpoint with its own /convex/jwks (same table, same kid).
        jwks: { keyPairConfig: { alg: "RS256" }, remoteUrl: `${convexSiteUrl}/api/auth/convex/jwks` },
        // Copied from the convex() plugin: the Convex adapter returns createdAt as a number.
        adapter: {
          createJwk: async (webKey, ctx) =>
            await ctx.context.adapter.create<Omit<Jwk, "id">, Jwk>({
              model: "jwks",
              data: { ...webKey, createdAt: new Date() },
            }),
          getJwks: async (ctx) => {
            const keys = await ctx.context.adapter.findMany<Jwk>({
              model: "jwks",
              sortBy: { field: "createdAt", direction: "desc" },
            });
            return keys.map((key) => ({
              ...key,
              createdAt: new Date(key.createdAt),
              ...(key.expiresAt ? { expiresAt: new Date(key.expiresAt) } : {}),
            }));
          },
        },
      }),
      crossDomain({ siteUrl }),
      convex({ authConfig }),
    ],
  } satisfies BetterAuthOptions;
};

export const createAuth = (ctx: GenericCtx<DataModel>) => betterAuth(createAuthOptions(ctx));
