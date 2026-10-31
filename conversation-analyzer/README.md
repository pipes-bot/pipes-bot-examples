---
title: Conversation analyzer
description: Connect WhatsApp Business numbers, capture every reply sent from the phone, and score each conversation on response time and your support methodology
type: app
stack: [tanstack-router, convex, better-auth, openrouter, typescript]
features: [webhooks, byon-v2, embedded-signup, coexistence, echoes]
---

# Conversation analyzer

## What it shows

A complete app that connects WhatsApp Business numbers to pipes.bot (BYON API v2), receives every webhook, and analyzes each customer conversation: response times computed in code, and adherence to your support methodology scored by an AI model.

The app only observes. It never sends a message. Your team keeps answering from the WhatsApp Business app on the phone, and pipes.bot forwards those replies as `smb_message_echoes` (coexistence), which is what lets the app see them.

- A workspace per account, with Better Auth sign-up and sign-in.
- A **Connect a number** flow built on pipes.bot embedded signup.
- A live overview of waiting customers, response times, and scores.
- A conversation view with the transcript, metrics, a summary, and a verdict with quoted evidence for each methodology step.
- An editable methodology checklist and inactivity window per workspace.
- A demo seed so you can see all of it without a phone.

Stack: TanStack Router (static SPA built with Vite), Convex (HTTP actions, reactive queries, scheduler, crons), Better Auth (Convex component, `crossDomain` plugin), Tailwind v4 and shadcn/ui, AI SDK 7 with OpenRouter.

## pipes.bot features used

- Webhooks with Standard Webhooks signatures (`POST /webhooks/pipes`)
- BYON API v2 events: `number.onboarded`, `messages`, `smb_message_echoes`, message statuses
- Embedded signup: `POST /v1/apps/token` with `metadata.workspaceId`
- Coexistence echoes: replies sent from the phone
- Number health: `GET /v1/pool-numbers/{id}/health`

## Run locally

Requires Node 22 and pnpm.

```bash
pnpm install
pnpm exec convex dev        # creates a deployment, pushes the functions, writes .env.local
```

On first run `convex dev` asks how to create the deployment. Without a Convex account, run `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev` to get a local anonymous deployment. A local deployment is not reachable from the internet, so pipes.bot cannot deliver webhooks to it. That is enough for the demo seed and the simulator. To connect a real number you need a cloud dev deployment (`pnpm exec convex dev` while logged in).

Set the Convex environment variables on the deployment (they are not read from `.env.example`):

```bash
npx convex env set PIPES_API_KEY ak_...
npx convex env set PIPES_APP_SLUG your-app-slug
npx convex env set PIPES_WEBHOOK_SECRET whsec_...
npx convex env set SITE_URL http://localhost:5173
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
# Optional
npx convex env set OPENROUTER_API_KEY sk-or-...
npx convex env set OPENROUTER_MODEL anthropic/claude-sonnet-5.5
npx convex env set PIPES_API_BASE_URL https://api.pipes.bot
```

| Variable | Where | Description |
| --- | --- | --- |
| `PIPES_API_KEY` | Convex | `ak_...` key of your App. Used to create signup links and check number health. Required. |
| `PIPES_APP_SLUG` | Convex | Slug of your App, used to build the signup URL. Required. |
| `PIPES_WEBHOOK_SECRET` | Convex | `whsec_...` secret of your App. Required. |
| `PIPES_API_BASE_URL` | Convex | Optional. Defaults to `https://api.pipes.bot`. |
| `SITE_URL` | Convex | Exact origin of the web app, for example `http://localhost:5173`. Required. |
| `BETTER_AUTH_SECRET` | Convex | Random secret for Better Auth. Generate it with `openssl rand -base64 32`. Required. |
| `OPENROUTER_API_KEY` | Convex | Optional. Without it conversations are not analyzed (state `skipped`). |
| `OPENROUTER_MODEL` | Convex | Optional. Defaults to `anthropic/claude-sonnet-5.5`. |
| `VITE_CONVEX_URL` | `.env.local` | The `.convex.cloud` URL (or the local API URL). Written by `convex dev`. |
| `VITE_CONVEX_SITE_URL` | `.env.local` | The `.convex.site` URL (or the local site proxy URL). Written by `convex dev`. |

Then start the web app and open http://localhost:5173:

```bash
pnpm dev
```

`pnpm test` runs the Convex functions against `convex-test`, `pnpm typecheck` checks the app and the functions, and `pnpm build` produces the static bundle.

### Set up pipes.bot

1. Create an App on **API v2** in pipes.bot.
2. Turn on **Forward messages sent from the phone**. Without it no echoes arrive and the app cannot see your team's replies.
3. Set the webhook URL to `https://<deployment>.convex.site/webhooks/pipes`.
4. Copy the `whsec_` secret and the `ak_` key into `PIPES_WEBHOOK_SECRET` and `PIPES_API_KEY`, and the App slug into `PIPES_APP_SLUG`.
5. Sign up in the app, open **Numbers**, and click **Connect a number**.

## Try it without a phone

Sign up in the app once so your workspace exists, then seed four conversations for your account:

```bash
npx convex run demo:seed '{"email":"you@example.com"}'
npx convex run demo:reset '{"email":"you@example.com"}'   # removes the demo number and everything under it
```

These are internal functions, so they run from the CLI only. The seed goes through the same ingestion function as real webhooks and closes the conversations right away. The four scenarios are: a quick answer from the phone, a customer left waiting, a customer who never got a reply, and a reply sent through the API. Without `OPENROUTER_API_KEY` the analysis shows as skipped; with a key it runs for the answered ones.

To exercise the webhook route itself, use the simulator from the repo root (run `pnpm install` there first). It signs a fixture with your secret and posts it:

```bash
pnpm simulate byon-v2/test-webhook --url <site-url>/webhooks/pipes --secret <whsec_...>
pnpm simulate byon-v2/test-webhook --url <site-url>/webhooks/pipes --secret <whsec_...> --bad-signature
```

`<site-url>` is the `.convex.site` URL (the local proxy prints something like `http://127.0.0.1:3211`). The first command prints `200 ok`, the second prints `401`.

## Deploy

1. Deploy the backend: `npx convex deploy`. Set the same environment variables on the production deployment, with `SITE_URL` set to the final URL of the web app.
2. Build the web app with `pnpm build` and host the `dist/` folder as a static site on Vercel or Netlify. Set `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` in the host's build environment, and add a rewrite of every path to `/index.html` so deep links work.
3. In pipes.bot, set the webhook URL to `https://<production-deployment>.convex.site/webhooks/pipes`.

`SITE_URL` must be the exact origin of the SPA (scheme, host and port, no trailing path). This app trusts exactly one origin, `SITE_URL`, so preview deployments on other origins cannot sign in. Better Auth accepts wildcard patterns in `trustedOrigins` if you extend `convex/auth.ts`. The signup `redirectUrl` is built from `SITE_URL` and must be HTTPS except on localhost.

## How it works

```
pipes.bot --POST /webhooks/pipes--> httpAction (verify signature)
                                       |
                                       v
                                 mutation ingest --> events, numbers, contacts,
                                       |             conversations, messages, statuses
                                       v
                         scheduler: closeIfIdle(conversation)
                                       |
                                       v
                         close + computeMetrics --> action analyzeConversation --> OpenRouter
```

### Webhook and ingestion

`POST /webhooks/pipes` verifies the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`, 300 s tolerance, constant-time comparison) and answers:

| Status | When |
| --- | --- |
| 401 | Missing or invalid signature |
| 400 | The body is not a JSON object |
| 500 | `PIPES_WEBHOOK_SECRET` is unset or malformed |
| 200 | Everything else, including duplicates |

The raw payload is stored in `events` (deduplicated by webhook id) and then projected into numbers, contacts, conversations, messages and statuses, all in one transaction. A failure returns 500 so pipes.bot retries.

**Signup and ownership.** `createSignupLink` calls `POST /v1/apps/token` with `metadata.workspaceId` and `redirectUrl = ${SITE_URL}/numbers/connected`, and sends the user to the pipes.bot signup page. The token is valid for 15 minutes and is single use. When `number.onboarded` arrives, its `metadata.workspaceId` ties the number to the workspace. `/numbers/connected` shows troubleshooting if the number has not appeared after 3 minutes.

**Parking and replay.** Events for a number the app does not know yet are parked. They are replayed when `number.onboarded` arrives, so nothing is lost if messages beat the onboarding event. If a number moves to another workspace, its open conversations are closed in the old one.

### Message sources

| Source | What it is | How it arrives |
| --- | --- | --- |
| `customer` | Inbound message from the customer | `messages` |
| `phone` | Reply sent from the WhatsApp Business app on the phone | `smb_message_echoes` echo, with text |
| `api` | Reply sent through the API by another system | Only as message statuses, with no text |

Echoes are never treated as customer messages. API replies are never delivered as messages, so their statuses are kept aside and adopted as `api` messages when the conversation closes. They count as an answer in the metrics but have no text.

### Conversation lifecycle

A conversation opens with the first message for a contact that has no open one, and closes after `inactivityMinutes` without activity (default 120, allowed range 5-1440, set in **Settings**). Each message reschedules the close. A message after the close opens a new conversation. On close the app computes the metrics and schedules the analysis.

### Metrics

Computed in code by a pure function, from the WhatsApp timestamps. A customer turn is a run of customer messages with no reply from the business in between.

- First response: from the first customer message to the first reply.
- Average and maximum response per customer turn: from the start of each answered turn to the first reply after it.
- Unanswered turns: customer turns with no reply after them.
- Answered: the business replied at least once.
- Duration: first to last message.
- Counts per source: `customer`, `phone`, `api`.

### Analysis

`analyzeConversation` builds a transcript and calls AI SDK 7 `generateText` with `Output.object` and a zod schema through OpenRouter. The model is `anthropic/claude-sonnet-5.5` unless `OPENROUTER_MODEL` says otherwise. The call asks OpenRouter for `provider: { zdr: true, data_collection: "deny" }`.

- At most 3 model calls per analysis, each with a 120 s timeout. The SDK retries are off, the loop does the retrying.
- Step ids are validated against the methodology snapshot taken at close time.
- Quoted evidence must appear in the transcript, otherwise it is dropped.
- The score is `round(100 * met / (met + not_met))`. Steps that are not applicable do not count, and the score is absent when nothing was applicable.
- The analysis is `skipped` when there was no reply (`no-reply`) or when `OPENROUTER_API_KEY` is not set (`no-api-key`). **Retry** and **Re-analyze** are available on the conversation page.

### Number health

An hourly cron calls `GET /v1/pool-numbers/{id}/health` for each number and maps the result to healthy, unhealthy or unknown (also used when the call fails). Demo numbers are skipped. The Numbers page shows the badge.

## Privacy

Conversation transcripts (message text, labeled Customer and Agent) are sent to an AI provider through OpenRouter to be analyzed.

- The app requests zero-data-retention endpoints with `zdr: true` and `data_collection: "deny"`. OpenRouter only routes the request to providers that match those settings.
- You can restrict providers further in your OpenRouter account settings (privacy and allowed providers).
- Analysis is off unless `OPENROUTER_API_KEY` is set. Without it, no transcript leaves your Convex deployment.
- API replies have no text in the transcript, because pipes.bot does not deliver it.

Decide with your legal team whether you need your customers' consent before analyzing their conversations.

## Limits and extensions

Left out on purpose, and good next steps:

- Ranking per agent. The echo does not say who answered.
- Business hours. Response times are wall-clock.
- Sending messages. The app only observes.
- Disconnecting numbers.
- Organizations and invitations. There is one workspace per account.
- Showing media. Media messages appear as a type label with the caption.
- BYON legacy, sandbox and WebSocket modes.
- Email verification and OAuth sign-in.

Dashboard queries read at most 1000 conversations in the selected window. For larger volumes, keep the counters in [`@convex-dev/aggregate`](https://www.convex.dev/components/aggregate) instead.
