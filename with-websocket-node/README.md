---
title: WebSocket bot for Node
description: Receive and reply to WhatsApp messages over a WebSocket connection, no public URL needed
type: starter
stack: [nodejs, typescript, ws]
features: [websocket, sandbox, byon-v2]
---

# WebSocket bot for Node

## What it shows

A pipes.bot bot that connects out over WebSocket, so it needs no public URL and no tunnel. The pure logic lives in `bot.ts` (about 120 lines) and the connection in `index.ts` (about 90 lines). It ignores everything that is not a text message and replies `Echo: <text>`. It runs in two modes, picked from the prefix of `PIPES_API_KEY`:

- `pk_...`: sandbox, user-scoped connection, `whatsapp_message` frames answered with `whatsapp_reply`.
- `ak_...`: BYON API v2, App-scoped connection, `event` frames answered with `send`.

## pipes.bot features used

- WebSocket connection: `wss://api.pipes.bot/ws?apiKey=<key>`
- Sandbox: `whatsapp_message` in, `whatsapp_reply` out, `reply_status` back
- BYON v2: `event` in, `send` out, `send_result` back

## Run locally

Requires Node.js 22.18 or later (it runs `.ts` files directly) and [pnpm](https://pnpm.io).

```bash
pnpm install
cp .env.example .env   # set PIPES_API_KEY
pnpm start
```

`index.ts` loads `.env` on startup. There is no server to expose: send a message to your sandbox number (or your BYON number) and the bot answers over the same connection. `pnpm test` runs the unit tests for `bot.ts`.

| Variable | Description |
| --- | --- |
| `PIPES_API_KEY` | `pk_...` (sandbox) or `ak_...` (BYON v2). Selects the mode. Required. |
| `PIPES_API_BASE_URL` | Optional. Defaults to `https://api.pipes.bot`. `https` becomes `wss` (and `http` becomes `ws`). |

This starter does not use `PIPES_WEBHOOK_SECRET` or `PORT`: nothing calls the bot, it calls pipes.bot.

## Deploy

Any host that keeps a long-lived Node process running works (a VPS, Railway, Fly.io, Render as a background worker). Set `PIPES_API_KEY`, run `pnpm start` and keep one instance up. Serverless platforms are a poor fit, because they cannot hold the connection open. No public URL or webhook registration is needed.

## How it works

1. `PIPES_API_KEY` picks the mode at startup. A missing or unknown key exits with `PIPES_API_KEY must start with pk_ or ak_`.
2. `index.ts` connects to `wss://api.pipes.bot/ws?apiKey=<key>` and waits for the `connected` frame.
3. Every frame goes through `repliesFor(frame, mode, isNew)` in `bot.ts`, which returns the frames to send back. Frames that are not JSON, or not a JSON object, are ignored.
4. Sandbox: a `whatsapp_message` frame with `data.type === "text"` becomes `{ type: "whatsapp_reply", data: { conversationId, toNumber, text } }`. Duplicates are dropped by `data.messageId`.
5. BYON v2: an `event` frame carries the same envelope as the webhook. Only `field: "messages"` is answered. Each text message becomes `{ type: "send", requestId, poolNumberId, message }`, where `message` is a Meta `/messages` body. The recipient is `to: message.from`, or `recipient: message.from_user_id` for users who hide their phone number. Duplicates are dropped by the event `data.id`. Statuses, echoes and system events are skipped, so the bot never answers itself.
6. A frame without a string id is skipped and not deduplicated.
7. The server answers each reply with `send_result` (BYON) or `reply_status` (sandbox). Failures are logged and never stop the bot.
8. A ping goes out every 25 seconds, and the connection is dropped and reopened if no pong comes back. When the connection closes, it reconnects with exponential backoff: 1 s, 2 s, 4 s and so on up to 30 s. The counter resets once the server sends `connected`.

Log lines: `received <kind> <id>`, `replied <id>`, `skipped <reason> <id>`, `duplicate <id>`.

## Going to production

- **Sandbox limits.** The sandbox number is shared, there are no templates and you can only reply inside the 24-hour customer window.
- **Move to BYON v2.** Use an `ak_` API key, which opens an App-scoped connection that receives the v2 envelope and replies with `send` frames. This starter already handles both.
- **Persist deduplication.** The in-memory `Set` is capped at 1000 entries and resets on restart. Store processed ids in your database. While the bot is offline, pipes.bot queues events and replays them when you reconnect, so a restart alone should not cause duplicates. Deduplication matters when the App also has a webhook configured (events go to both) or after a crash between handling an event and replying to it.
- **Run one instance.** Every connection with the same key receives every message, so two copies of the bot answer twice.
- **More.** Full apps live in the [examples repo](https://github.com/pipes-bot/pipes-bot-examples). See [docs.pipes.bot](https://docs.pipes.bot) for the WebSocket protocol, sending messages and BYON setup.
