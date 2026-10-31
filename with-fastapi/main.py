import base64, hashlib, hmac, json, os, time
from collections import OrderedDict
from functools import partial

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import PlainTextResponse

log = partial(print, flush=True)
api_key = os.environ.get("PIPES_API_KEY", "")
secret = os.environ.get("PIPES_WEBHOOK_SECRET", "")
base_url = os.environ.get("PIPES_API_BASE_URL", "https://api.pipes.bot").rstrip("/")

# The key prefix decides the mode: pk_ = sandbox, ak_ = BYON API v2.
mode = "sandbox" if api_key.startswith("pk_") else "byon" if api_key.startswith("ak_") else None
if mode is None:
    raise SystemExit("PIPES_API_KEY is missing or invalid: expected a pk_ (sandbox) or ak_ (BYON v2) key")
if mode == "byon" and not secret:
    raise SystemExit("PIPES_WEBHOOK_SECRET (whsec_...) is required with an ak_ key")
if mode == "sandbox" and not secret:
    log("PIPES_WEBHOOK_SECRET is not set: sandbox signatures will NOT be verified")

# BYON v2 signing key: the base64 part of the whsec_ secret (a malformed secret fails here, at startup).
byon_key = base64.b64decode(secret.removeprefix("whsec_")) if mode == "byon" else b""

# In-memory dedup, capped at 1000 entries. In production, keep this in your database.
seen: OrderedDict[str, None] = OrderedDict()


def is_duplicate(key: str) -> bool:
    duplicate = key in seen
    seen[key] = None
    if len(seen) > 1000:
        seen.popitem(last=False)
    return duplicate


def dig(value, *path):  # safe lookup through dicts and lists: None instead of an exception
    for key in path:
        try:
            value = value[key]
        except (KeyError, IndexError, TypeError):
            return None
    return value


# Sandbox: hex HMAC-SHA256 of the raw body, keyed with the raw secret string.
def verify_sandbox(headers, body: bytes) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return not secret or hmac.compare_digest(headers.get("x-pipes-signature", "").encode(), expected.encode())


# BYON v2 (Standard Webhooks): sign `{id}.{timestamp}.{body}`, key = base64-decoded secret.
def verify_byon(headers, body: bytes) -> bool:
    msg_id, ts, signatures = (headers.get(h, "") for h in ("webhook-id", "webhook-timestamp", "webhook-signature"))
    fresh = ts.isascii() and ts.isdigit() and abs(time.time() - int(ts)) <= 300  # integer seconds, 5 minutes
    expected = base64.b64encode(hmac.new(byon_key, f"{msg_id}.{ts}.".encode() + body, hashlib.sha256).digest())
    entries = (entry.partition(",") for entry in signatures.split(" "))  # rotation: any v1 entry may match
    return bool(msg_id) and fresh and any(v == "v1" and hmac.compare_digest(s.encode(), expected) for v, _, s in entries)


# Runs after the 200 has been returned; failures are logged and never raised into the request.
async def send(path: str, payload: dict, msg_id: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.post(base_url + path, json=payload, headers={"Authorization": f"Bearer {api_key}"})
        log(f"replied {msg_id}" if res.is_success else f"send failed {msg_id}: {res.status_code} {res.text}")
    except Exception as err:
        log(f"send failed {msg_id}: {err!r}")


app = FastAPI()


@app.post("/webhook")
async def webhook(request: Request, tasks: BackgroundTasks):
    body = await request.body()  # raw bytes: the signature covers these exact bytes
    if not (verify_sandbox if mode == "sandbox" else verify_byon)(request.headers, body):
        return PlainTextResponse("invalid signature", status_code=401)
    try:
        event = json.loads(body)
    except (ValueError, RecursionError):
        return PlainTextResponse("invalid JSON", status_code=400)
    if not isinstance(event, dict):  # null, a list, a number: rejected before dedup
        return PlainTextResponse("invalid payload", status_code=400)
    if event.get("test") is True or event.get("event") == "test":
        return PlainTextResponse("ok")
    if mode == "sandbox":
        for message in dig(event, "entry", 0, "changes", 0, "value", "messages") or []:
            msg_id, kind = dig(message, "id"), dig(message, "type")
            if not isinstance(msg_id, str):
                log("skipped missing-id -")  # nothing to dedup on, so nothing is answered
            elif is_duplicate(msg_id):
                log(f"duplicate {msg_id}")
            elif kind != "text":
                log(f"skipped {kind} {msg_id}")
            else:
                log(f"received message {msg_id}")
                payload = {"conversationId": dig(event, "pipes", "conversationId")}
                payload["text"] = f"Echo: {dig(message, 'text', 'body') or ''}"
                tasks.add_task(send, "/v1/messages/send", payload, msg_id)
    else:
        webhook_id = request.headers["webhook-id"]
        if is_duplicate(webhook_id):
            log(f"duplicate {webhook_id}")
        elif event.get("field") != "messages":
            log(f"skipped {event.get('field')} {webhook_id}")
        else:
            log(f"received message {webhook_id}")
            for message in dig(event, "whatsapp", "messages") or []:
                msg_id, kind = dig(message, "id"), dig(message, "type")
                if kind != "text":
                    log(f"skipped {kind} {msg_id}")
                    continue
                to = message.get("from") or message.get("from_user_id")  # BSUID users may have no phone
                payload = {"poolNumberId": dig(event, "pipes", "poolNumberId"), "to": to}
                payload["text"] = f"Echo: {dig(message, 'text', 'body') or ''}"
                tasks.add_task(send, "/v1/messages/app/send", payload, msg_id)
    return PlainTextResponse("ok")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    log(f"{mode} webhook listening on :{port}/webhook")
    uvicorn.run(app, host="0.0.0.0", port=port)
