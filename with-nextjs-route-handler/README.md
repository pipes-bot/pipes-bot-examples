---
title: Next.js route handler webhook
description: Receive and reply to WhatsApp messages with a single Next.js route handler, ready for Vercel
type: starter
stack: [nextjs, typescript, vercel]
features: [webhooks, sandbox, byon-v2]
---

# Next.js route handler webhook

## What it shows

A pipes.bot webhook receiver in one Next.js route handler (`app/api/webhook/route.ts`, about 120 lines). It verifies the signature, ignores everything that is not a text message and replies `Echo: <text>`. It runs in two modes, picked from the prefix of `PIPES_API_KEY`:

- `pk_...`: sandbox, legacy payload, `X-Pipes-Signature` header.
- `ak_...`: BYON API v2, Standard Webhooks signature, v2 envelope.

## pipes.bot features used

- Webhooks (sandbox payload and BYON API v2 envelope)
- Sandbox send: `POST /v1/messages/send`
- BYON v2 send: `POST /v1/messages/app/send`

## Run locally

Requires Node.js 20.9 or later and [pnpm](https://pnpm.io).

```bash
pnpm install
cp .env.example .env.local   # set PIPES_API_KEY and PIPES_WEBHOOK_SECRET
pnpm dev
```

Next.js loads `.env.local` automatically. The webhook listens on `POST http://localhost:3000/api/webhook`.

pipes.bot needs a public URL to reach it. Open a tunnel and register `<public-url>/api/webhook` as the webhook URL:

```bash
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```

No phone or account yet? Use the mock API and webhook simulator from the [root README](../README.md#testing-without-a-phone).

| Variable | Description |
| --- | --- |
| `PIPES_API_KEY` | `pk_...` (sandbox) or `ak_...` (BYON v2). Selects the mode. Required. |
| `PIPES_WEBHOOK_SECRET` | Sandbox webhook secret (optional, but verification is skipped without it) or the `whsec_...` secret of your App (required for BYON). |
| `PIPES_API_BASE_URL` | Optional. Defaults to `https://api.pipes.bot`. |

Next.js picks its own port (`pnpm dev -p 4000` changes it), so this starter does not read `PORT`.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fpipes-bot%2Fexamples%2Ftree%2Fmain%2Fwith-nextjs-route-handler&env=PIPES_API_KEY,PIPES_WEBHOOK_SECRET&root-directory=with-nextjs-route-handler)

Vercel asks for `PIPES_API_KEY` and `PIPES_WEBHOOK_SECRET`. After the deploy, register `https://<your-project>.vercel.app/api/webhook` in pipes.bot. Any host that runs Next.js works too (`pnpm build && pnpm start`).

The deduplication `Set` lives in memory, so on Vercel each serverless instance has its own copy. See "Going to production".

## How it works

1. `PIPES_API_KEY` picks the mode when the module loads. Next.js cannot exit the process on bad config, so a missing or unknown key (or BYON without `PIPES_WEBHOOK_SECRET`) makes every `POST` log the problem and return 500.
2. The handler reads the raw body with `await req.text()` before parsing, because the signature covers the exact bytes. It runs on the Node.js runtime (`export const runtime = "nodejs"`) for `node:crypto`.
3. The signature is checked with `node:crypto` and `timingSafeEqual`. Sandbox: hex HMAC-SHA256 of the body with the raw secret. BYON v2: HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{body}`, keyed with the base64-decoded `whsec_` secret. Any `v1,` entry in the header may match (secret rotation) and timestamps that are not integer seconds, or are more than 5 minutes off, are rejected. Invalid signature returns 401, invalid JSON returns 400, and a JSON body that is not an object returns 400 `invalid payload`.
4. Test payloads (`{"test": true}` or `{"event": "test"}`) get a 200 and nothing else.
5. Duplicates are dropped using the message id (sandbox) or `webhook-id` (BYON). A sandbox message without an `id` is skipped, since there is nothing to deduplicate on.
6. Only text messages are answered. In v2 the envelope must have `field: "messages"`. Statuses, echoes and system events are skipped, so the bot never answers itself. The recipient is `message.from ?? message.from_user_id`.
7. The handler returns 200 first. The replies are sent in order from `after()` (`next/server`), once the response is out, and the function stays alive until they finish. Failures are caught and logged, so a failed send never breaks the next message.

Log lines: `received <kind> <id>`, `replied <id>`, `skipped <reason> <id>`, `duplicate <id>`.

## Going to production

- **Sandbox limits.** The sandbox number is shared, there are no templates and you can only reply inside the 24-hour customer window.
- **Move to BYON v2.** Use an `ak_` API key, the `whsec_` signing secret of your App, the v2 envelope and the `app/send` endpoint. This starter already handles both.
- **Persist deduplication.** The in-memory `Set` is capped at 1000 entries, is per serverless instance and resets on cold starts. Store processed ids in your database.
- **More.** Full apps live in the [examples repo](../README.md). See [docs.pipes.bot](https://docs.pipes.bot) for webhooks, sending messages and BYON setup.
