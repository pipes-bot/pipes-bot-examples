import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

const apiKey = process.env.PIPES_API_KEY ?? "";
const secret = process.env.PIPES_WEBHOOK_SECRET ?? "";
const baseUrl = (process.env.PIPES_API_BASE_URL ?? "https://api.pipes.bot").replace(/\/+$/, "");
const port = Number(process.env.PORT ?? 3000);

// The key prefix decides the mode: pk_ = sandbox, ak_ = BYON API v2.
const mode = apiKey.startsWith("pk_") ? "sandbox" : apiKey.startsWith("ak_") ? "byon" : null;
if (!mode) {
  console.error("PIPES_API_KEY is missing or invalid: expected a pk_ (sandbox) or ak_ (BYON v2) key");
  process.exit(1);
}
if (mode === "byon" && !secret) {
  console.error("PIPES_WEBHOOK_SECRET (whsec_...) is required with an ak_ key");
  process.exit(1);
}
if (mode === "sandbox" && !secret) {
  console.warn("PIPES_WEBHOOK_SECRET is not set: sandbox signatures will NOT be verified");
}

// In-memory dedup, capped at 1000 entries. In production, keep this in your database.
const seen = new Set<string>();
const isDuplicate = (id: string) => {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1000) seen.delete(seen.values().next().value!);
  return false;
};

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Sandbox: hex HMAC-SHA256 of the raw body, keyed with the raw secret string.
function verifySandbox(req: Request, body: string) {
  if (!secret) return true;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return safeEqual(req.headers.get("x-pipes-signature") ?? "", expected);
}

// BYON v2 (Standard Webhooks): sign `${id}.${timestamp}.${body}`, key = base64-decoded secret.
function verifyByon(req: Request, body: string) {
  const id = req.headers.get("webhook-id");
  const timestamp = req.headers.get("webhook-timestamp");
  const signatures = req.headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return false;
  // Integer seconds only (at most 12 ASCII digits), at most 5 minutes off.
  if (!/^[0-9]{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    return version === "v1" && safeEqual(signature ?? "", expected);
  });
}

// Runs after the 200 has been returned; failures are logged and never crash the process.
async function send(path: string, payload: object, id: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) console.log(`replied ${id}`);
  else console.error(`send failed ${id}: ${res.status} ${await res.text()}`);
}
const reply = (path: string, payload: object, id: string) =>
  void send(path, payload, id).catch((err) => console.error(`send failed ${id}:`, err));

const app = new Hono();

app.post("/webhook", async (c) => {
  const body = await c.req.text(); // raw body: the signature covers these exact bytes
  if (!(mode === "sandbox" ? verifySandbox(c.req.raw, body) : verifyByon(c.req.raw, body))) {
    return c.text("invalid signature", 401);
  }
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return c.text("invalid JSON", 400);
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return c.text("invalid payload", 400); // null, a list, a number: rejected before dedup
  }
  if (event.test === true || event.event === "test") return c.text("ok");

  if (mode === "sandbox") {
    for (const message of list(event.entry?.[0]?.changes?.[0]?.value?.messages)) {
      const id = message?.id;
      if (typeof id !== "string") console.log("skipped missing-id -"); // nothing to dedup on, so nothing is answered
      else if (isDuplicate(id)) console.log(`duplicate ${id}`);
      else if (message.type !== "text") console.log(`skipped ${message.type} ${id}`);
      else {
        console.log(`received message ${id}`);
        const text = `Echo: ${message.text?.body ?? ""}`;
        reply("/v1/messages/send", { conversationId: event.pipes?.conversationId, text }, id);
      }
    }
  } else {
    const id = c.req.header("webhook-id")!;
    if (isDuplicate(id)) console.log(`duplicate ${id}`);
    else if (event.field !== "messages") console.log(`skipped ${event.field} ${id}`);
    else {
      console.log(`received message ${id}`);
      for (const message of list(event.whatsapp?.messages)) {
        if (message?.type !== "text") {
          console.log(`skipped ${message?.type} ${message?.id}`);
          continue;
        }
        const to = typeof message.from === "string" && message.from ? message.from : message.from_user_id; // BSUID users may have no phone
        const text = `Echo: ${message.text?.body ?? ""}`;
        reply("/v1/messages/app/send", { poolNumberId: event.pipes?.poolNumberId, to, text }, message.id);
      }
    }
  }
  return c.text("ok");
});

console.log(`${mode} webhook listening on :${port}/webhook`);
export default { port, fetch: app.fetch };
