---
title: FastAPI webhook
description: Receive and reply to WhatsApp messages with a single FastAPI file
type: starter
stack: [fastapi, python]
features: [webhooks, sandbox, byon-v2]
---

# FastAPI webhook

## What it shows

A pipes.bot webhook receiver in one file (`main.py`, about 140 lines). It verifies the signature, ignores everything that is not a text message and replies `Echo: <text>`. It runs in two modes, picked from the prefix of `PIPES_API_KEY`:

- `pk_...`: sandbox, legacy payload, `X-Pipes-Signature` header.
- `ak_...`: BYON API v2, Standard Webhooks signature, v2 envelope.

## pipes.bot features used

- Webhooks (sandbox payload and BYON API v2 envelope)
- Sandbox send: `POST /v1/messages/send`
- BYON v2 send: `POST /v1/messages/app/send`

## Run locally

Requires [uv](https://docs.astral.sh/uv/). It uses Python 3.12 (pinned by `.python-version`) and installs the dependencies from `pyproject.toml` for you.

```bash
cp .env.example .env   # set PIPES_API_KEY and PIPES_WEBHOOK_SECRET
uv run --env-file .env main.py
```

The webhook listens on `POST http://localhost:3000/webhook`.

pipes.bot needs a public URL to reach it. Open a tunnel and register `<public-url>/webhook` as the webhook URL:

```bash
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```

No phone or account yet? Use the mock API and webhook simulator from the [root README](https://github.com/pipes-bot/examples#testing-without-a-phone).

| Variable | Description |
| --- | --- |
| `PIPES_API_KEY` | `pk_...` (sandbox) or `ak_...` (BYON v2). Selects the mode. Required. |
| `PIPES_WEBHOOK_SECRET` | Sandbox webhook secret (optional, but verification is skipped without it) or the `whsec_...` secret of your App (required for BYON). |
| `PIPES_API_BASE_URL` | Optional. Defaults to `https://api.pipes.bot`. |
| `PORT` | Optional. Defaults to `3000`. |

## Deploy

Any host that runs Python works (a VPS, Railway, Fly.io, Render). Set the environment variables above, run `uv run main.py` and register `https://<your-host>/webhook` in pipes.bot. The `app` object is a regular ASGI app, so `uvicorn main:app --host 0.0.0.0 --port $PORT` works too.

## How it works

1. `PIPES_API_KEY` picks the mode at startup. A missing or unknown key exits with an error. BYON without `PIPES_WEBHOOK_SECRET` also exits.
2. The handler reads the raw body with `await request.body()` before parsing, because the signature covers the exact bytes.
3. The signature is checked with `hmac` and `hmac.compare_digest`. Sandbox: hex HMAC-SHA256 of the body with the raw secret. BYON v2: HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{body}`, keyed with the base64-decoded `whsec_` secret. Any `v1,` entry in the header may match (secret rotation) and timestamps that are not integer seconds, or are more than 5 minutes off, are rejected. Invalid signature returns 401, invalid JSON returns 400, and a JSON body that is not an object returns 400 `invalid payload`.
4. Test payloads (`{"test": true}` or `{"event": "test"}`) get a 200 and nothing else.
5. Duplicates are dropped using the message id (sandbox) or `webhook-id` (BYON). A sandbox message without an `id` is skipped, since there is nothing to deduplicate on.
6. Only text messages are answered. In v2 the envelope must have `field: "messages"`. Statuses, echoes and system events are skipped, so the bot never answers itself. The recipient is `message.from` when it is a non-empty string, otherwise `message.from_user_id`.
7. The handler returns 200 first. The reply runs in a FastAPI `BackgroundTasks` task with `httpx.AsyncClient`, after the response is sent. Failures are caught and logged, so a failed send never crashes the server or blocks the next message.

Log lines: `received <kind> <id>`, `replied <id>`, `skipped <reason> <id>`, `duplicate <id>`. uvicorn also prints one access log line per request.

## Going to production

- **Sandbox limits.** The sandbox number is shared, there are no templates and you can only reply inside the 24-hour customer window.
- **Move to BYON v2.** Use an `ak_` API key, the `whsec_` signing secret of your App, the v2 envelope and the `app/send` endpoint. This starter already handles both.
- **Persist deduplication.** The in-memory `OrderedDict` is capped at 1000 entries and resets on restart. Store processed ids in your database.
- **More.** Full apps live in the [examples repo](https://github.com/pipes-bot/examples). See [docs.pipes.bot](https://docs.pipes.bot) for webhooks, sending messages and BYON setup.
