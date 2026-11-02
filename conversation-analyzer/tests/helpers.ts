import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

/** `transactionLimits: true` enforces the Convex per-transaction limits, like production. */
export function makeT(options: { transactionLimits?: boolean } = {}) {
  const t = convexTest({ schema, modules, transactionLimits: options.transactionLimits ?? false });
  betterAuthTest.register(t, "betterAuth");
  return t;
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
