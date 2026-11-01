import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// oauthProviderClient() must stay first: on any sign-in/sign-up/consent call it adds the signed
// OAuth query from `window.location.search` as `oauth_query`.
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL,
  plugins: [oauthProviderClient(), crossDomainClient(), convexClient()],
});
