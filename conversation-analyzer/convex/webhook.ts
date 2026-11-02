import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { summarizeHistory } from "./lib/history";
import { verifyStandardWebhook } from "./lib/signature";

/** Address-book items per ingested event; a larger `smb_app_state_sync` envelope is split. */
export const STATE_SYNC_BATCH = 500;

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

  const items = (payload as { whatsapp?: { state_sync?: unknown } }).whatsapp?.state_sync;
  if (
    (payload as { field?: unknown }).field === "smb_app_state_sync" &&
    Array.isArray(items) &&
    items.length > STATE_SYNC_BATCH
  ) {
    // A full address book can hold thousands of contacts: one event per slice
    // keeps each mutation and each stored payload within the Convex limits.
    // Every slice is deduped on its own id, so a retry only redoes what failed.
    const envelope = payload as { whatsapp: Record<string, unknown> };
    for (let i = 0; i * STATE_SYNC_BATCH < items.length; i++) {
      const state_sync = items.slice(i * STATE_SYNC_BATCH, (i + 1) * STATE_SYNC_BATCH);
      await ctx.runMutation(internal.ingest.ingest, {
        webhookId: `${webhookId}#${i}`,
        payload: { ...envelope, whatsapp: { ...envelope.whatsapp, state_sync } },
      });
    }
    return reply("ok", 200);
  }

  await ctx.runMutation(internal.ingest.ingest, { webhookId, payload });
  return reply("ok", 200);
});
