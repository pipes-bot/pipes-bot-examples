# Examples base + starters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pipes.bot examples repo: root tooling (README generator, webhook simulator, mock API, smoke test), fixtures copied from the docs, and four starters that echo WhatsApp text messages in both sandbox and BYON v2 modes.

**Architecture:** Every example folder is standalone. The root `package.json` only holds tooling scripts written in TypeScript and run by Node's native type stripping, tested with `node:test`. The smoke test boots each webhook starter against a local mock of the pipes.bot API and replays signed fixtures. It asserts HTTP status codes and the exact send calls the starter makes.

**Tech Stack:** Node ≥ 22.18 (type stripping), `node:test`, `yaml`; Bun + Hono; Python 3.11+ via uv + FastAPI + httpx; Next.js 16 route handlers; Node + `ws`.

**Spec:** `docs/superpowers/specs/2026-10-30-examples-base-starters-design.md`

## Global Constraints

- English in code, READMEs and log lines.
- No co-author / "Generated with Claude Code" footers in commits or PRs. Commit messages concise.
- Examples are standalone: no root workspace, no imports between example folders, nothing in an example imports from `scripts/` or `fixtures/`.
- Root tooling: Node ≥ 22.18, `.ts` run directly, only dependency `yaml`.
- Env names: `PIPES_API_KEY` (`pk_` → sandbox, `ak_` → BYON v2), `PIPES_WEBHOOK_SECRET`, `PIPES_API_BASE_URL` (default `https://api.pipes.bot`), `PORT` (default `3000`).
- Webhook starters: ~80–120 lines of code each (excluding README/config).
- Reply text is exactly `Echo: <text>`.
- Log lines: `received <kind> <id>`, `replied <id>`, `skipped <reason> <id>`, `duplicate <id>`.
- Dedup set bounded to 1000 entries, with a comment saying production should use the database.
- Frontmatter required fields: `title`, `description`, `type` (`starter` | `app`), `stack`, `features`. Known features: `webhooks`, `websocket`, `sandbox`, `byon-v2`, `coexistence`, `echoes`, `embedded-signup`, `templates`, `media`, `mcp`. Unknown feature = warning.
- Example README sections, in order: What it shows · pipes.bot features used · Run locally · Deploy · How it works · Going to production (starters only).
- Standard Webhooks timestamp tolerance: 5 minutes.

## Review Focus

1. **Secret rotation:** `webhook-signature` holds two space-separated `v1,` signatures, one stale. Expect 200 and a reply. Pinned in Task 5 (`multi-signature` case).
2. **Missing signature header** (BYON) or a non-JSON body with a valid signature. Expect 401 / 400, never a 500 or a crash. Pinned in Task 5 (`no-signature`, `non-json` cases).
3. **Non-ASCII text** (`Olá 👋 ação`). The signature must verify over raw bytes, and the echo must preserve the text exactly. Pinned in Task 5 (`unicode` case).
4. **pipes.bot API returns 500 on a send.** The starter must log it, stay up, and reply to the next message. Pinned in Task 5 (`send-failure` case).
5. **Several messages in one v2 envelope** (`whatsapp.messages` with 2 text items). Expect one reply per message. Pinned in Task 5 (`multi-message` case).

---

## File Structure

```
package.json, .nvmrc, .gitignore, LICENSE, README.md
fixtures/README.md
fixtures/byon-v2/*.json        # 11 copied + smb-message-echo, number-onboarded, test-webhook
fixtures/sandbox/*.json        # message-text, message-image, test-connection
scripts/lib/sign.ts            # signature helpers (sandbox hex HMAC, Standard Webhooks)
scripts/lib/fixtures.ts        # load a fixture + its mode
scripts/simulate-webhook.ts    # simulate(): sign + POST a fixture; CLI
scripts/mock-pipes-api.ts      # startMockApi(): fake send endpoints; CLI
scripts/generate-readme.ts     # frontmatter → README table; CLI (--check)
scripts/smoke.ts               # STARTERS, CASES, runSmoke(); CLI
scripts/sync-fixtures.ts       # re-download docs-hosted fixtures
scripts/**/*.test.ts           # node:test
with-hono-bun/      index.ts, package.json, tsconfig.json, .env.example, README.md
with-fastapi/       main.py, pyproject.toml, .env.example, README.md
with-nextjs-route-handler/  app/api/webhook/route.ts, app/page.tsx, app/layout.tsx, package.json, tsconfig.json, next.config.ts, .env.example, README.md
with-websocket-node/  bot.ts (pure frame logic), index.ts (connection), bot.test.ts, package.json, tsconfig.json, .env.example, README.md
.github/workflows/ci.yml
```

Shared types (defined in Task 2, used everywhere in `scripts/`):

```ts
export type Mode = "sandbox" | "byon";
```

---

### Task 1: Repo scaffold + fixtures

**Files:**
- Create: `package.json`, `.nvmrc`, `.gitignore`, `LICENSE`, `fixtures/README.md`, `fixtures/byon-v2/*.json`, `fixtures/sandbox/*.json`, `scripts/sync-fixtures.ts`, `scripts/lib/fixtures.ts`
- Test: `scripts/lib/fixtures.test.ts`

**Interfaces:**
- Produces: `loadFixture(name: string): Fixture` with `type Fixture = { name: string; mode: Mode; body: any }`. `name` is `"byon-v2/message-text"` or `"sandbox/message-text"`. Mode `"byon"` for the `byon-v2/` folder, `"sandbox"` for `sandbox/`. Throws `Error("Unknown fixture: <name>")`. Also `listFixtures(): string[]` (all names, sorted).
- Produces: `package.json` scripts: `test` = `node --test "scripts/**/*.test.ts"`, `readme`, `readme:check`, `simulate`, `mock-api`, `smoke`, `fixtures:sync` (point at the scripts named in File Structure; `readme:check` = `node scripts/generate-readme.ts --check`).

- [ ] **Step 1: Root files.**
  - `package.json`: `"private": true`, `"type": "module"`, `"engines": { "node": ">=22.18" }`, devDependency `yaml`, plus the scripts above.
  - `.nvmrc`: `22`.
  - `.gitignore`: `node_modules`, `.env`, `.env.local`, `.venv`, `__pycache__`, `.next`, `next-env.d.ts`, `*.tsbuildinfo`.
  - `LICENSE`: MIT, "Copyright (c) 2026 pipes.bot".
  - Run `pnpm install`.
- [ ] **Step 2: Copy the 11 docs-hosted fixtures.** Source: `../pipes-bot-docs/public/fixtures/byon-v2/`. These are identical to `https://docs.pipes.bot/fixtures/byon-v2/<name>.json`.
- [ ] **Step 3: Build the doc-example fixtures.**
  - `byon-v2/smb-message-echo.json`: verbatim from the JSON block under "Message echoes" in `../pipes-bot-docs/content/docs/byon/coexistence.mdx`.
  - `byon-v2/number-onboarded.json`: verbatim from `byon/webhook-delivery.mdx`.
  - `byon-v2/test-webhook.json`: the "Test Webhook" body from `webhooks/payload.mdx`.
  - `sandbox/test-connection.json`: `{"test": true, "source": "pipes.bot"}`.
  - `sandbox/message-text.json`: the full legacy payload example from `webhooks/payload.mdx` (conversationId `conv_xyz789`, message id `msg_abc123`, from `15559876543`, text `Hello from WhatsApp!`).
  - `sandbox/message-image.json`: same envelope with message id `msg_img456`, `type: "image"`, `image: { id: "media_id", mime_type: "image/jpeg", caption: "Check this out" }` and the `pipes.media` object from the Image section.
- [ ] **Step 4: `fixtures/README.md`.** A table with File · Source · Kind (`docs file` with its URL, or `docs example` with the `.mdx` page). Add a note that `pnpm fixtures:sync` refreshes only `docs file` rows.
- [ ] **Step 5: Write the failing test** `scripts/lib/fixtures.test.ts`:
  - `loadFixture("byon-v2/message-text")` → `mode === "byon"`, `body.id === "evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0"`.
  - `loadFixture("sandbox/message-text")` → `mode === "sandbox"`, `body.pipes.conversationId === "conv_xyz789"`.
  - `loadFixture("nope")` throws `/Unknown fixture: nope/`.
  - `listFixtures()` has length 17 and every listed fixture parses as JSON.
- [ ] **Step 6: Run** `pnpm test`. Expected: FAIL, module not found.
- [ ] **Step 7: Implement `scripts/lib/fixtures.ts`.** Resolve paths from `import.meta.dirname`, using `../../fixtures`.
- [ ] **Step 8: Implement `scripts/sync-fixtures.ts`.** It holds a hard-coded list of the 11 docs-file names, fetches each from `https://docs.pipes.bot/fixtures/byon-v2/<name>.json`, writes it pretty-printed with 2 spaces and a trailing newline, and prints `updated <name>` or `unchanged <name>`. It exits 1 on any HTTP error.
- [ ] **Step 9: Run** `pnpm test` (Expected: PASS), then `pnpm fixtures:sync` (Expected: `unchanged` ×11. If any line says `updated`, the copy diverged from the published file: keep the published version).
- [ ] **Step 10: Commit** `Add repo scaffold and webhook fixtures`.

### Task 2: Signing helpers + webhook simulator

**Files:**
- Create: `scripts/lib/sign.ts`, `scripts/simulate-webhook.ts`
- Test: `scripts/lib/sign.test.ts`, `scripts/simulate-webhook.test.ts`

**Interfaces:**
- Consumes: `loadFixture` (Task 1).
- Produces (`scripts/lib/sign.ts`): `export type Mode`; `signSandbox(body: string, secret: string): string` (lowercase hex HMAC-SHA256, UTF-8 secret as key); `signStandardWebhook(id: string, timestamp: number, body: string, secret: string): string` (returns `"v1,<base64>"`, key = base64-decode of the secret without `whsec_`).
- Produces (`scripts/simulate-webhook.ts`): `simulate(opts: SimulateOptions): Promise<SimulateResult[]>` (one result per attempt):

```ts
export type SimulateOptions = {
  fixture: string;          // e.g. "byon-v2/message-text"
  url: string;
  secret: string;
  times?: number;           // default 1; same id and body on every attempt
  idSuffix?: string;        // appended to envelope id (byon) or messages[0].id (sandbox) before signing
  text?: string;            // replaces the first text message body
  badSignature?: boolean;   // sign with "wrong-secret" (sandbox) / a different whsec_ key (byon)
  noSignature?: boolean;    // omit signature headers
  extraSignature?: boolean; // byon: "v1,<bogus> v1,<valid>"
  timestampOffset?: number; // seconds added to now for webhook-timestamp (byon)
  rawBody?: string;         // send this body verbatim instead of the fixture (webhook-id falls back to evt_fixture_<name>)
  transform?: (body: any) => any; // programmatic only: applied after idSuffix/text, before signing
};
export type SimulateResult = { status: number; body: string };
```

  - Headers. Sandbox: `X-Pipes-Signature`. BYON: `webhook-id` (= `body.id` after the suffix is applied, else `evt_fixture_<name with - → _>`), `webhook-timestamp`, `webhook-signature`. Always `Content-Type: application/json`.
  - For `--times`, the timestamp is refreshed on every attempt, as pipes.bot does on retries.
  - `--text` and `--idSuffix` also apply to every message in `whatsapp.messages` / sandbox `messages`. The CLI mirrors the options as flags (`--url`, `--secret`, `--times`, `--text`, `--bad-signature`, `--no-signature`, `--extra-signature`, `--timestamp-offset`). Defaults: url `http://localhost:3000/webhook`, secret from `PIPES_WEBHOOK_SECRET`. It prints `<status> <body>` per attempt.

- [ ] **Step 1: Write the failing test** `scripts/lib/sign.test.ts`:
  - The Standard Webhooks reference vector: `signStandardWebhook("msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}', "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw") === "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="`.
  - `signSandbox("hello", "secret") === "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b"`.
- [ ] **Step 2: Write the failing test** `scripts/simulate-webhook.test.ts`. It starts a `node:http` server that records the headers and raw body, then:
  - BYON `message-text`: `webhook-id === "evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0"`, and `webhook-signature` equals `signStandardWebhook(id, Number(ts), receivedBody, secret)`.
  - `idSuffix: "_x"` → `webhook-id` ends with `_x`, and the received body's `id` matches.
  - `extraSignature` → the header has 2 space-separated `v1,` entries, and the second one is valid.
  - Sandbox `message-text` with `text: "Olá 👋"` → the body's first message text is `Olá 👋`, and `x-pipes-signature === signSandbox(receivedBody, secret)`.
  - `times: 2` → 2 requests with the same `webhook-id`.
  - `byon-v2/number-onboarded` → `webhook-id === "evt_fixture_number_onboarded"`.
- [ ] **Step 3: Run** `pnpm test`. Expected: FAIL, modules missing.
- [ ] **Step 4: Implement `sign.ts` and `simulate-webhook.ts`.** Guard the CLI with `if (process.argv[1] === import.meta.filename)`.
- [ ] **Step 5: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 6: Commit** `Add webhook simulator with sandbox and Standard Webhooks signing`.

### Task 3: Mock pipes.bot API

**Files:**
- Create: `scripts/mock-pipes-api.ts`
- Test: `scripts/mock-pipes-api.test.ts`

**Interfaces:**
- Produces:

```ts
export type MockCall = { path: string; authorization: string | null; body: any };
export type MockApi = {
  url: string;               // e.g. "http://127.0.0.1:4010"
  calls(): MockCall[];
  clear(): void;
  failNext(): void;          // the next send call returns 500 {"error":"mock failure"} and is still recorded
  close(): Promise<void>;
};
export function startMockApi(port?: number): Promise<MockApi>; // port 0 = random
```

  - `POST /v1/messages/send` → `200 { success: true, messageId: "wamid.mock_<n>", conversationId: body.conversationId }`.
  - `POST /v1/messages/app/send` → `200 { messageId: "wamid.mock_<n>", contacts: [{ input: body.to, wa_id: body.to }] }`.
  - Any other path → 404.
  - Control endpoints for CLI use: `GET /__calls` (JSON array), `DELETE /__calls`, `POST /__fail-next`.
  - The CLI (`pnpm mock-api [--port 4010]`) logs each call as `<path> <json body>`.

- [ ] **Step 1: Write the failing test.** Start on port 0, POST to both send paths with `Authorization: Bearer pk_x`, and assert the response shapes above and that `calls()` has 2 entries with path, authorization and body. Call `failNext()`; the next send returns 500 and the one after returns 200. `clear()` empties `calls()`. An unknown path returns 404.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:http`.
- [ ] **Step 4: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Add mock pipes.bot API for local testing`.

### Task 4: README generator + root README

**Files:**
- Create: `scripts/generate-readme.ts`, `README.md`
- Test: `scripts/generate-readme.test.ts`

**Interfaces:**
- Produces:

```ts
export type ExampleMeta = { title: string; description: string; type: "starter" | "app"; stack: string[]; features: string[] };
export type ExampleEntry = ExampleMeta & { dir: string };
export function parseFrontmatter(markdown: string, source: string): ExampleMeta | null; // null when no leading '---'
export function renderExamples(examples: ExampleEntry[]): string;
export function replaceBlock(readme: string, block: string): string;
```

  - `parseFrontmatter` throws `Error("<source>: missing required field \"<field>\"")` and `Error("<source>: invalid type \"<value>\"")`. It prints `warning: <source>: unknown feature "<f>"` to stderr.
  - `renderExamples` emits a `### Starters` section, then `### Apps`, omitting empty groups. Each section is a table with header `| Example | Stack | pipes.bot features | Description |`. Rows are sorted by `dir`, in the form `| [<dir>](./<dir>) | <stack joined ", "> | <features joined ", "> | <description> |`. The title is not shown in the table.
  - `replaceBlock` replaces everything between `<!-- examples:start -->` and `<!-- examples:end -->`, keeping the markers on their own lines. It throws if a marker is missing.
  - The CLI scans the top-level directories (skipping dot dirs, `node_modules`, `scripts`, `fixtures`, `docs`), reads `<dir>/README.md` and keeps entries with frontmatter. With `--check` it exits 1 and prints `README.md is out of date. Run pnpm readme.` if the result differs. Otherwise it writes the file.

- [ ] **Step 1: Write the failing tests.**
  - Valid frontmatter parses into arrays.
  - A missing `stack` throws the exact message.
  - `type: demo` throws.
  - No frontmatter → `null`.
  - `renderExamples` with one starter and no apps → contains `### Starters`, does not contain `### Apps`, and the row is exactly `| [with-x](./with-x) | hono, bun | webhooks, sandbox | Desc |`.
  - `replaceBlock` keeps the text outside the markers byte-for-byte.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** using `yaml`'s `parse`.
- [ ] **Step 4: Write `README.md`.** Sections:
  1. Title `pipes.bot examples` and a one-paragraph intro with a link to https://docs.pipes.bot.
  2. "Using an example": `npx degit pipes-bot/examples/<folder> my-app`.
  3. "Examples", with the markers and an empty block between them.
  4. "Testing without a phone": `pnpm mock-api`, then the starter with `PIPES_API_BASE_URL=http://localhost:4010`, then `pnpm simulate byon-v2/message-text --secret ...`.
  5. "Adding an example": required frontmatter fields, required README sections, `pnpm readme`.
- [ ] **Step 5: Run** `pnpm test` (Expected: PASS) and `pnpm readme:check` (Expected: exit 0, since there are no examples yet and the block is empty).
- [ ] **Step 6: Commit** `Add README generator and root README`.

### Task 5: Smoke test runner

**Files:**
- Create: `scripts/smoke.ts`

**Interfaces:**
- Consumes: `simulate` (Task 2), `startMockApi` (Task 3).
- Produces: `runSmoke(names?: string[]): Promise<boolean>`. The CLI is `pnpm smoke [starter...]` and exits 1 on any failure.

```ts
type StarterConfig = { name: string; cwd: string; command: string[]; path: string; port: number };
type SmokeCase = {
  name: string; mode: Mode; fixture: string;
  options?: Partial<SimulateOptions>;     // url/secret/idSuffix filled by the runner
  status: number[];                       // one per attempt
  sends: Array<{ path: string; body: Record<string, unknown> }>; // expected calls, partial deep match, in order
};
```

  - `STARTERS`:
    - `with-hono-bun`: `["bun", "run", "index.ts"]`, path `/webhook`, port 3101.
    - `with-fastapi`: `["uv", "run", "main.py"]`, path `/webhook`, port 3102.
    - `with-nextjs-route-handler`: `["pnpm", "exec", "next", "dev", "--port", "3103"]`, path `/api/webhook`, port 3103.
  - Fake credentials:
    - sandbox: key `pk_smoke_test_key`, secret `smoke-secret-0123456789`.
    - byon: key `ak_smoke_test_key`, secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`.
  - Per starter, per mode:
    1. Start the mock (port 0).
    2. Spawn the starter with env `PIPES_API_KEY`, `PIPES_WEBHOOK_SECRET`, `PIPES_API_BASE_URL=<mock url>`, `PORT`.
    3. Wait until a `POST <path>` with an empty body returns any HTTP status (poll every 250 ms, timeout 60 s, since Next dev is slow).
    4. For each case of that mode: `clear()`, call `simulate` with `idSuffix: "_<case index>"`, wait 1000 ms, then compare.
    5. Kill the process group and close the mock.
  - Print `PASS|FAIL <starter> <mode> <case>`, with a diff on failure. If the starter process exits early, report its stderr.
  - `CASES`. `text` is the fixture's body (`Does it come in another color?` for v2, `Hello from WhatsApp!` for sandbox). `S` = sandbox send path `/v1/messages/send`, `A` = `/v1/messages/app/send`.

| name | mode | fixture | options | status | sends |
| --- | --- | --- | --- | --- | --- |
| text | sandbox | sandbox/message-text | | [200] | S `{conversationId:"conv_xyz789", text:"Echo: Hello from WhatsApp!"}` |
| image | sandbox | sandbox/message-image | | [200] | none |
| test-connection | sandbox | sandbox/test-connection | | [200] | none |
| bad-signature | sandbox | sandbox/message-text | badSignature | [401] | none |
| duplicate | sandbox | sandbox/message-text | times 2 | [200,200] | 1× S |
| unicode | sandbox | sandbox/message-text | text `Olá 👋 ação` | [200] | S `{text:"Echo: Olá 👋 ação"}` |
| text | byon | byon-v2/message-text | | [200] | A `{poolNumberId:"pn_abc123", to:"16505551234", text:"Echo: Does it come in another color?"}` |
| username-with-phone | byon | byon-v2/message-text-username-with-phone | | [200] | A `{to:"16505551234"}` |
| bsuid-only | byon | byon-v2/message-text-bsuid-only | | [200] | A `{to:"US.13491208655302741918"}` |
| parent-bsuid | byon | byon-v2/message-text-parent-bsuid | | [200] | A `{to:"US.13491208655302741918"}` |
| ignored-* (one case each) | byon | message-image, message-contact-request, smb-message-echo, status-delivered-bsuid, status-failed, system-user-changed-number, system-user-changed-user-id, template-status-update, number-onboarded, test-webhook | | [200] | none |
| bad-signature | byon | byon-v2/message-text | badSignature | [401] | none |
| stale-timestamp | byon | byon-v2/message-text | timestampOffset -600 | [401] | none |
| no-signature | byon | byon-v2/message-text | noSignature | [401] | none |
| non-json | byon | byon-v2/message-text | rawBody `not json` | [400] | none |
| duplicate | byon | byon-v2/message-text | times 2 | [200,200] | 1× A |
| multi-signature | byon | byon-v2/message-text | extraSignature | [200] | 1× A |
| unicode | byon | byon-v2/message-text | text `Olá 👋 ação` | [200] | A `{text:"Echo: Olá 👋 ação"}` |
| multi-message | byon | byon-v2/message-text | `transform` appends a copy of `whatsapp.messages[0]` with `id` suffixed `_2` and text `Second` | [200] | 2× A: `Echo: Does it come in another color?`, `Echo: Second` |
| send-failure | byon | byon-v2/message-text, then byon-v2/message-text-bsuid-only | `failNext()` before the first | [200], [200] | first send recorded and fails; second A `{to:"US.13491208655302741918"}` succeeds |

  The `send-failure` case is the only one with two simulate calls. Model it as a `steps` array if that keeps `SmokeCase` simpler, or special-case it. Either way, it must assert that the starter answered the second request.

- [ ] **Step 1: Implement `scripts/smoke.ts`** with the configs and the cases table above. Spawn with `detached: true` and kill with `process.kill(-pid)`.
- [ ] **Step 2: Run** `pnpm smoke with-hono-bun`. Expected: FAIL, reporting that the starter failed to start (the folder does not exist yet). This confirms the runner reports a missing or crashed starter instead of hanging.
- [ ] **Step 3: Commit** `Add smoke test runner for webhook starters`.

### Task 6: `with-hono-bun`

**Files:**
- Create: `with-hono-bun/index.ts`, `package.json` (deps `hono`; devDeps `@types/bun`, `typescript`; scripts `start: bun run index.ts`, `typecheck: tsc --noEmit`), `tsconfig.json`, `.env.example`, `README.md`

**Interfaces:**
- Implements the spec's "Contrato comum (webhook starters)" steps 1–9. `POST /webhook` on `PORT`.

- [ ] **Step 1: Run** `pnpm smoke with-hono-bun`. Expected: FAIL (starter missing).
- [ ] **Step 2: Implement `index.ts`.** Notes:
  - Raw body via `c.req.text()`; signatures with `node:crypto` (`createHmac`, `timingSafeEqual`, comparing equal-length buffers only).
  - Mode from the key prefix at startup. Invalid or missing key → `console.error` + `process.exit(1)`. BYON without a secret → exit 1. Sandbox without a secret → warning.
  - Send after the 200 with an un-awaited promise plus `.catch(log)`.
  - Dedup: `Set` with oldest-eviction at 1000 entries.
  - `export default { port, fetch: app.fetch }`.
- [ ] **Step 3: `.env.example`** with the 4 env vars and comments. **README.md** with frontmatter: `title: Hono + Bun webhook`, `type: starter`, `stack: [hono, bun, typescript]`, `features: [webhooks, sandbox, byon-v2]`, the required sections, and a cloudflared/ngrok tunnel tip under "Run locally".
- [ ] **Step 4: Run** `bun install && pnpm smoke with-hono-bun` (Expected: all PASS), `bunx tsc --noEmit` in the folder (Expected: no errors), and `wc -l index.ts` (Expected: ≤ ~120).
- [ ] **Step 5: Run** `pnpm readme && pnpm readme:check`. Expected: the table shows the starter, and the check exits 0.
- [ ] **Step 6: Commit** `Add Hono + Bun webhook starter`.

### Task 7: `with-fastapi`

**Files:**
- Create: `with-fastapi/main.py`, `pyproject.toml` (`requires-python = ">=3.11"`, deps `fastapi`, `uvicorn`, `httpx`), `.env.example`, `README.md`

**Interfaces:**
- Same contract as Task 6. `POST /webhook`. `main.py` ends with `uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "3000")))` under `if __name__ == "__main__":`.

- [ ] **Step 1: Run** `pnpm smoke with-fastapi`. Expected: FAIL.
- [ ] **Step 2: Implement `main.py`.** Notes:
  - `await request.body()` (bytes) for verification; `hmac.compare_digest`; `base64.b64decode` of the secret after `whsec_`.
  - Send in `BackgroundTasks` with `httpx.AsyncClient`. Log failures and never raise into the request.
  - Reject bad JSON with 400 via `json.loads` inside `try`.
  - Dedup with `collections.OrderedDict` capped at 1000.
- [ ] **Step 3: `.env.example`, README** (`stack: [fastapi, python]`, same features).
- [ ] **Step 4: Run** `uv sync && pnpm smoke with-fastapi`. Expected: all PASS.
- [ ] **Step 5: Run** `pnpm readme && pnpm readme:check`. Expected: exit 0.
- [ ] **Step 6: Commit** `Add FastAPI webhook starter`.

### Task 8: `with-nextjs-route-handler`

**Files:**
- Create: `with-nextjs-route-handler/app/api/webhook/route.ts`, `app/layout.tsx`, `app/page.tsx` (one line pointing to `/api/webhook` and the README), `package.json` (`next@16`, `react`, `react-dom`, `typescript`, `@types/*`; scripts `dev`, `build`, `start`, `typecheck`), `tsconfig.json`, `next.config.ts`, `.env.example`, `README.md`

**Interfaces:**
- Same contract as Task 6. `export async function POST(req: Request)` with `export const runtime = "nodejs"`. Raw body via `await req.text()`. Send inside `after()` from `next/server`.
- Key validation can't exit the process in Next. Validate at module load and make `POST` return 500 with a clear log line if `PIPES_API_KEY` or the required secret is invalid. Document this difference in "How it works".

- [ ] **Step 1: Run** `pnpm smoke with-nextjs-route-handler`. Expected: FAIL.
- [ ] **Step 2: Implement the route and the minimal app shell.**
- [ ] **Step 3: `.env.example`, README.** Use `stack: [nextjs, typescript, vercel]`, same features. Under "Deploy", add a Vercel deploy button with `repository-url=https://github.com/pipes-bot/examples/tree/main/with-nextjs-route-handler` and `env=PIPES_API_KEY,PIPES_WEBHOOK_SECRET`. Note that the dedup `Set` is per serverless instance.
- [ ] **Step 4: Run** `pnpm install && pnpm smoke with-nextjs-route-handler` (Expected: all PASS) and `pnpm typecheck && pnpm build` in the folder (Expected: success).
- [ ] **Step 5: Run** `pnpm readme && pnpm readme:check`. Expected: exit 0.
- [ ] **Step 6: Commit** `Add Next.js route handler webhook starter`.

### Task 9: `with-websocket-node`

**Files:**
- Create: `with-websocket-node/bot.ts`, `index.ts`, `bot.test.ts`, `package.json` (dep `ws`; devDeps `@types/ws`, `@types/node`, `typescript`; scripts `start: node index.ts`, `test: node --test bot.test.ts`, `typecheck: tsc --noEmit`; `engines.node >= 22.18`), `tsconfig.json` (`allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`), `.env.example` (no webhook secret), `README.md`

**Interfaces:**
- Produces (`bot.ts`, pure, no I/O):

```ts
export type Mode = "sandbox" | "byon";
export function modeFromKey(key: string | undefined): Mode;            // throws Error("PIPES_API_KEY must start with pk_ or ak_")
export function createDedup(limit?: number): (id: string) => boolean;  // true = first time seen; default limit 1000
export function repliesFor(frame: any, mode: Mode, isNew: (id: string) => boolean): object[]; // frames to send
```

  - Sandbox: `type === "whatsapp_message"` with `data.type === "text"` → `{ type: "whatsapp_reply", data: { conversationId, toNumber: data.fromNumber, text: "Echo: " + data.text } }`. Dedup key `data.messageId`.
  - BYON: `type === "event"`, `data.field === "messages"`, one frame per text message: `{ type: "send", requestId: message.id, poolNumberId: data.pipes.poolNumberId, message: { messaging_product: "whatsapp", ...(from ? { to: from } : { recipient: from_user_id }), type: "text", text: { body: "Echo: " + body } } }`. Dedup key `data.id`.
  - Anything else → `[]`.
- `index.ts`: connects to `wss://api.pipes.bot/ws?apiKey=<key>` (the base is derived from `PIPES_API_BASE_URL`, with `https` → `wss`), pings every 25 s, and reconnects with backoff 1 s doubling to a 30 s cap, reset on `connected`. It logs `send_result` frames and errors, and uses the same log line formats.

- [ ] **Step 1: Write the failing test** `bot.test.ts`. It uses frames built inline from the shapes in the spec/docs, with the v2 `data` taken from `byon-v2/message-text` copied inline. The test must not import `../fixtures`.
  - Sandbox text → exactly one `whatsapp_reply` with `toNumber` and `text: "Echo: Hello"`.
  - BYON text with `from` → `message.to === "16505551234"`.
  - BYON text without `from` → `message.recipient === "US.13491208655302741918"` and no `to`.
  - BYON `field: "smb_message_echoes"` → `[]`.
  - BYON statuses-only → `[]`.
  - The same event twice → the second call returns `[]`.
  - `modeFromKey("xk_1")` throws.
  - `createDedup(2)` evicts the oldest entry.
- [ ] **Step 2: Run** `pnpm install && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement `bot.ts`, then `index.ts`.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS, no errors.
- [ ] **Step 5: README** (`stack: [nodejs, typescript, ws]`, `features: [websocket, sandbox, byon-v2]`). Then run `pnpm readme && pnpm readme:check` from the root. Expected: exit 0.
- [ ] **Step 6: Manual check (recorded in the PR):** with a real `pk_` key and an activated sandbox number, `pnpm start`, send "hi" from a phone, and receive `Echo: hi`. If no real key is available, say so in the PR. Do not claim it was verified.
- [ ] **Step 7: Commit** `Add WebSocket starter for Node`.

### Task 10: CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts (Tasks 1–5) and the per-starter install/typecheck commands (Tasks 6–9).

- [ ] **Step 1: Write the workflow.** Triggers: `push` to `main` and `pull_request`. Jobs, each starting with `actions/checkout@v4` + `pnpm/action-setup@v4` + `actions/setup-node@v4` (`node-version-file: .nvmrc`) + `pnpm install` at the root:
  - `tooling`: `pnpm test` and `pnpm readme:check`.
  - `smoke`: `oven-sh/setup-bun@v2` and `astral-sh/setup-uv@v6`. Then `bun install` in `with-hono-bun`, `uv sync` in `with-fastapi`, `pnpm install` in `with-nextjs-route-handler`. Then `pnpm smoke`.
  - `typecheck`: install deps, then `typecheck` in `with-hono-bun`, `with-nextjs-route-handler` and `with-websocket-node`, plus `pnpm test` in `with-websocket-node`.
- [ ] **Step 2: Verify locally** by running each job's commands in order from a clean state (`git clean -xdn` to preview, then remove `node_modules`/`.venv`). Expected: all exit 0. If `act` is installed, `act pull_request` is optional.
- [ ] **Step 3: Final checks:** `pnpm test`, `pnpm readme:check` and `pnpm smoke` all pass. Run `git log --format=%B | grep -i -E "co-authored|generated with"`. Expected: no output.
- [ ] **Step 4: Commit** `Add CI for tooling, smoke tests and typechecks`.
