# conversation-analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `conversation-analyzer/`, a standalone app that connects BYON v2 numbers per workspace, ingests every pipes.bot webhook (including coexistence echoes), groups messages into conversations that close on inactivity, computes response-time metrics in code and scores each conversation against an editable methodology with an LLM via OpenRouter.

**Architecture:** A Vite + TanStack Router SPA talks to Convex. A Convex `httpAction` verifies Standard Webhooks signatures and calls one transactional `ingest` mutation that dedups, stores the raw event and projects it into numbers, contacts, conversations, messages and orphan statuses (parking events for unknown numbers until `number.onboarded`). The scheduler closes idle conversations, computes metrics and schedules an analysis action that calls OpenRouter through the AI SDK. The UI reads everything through reactive queries.

**Tech Stack:** Node 22, pnpm 11, TypeScript ~7.0.2, Vite 8 + `@vitejs/plugin-react` 6, `@tanstack/react-router` 1.170 + `@tanstack/router-plugin` 1.168, Tailwind v4 + shadcn/ui (radix, nova preset), Convex 1.49, `@convex-dev/better-auth` 0.12.6 + `better-auth` ~1.6.33, `ai` 7 + `@openrouter/ai-sdk-provider` 3.1, zod 4, Vitest 4 + `convex-test` 0.0.66 + `@edge-runtime/vm`.

**Spec:** `docs/superpowers/specs/2026-10-31-conversation-analyzer-design.md`

## Global Constraints

- English in code, UI copy, README and log lines.
- No co-author / "Generated with Claude Code" footers in commits or PRs. Commit messages concise.
- Standalone folder: nothing in `conversation-analyzer/` imports from the repo root (`scripts/`, `fixtures/`). Fixtures it needs are copied into `conversation-analyzer/tests/fixtures/`.
- Pin versions: `vitest@^4` (vitest 5 conflicts with better-auth's peer range), `better-auth@~1.6.33` (`@convex-dev/better-auth@0.12.6` peers `>=1.6.11 <1.7.0`), `typescript@~7.0.2`. TypeScript 7 rejects `baseUrl`: use `paths` only.
- `convex/_generated/` is committed. After adding or changing Convex functions, regenerate it with `pnpm exec convex dev --once` against the local anonymous deployment created in Task 1, and commit the result.
- Convex env names, exactly: `PIPES_API_KEY`, `PIPES_APP_SLUG`, `PIPES_WEBHOOK_SECRET`, `PIPES_API_BASE_URL` (default `https://api.pipes.bot`), `SITE_URL`, `BETTER_AUTH_SECRET`, `OPENROUTER_API_KEY` (optional), `OPENROUTER_MODEL` (optional). Vite: `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`.
- Defaults and limits: `inactivityMinutes` 120, allowed integer range 5–1440; methodology 1–20 steps, step name 1–80 chars, description 0–500 chars; workspace name 1–80 chars; signature tolerance 300 s; dashboard queries capped at 1000 conversations; health cron every hour; `/numbers/connected` shows troubleshooting after 3 minutes.
- AI: default model `anthropic/claude-sonnet-5.5`; OpenRouter routing `provider: { zdr: true, data_collection: "deny" }`; at most 3 model calls per analysis (AI SDK `maxRetries: 0`, our loop does the retries); score = `round(100 * met / (met + not_met))`, absent when the denominator is 0.
- Webhook route: `POST /webhooks/pipes`. Responses: 401 bad/missing signature, 400 body not a JSON object, 500 when `PIPES_WEBHOOK_SECRET` is unset, 200 otherwise (including duplicates).
- Echoes are never treated as customer messages.
- Every public query/mutation/action resolves the caller's workspace and treats resources from another workspace as not found.

## Review Focus

1. **Malformed WhatsApp `timestamp`** (missing, non-numeric, or more than 12 digits) on a message, echo or status: use the arrival time and keep going, never throw. Pinned in Task 2 (`waTimestampMs`) and Task 8 (`malformed timestamp falls back to arrival time`).
2. **A number reconnected by another workspace** (a second `number.onboarded` for the same `poolNumberId` with a different, valid `workspaceId`): the number moves to the new workspace; the old workspace stops seeing it. Pinned in Task 8 (`reonboarding moves the number`).
3. **Settings edits out of range** (empty methodology, 0 or 5000 inactivity minutes, blank step name): rejected with a clear error, nothing saved, so analysis never runs with zero steps. Pinned in Task 5 (`updateSettings rejects invalid input`).
4. **`PIPES_WEBHOOK_SECRET` not set on the deployment:** the webhook returns 500 and logs `PIPES_WEBHOOK_SECRET is not set`, instead of accepting unsigned events or crashing obscurely. Pinned in Task 8 (`missing secret returns 500`).
5. **Business-initiated conversation to a BSUID-only contact** (an echo whose `to` is absent and `to_user_id` is set, contact never wrote before): a contact keyed by `userId` is created, the conversation has `initiatedBy: "business"` and no `firstResponseSeconds`. Pinned in Task 8 (`echo to BSUID-only contact opens a business conversation`).

---

## File Structure

```
conversation-analyzer/
  package.json, pnpm-lock.yaml, tsconfig.json, tsconfig.app.json, vite.config.ts,
  vitest.config.ts, index.html, components.json, .env.example, .gitignore, README.md
  convex/
    convex.config.ts        # app + betterAuth component
    auth.config.ts, auth.ts # Better Auth (crossDomain), authComponent, createAuth
    http.ts                 # auth routes + POST /webhooks/pipes
    schema.ts               # all app tables
    crons.ts                # hourly health check
    authz.ts                # requireWorkspace / requireNumber / requireConversation
    workspaces.ts           # ensureWorkspace, current, updateSettings, byOwner
    webhook.ts              # httpAction pipesWebhook
    ingest.ts               # ingest mutation + ingestPayload helper + routing
    conversations.ts        # recordMessage, closeIfIdle, closeConversation, retry/reanalyze
    analysis.ts             # analyzeConversation action + internal query/mutation
    numbers.ts              # list/get/findByPoolNumberId, createSignupLink, checkHealth
    dashboard.ts            # overview, waiting, conversations, conversation
    demo.ts                 # seed, reset
    lib/payload.ts          # list, waTimestampMs, senderOf, echoRecipientOf, statusRecipientOf, contentOf
    lib/signature.ts        # verifyStandardWebhook
    lib/metrics.ts          # computeMetrics
    lib/stats.ts            # summarize
    lib/transcript.ts       # buildTranscript
    lib/evaluation.ts       # evaluationSchema, checkEvaluation, scoreOf
    lib/methodology.ts      # DEFAULT_METHODOLOGY, newStepId, validateSettings
    lib/model.ts            # getModel (OpenRouter), mocked in tests
    *.test.ts, lib/*.test.ts
    _generated/             # committed
  tests/fixtures/*.json     # copies of ../fixtures/byon-v2 files used by tests
  tests/helpers.ts          # makeT(), signedRequest(), seedWorkspace()
  src/
    main.tsx, index.css, routeTree.gen.ts (generated, committed)
    lib/auth-client.ts, lib/utils.ts, lib/format.ts
    components/ui/*         # shadcn components actually used
    components/*.tsx        # app components (StatCards, WaitingList, ChatView, StepList, MethodologyEditor)
    routes/__root.tsx, sign-in.tsx, sign-up.tsx, _app.tsx,
           _app/index.tsx, _app/numbers/index.tsx, _app/numbers/connected.tsx,
           _app/numbers/$numberId.tsx, _app/conversations/$conversationId.tsx, _app/settings.tsx
.github/workflows/ci.yml    # new job conversation-analyzer
README.md (root)            # regenerated table
```

Shared types (defined in Task 1 `convex/schema.ts` validators, or the lib files named, used everywhere):

```ts
type Source = "customer" | "phone" | "api";
type Step = { id: string; name: string; description: string };          // lib/methodology.ts
type Verdict = "met" | "not_met" | "not_applicable";
type StepResult = { stepId: string; verdict: Verdict; evidence: string | null; reason: string }; // lib/evaluation.ts
type Metrics = {                                                         // lib/metrics.ts
  firstResponseSeconds?: number; avgResponseSeconds?: number; maxResponseSeconds?: number;
  unansweredTurns: number; answered: boolean; durationSeconds: number;
  counts: { customer: number; phone: number; api: number };
};
```

---

### Task 1: Scaffold the app, schema and CI job

**Files:**
- Create: everything at `conversation-analyzer/` root listed above, `convex/convex.config.ts`, `convex/schema.ts`, `convex/schema.test.ts`, `src/main.tsx`, `src/index.css`, `src/routes/__root.tsx`, `src/routes/index.tsx` (temporary "conversation-analyzer" page, replaced in Task 5), `README.md` (frontmatter + "What it shows" stub)
- Modify: `.github/workflows/ci.yml`, root `README.md` (via `pnpm readme`)

**Interfaces:**
- Produces: `convex/schema.ts` with the tables below; validators exported as `stepValidator`, `metricsValidator`, `analysisValidator`, `healthValidator`, `sourceValidator`.
- Produces: package scripts `dev` (`vite`), `build` (`vite build`), `typecheck` (`tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p convex/tsconfig.json`), `test` (`vitest run`), `convex` (`convex dev`).

Schema (fields and indexes; `?` = `v.optional`):

| Table | Fields | Indexes |
| --- | --- | --- |
| `workspaces` | `ownerId: string`, `name`, `inactivityMinutes: number`, `methodology: Step[]` | `by_owner [ownerId]` |
| `numbers` | `workspaceId`, `poolNumberId`, `phoneNumber`, `displayName`, `connectedAt`, `health?: {state: "healthy"\|"unhealthy"\|"unknown", checkedAt, detail?}`, `isDemo?: boolean` | `by_pool_number [poolNumberId]`, `by_workspace [workspaceId]` |
| `events` | `webhookId`, `kind: string`, `poolNumberId?`, `payload: any`, `state: "processed"\|"parked"\|"ignored"`, `receivedAt` | `by_webhook_id [webhookId]`, `by_pool_number_state [poolNumberId, state]` |
| `contacts` | `numberId`, `waId?`, `userId?`, `name?` | `by_number_wa_id [numberId, waId]`, `by_number_user_id [numberId, userId]` |
| `conversations` | `workspaceId`, `numberId`, `contactId`, `status: "open"\|"closed"`, `initiatedBy: "customer"\|"business"`, `openedAt`, `lastActivityAt`, `lastTurn: "customer"\|"business"`, `waitingSince?`, `closedAt?`, `closeJobId?: Id<"_scheduled_functions">`, `metrics?`, `analysis?` | `by_contact_status [contactId, status]`, `by_workspace_closed_at [workspaceId, closedAt]`, `by_number_closed_at [numberId, closedAt]`, `by_number_status_activity [numberId, status, lastActivityAt]`, `by_workspace_status [workspaceId, status]` |
| `messages` | `conversationId`, `wamid`, `direction: "inbound"\|"outbound"`, `source`, `type: string`, `text?`, `sentAt`, `deliveredAt?`, `readAt?`, `failedAt?` | `by_wamid [wamid]`, `by_conversation_sent_at [conversationId, sentAt]` |
| `statuses` | `numberId`, `wamid`, `status: string`, `timestamp`, `recipient: string` | `by_wamid [wamid]`, `by_number_recipient [numberId, recipient, timestamp]` |

`analysis` = `{ state: "pending"|"running"|"done"|"failed"|"skipped", reason?, methodology: Step[], requestedAt: number, summary?, steps?: StepResult[], score?, model?, analyzedAt? }`. All timestamps are ms since epoch.

- [ ] **Step 1: Scaffold the frontend.** `pnpm create vite@latest conversation-analyzer --template react-ts`, then install the Tech Stack versions. Configure `vite.config.ts` with `tanstackRouter({ target: "react", autoCodeSplitting: true })` before `react()`, `tailwindcss()`, and `resolve.alias` `@` → `./src`. Add `"paths": { "@/*": ["./src/*"] }` (no `baseUrl`) to `tsconfig.json` and `tsconfig.app.json`. `src/index.css` = `@import "tailwindcss";`. Run `pnpm dlx shadcn@latest init -t vite -b radix -p nova`, then add `button card input label textarea badge table select tabs separator alert sonner` with `pnpm dlx shadcn@latest add`.
- [ ] **Step 2: Initialize Convex.** `pnpm add convex@1.49.0`, then `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once` (local anonymous deployment, no account; writes `.env.local` and `convex/_generated/`). Add `convex/convex.config.ts` with the betterAuth component (`app.use(betterAuth)`) and `convex/schema.ts` as above. If the anonymous command differs in this Convex version, find the current equivalent (`npx convex dev --help`) and record the command in the README's Run locally section.
- [ ] **Step 3: Vitest.** `vitest.config.ts` with `test.environment: "edge-runtime"` and `include: ["convex/**/*.test.ts"]`. `tests/helpers.ts` exports `makeT()` = `convexTest(schema, import.meta.glob("../convex/**/*.ts"))` with `betterAuthTest.register(t, "betterAuth")` from `@convex-dev/better-auth/test`.
- [ ] **Step 4: Write `convex/schema.test.ts`** — `"schema accepts a workspace"`: `t.run` inserts a workspace `{ ownerId: "u1", name: "Acme", inactivityMinutes: 120, methodology: [] }` and reads it back with `name === "Acme"`.
- [ ] **Step 5: Run.** `pnpm test` → 1 passed. `pnpm typecheck` and `pnpm build` → exit 0.
- [ ] **Step 6: Repo integration.**
  - `.gitignore`: `node_modules`, `dist`, `.env.local`, `.env*.local`.
  - `.env.example`: the two variable lists from Global Constraints, with comments that Convex ones go through `npx convex env set`.
  - `README.md` frontmatter exactly as the spec's "Integração com o repo" block.
  - Copy `../fixtures/byon-v2/{message-text,message-text-bsuid-only,message-image,smb-message-echo,status-delivered-bsuid,status-failed,system-user-changed-number,system-user-changed-user-id,number-onboarded,test-webhook,template-status-update}.json` into `tests/fixtures/`.
  - Add a CI job `conversation-analyzer` (same `timeout-minutes: 10`, pnpm 11, setup-node from `.nvmrc`, `cache-dependency-path: conversation-analyzer/pnpm-lock.yaml`) running `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build` in `working-directory: conversation-analyzer`.
  - From the repo root: `pnpm readme`, then `pnpm readme:check` → exit 0 and the root README has an "Apps" section listing `conversation-analyzer`.
- [ ] **Step 7: Commit.** `git add conversation-analyzer .github/workflows/ci.yml README.md && git commit -m "Scaffold conversation-analyzer app"`

---

### Task 2: Payload helpers and signature verification

**Files:**
- Create: `convex/lib/payload.ts`, `convex/lib/payload.test.ts`, `convex/lib/signature.ts`, `convex/lib/signature.test.ts`

**Interfaces:**
- Produces (`lib/payload.ts`):
  - `list(value: unknown): any[]` — the value if it is an array, else `[]`.
  - `waTimestampMs(value: unknown, fallbackMs: number): number` — a string or number of 1–12 ASCII digits, as seconds → ms; otherwise `fallbackMs`.
  - `senderOf(msg: any): { waId?: string; userId?: string }` — `waId` from `from` when it is a non-empty string, `userId` from `from_user_id` when non-empty.
  - `echoRecipientOf(echo: any): { waId?: string; userId?: string }` — from `to` / `to_user_id`, same rule.
  - `statusRecipientOf(status: any): string | undefined` — `recipient_id` if non-empty string, else `recipient_user_id`.
  - `contentOf(msg: any): { type: string; text?: string }` — `type` (default `"unknown"`); `text` = `text.body` for text, `caption` for `image`/`video`/`document`, `button.text`, `interactive.button_reply.title` / `list_reply.title`; else undefined.
  - `contactName(whatsapp: any, ids: { waId?: string; userId?: string }): string | undefined` — `profile.name` of the `contacts[]` entry matching `wa_id` or `user_id`.
- Produces (`lib/signature.ts`): `verifyStandardWebhook(input: { id: string | null; timestamp: string | null; signature: string | null; body: string; secret: string; nowMs?: number }): Promise<boolean>`. Throws `Error("Invalid webhook secret")` when `secret` is not `whsec_` + base64.

- [ ] **Step 1: Write the failing tests.**
  - `payload.test.ts`: `list(null)` → `[]`; `list({})` → `[]`; `waTimestampMs("1749416383", 5)` → `1749416383000`; `waTimestampMs("abc", 5)` → `5`; `waTimestampMs("1234567890123", 5)` → `5`; `waTimestampMs(undefined, 5)` → `5`; `senderOf({ from: "", from_user_id: "US.1" })` → `{ userId: "US.1" }`; `senderOf` on `tests/fixtures/message-image.json` first message → `{ waId: "16505551234", userId: "US.13491208655302741918" }`; `statusRecipientOf` on `status-failed` → `"16505551234"` and on `status-delivered-bsuid` → `"US.13491208655302741918"`; `contentOf` on `message-image` → `{ type: "image", text: "Do you have this one in blue?" }`; `contentOf({ type: "sticker" })` → `{ type: "sticker" }`; `contactName` on `message-text-bsuid-only` with `{ userId: "US.13491208655302741918" }` → `"Sheena Nelson"`.
  - `signature.test.ts`: the repo vector — id `msg_p5jXN8AQM9LWM0D4loKWxJek`, timestamp `"1614265330"`, body `'{"test": 2432232314}'`, secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, signature `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`, `nowMs: 1614265330000` → `true`; same with `nowMs` + 301 s → `false`; `"v1,AAAA v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="` → `true`; body changed by one char → `false`; `signature: null` → `false`; timestamp `"16142653300000"` → `false`; secret `"nope"` → rejects with `Invalid webhook secret`.
- [ ] **Step 2: Run** `pnpm test convex/lib` → FAIL (modules missing).
- [ ] **Step 3: Implement both files.** Signature uses Web Crypto only (Convex default runtime): import the decoded key with `crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["verify"])` and check each `v1,` entry with `crypto.subtle.verify` over the UTF-8 bytes of `${id}.${timestamp}.${body}` (constant-time). Entries that are not valid base64 are skipped.
- [ ] **Step 4: Run** `pnpm test convex/lib` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add payload helpers and Standard Webhooks verification"`

---

### Task 3: Conversation metrics and dashboard stats

**Files:**
- Create: `convex/lib/metrics.ts`, `convex/lib/metrics.test.ts`, `convex/lib/stats.ts`, `convex/lib/stats.test.ts`

**Interfaces:**
- Produces: `computeMetrics(messages: { source: Source; sentAt: number }[]): Metrics` (input order irrelevant; sorts by `sentAt`).
- Produces: `summarize(conversations: { metrics?: Metrics; analysis?: { score?: number } }[]): { total: number; medianFirstResponseSeconds?: number; answeredRate?: number; avgScore?: number }` — `answeredRate` in 0–1, undefined when `total` is 0; median over defined `firstResponseSeconds` (mean of the two middle values for even counts); `avgScore` = rounded mean of defined scores.

A turn starts at a `customer` message that follows a business message (`phone`/`api`) or starts the list; it is answered by the first business message after it. Times are in whole seconds (`Math.round`).

- [ ] **Step 1: Write the failing tests** (`s` = seconds → ms):
  - `"mixed conversation"`: customer@0, customer@60, phone@300, customer@600, api@660, customer@900 → `{ firstResponseSeconds: 300, avgResponseSeconds: 180, maxResponseSeconds: 300, unansweredTurns: 1, answered: true, durationSeconds: 900, counts: { customer: 4, phone: 1, api: 1 } }`.
  - `"business initiated"`: phone@0, customer@100, phone@160 → `firstResponseSeconds` undefined, `avgResponseSeconds: 60`, `maxResponseSeconds: 60`, `unansweredTurns: 0`, `answered: true`, `durationSeconds: 160`.
  - `"customer only"`: customer@0, customer@50 → `answered: false`, `unansweredTurns: 1`, response fields undefined, `durationSeconds: 50`.
  - `"empty"`: `[]` → `{ unansweredTurns: 0, answered: false, durationSeconds: 0, counts: { customer: 0, phone: 0, api: 0 } }`.
  - `"unsorted input"`: the mixed case shuffled → same result.
  - `stats.test.ts`: three conversations with `firstResponseSeconds` 10, 30, undefined (`answered` true, true, false) and scores 50, 100, undefined → `{ total: 3, medianFirstResponseSeconds: 20, answeredRate: 2/3, avgScore: 75 }`; `summarize([])` → `{ total: 0 }`.
- [ ] **Step 2: Run** `pnpm test convex/lib/metrics convex/lib/stats` → FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add conversation metrics and summary stats"`

---

### Task 4: Methodology, transcript and evaluation checks

**Files:**
- Create: `convex/lib/methodology.ts`, `convex/lib/transcript.ts`, `convex/lib/evaluation.ts`, and a `.test.ts` for each

**Interfaces:**
- Produces (`methodology.ts`):
  - `DEFAULT_METHODOLOGY: Step[]` = `greet` "Greet the customer" / `understand` "Confirm what the customer needs" / `resolve` "Answer or give a clear next step" / `close` "Check the customer is satisfied before ending", each with a one-sentence description.
  - `newStepId(name: string, existing: string[]): string` — slug of `name` (lowercase, runs of non `[a-z0-9]` → `-`, trimmed, max 24 chars, `"step"` if empty) + `-` + 4 random base36 chars; regenerates on collision with `existing`.
  - `validateSettings(input: { name: string; inactivityMinutes: number; methodology: { id?: string; name: string; description: string }[] }, existingIds: string[]): { name: string; inactivityMinutes: number; methodology: Step[] }` — trims strings, assigns `newStepId` to steps without `id`, throws `ConvexError` with a message naming the field for anything outside Global Constraints limits (including duplicate ids).
- Produces (`transcript.ts`): `buildTranscript(messages: { source: Source; sentAt: number; type: string; text?: string }[]): string` — one line per message sorted by `sentAt`, `[HH:MM] <Label>: <content>` in UTC. Labels: `Customer`, `Agent (phone)`, `Agent (API)`. Content: text type → text; other types → `[<type>]` plus ` <text>` if any; `api` without text → `[content not available]`.
- Produces (`evaluation.ts`):
  - `evaluationSchema` = the zod object in the spec (summary max 400).
  - `checkEvaluation(output: z.infer<typeof evaluationSchema>, steps: Step[], transcript: string): { ok: true; steps: StepResult[] } | { ok: false; error: string }` — fails when the set of `stepId`s is not exactly the methodology's (missing, extra or repeated; error names them); on success returns results in methodology order with `evidence` set to `null` when `normalize(evidence)` is not a substring of `normalize(transcript)`. `normalize` = lowercase + collapse whitespace + trim.
  - `scoreOf(steps: StepResult[]): number | undefined`.

- [ ] **Step 1: Write the failing tests.**
  - `newStepId("Greet the customer!", [])` matches `/^greet-the-customer-[a-z0-9]{4}$/`; `newStepId("!!!", [])` matches `/^step-[a-z0-9]{4}$/`.
  - `validateSettings` happy path assigns ids to new steps and keeps given ids; `"updateSettings rejects invalid input"` cases here at the pure level: `methodology: []`, `inactivityMinutes: 0`, `5000`, `12.5`, a step named `"  "`, a 501-char description, two steps with the same id — each throws `ConvexError`.
  - `buildTranscript`: customer text at `2026-10-31T14:02:00Z` "Hi", phone at 14:09 "Hello!", api with no text at 14:10, customer image at 14:11 with text "blue?" → exactly
    ```
    [14:02] Customer: Hi
    [14:09] Agent (phone): Hello!
    [14:10] Agent (API): [content not available]
    [14:11] Customer: [image] blue?
    ```
  - `checkEvaluation` with `DEFAULT_METHODOLOGY`: all four ids → ok, ordered `greet, understand, resolve, close`; missing `close` → `{ ok: false }` with error containing `close`; extra `upsell` → not ok; `greet` twice → not ok; evidence `"HELLO!"` against the transcript above → kept; evidence `"we offer refunds"` → `null`, verdict unchanged.
  - `scoreOf`: met, met, not_met, not_applicable → `67`; all `not_applicable` → `undefined`.
- [ ] **Step 2: Run** `pnpm test convex/lib` → new tests FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add methodology, transcript and evaluation checks"`

---

### Task 5: Auth, workspaces and the signed-in shell

**Files:**
- Create: `convex/auth.config.ts`, `convex/auth.ts`, `convex/http.ts`, `convex/authz.ts`, `convex/workspaces.ts`, `convex/workspaces.test.ts`, `src/lib/auth-client.ts`, `src/routes/sign-in.tsx`, `src/routes/sign-up.tsx`, `src/routes/_app.tsx`, `src/routes/_app/index.tsx` (placeholder heading, filled in Task 11)
- Modify: `src/main.tsx`, `src/routes/__root.tsx`; delete `src/routes/index.tsx`

**Interfaces:**
- Consumes: `DEFAULT_METHODOLOGY`, `validateSettings` (Task 4).
- Produces (`authz.ts`):
  - `requireWorkspace(ctx: QueryCtx | MutationCtx): Promise<Doc<"workspaces">>` — owner = `(await ctx.auth.getUserIdentity())?.subject`; throws `ConvexError("Not signed in")` or `ConvexError("Workspace not found")`.
  - `requireNumber(ctx, numberId: Id<"numbers">): Promise<{ workspace; number }>` and `requireConversation(ctx, conversationId: Id<"conversations">): Promise<{ workspace; conversation }>` — throw `ConvexError("Not found")` when missing or in another workspace.
- Produces (`workspaces.ts`): `ensureWorkspace` mutation `() => Id<"workspaces">` (idempotent; creates `{ name: "My workspace", inactivityMinutes: 120, methodology: DEFAULT_METHODOLOGY }`); `current` query `() => Doc<"workspaces"> | null`; `updateSettings` mutation `({ name, inactivityMinutes, methodology }) => null` (runs `validateSettings` with the current ids); `byOwner` internalQuery `({ ownerId }) => Doc<"workspaces"> | null`.
- Produces: `convex/http.ts` exporting the router with `authComponent.registerRoutes(http, createAuth, { cors: true })`. Task 8 adds the webhook route to this file.
- Produces (`src/lib/auth-client.ts`): `authClient` (`createAuthClient({ baseURL: import.meta.env.VITE_CONVEX_SITE_URL, plugins: [convexClient(), crossDomainClient()] })`).

- [ ] **Step 1: Write the failing tests** in `workspaces.test.ts` (use `t.withIdentity({ subject: "user_a" })`):
  - `"ensureWorkspace is idempotent"`: two calls return the same id; one row; methodology equals `DEFAULT_METHODOLOGY`; `inactivityMinutes` 120.
  - `"current is null before ensure"`.
  - `"updateSettings saves and assigns ids"`: new step without id gets one; `current` reflects it.
  - `"updateSettings rejects invalid input"`: `methodology: []` and `inactivityMinutes: 5000` reject with `ConvexError`; `current` unchanged.
  - `"signed-out calls are rejected"`: `current` without identity returns `null`; `updateSettings` without identity throws `Not signed in`.
- [ ] **Step 2: Run** `pnpm test convex/workspaces` → FAIL.
- [ ] **Step 3: Implement** `auth.config.ts`, `auth.ts` (exactly the research pattern: `betterAuth` from `better-auth/minimal`, `baseURL: process.env.CONVEX_SITE_URL`, `trustedOrigins: [SITE_URL]`, `emailAndPassword: { enabled: true, requireEmailVerification: false }`, plugins `crossDomain({ siteUrl })` and `convex({ authConfig })`), `http.ts`, `authz.ts`, `workspaces.ts`. Regenerate `_generated`.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Frontend shell.**
  - `main.tsx`: `ConvexReactClient(VITE_CONVEX_URL, { expectAuth: true })` inside `ConvexBetterAuthProvider` with `authClient`, plus the TanStack `RouterProvider`.
  - `sign-up.tsx` / `sign-in.tsx`: email + password (+ name on sign-up) forms calling `authClient.signUp.email` / `authClient.signIn.email`, showing the returned error message, navigating to `/` on success, each linking to the other.
  - `_app.tsx`: pathless layout. While `useConvexAuth()` is loading show a spinner; unauthenticated → `<Navigate to="/sign-in" />`; authenticated → call `ensureWorkspace` once, then render a top nav (Overview `/`, Numbers `/numbers`, Settings `/settings`, Sign out) and `<Outlet />`.
- [ ] **Step 6: Verify.** `pnpm typecheck && pnpm build` → exit 0. Manual: `npx convex env set BETTER_AUTH_SECRET $(openssl rand -base64 32)` and `SITE_URL http://localhost:5173` on the local deployment, run `pnpm exec convex dev` + `pnpm dev`, sign up, land on `/`, reload stays signed in, sign out returns to `/sign-in`.
- [ ] **Step 7: Commit.** `git commit -m "Add Better Auth, workspaces and signed-in shell"`

---

### Task 6: Analysis action

**Files:**
- Create: `convex/lib/model.ts`, `convex/analysis.ts`, `convex/analysis.test.ts`

**Interfaces:**
- Consumes: `buildTranscript`, `evaluationSchema`, `checkEvaluation`, `scoreOf` (Task 4).
- Produces (`lib/model.ts`): `getModel(): { model: LanguageModel; id: string } | null` — `null` without `OPENROUTER_API_KEY`; otherwise `createOpenRouter({ apiKey }).chat(id, { provider: { zdr: true, data_collection: "deny" } })` with `id = OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5.5"`.
- Produces (`analysis.ts`):
  - `analyzeConversation` internalAction `({ conversationId: Id<"conversations">, requestedAt: number }) => null`.
  - `load` internalQuery `({ conversationId }) => { conversation; messages } | null`.
  - `save` internalMutation `({ conversationId, requestedAt, patch }) => null` — merges `patch` into `analysis` only if `conversation.analysis?.requestedAt === requestedAt` (a newer request wins).

Behavior: return early unless the conversation is `closed` with `analysis.state === "pending"` and the same `requestedAt`. `metrics.answered === false` → `skipped` / `reason: "no-reply"`. `getModel()` null → `skipped` / `reason: "no-api-key"`. Else `running`, then up to 3 attempts of `generateText({ model, output: Output.object({ schema: evaluationSchema }), system, prompt, maxRetries: 0 })`; each thrown error or failed `checkEvaluation` counts as an attempt. Success → `done` with `summary`, `steps`, `score: scoreOf(steps)`, `model: id`, `analyzedAt: Date.now()`. After 3 failures → `failed` with `reason` = last error message. The system prompt states the role (support QA reviewer), lists the steps as `id — name: description`, requires one entry per step id, a literal quote as evidence or null, and the summary and reasons in the conversation's language; the prompt is the transcript.

- [ ] **Step 1: Write the failing tests.** `vi.mock("./lib/model")` so `getModel` returns `{ model: MockLanguageModelV4, id: "mock/model" }` (or `null` per test). Seed with `t.run`: a workspace, number, contact, a `closed` conversation with `metrics` (`answered: true`), `analysis: { state: "pending", methodology: DEFAULT_METHODOLOGY, requestedAt: 1 }`, and three messages.
  - `"done on valid output"`: mock returns all four steps (met, met, not_met, not_applicable) with one evidence quote present in the transcript → state `done`, `score: 67`, `model: "mock/model"`, `steps.length` 4, one call recorded.
  - `"retries when a step is missing"`: first response lacks `close`, second valid → `done`, `doGenerateCalls.length === 2`.
  - `"fails after three calls"`: mock always throws → `failed`, reason contains the error message, 3 calls.
  - `"skipped without reply"`: `metrics.answered: false` → `skipped` / `no-reply`, 0 calls.
  - `"skipped without api key"`: `getModel` → null → `skipped` / `no-api-key`.
  - `"stale request is ignored"`: call with `requestedAt: 0` → analysis unchanged, 0 calls.
- [ ] **Step 2: Run** `pnpm test convex/analysis` → FAIL.
- [ ] **Step 3: Implement** `lib/model.ts` and `analysis.ts`; regenerate `_generated`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add LLM methodology analysis via OpenRouter"`

---

### Task 7: Closing conversations

**Files:**
- Create: `convex/conversations.ts`, `convex/conversations.test.ts`

**Interfaces:**
- Consumes: `computeMetrics` (Task 3), `requireConversation` (Task 5), `internal.analysis.analyzeConversation` (Task 6).
- Produces:
  - `closeConversation(ctx: MutationCtx, conversationId: Id<"conversations">, now = Date.now()): Promise<void>` (exported helper; also used by Task 13).
  - `closeIfIdle` internalMutation `({ conversationId }) => null`.
  - `requestAnalysis(ctx: MutationCtx, conversationId, methodology: Step[]): Promise<void>` — sets `analysis = { state: "pending", methodology, requestedAt: Date.now() }` and `ctx.scheduler.runAfter(0, internal.analysis.analyzeConversation, { conversationId, requestedAt })`.
  - `retryAnalysis` mutation `({ conversationId }) => null` — only when `analysis.state === "failed"`; reuses `analysis.methodology`.
  - `reanalyze` mutation `({ conversationId }) => null` — only when `status === "closed"`; uses the workspace's current methodology.

`closeConversation`, for an `open` conversation (no-op otherwise):
1. Orphan statuses: for each of the contact's `waId`/`userId`, read `statuses` by `by_number_recipient` with `timestamp` in `[openedAt, now]`; group by `wamid`; each group becomes a message `{ source: "api", direction: "outbound", type: "text", sentAt: timestamp of the "sent" status or the earliest, deliveredAt/readAt/failedAt from the group }` (no text); delete the grouped statuses. Skip a `wamid` that already has a message.
2. `metrics = computeMetrics(all messages)`.
3. Patch `status: "closed"`, `closedAt: now`, `waitingSince: undefined`, `closeJobId: undefined`.
4. `requestAnalysis` with the workspace methodology.

`closeIfIdle` returns unless the conversation is `open` and `lastActivityAt + inactivityMinutes * 60_000 <= Date.now()`.

- [ ] **Step 1: Write the failing tests** (seed with `t.run`; `vi.useFakeTimers()` where scheduling matters):
  - `"closes and schedules analysis"`: open conversation with customer@t0 and phone@t0+60s → after `closeConversation`: `closed`, `metrics.firstResponseSeconds === 60`, `analysis.state === "pending"` with the workspace methodology, one scheduled `analysis:analyzeConversation`.
  - `"orphan statuses become api messages"`: statuses `sent`@t0+30s and `delivered`@t0+35s for `wamid.X` with `recipient` = contact `waId` → one `api` message with `sentAt` t0+30s and `deliveredAt` t0+35s; `statuses` empty; `metrics.counts.api === 1`. A status for another recipient is left untouched.
  - `"closeIfIdle skips after new activity"`: `lastActivityAt` = now → still `open`.
  - `"closeIfIdle closes when idle"`: `lastActivityAt` = now − 121 min, `inactivityMinutes` 120 → `closed`.
  - `"retryAnalysis only when failed"` and `"reanalyze uses current methodology"` (after editing the workspace methodology with `t.run`), both as the owner via `withIdentity`; user_b calling `reanalyze` → throws `Not found`.
- [ ] **Step 2: Run** `pnpm test convex/conversations` → FAIL.
- [ ] **Step 3: Implement**; regenerate `_generated`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "Close idle conversations and request analysis"`

---

### Task 8: Webhook ingestion

**Files:**
- Create: `convex/webhook.ts`, `convex/ingest.ts`, `convex/ingest.test.ts`, `convex/webhook.test.ts`
- Modify: `convex/http.ts` (route), `convex/conversations.ts` (add `recordMessage`), `tests/helpers.ts` (add `signedRequest`)

**Interfaces:**
- Consumes: Task 2 helpers and `verifyStandardWebhook`; `internal.conversations.closeIfIdle` and `closeConversation` (Task 7).
- Produces:
  - `ingestPayload(ctx: MutationCtx, webhookId: string, payload: Record<string, unknown>, now = Date.now()): Promise<"duplicate" | "processed" | "parked" | "ignored">` (exported; Task 13 calls it).
  - `ingest` internalMutation `({ webhookId: string, payload: any }) => same union`.
  - `recordMessage(ctx: MutationCtx, input: { number: Doc<"numbers">; contactId: Id<"contacts">; wamid: string; source: Source; type: string; text?: string; sentAt: number }): Promise<void>` in `conversations.ts` — skips an existing `wamid`; opens a conversation when the contact has none `open` (`initiatedBy` from `source`, `openedAt = sentAt`); updates `lastActivityAt = max(lastActivityAt, sentAt)`, `lastTurn`, `waitingSince` (set to `sentAt` on a customer message when not already waiting; cleared on a business message); cancels `closeJobId` (ignore a cancel error for an already-finished job) and schedules `closeIfIdle` at `Date.now() + inactivityMinutes * 60_000`.
  - `pipesWebhook` httpAction; `http.route({ path: "/webhooks/pipes", method: "POST", handler: pipesWebhook })`.
  - `tests/helpers.ts`: `signedRequest(payload: unknown, opts?: { id?: string; secret?: string; tamper?: boolean }): { body: string; headers: Record<string, string> }` using the test secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`.

Routing (in `ingestPayload`, after the dedup check on `by_webhook_id` and inserting the event): follow the spec's routing table exactly. Details the table leaves open:
- Workspace validity: `ctx.db.normalizeId("workspaces", metadata.workspaceId)` then `ctx.db.get`; null → `parked` and `console.warn("unassigned number <numberId>")`.
- `number.onboarded` upsert by `by_pool_number`: update `workspaceId`, `phoneNumber`, `displayName`; set `connectedAt = now` on insert. Then replay: for each `parked` event with that `poolNumberId` ordered by `receivedAt`, run the envelope routing and patch its `state`.
- Envelope routing for a known number: `messages[]` — `type === "system"` updates the contact (`user_changed_number`: find by `previous_user_id`, else by `user_id`, set `waId = system.wa_id`, `userId = system.user_id`; `user_changed_user_id`: find by `previous_user_id`, set `userId = system.user_id`) and records no message; other types → resolve contact from `senderOf` + `contactName`, `recordMessage` with `source: "customer"`, `sentAt = waTimestampMs(msg.timestamp, now)`. `statuses[]` — matching message by `by_wamid`: patch `deliveredAt`/`readAt`/`failedAt` (`sent` changes nothing); else insert into `statuses` with `recipient = statusRecipientOf` (skip if undefined). `message_echoes[]` — resolve contact from `echoRecipientOf`, `recordMessage` with `source: "phone"`, then fold `statuses` rows with the same `wamid` into the message and delete them.
- Contact resolution: look up by `userId`, then by `waId`; create if absent; fill the missing id or `name` when now known.

`pipesWebhook`: read `await request.text()`; secret unset → 500 + `console.error("PIPES_WEBHOOK_SECRET is not set")`; `verifyStandardWebhook` false → 401; `JSON.parse` failure or non-object (null, array, primitive) → 400; else `ctx.runMutation(internal.ingest.ingest, { webhookId: header "webhook-id", payload })` → 200 `ok`.

- [ ] **Step 1: Write the failing tests.**
  - `webhook.test.ts` (set `process.env.PIPES_WEBHOOK_SECRET` in `beforeEach`, `t.fetch("/webhooks/pipes", …)`): valid signed `test-webhook` → 200; tampered body → 401; no signature headers → 401; signed body `"null"` → 400; signed `"[1]"` → 400; signed `"not json"` → 400; `"missing secret returns 500"` (delete the env var) → 500; the same signed delivery twice → 200 both, one `events` row.
  - `ingest.test.ts` (call `internal.ingest.ingest` directly; fixtures from `tests/fixtures/`, with `pipes.poolNumberId` rewritten to the test number):
    - `"parks before onboarding and replays"`: `message-text` for `pn_new` → `parked`; then `number.onboarded` with `metadata.workspaceId` → `processed`, the parked event becomes `processed`, one open conversation with one `customer` message.
    - `"onboarded without metadata is parked"` → `parked`, no number row.
    - `"reonboarding moves the number"`: onboard `pn_1` to workspace A, then to B → number `workspaceId` is B.
    - `"echo is never a customer message"`: `smb-message-echo` for a known number → message `source: "phone"`, `direction: "outbound"`; conversation `lastTurn: "business"`.
    - `"echo to BSUID-only contact opens a business conversation"`: echo with `to` removed and `to_user_id` set → contact with `userId` only, conversation `initiatedBy: "business"`.
    - `"status before echo is folded"`: `status-delivered-bsuid` with `id` = the echo's wamid, then the echo → message has `deliveredAt`, `statuses` empty.
    - `"status for known message updates it"`: `status-failed` after a message with that wamid → `failedAt` set.
    - `"system change updates contact"`: message from `US.13491208655302741918`, then `system-user-changed-number` → contact `waId: "16505559999"`, `userId: "US.99999999999999999999"`; then `system-user-changed-user-id` (with `previous_user_id` set to the contact's current `userId`) → contact `userId` updated to that payload's `system.user_id`.
    - `"bsuid-only sender"`: `message-text-bsuid-only` → contact `userId` set, `name: "Sheena Nelson"`.
    - `"malformed timestamp falls back to arrival time"`: message with `timestamp: "soon"` and `now` passed → `sentAt === now`.
    - `"message after close opens a new conversation"`: record, close with `closeConversation`, record another → two conversations.
    - `"activity reschedules close"`: two messages → only the latest `closeIfIdle` job is pending (`_scheduled_functions` state), the first is `canceled`.
    - `"template status is ignored"`: `template-status-update` → `ignored`.
- [ ] **Step 2: Run** `pnpm test convex/ingest convex/webhook` → FAIL.
- [ ] **Step 3: Implement**; regenerate `_generated`.
- [ ] **Step 4: Run** `pnpm test` → all PASS.
- [ ] **Step 5: Commit.** `git commit -m "Ingest pipes.bot webhooks into conversations"`

---

### Task 9: Numbers, signup links and health checks

**Files:**
- Create: `convex/numbers.ts`, `convex/numbers.test.ts`, `convex/crons.ts`

**Interfaces:**
- Consumes: `requireWorkspace`, `requireNumber`, `internal.workspaces.byOwner` (Task 5).
- Produces:
  - `list` query `() => Doc<"numbers">[]` (workspace's numbers, `connectedAt` desc).
  - `get` query `({ numberId }) => Doc<"numbers">` (throws `Not found`).
  - `findByPoolNumberId` query `({ poolNumberId: string }) => Doc<"numbers"> | null` — null when missing or in another workspace.
  - `createSignupLink` action `() => { url: string }` — `POST ${PIPES_API_BASE_URL ?? "https://api.pipes.bot"}/v1/apps/token` with `Authorization: Bearer ${PIPES_API_KEY}`, body `{ redirectUrl: ${SITE_URL}/numbers/connected, metadata: { workspaceId } }`; returns `https://app.pipes.bot/apps/${PIPES_APP_SLUG}?token=${encodeURIComponent(token)}`. Non-2xx → `ConvexError("Could not create a signup link (<status>): <body text, first 200 chars>")`. Missing env → `ConvexError("<NAME> is not set")`.
  - `checkHealth` internalAction `() => null` — for each non-demo number: `GET …/v1/pool-numbers/{poolNumberId}/health`; `canSendMessage === "AVAILABLE"` → `healthy`; `"LIMITED"` or `"BLOCKED"` → `unhealthy` with `detail` = first `entities[].errors[].description` (or the value); network error or non-2xx → `unknown` with `detail` = status or error message. Writes through `setHealth` internalMutation `({ numberId, health }) => null`. `allNumbers` internalQuery for the loop.
  - `crons.ts`: `crons.interval("check number health", { hours: 1 }, internal.numbers.checkHealth)`.

- [ ] **Step 1: Write the failing tests** (assign `globalThis.fetch = vi.fn(...)` before calling the action; set env vars in `beforeEach`):
  - `"createSignupLink sends workspace metadata"`: fetch receives the token URL, the Bearer key, and a body with `metadata.workspaceId` = the caller's workspace and `redirectUrl` ending in `/numbers/connected`; result URL is `https://app.pipes.bot/apps/acme?token=jwt.abc`.
  - `"createSignupLink surfaces API errors"`: fetch → 400 `redirectUrl must use HTTPS protocol` → throws containing `400` and that text.
  - `"findByPoolNumberId hides other workspaces"`: user_b gets `null` for user_a's number; user_a gets it.
  - `"get rejects other workspace"` → `Not found`.
  - `"checkHealth maps states"`: three numbers answering `AVAILABLE`, `BLOCKED` (with an error description) and HTTP 500; one demo number is never fetched → `healthy`, `unhealthy` + detail, `unknown`.
- [ ] **Step 2: Run** `pnpm test convex/numbers` → FAIL.
- [ ] **Step 3: Implement**; regenerate `_generated`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add number onboarding links and health checks"`

---

### Task 10: Dashboard queries

**Files:**
- Create: `convex/dashboard.ts`, `convex/dashboard.test.ts`

**Interfaces:**
- Consumes: `summarize` (Task 3), `requireWorkspace`, `requireNumber`, `requireConversation` (Task 5).
- Produces:
  - `overview` query `({ days: 7 | 30, numberId?: Id<"numbers"> }) => ReturnType<typeof summarize>` — closed conversations with `closedAt >= Date.now() - days*86_400_000` via `by_workspace_closed_at` or `by_number_closed_at`, `.take(1000)`.
  - `waiting` query `({ numberId?: Id<"numbers"> }) => { conversationId; numberId; contactName?; contactId: string; waitingSince: number; lastMessage?: string }[]` — open conversations with `waitingSince` set, oldest first, max 50. `contactId` shown = `waId ?? userId`.
  - `conversations` query `({ numberId, status: "open" | "closed" }) => { _id; status; openedAt; lastActivityAt; contactName?; contactLabel: string; metrics?; analysisState?; score? }[]` — `by_number_status_activity` desc, max 100.
  - `conversation` query `({ conversationId }) => { conversation; contact; number; messages }` — messages by `by_conversation_sent_at`.

- [ ] **Step 1: Write the failing tests:** `overview` counts only closed conversations inside the window (one at −2 days counted for 7, one at −10 days only for 30); `numberId` filter; `waiting` returns the open waiting conversation and not an open one with `lastTurn: "business"`; `conversations` orders by `lastActivityAt` desc; `"other workspace is not found"`: user_b calling `conversation` and `overview({ numberId })` on user_a's resources throws `Not found`.
- [ ] **Step 2: Run** `pnpm test convex/dashboard` → FAIL.
- [ ] **Step 3: Implement**; regenerate `_generated`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add dashboard queries"`

---

### Task 11: Overview and numbers UI

**Files:**
- Create: `src/lib/format.ts`, `src/components/StatCards.tsx`, `src/components/WaitingList.tsx`, `src/components/HealthBadge.tsx`, `src/routes/_app/numbers/index.tsx`, `src/routes/_app/numbers/connected.tsx`, `src/routes/_app/numbers/$numberId.tsx`
- Modify: `src/routes/_app/index.tsx`, `vitest.config.ts` (second project for `src/**/*.test.ts`)

**Interfaces:**
- Consumes: `api.dashboard.overview | waiting | conversations`, `api.numbers.list | get | findByPoolNumberId | createSignupLink`.
- Produces (`format.ts`): `formatDuration(seconds?: number): string` (`—` when undefined, `45s`, `12m`, `1h 05m`), `formatPercent(rate?: number): string` (`—`, `67%`), `useNow(intervalMs = 1000): number` hook.

- [ ] **Step 1:** `format.ts` with a small `format.test.ts` run by a second Vitest project (`environment: "node"`, `include: ["src/**/*.test.ts"]`): `formatDuration(45) === "45s"`, `formatDuration(720) === "12m"`, `formatDuration(3900) === "1h 05m"`, `formatDuration(undefined) === "—"`, `formatPercent(2/3) === "67%"`. Run → FAIL, implement, run → PASS.
- [ ] **Step 2: Overview `/`.** 7/30-day tabs feeding `overview`; `StatCards` (Conversations, Median first response, Answered, Avg methodology score); `WaitingList` with a live "waiting 12m" counter from `useNow`, each row linking to the conversation. Empty state when there are no numbers: a card pointing to `/numbers` and to the README's demo seed command.
- [ ] **Step 3: Numbers `/numbers`.** Table of numbers (display name, phone, connected date, `HealthBadge` with `detail` as a tooltip/title). **Connect a number** calls `createSignupLink` and sets `window.location.href` to the URL; errors appear in an `Alert`.
- [ ] **Step 4: Connected `/numbers/connected`.** Validates search params `numberId?`, `phone?`. Shows "Waiting for confirmation…" until `findByPoolNumberId` returns the number, then "Connected" with a link to `/numbers/$numberId`. After 3 minutes still waiting, show the troubleshooting list (webhook URL is `https://<deployment>.convex.site/webhooks/pipes`, App must be on API v2, signing secret must match `PIPES_WEBHOOK_SECRET`). Without `numberId`, show the waiting state with the troubleshooting list and a link back.
- [ ] **Step 5: Number `/numbers/$numberId`.** Header with number info, the same `StatCards` filtered by `numberId`, Open/Closed tabs listing `conversations` (contact, last activity, first response, score or analysis state badge), rows link to the conversation.
- [ ] **Step 6: Verify.** `pnpm typecheck && pnpm test && pnpm build` → exit 0.
- [ ] **Step 7: Commit.** `git commit -m "Add overview and numbers screens"`

---

### Task 12: Conversation detail and settings UI

**Files:**
- Create: `src/components/ChatView.tsx`, `src/components/StepList.tsx`, `src/components/MethodologyEditor.tsx`, `src/routes/_app/conversations/$conversationId.tsx`, `src/routes/_app/settings.tsx`

**Interfaces:**
- Consumes: `api.dashboard.conversation`, `api.conversations.retryAnalysis | reanalyze`, `api.workspaces.current | updateSettings`.

- [ ] **Step 1: Conversation `/conversations/$conversationId`.**
  - `ChatView`: customer messages left, business right, each business bubble with a `phone` or `API` badge; `api` messages without text render "Sent via API (content not available)"; non-text types render `[image]` + caption; timestamps local; delivered/read/failed ticks from the message fields.
  - Side panel: metrics (`formatDuration`), `initiatedBy`, analysis state. `done` → summary, score, `StepList` (step name, verdict badge met/not met/n/a, quoted evidence when non-null, reason). `pending`/`running` → spinner text. `failed` → reason + **Retry**. `skipped` → "No reply to evaluate" or "Set OPENROUTER_API_KEY to enable analysis". **Re-analyze** visible when closed. `Not found` errors render a not-found state.
- [ ] **Step 2: Settings `/settings`.** Form for workspace name and inactivity minutes; `MethodologyEditor` with add, edit name/description, remove, move up/down; Save calls `updateSettings` and shows the `ConvexError` message on failure, a toast on success. Note under the editor: "Changes apply to conversations analyzed from now on. Use Re-analyze on a conversation to score it again."
- [ ] **Step 3: Verify.** `pnpm typecheck && pnpm test && pnpm build` → exit 0.
- [ ] **Step 4: Commit.** `git commit -m "Add conversation detail and settings screens"`

---

### Task 13: Demo seed and reset

**Files:**
- Create: `convex/demo.ts`, `convex/demo.test.ts`

**Interfaces:**
- Consumes: `ingestPayload` (Task 8), `closeConversation` (Task 7).
- Produces: `seed` internalMutation `({ email: string }) => { poolNumberId: string; conversations: number }` and `reset` internalMutation `({ email: string }) => { deleted: number }`.

`seed`: find the user with `ctx.runQuery(components.betterAuth.adapter.findOne, { model: "user", where: [{ field: "email", value: email }] })`, then the workspace by `ownerId = user._id`; missing either → `ConvexError("No workspace for <email>. Sign in to the app once first.")`. `poolNumberId = "pn_demo_" + 6 random base36 chars`. Feed through `ingestPayload` with webhook ids `demo_<poolNumberId>_<n>`: a `number.onboarded` (`displayName: "Demo Support"`, `phoneNumber: "+15550100000"`, `metadata.workspaceId`), then patch the number `isDemo: true`, then v2 envelopes built in code for four customers (`15550100001`–`15550100004`, names Ana, Ben, Carla, Dev), timestamps relative to `now - 1 day`:
1. Fast and on-method: customer asks about an order; phone greets by name within 1 min, confirms the order number, gives a delivery date, asks if anything else is needed; customer thanks.
2. Slow: customer asks twice 20 min apart; phone answers 45 min after the first message with a short reply; no closing check.
3. Unanswered: two customer messages, no reply.
4. Mixed: customer asks; an API reply represented only by `sent` + `delivered` statuses (`recipient_id` = customer) 2 min later; later a phone echo follows up.
Then `closeConversation` every open conversation of the number. Return the count (4).

`reset`: for the workspace's numbers with `isDemo`, delete messages, conversations (canceling pending `closeJobId`s), contacts, statuses, events with that `poolNumberId`, and the number; return the number of deleted rows.

- [ ] **Step 1: Write the failing tests** (create the user with the component API returned by `betterAuthTest.register`, `adapter.create` with model `user`; workspace via `t.run`): `seed` returns `conversations: 4`; all four `closed` with `analysis.state === "pending"`; scenario 1 `metrics.firstResponseSeconds <= 60`; scenario 2 `>= 2700`; scenario 3 `answered === false`; scenario 4 `counts.api === 1 && counts.phone >= 1`; unknown email throws `No workspace`; `reset` leaves no demo number, conversation, message or event, and does not touch a non-demo number.
- [ ] **Step 2: Run** `pnpm test convex/demo` → FAIL.
- [ ] **Step 3: Implement**; regenerate `_generated`.
- [ ] **Step 4: Run** `pnpm test` → all PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add demo seed and reset"`

---

### Task 14: README and end-to-end verification

**Files:**
- Modify: `conversation-analyzer/README.md`, `conversation-analyzer/.env.example`, root `README.md` (regenerated)

- [ ] **Step 1: Write the README** under the frontmatter, sections in order: What it shows · pipes.bot features used · Run locally · Try it without a phone · Deploy · How it works · Privacy · Limits and extensions. Must include:
  - Run locally: `pnpm install`, `pnpm exec convex dev` (local or cloud), every `npx convex env set` for the Convex variables, `.env.local` for Vite, `pnpm dev`.
  - pipes.bot setup: create an App on API v2, turn on **Forward messages sent from the phone**, webhook URL `https://<deployment>.convex.site/webhooks/pipes`, copy the `whsec_` secret and `ak_` key; a local deployment is not reachable by pipes.bot, so real numbers need a cloud dev deployment.
  - Try it without a phone: `npx convex run demo:seed '{"email":"you@example.com"}'` and `demo:reset`; the root `simulate` command against `<site-url>/webhooks/pipes` with the matching secret.
  - Deploy: `npx convex deploy`, then the static build on Vercel or Netlify with `VITE_CONVEX_URL`/`VITE_CONVEX_SITE_URL`, and `SITE_URL` set to the exact SPA origin (Better Auth `trustedOrigins` has no wildcards).
  - How it works: the ingestion flow, parking/replay, echoes vs statuses vs `api` replies, inactivity close, metrics definitions, analysis validation.
  - Privacy: transcripts are sent to an AI provider via OpenRouter; the app requests zero-data-retention endpoints (`zdr: true`, `data_collection: "deny"`); how to restrict further in OpenRouter settings; analysis is off without `OPENROUTER_API_KEY`.
  - Limits and extensions: the spec's "Fora do escopo" list, plus `@convex-dev/aggregate` for large volumes.
- [ ] **Step 2: Repo checks.** From the root: `pnpm readme && pnpm readme:check && pnpm test && pnpm typecheck` → all exit 0. In `conversation-analyzer/`: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build` → exit 0.
- [ ] **Step 3: Local end-to-end (acceptance 2 and 3).** On the local anonymous deployment with `PIPES_WEBHOOK_SECRET=whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw` (never a real key): sign up in the app, run `demo:seed` for that email → four closed conversations visible on `/` and the number page, analysis `skipped` (`no-api-key`) unless an OpenRouter key is set. From the repo root: `pnpm simulate byon-v2/test-webhook --url <local site url>/webhooks/pipes --secret whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw` → prints `200 ok`; the same with `--bad-signature` → `401`. Record the commands and results for the PR.
- [ ] **Step 4: Commit.** `git commit -m "Document conversation-analyzer"`

Acceptance 4 (real number, phone conversation) is the user's manual check; the PR states whether it was done.
