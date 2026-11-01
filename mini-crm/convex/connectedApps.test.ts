import { expect, test } from "vitest";
import { makeT, seedConsent, type TestConvex } from "../tests/helpers";
import { api, components } from "./_generated/api";

/** The refresh and access token rows an authorization code exchange leaves behind. */
async function seedTokens(t: TestConvex, grant: { userId: string; clientId: string }) {
  await t.run(async (ctx) => {
    for (const model of ["oauthRefreshToken", "oauthAccessToken"] as const) {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model,
          data: {
            token: `${model}_${grant.userId}_${grant.clientId}`,
            clientId: grant.clientId,
            userId: grant.userId,
            scopes: ["crm:read"],
          },
        },
      });
    }
  });
}

async function rows(t: TestConvex, model: "oauthConsent" | "oauthRefreshToken" | "oauthAccessToken") {
  const result = await t.run((ctx) =>
    ctx.runQuery(components.betterAuth.adapter.findMany, {
      model,
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  );
  return (result.page as { userId: string; clientId: string }[]).map(
    ({ userId, clientId }) => `${userId}/${clientId}`,
  );
}

test("list shows the user's consents", async () => {
  const t = makeT();
  await seedConsent(t, {
    userId: "user_1",
    clientId: "client_1",
    clientName: "Claude",
    scopes: ["openid", "crm:read"],
    createdAt: 1_000,
  });
  await seedConsent(t, { userId: "user_1", clientId: "client_2", createdAt: 2_000 });
  await seedConsent(t, { userId: "user_2", clientId: "client_3", clientName: "Other" });

  // Newest first; a client registered without a name is labelled like on /mcp.
  expect(await t.withIdentity({ subject: "user_1" }).query(api.connectedApps.list, {})).toEqual([
    { clientId: "client_2", clientName: "MCP", scopes: ["crm:read", "crm:write"], createdAt: 2_000 },
    { clientId: "client_1", clientName: "Claude", scopes: ["openid", "crm:read"], createdAt: 1_000 },
  ]);
  expect(await t.withIdentity({ subject: "user_3" }).query(api.connectedApps.list, {})).toEqual([]);
  await expect(t.query(api.connectedApps.list, {})).rejects.toThrow("Not signed in");
});

test("revoke deletes consent and tokens", async () => {
  const t = makeT();
  await seedConsent(t, { userId: "user_1", clientId: "client_1", clientName: "Claude" });
  await seedConsent(t, { userId: "user_1", clientId: "client_2", clientName: "ChatGPT" });
  await seedTokens(t, { userId: "user_1", clientId: "client_1" });
  await seedTokens(t, { userId: "user_1", clientId: "client_2" });
  const user = t.withIdentity({ subject: "user_1" });

  await user.mutation(api.connectedApps.revoke, { clientId: "client_1" });

  expect(await rows(t, "oauthConsent")).toEqual(["user_1/client_2"]);
  expect(await rows(t, "oauthRefreshToken")).toEqual(["user_1/client_2"]);
  expect(await rows(t, "oauthAccessToken")).toEqual(["user_1/client_2"]);
  expect((await user.query(api.connectedApps.list, {})).map((app) => app.clientId)).toEqual([
    "client_2",
  ]);
  // Revoking again (or an unknown client) is a no-op.
  await user.mutation(api.connectedApps.revoke, { clientId: "client_1" });
  await expect(t.mutation(api.connectedApps.revoke, { clientId: "client_2" })).rejects.toThrow(
    "Not signed in",
  );
});

test("revoke is scoped to the caller", async () => {
  const t = makeT();
  await seedConsent(t, { userId: "user_1", clientId: "client_1", clientName: "Claude" });
  await t.run((ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "oauthConsent",
        data: { clientId: "client_1", userId: "user_2", scopes: ["crm:read"] },
      },
    }),
  );
  await seedTokens(t, { userId: "user_1", clientId: "client_1" });
  await seedTokens(t, { userId: "user_2", clientId: "client_1" });

  await t.withIdentity({ subject: "user_2" }).mutation(api.connectedApps.revoke, {
    clientId: "client_1",
  });

  for (const model of ["oauthConsent", "oauthRefreshToken", "oauthAccessToken"] as const) {
    expect(await rows(t, model)).toEqual(["user_1/client_1"]);
  }
});
