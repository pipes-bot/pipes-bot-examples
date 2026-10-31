import { createHmac } from "node:crypto";

export type { Mode } from "./fixtures.ts";

/** Legacy sandbox signature: lowercase hex HMAC-SHA256 of the raw body, keyed by the UTF-8 secret. */
export function signSandbox(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Standard Webhooks signature (`v1,<base64>`) over `<id>.<timestamp>.<body>`. */
export function signStandardWebhook(
  id: string,
  timestamp: number,
  body: string,
  secret: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
  return `v1,${digest}`;
}
