import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { summarizeHistory } from "./lib/history";
import { verifyStandardWebhook } from "./lib/signature";

const reply = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

/** Receives every pipes.bot App webhook. Non-2xx responses make pipes.bot retry. */
export const pipesWebhook = httpAction(async (ctx, request) => {
  const body = await request.text();
  const secret = process.env.PIPES_WEBHOOK_SECRET;
  if (!secret) {
    console.error("PIPES_WEBHOOK_SECRET is not set");
    return reply("webhook secret not configured", 500);
  }

  const webhookId = request.headers.get("webhook-id");
  let valid: boolean;
  try {
    valid = await verifyStandardWebhook({
      id: webhookId,
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
      body,
      secret,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Invalid webhook secret") throw error;
    console.error("PIPES_WEBHOOK_SECRET is invalid");
    return reply("webhook secret not configured", 500);
  }
  if (!valid || !webhookId) return reply("invalid signature", 401);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return reply("body is not JSON", 400);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return reply("body is not a JSON object", 400);
  }

  if ((payload as { field?: unknown }).field === "history") {
    // Chunks can hold thousands of messages: keep the raw body in file storage
    // and the event row to a summary. `receive` owns the blob from here on.
    const summary = summarizeHistory(payload);
    const storageId =
      summary.messageCount > 0
        ? await ctx.storage.store(new Blob([body], { type: "application/json" }))
        : undefined;
    const poolNumberId = (payload as { pipes?: { poolNumberId?: unknown } }).pipes?.poolNumberId;
    await ctx.runMutation(internal.history.receive, {
      webhookId,
      poolNumberId: typeof poolNumberId === "string" && poolNumberId ? poolNumberId : undefined,
      summary,
      storageId,
    });
    return reply("ok", 200);
  }

  await ctx.runMutation(internal.ingest.ingest, { webhookId, payload });
  return reply("ok", 200);
});
