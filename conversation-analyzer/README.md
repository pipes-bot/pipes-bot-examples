---
title: Conversation analyzer
description: Connect WhatsApp Business numbers, capture every reply sent from the phone, and score each conversation on response time and your support methodology
type: app
stack: [tanstack-router, convex, better-auth, openrouter, typescript]
features: [webhooks, byon-v2, embedded-signup, coexistence, echoes, history-import, contacts-sync]
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
- An optional import of the phone's chat history (up to 6 months) and address book when you connect a Coexistence number.
- A demo seed so you can see all of it without a phone.

Stack: TanStack Router (static SPA built with Vite), Convex (HTTP actions, reactive queries, scheduler, crons), Better Auth (Convex component, `crossDomain` plugin), Tailwind v4 and shadcn/ui, AI SDK 7 with OpenRouter.

## pipes.bot features used

- Webhooks with Standard Webhooks signatures (`POST /webhooks/pipes`)
- BYON API v2 events: `number.onboarded`, `messages`, `smb_message_echoes`, message statuses, `history`, `smb_app_state_sync`
- Embedded signup: `POST /v1/apps/token` with `metadata.workspaceId`, `importHistory` and `importContacts`
- Chat history import: `history` events, and the `importHistory` / `importContacts` flags in `number.onboarded`
- Contacts sync: `smb_app_state_sync` events with the phone's address book
- Coexistence echoes: replies sent from the phone
- Number health: `GET /v1/pool-numbers/{id}/health`

## Run locally

Requires Node 22 and pnpm.

```bash
pnpm install
pnpm exec convex dev        # creates a deployment, pushes the functions, writes .env.local
```

`convex dev` keeps running and pushes your function changes as you edit, so leave it open and run the commands below, and later `pnpm dev`, in a second terminal.

On first run `convex dev` asks how to create the deployment. Without a Convex account, run `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev` to get a local anonymous deployment. A local deployment is not reachable from the internet, so pipes.bot cannot deliver webhooks to it. That is enough for the demo seed and the simulator. To connect a real number you need a cloud dev deployment (`pnpm exec convex dev` while logged in).

### Set the environment variables (before you sign in)

The app reads its configuration from the Convex deployment, not from `.env.local`; `.env.example` only lists the variables for reference. Run these in this folder, against the deployment `convex dev` created. Each app has its own deployment, so set them again for every app you run.

```bash
# Required, also for the demo
npx convex env set SITE_URL http://localhost:5173
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
# Needed for a real number: signup links, webhooks, health checks
npx convex env set PIPES_API_KEY ak_...
npx convex env set PIPES_APP_SLUG your-app-slug
npx convex env set PIPES_WEBHOOK_SECRET whsec_...
# Optional
npx convex env set OPENROUTER_API_KEY sk-or-...
npx convex env set OPENROUTER_MODEL anthropic/claude-sonnet-5.5
npx convex env set PIPES_API_BASE_URL https://api.pipes.bot
```

Check what is set with `npx convex env list`. `SITE_URL` and `BETTER_AUTH_SECRET` are needed even for the demo: without them, sign-up fails with "Failed to fetch" (see Troubleshooting below).

| Variable | Where | Description |
| --- | --- | --- |
| `SITE_URL` | Convex | Exact origin of the web app, for example `http://localhost:5173`. Required, also for the demo. |
| `BETTER_AUTH_SECRET` | Convex | Random secret for Better Auth. Generate it with `openssl rand -base64 32`. Required, also for the demo. |
| `PIPES_API_KEY` | Convex | `ak_...` key of your App. Used to create signup links and check number health. Required to connect a real number. |
| `PIPES_APP_SLUG` | Convex | Slug of your App, used to build the signup URL. Required to connect a real number. |
| `PIPES_WEBHOOK_SECRET` | Convex | `whsec_...` secret of your App. Required to receive webhooks. |
| `PIPES_API_BASE_URL` | Convex | Optional. Defaults to `https://api.pipes.bot`. |
| `OPENROUTER_API_KEY` | Convex | Optional. Without it conversations are not analyzed (state `skipped`). |
| `OPENROUTER_MODEL` | Convex | Optional. Defaults to `anthropic/claude-sonnet-5.5`. |
| `VITE_CONVEX_URL` | `.env.local` | The `.convex.cloud` URL (or the local API URL). Written by `convex dev`. |
| `VITE_CONVEX_SITE_URL` | `.env.local` | The `.convex.site` URL (or the local site proxy URL). Written by `convex dev`. |

The three `PIPES_*` secrets can stay unset if you only use the demo seed.

Then start the web app and open http://localhost:5173:

```bash
pnpm dev
```

### Troubleshooting

- **Sign-up or sign-in shows "Failed to fetch", and the browser's Network tab shows a CORS error on `/api/auth/...`.** `SITE_URL` or `BETTER_AUTH_SECRET` is not set on the deployment, or `SITE_URL` is not exactly the origin in the address bar (scheme, host and port, no trailing slash). Run `npx convex env list`, set the missing values and try again.
- **`/webhooks/pipes` answers 500.** `PIPES_WEBHOOK_SECRET` is not set on the deployment. A 401 means the secret does not match the App's `whsec_` secret.
- **Connecting a number fails.** `PIPES_API_KEY` or `PIPES_APP_SLUG` is not set, or the key is not the App's `ak_` key.
- **Conversations stay in `skipped`.** `OPENROUTER_API_KEY` is not set, so nothing is analyzed.
- **The chat history never arrives (the number stays on "Waiting for history").** In order of likelihood: the number is not on the WhatsApp Business app (Coexistence), so there is nothing to import; the business chose not to share history on the phone (the number shows "History not shared"); more than 24 hours passed since the number was connected, so WhatsApp no longer offers the import; or the import is not enabled on pipes.bot for your App (the `SMB_SYNC_ENABLED` switch on the pipes.bot side). WhatsApp allows the import once per number, so none of these can be retried for the same number. A webhook that fails also makes the history chunk fail: pipes.bot answers WhatsApp with an error and WhatsApp retries, so check the Convex logs for a 5xx on `/webhooks/pipes`. A chunk over Convex's 20 MiB HTTP action limit fails the same way.
- **The names from the address book do not show up.** **Import contacts** was unchecked when the number was connected, so pipes.bot never sent the contacts. Names appear only for contacts the phone has saved; everyone else keeps the WhatsApp profile name or the number.

`pnpm test` runs the Convex functions against `convex-test`, `pnpm typecheck` checks the app and the functions, and `pnpm build` produces the static bundle. The webhook payloads in `tests/fixtures/` are copies of files in the repo's `fixtures/byon-v2/`, so this folder does not import anything from the repo root.

### Set up pipes.bot

1. Create an App on **API v2** in pipes.bot.
2. Turn on **Forward messages sent from the phone**. Without it no echoes arrive and the app cannot see your team's replies.
3. Set the webhook URL to `https://<deployment>.convex.site/webhooks/pipes`.
4. Copy the `whsec_` secret and the `ak_` key into `PIPES_WEBHOOK_SECRET` and `PIPES_API_KEY`, and the App slug into `PIPES_APP_SLUG`.
5. Sign up in the app, open **Numbers**, and click **Connect a number**.

## Try it without a phone

Sign up in the app once so your workspace exists, then seed the demo number for your account:

```bash
npx convex run demo:seed '{"email":"you@example.com"}'
npx convex run demo:reset '{"email":"you@example.com"}'   # removes the demo number and everything under it
```

These are internal functions, so they run from the CLI only. The seed goes through the same ingestion function as real webhooks and closes the conversations right away. The four scenarios are: a quick answer from the phone, a customer left waiting, a customer who never got a reply, and a reply sent through the API. It also adds 6 imported conversations and address book names (see Chat history and contacts import below). Without `OPENROUTER_API_KEY` the analysis shows as skipped; with a key it runs for the answered ones.

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

`SITE_URL` must be the exact origin of the SPA (scheme, host and port, no trailing path). This app trusts exactly one origin, `SITE_URL`, so preview deployments on other origins cannot sign in. To let preview deployments sign in, add each preview origin exactly to `trustedOrigins` in `convex/auth.ts`; the cross-domain sign-in only hands the session to exact origins, so wildcard patterns are not enough. The signup `redirectUrl` is built from `SITE_URL` and must be HTTPS except on localhost.

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

An hourly cron calls `GET /v1/pool-numbers/{id}/health` for each number and maps the result to healthy, unhealthy or unknown (also used when the call fails). Demo numbers are skipped, and without `PIPES_API_KEY` real numbers show as unknown. The Numbers page shows the badge.

## Chat history and contacts import

When you connect a number that already runs on the WhatsApp Business app (Coexistence), the app can ask pipes.bot for two things: the chat history of the last 6 months, and the phone's address book. The app still only observes.

The public pipes.bot docs page on coexistence (`byon/coexistence`) still says pipes.bot does not import past conversations. That is out of date. For the events used here, read the "Chat history and contacts (Coexistence)" section of the BYON v2 migration guide, and expect the page to be updated.

### The flow

1. On **Numbers**, **Connect a number** opens a panel with two checkboxes, both checked: **Import chat history (up to 6 months)** and **Import contacts**. `createSignupLink` sends them as `importHistory` and `importContacts` in `POST /v1/apps/token`. They override the App's own switch, in both directions.
2. `number.onboarded` carries `data.importHistory` and `data.importContacts`. The number gets `historyImport` (`requested`, `importing`, `done`, `declined`) and `contactsImport` (`requested`, `received`). A repeated `number.onboarded` never moves a state backwards.
3. The phone asks the business whether to share the history. Only the phone decides. A refusal arrives as one event with error code `2593109` and the state becomes `declined`.
4. History chunks arrive as `history` events, out of order, with up to thousands of messages each. `POST /webhooks/pipes` stores the raw body in Convex file storage and does not send it through `ingest`. `history.receive` deduplicates it, parks it if the number is unknown yet, and updates the progress. `history.processChunk` (an action) reads the blob and `history.stage` writes the messages to `historyMessages` in batches of 500.
5. Each `stage` call schedules `history.build` 10 minutes later and cancels the previous one, so the build waits until the chunks stop arriving. The build handles one contact per run: it splits the messages into conversations with the workspace inactivity window, and creates closed conversations marked `imported`, with metrics and no AI analysis. If the newest segment touches an open live conversation, its messages are folded into that conversation. A late chunk rebuilds the affected contacts, so the result does not depend on the order of the chunks. A progress-only chunk (no messages) finishes the import.
6. `smb_app_state_sync` events carry the phone's address book, first the full list and then every edit. `contactsSync.ts` stores the name in `contacts.bookName` (`add`) or clears it (`remove`). The name shown everywhere is the address book name, then the WhatsApp profile name, then the number.
7. The conversations count in the overview by their real dates and show an **Imported** badge. The AI analysis runs only when you ask: **Analyze** on a conversation, or **Analyze imported conversations (N)** on the number page, which requests up to 100 per click, 3 seconds apart, and confirms first because it uses your OpenRouter key.

The **Import** card on the number page and the **Import** column on **Numbers** show where the import is: "Waiting for history", "Importing history 40%", "Building history", "History imported", "History not shared" and "Contacts imported". The demo seed includes 6 imported conversations and address book names, so you can see all of it without a phone.

### Files

| File | What it does |
| --- | --- |
| `convex/lib/history.ts` | Pure functions: `summarizeHistory`, `flattenHistory`, `segmentMessages` |
| `convex/history.ts` | `receive`, `processChunk`, `stage`, `build` and `buildContact`, `analyzeImported`, `importStatus` |
| `convex/contactsSync.ts` | Applies `smb_app_state_sync` (`add` and `remove`) to `contacts.bookName` |
| `convex/contactLookup.ts` | Finds or creates a contact by phone or BSUID, shared by ingestion, the history stage and the contacts sync |
| `src/components/ImportCard.tsx` | The **Import** card and the bulk analyze button |
| `src/components/ImportBadges.tsx` | The status badges and the **Imported** badge |

### Limitations

- WhatsApp offers the import once per number, in the 24 hours after connecting. It cannot be requested for a number that is already connected, and the business can refuse on the phone.
- Only Coexistence numbers (the WhatsApp Business app) have anything to import. Legacy Apps ignore the flags.
- Media is not imported. A media message in the history appears as `[media]`. The follow-up event with media from the last 14 days is ignored.
- Delivery and read times are not imported, so imported conversations have response times but no status timing.
- Very large contacts. One contact is built in one Convex transaction, which fits a few thousand messages. A contact with more is not split across transactions.
- A chunk whose processing throws is lost: WhatsApp does not resend an event that was accepted. Check the logs.
- Changing the inactivity window later does not re-segment imported conversations.
- A rebuild caused by a late chunk drops the AI analysis of that contact's imported conversations. In practice the chunk arrives minutes later, before anyone asks for an analysis.
- The overview reads at most 1000 conversations in the window, which can cut a 30-day view for a large number.
- The AI transcript shows only the time (`HH:MM`), so an imported conversation that crosses midnight looks out of order.

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
- Importing history for numbers that are already connected. WhatsApp does not allow it.
- Downloading or showing media from the imported history.
- A Live / Imported filter in the overview.
- Disconnecting numbers.
- Organizations and invitations. There is one workspace per account.
- Showing media. Media messages appear as a type label with the caption.
- BYON legacy, sandbox and WebSocket modes.
- Email verification and OAuth sign-in. To add OAuth providers, add `socialProviders` to the `betterAuth({...})` call in `convex/auth.ts` (see the [Better Auth OAuth docs](https://www.better-auth.com/docs/concepts/oauth)).

Dashboard queries read at most 1000 conversations in the selected window. For larger volumes, keep the counters in [`@convex-dev/aggregate`](https://www.convex.dev/components/aggregate) instead.
