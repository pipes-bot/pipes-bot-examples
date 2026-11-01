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
