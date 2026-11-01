import { convexTest } from "convex-test";
import { api, components } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import betterAuthSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";

// The local Better Auth component is registered separately, so keep its files
// (and its own _generated/) out of the app's module map.
const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/betterAuth/**"]);
const betterAuthModules = import.meta.glob("../convex/betterAuth/**/*.ts");

export function makeT() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

export type TestConvex = ReturnType<typeof makeT>;

/** Signs in as `ownerId` (Convex identity `subject`) and creates their workspace. */
export async function seedUser(t: TestConvex, ownerId = "user_1") {
  const asUser = t.withIdentity({ subject: ownerId });
  const workspaceId = await asUser.mutation(api.workspaces.ensureWorkspace, {});
  return { workspaceId, asUser };
}

export const TEST_WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Signs a delivery the way pipes.bot does (Standard Webhooks). A string payload
 * is sent as-is so tests can sign bodies that are not JSON objects.
 * Async because Web Crypto has no synchronous HMAC.
 */
export async function signedRequest(
  payload: unknown,
  opts: { id?: string; secret?: string; tamper?: boolean } = {},
): Promise<{ body: string; headers: Record<string, string> }> {
  const id = opts.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const secret = opts.secret ?? TEST_WEBHOOK_SECRET;
  const keyBytes = Uint8Array.from(atob(secret.slice("whsec_".length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return {
    body: opts.tamper ? `${body} ` : body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${bytesToBase64(new Uint8Array(mac))}`,
    },
  };
}

/**
 * Stores what a finished OAuth authorization leaves behind in the Better Auth
 * component: the (dynamically registered) client and the user's consent.
 */
export async function seedConsent(
  t: TestConvex,
  grant: { userId: string; clientId: string; clientName?: string; scopes?: string[] },
) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "oauthClient",
        data: {
          clientId: grant.clientId,
          name: grant.clientName,
          redirectUris: ["http://127.0.0.1:9/callback"],
        },
      },
    });
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "oauthConsent",
        data: {
          clientId: grant.clientId,
          userId: grant.userId,
          scopes: grant.scopes ?? ["crm:read", "crm:write"],
        },
      },
    });
  });
}

export const HOUR = 3_600_000;

export function seedNumber(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  extra: Partial<Doc<"numbers">> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("numbers", {
      workspaceId,
      poolNumberId: "pn_1",
      phoneNumber: "+15550001111",
      displayName: "Support",
      connectedAt: 0,
      ...extra,
    }),
  );
}

/** A lead whose 24h window is open (last wrote an hour ago) unless overridden. */
export function seedContact(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  numberId: Id<"numbers">,
  overrides: Partial<Doc<"contacts">> = {},
) {
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert("contacts", {
      workspaceId,
      waId: "5511900000000",
      name: "Ana",
      stage: "lead",
      tags: [],
      lastNumberId: numberId,
      lastInboundAt: now - HOUR,
      lastMessageAt: now - HOUR,
      lastDirection: "in",
      unread: 1,
      searchText: "Ana 5511900000000",
      ...overrides,
    }),
  );
}
