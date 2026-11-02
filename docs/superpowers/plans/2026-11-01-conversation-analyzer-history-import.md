# conversation-analyzer history and contacts import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Coexistence number is connected with the import boxes ticked, `conversation-analyzer` turns the phone's chat history into closed, measured "Imported" conversations, and names contacts from the phone's address book. AI analysis of imported conversations runs only on demand.

**Architecture:**
- `POST /webhooks/pipes` sends `field: "history"` envelopes down a separate path: the raw body goes to Convex file storage, `history.receive` records a small event, `history.processChunk` stages the rows in `historyMessages`, and a debounced `history.build` chain turns each contact's staged rows into conversations.
- `smb_app_state_sync` goes through the existing `ingest` path and sets `contacts.bookName`.
- The UI adds the connect checkboxes, an Import card, Imported badges and the analyze buttons.

**Tech Stack:** As the analyzer today: Convex 1.49.0, `convex-test` 0.0.66, Vitest 4 (edge-runtime), TanStack Router SPA, Tailwind v4 + shadcn/ui, TypeScript ~7.0.2, pnpm, Node 22.18+.

**Spec:** `docs/superpowers/specs/2026-11-01-conversation-analyzer-history-import-design.md`. Read it before any task. This plan pins names, signatures and tests; the spec explains why.

## Global Constraints

- **Language:** English in code, UI copy, README, log lines and demo data.
- **Commits:** concise messages, no co-author or "Generated with Claude Code" footers.
- **Standalone folder:** `conversation-analyzer/` imports nothing from the repo root. Fixtures are copied into `conversation-analyzer/tests/fixtures/`.
- **No real keys:** use `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, fake `ak_test` / `pk_smoke_test_key` and Convex local anonymous deployments (`CONVEX_AGENT_MODE=anonymous`). Never touch `~/.claude/channels/whatsapp`. Stop any backend or dev server you start (ports 3210/3211/5173) before finishing a task.
- **Generated code:** `convex/_generated/` is committed. Regenerate it with `cd conversation-analyzer && CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once` after changing Convex functions or the schema, and commit it with the task.
- **Run from `conversation-analyzer/`:** `pnpm test`, `pnpm typecheck`, `pnpm build`. All three must pass at the end of every task.
- **Fixed values:**

  | Name | Value |
  | --- | --- |
  | `DECLINED_CODE` | `2593109` |
  | `STAGE_BATCH` | 500 rows per `history.stage` call |
  | `BUILD_DEBOUNCE_MS` | 600_000 (10 min) |
  | `ANALYZE_BATCH` | 100 conversations per `analyzeImported` call |
  | `ANALYZE_SPACING_MS` | 3000 |
  | `UNANALYZED_COUNT_CAP` | 1000 |

- **Import states, exactly:**
  - history: `requested | importing | done | declined`;
  - contacts: `requested | received`.
- **UI copy, exactly:**
  - Checkboxes: "Import chat history (up to 6 months)" and "Import contacts".
  - Connect note: "Only for numbers on the WhatsApp Business app. Your phone will ask whether to share chat history. WhatsApp allows the import once, right after connecting."
  - Badges: "Importing history {n}%", "Building history", "History imported", "History not shared", "Waiting for history", "Contacts imported", "Imported".
  - Bulk button: "Analyze imported conversations ({n})".
  - Confirm dialog: "This runs the AI analysis on {n} conversations using your OpenRouter key."
  - Declined: "The business chose not to share chat history on the phone. WhatsApp only allows the import once, so it can't be requested again for this number."
  - Connected page: "If you shared chat history on the phone, past conversations appear here in a few minutes."

## Review Focus

1. **A late chunk after the build already ran, for a contact whose last history segment was folded into a live open conversation.** The rebuild must neither duplicate messages nor leave the live conversation with a stale `openedAt`. Pinned in Task 5 (`rebuild after a fold restores the live conversation`).
2. **The same chunk delivered twice with different `webhook-id`s** (Meta retry through pipes.bot). Staging dedupes by wamid, so no conversation or message is doubled. Pinned in Task 4 (`same chunk under two webhook ids stages once`).
3. **A history message whose wamid also arrived live** (an echo captured after onboarding). It appears once, in the live conversation. Pinned in Task 5 (`live wamid is not imported again`).
4. **A chunk that is not shaped as documented** (`history: {}`, a thread without `messages`, a message without `timestamp`). Nothing throws, and the valid rows still stage. Pinned in Task 1 (`flattenHistory skips malformed parts`).
5. **A contacts `remove` that arrives before its `add`** (out of order). The later-timestamped event wins. Pinned in Task 3 (`older add after a remove is ignored`).

---

### Task 1: Pure history helpers and fixtures

**Files:**
- Create: `conversation-analyzer/convex/lib/history.ts`, `conversation-analyzer/convex/lib/history.test.ts`
- Create: `fixtures/byon-v2/history-chunk.json`, `history-complete.json`, `history-declined.json`, `history-media.json`, `smb-app-state-sync.json`, with copies in `conversation-analyzer/tests/fixtures/`
- Modify: `fixtures/README.md` (five rows, kind `docs example`, source `pipes-bot docs/byon-v2-migration.mdx (Chat history and contacts)`)
- Modify: `conversation-analyzer/convex/lib/transcript.ts`, `transcript.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DECLINED_CODE = 2593109;
  export type HistorySummary = {
    declined: boolean;
    progress?: number;    // max numeric history[].metadata.progress
    phase?: number;       // from the first history[] item with metadata
    chunkOrder?: number;  // idem
    messageCount: number; // sum of history[].threads[].messages[] lengths
    mediaFollowUp: boolean; // no history[] array but whatsapp.messages[] non-empty
  };
  export function summarizeHistory(payload: unknown): HistorySummary;
  export type HistoryRow = {
    threadId: string; wamid: string; source: "customer" | "phone";
    type: string; text?: string; sentAt: number;
  };
  export function flattenHistory(payload: unknown): HistoryRow[];
  export function segmentMessages<M extends { wamid: string; sentAt: number }>(
    messages: M[], inactivityMs: number,
  ): M[][];
  ```
- Consumes: `contentOf` and `waTimestampMs` from `convex/lib/payload.ts`.

Fixture content:
- Envelopes use `pipes.poolNumberId: "pn_abc123"` and `appId: "app_abc123"`, the same ids as `number-onboarded.json`.
- `history-chunk.json` is the doc example (phase 0, `chunk_order` 1, progress 40, thread `16505551234` with a customer text and a business `media_placeholder` that has `to`).
- `history-complete.json`: phase 1, `chunk_order` 2, progress 100, thread `16505559876` with four messages (customer, business with `to`, customer, business with `to`) spaced so they form two segments at a 120-minute window.
- `history-declined.json` and `history-media.json` are the doc examples (the media one has `whatsapp.messages[]` with one `image`).
- `smb-app-state-sync.json` has two items: `add` for `16505551234` ("Sheena Nelson"), and `remove` for `16505550000`.

- [ ] **Step 1: Add the five fixtures (root and copies) and the README rows**
- [ ] **Step 2: Write failing tests in `lib/history.test.ts`**
  - `summarizeHistory`:
    - chunk fixture → `{ declined: false, progress: 40, phase: 0, chunkOrder: 1, messageCount: 2, mediaFollowUp: false }`;
    - complete fixture → `progress: 100`;
    - declined fixture → `declined: true, messageCount: 0`;
    - media fixture → `mediaFollowUp: true, messageCount: 0`;
    - `null`, `"x"`, `{ whatsapp: { history: {} } }` → `{ declined: false, messageCount: 0, mediaFollowUp: false }`.
  - `flattenHistory`:
    - chunk fixture → two rows with `threadId: "16505551234"`; the first is `source: "customer", type: "text", text: "do you deliver on sundays?", sentAt: 1760400000000`; the second is `source: "phone", type: "media_placeholder"` with no `text`.
  - `flattenHistory skips malformed parts`:
    - a thread without `id`, a thread with `messages: "x"`, a message without `id` and a message with `timestamp: "abc"` are all dropped;
    - a valid sibling message in the same payload is kept.
  - `segmentMessages`:
    - gaps of 120 min (exactly the window) stay in one segment; a gap of 120 min + 1 ms splits;
    - input given out of order comes back sorted; equal `sentAt` sorts by wamid;
    - `[]` → `[]`.
- [ ] **Step 3: Run** `pnpm test convex/lib/history.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement `convex/lib/history.ts`**
  - Every accessor tolerates any shape, using the `list()` helper from `payload.ts`.
  - `source` is `"phone"` when `msg.to` is a non-empty string, `"customer"` otherwise.
  - A row needs a string `thread.id`, a string `msg.id` and a timestamp that `waTimestampMs(ts, NaN)` turns into a finite number. Anything else is dropped.
- [ ] **Step 5: Transcript.** In `transcript.ts`, `media_placeholder` renders as `[media]`. Add the test `media placeholder renders as [media]` to `transcript.test.ts`.
- [ ] **Step 6: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 7: Commit** `Add history parsing helpers and import fixtures`

### Task 2: Schema, connect flags and onboarding states

**Files:**
- Modify: `convex/schema.ts`, `convex/numbers.ts` (`createSignupLink`), `convex/ingest.ts` (`onboardNumber`)
- Create: `convex/contactLookup.ts`, holding `contactByWaId`, `contactByUserId` and `resolveContact` moved out of `ingest.ts`, unchanged and exported. `ingest.ts` imports them, so `history.ts` and `contactsSync.ts` can use them without an import cycle.
- Test: `convex/numbers.test.ts`, `convex/ingest.test.ts`

**Interfaces:**
- Produces, in `schema.ts`:
  - exported validators `historyImportValidator` and `contactsImportValidator` (fields exactly as in the spec's "Modelo de dados");
  - `numbers.historyImport?`, `numbers.contactsImport?`;
  - `contacts.bookName?`, `bookUpdatedAt?`, `bookRemovedAt?` and index `by_number: ["numberId"]`;
  - `conversations.imported?: true` and index `by_number_imported: ["numberId", "imported"]`;
  - `messages.imported?: true`;
  - `events.storageId?: Id<"_storage">`;
  - table `historyMessages` with the three indexes from the spec.
- Produces: `numbers.createSignupLink` takes the args `{ importHistory: v.boolean(), importContacts: v.boolean() }`.

- [ ] **Step 1: Failing tests**
  - `numbers.test.ts`:
    - update the existing calls to pass `{ importHistory: true, importContacts: false }`;
    - new test `sends the import flags`: the body has `importHistory: true, importContacts: false` next to `metadata` and `redirectUrl`.
  - `ingest.test.ts`:
    - `onboarded with import flags records requested states`: `data.importHistory: true, importContacts: true` → `historyImport` is `{ state: "requested", progress: 0, chunks: 0, messages: 0, conversations: 0, updatedAt: NOW }` and `contactsImport` is `{ state: "requested", updatedAt: NOW }`;
    - `onboarded without flags records nothing`: both fields are absent;
    - `repeated onboarded does not regress import state`: the number already has `historyImport.state: "importing"`, another onboarded arrives with flags, the state stays `importing`.
- [ ] **Step 2: Run** `pnpm test convex/numbers.test.ts convex/ingest.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, `contactLookup.ts`, the flags in the `fetch` body, and the onboarding states (set only when the field is absent on the number).
- [ ] **Step 4: Regenerate `_generated`; run** `pnpm test && pnpm typecheck`. Expected: PASS. `pnpm typecheck` fails in `src/routes/_app/numbers/index.tsx` because it calls `createSignupLink()` without args. Pass `{ importHistory: true, importContacts: true }` there for now; Task 8 replaces it with the panel.
- [ ] **Step 5: Commit** `Request history and contacts import when connecting a number`

### Task 3: Contacts sync and display names

**Files:**
- Create: `convex/contactsSync.ts`, `convex/contactsSync.test.ts`
- Modify: `convex/ingest.ts` (`ENVELOPE_FIELDS`, `projectEnvelope`), `convex/dashboard.ts`

**Interfaces:**
- Produces:
  - `export async function applyStateSync(ctx: MutationCtx, number: Doc<"numbers">, whatsapp: any, now: number): Promise<void>`;
  - `export function contactDisplayName(contact: Doc<"contacts"> | null): string | undefined`, exported from `dashboard.ts`, returning `contact?.bookName ?? contact?.name`.
- Consumes: `contactByWaId` from `contactLookup.ts`; `waTimestampMs` and `list` from `lib/payload.ts`.

- [ ] **Step 1: Failing tests in `contactsSync.test.ts`.** Feed the fixtures through `internal.ingest.ingest`, as `ingest.test.ts` does with a seeded number for `pn_abc123`.
  - `add creates a contact with bookName`: `waId: "16505551234"`, `bookName: "Sheena Nelson"`, `bookUpdatedAt` set from `metadata.timestamp` in ms.
  - `add fills bookName on an existing contact`: the contact already exists from a live message with profile `name: "Sheena"`. `name` stays, `bookName` is set.
  - `remove clears bookName but keeps the contact`: `bookName` is undefined, `bookRemovedAt` is set, and the row and its conversations still exist.
  - `older add after a remove is ignored`: a remove at t=200 followed by an add at t=100 → `bookName` stays undefined.
  - `first event marks contacts received`: `contactsImport.state` goes from `"requested"` to `"received"`.
  - `items without phone_number or with another type are skipped`.
  - `display name prefers the address book`: `dashboard.waiting` and `dashboard.conversations` return `contactName: "Sheena Nelson"` when both names are set, the profile name when only it is set, and `contactLabel` stays the number.
- [ ] **Step 2: Run** `pnpm test convex/contactsSync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the spec's "Contatos". `ENVELOPE_FIELDS` gains `smb_app_state_sync`, and `projectEnvelope` calls `applyStateSync`. The parked replay works unchanged.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Name contacts from the phone's address book`

### Task 4: Receive and stage history chunks

**Files:**
- Create: `convex/history.ts`, `convex/history.test.ts`
- Modify: `convex/webhook.ts`, `convex/webhook.test.ts`, `convex/ingest.ts` (parked replay)

**Interfaces:**
- Produces, in `history.ts`:
  ```ts
  export const historySummaryValidator; // v.object matching HistorySummary
  export const historyRowValidator;     // v.object matching HistoryRow
  export async function applyHistoryEvent(
    ctx: MutationCtx, number: Doc<"numbers">, summary: HistorySummary,
    storageId: Id<"_storage"> | undefined, now: number,
  ): Promise<"processed" | "ignored">;
  export const receive: internalMutation({ webhookId, poolNumberId?, summary, storageId? })
    → "duplicate" | "processed" | "parked" | "ignored";
  export const processChunk: internalAction({ numberId, storageId }) → null;
  export const stage: internalMutation({ numberId, rows: v.array(historyRowValidator) }) → { inserted: number };
  ```
- `receive` stores the event as `{ webhookId, kind: "history", poolNumberId, payload: { field: "history", pipes: { poolNumberId }, summary }, storageId, state, receivedAt }`.
- Blob ownership: `applyHistoryEvent` deletes the blob whenever it returns `ignored` (so the parked replay cleans up too); `receive` deletes it on `duplicate`. A `parked` event keeps its blob.
- `stage` reschedules `internal.history.build` with `{ numberId }`, `BUILD_DEBOUNCE_MS` after the last chunk. Task 5 defines `build`; in this task, add a stub `build` (an `internalMutation` that returns `null`) so the scheduler reference type-checks.

- [ ] **Step 1: Failing tests in `history.test.ts`** (fake timers, as `ingest.test.ts`; write blobs with `t.run(ctx => ctx.storage.store(new Blob([json])))`):
  - `receive on an unknown number parks the event and keeps the blob`.
  - `parked history is replayed on onboarding`: the event becomes `processed`, `processChunk` is scheduled, and `historyImport.chunks === 1`.
  - `receive without a requested import is ignored and deletes the blob`.
  - `declined event marks declined`: the state stays `declined` even after a later chunk.
  - `media follow-up is ignored`.
  - `chunk marks importing and keeps the max progress`: progress 100 then 40 → `progress: 100`.
  - `duplicate webhook id deletes the new blob`.
  - `processChunk stages the rows`: run `t.finishAllScheduledFunctions(vi.runAllTimers)` (the stub `build` does nothing), then assert `historyMessages` has 2 `pending` rows, the contact `16505551234` exists, and `historyImport.messages === 2`.
  - `same chunk under two webhook ids stages once`: still 2 rows, `messages === 2`.
  - `second chunk reschedules the build`: call `internal.history.stage` directly twice with different rows; the first scheduled build is canceled (its `_scheduled_functions` state is `canceled`) and `historyImport.buildJobId` points to the new one.
  - `processChunk with a missing blob does nothing`.
- [ ] **Step 2: Failing tests in `webhook.test.ts`:**
  - `history goes to storage, not ingest`: a signed history chunk → 200, the event has `storageId` and `kind: "history"`, and its `payload` has no `whatsapp`.
  - `a history chunk over 1 MiB is accepted`: one thread with ~6,000 messages, about 1.2 MB.
  - Existing tests unchanged.
- [ ] **Step 3: Run** `pnpm test convex/history.test.ts convex/webhook.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement**
  - `webhook.ts`: when `payload.field === "history"`, run `summarizeHistory`, store the blob only when `messageCount > 0`, then call `internal.history.receive`.
  - `history.ts`: as the spec's "Pipeline do histórico" (receive steps 1–6), with `processChunk` in batches of `STAGE_BATCH`.
  - `ingest.ts` replay: for parked events with `payload.field === "history"`, call `applyHistoryEvent(ctx, number, payload.summary, event.storageId, event.receivedAt)` and patch the event state with the result.
- [ ] **Step 5: Regenerate `_generated`; run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `Receive and stage chat history chunks`

### Task 5: Build imported conversations

**Files:**
- Modify: `convex/history.ts` (replace the stub `build`), `convex/dashboard.ts`
- Test: `convex/history.test.ts` (`describe("build")`)

**Interfaces:**
- Produces:
  - `export async function buildContact(ctx: MutationCtx, number: Doc<"numbers">, contactId: Id<"contacts">): Promise<number>`, returning the imported conversations created (folded segments are not counted);
  - `export const build: internalMutation({ numberId }) → null`;
  - `dashboard.conversations` rows gain `imported: boolean`.
- Consumes: `segmentMessages` (Task 1), `computeMetrics` from `lib/metrics.ts`, the workspace's `inactivityMinutes`.

`buildContact` follows the spec's `history.build` steps 2–5 exactly: undo the previous build, load the staging, drop live wamids, segment, fold into the open live conversation, create the rest, clear `pending`.
- Find the contact's conversations with `by_contact_status` (both statuses) restricted to `number._id`.
- Business source maps to turn `"business"`.
- `lastTurn` and `initiatedBy` of an imported conversation come from its last and first message.

- [ ] **Step 1: Failing tests** (stage rows with `t.mutation(internal.history.stage, …)`, then `t.mutation(internal.history.build, { numberId })` until no `pending` remains):
  - `builds closed imported conversations with metrics`: the `history-complete` rows at a 120-minute window → 2 conversations, each with `imported: true`, `status: "closed"`, `closedAt` = last `sentAt`, and `metrics.firstResponseSeconds` equal to the fixture gap. `analysis` is undefined and nothing is scheduled in `analysis`.
  - `imported conversations count in the overview`: `dashboard.overview({ days: 30 })` includes them when their dates fall inside the window. Write the fixture timestamps relative to `NOW` in the test.
  - `live wamid is not imported again`: a staged row whose wamid exists as a live `messages` row is skipped.
  - `folds the last segment into the open live conversation`: a live open conversation opened 30 min after the last history message receives the segment's messages with `imported: true`, and its `openedAt` moves to the segment start.
  - `does not fold into a closed or distant live conversation`: the segment becomes its own imported conversation.
  - `rebuild after a late chunk is idempotent`: build, stage one more older row, build again → the right segments, no duplicate messages or conversations.
  - `rebuild after a fold restores the live conversation`: build with a fold, stage a late row, build again → the live conversation holds its live messages plus exactly one copy of the folded ones, and `openedAt` is right.
  - `marks done only at progress 100`: progress 40 → `importing` after the build, with `conversations` counted; progress 100 → `done`.
  - `dashboard.conversations marks imported rows`.
- [ ] **Step 2: Run** `pnpm test convex/history.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildContact` and `build`.
  - `build` processes one contact per run, then `runAfter(0, internal.history.build, { numberId })`.
  - The final run counts imported conversations by `by_number_imported` in the number's workspace, clears `buildJobId`, and moves `importing` to `done` when `progress === 100`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Build imported conversations from staged history`

### Task 6: Import status and on-demand analysis

**Files:**
- Modify: `convex/history.ts`, `convex/conversations.ts` (`requestAnalysis`)
- Test: `convex/history.test.ts` (`describe("analyzeImported")`, `describe("importStatus")`)

**Interfaces:**
- Produces:
  ```ts
  // conversations.ts — new optional last parameter, default 0; existing callers unchanged
  export async function requestAnalysis(ctx, conversationId, methodology, delayMs = 0): Promise<void>;
  // history.ts
  export const analyzeImported: mutation({ numberId }) → { requested: number; remaining: number };
  export const importStatus: query({ numberId }) → null | {
    historyImport?: Doc<"numbers">["historyImport"];
    contactsImport?: Doc<"numbers">["contactsImport"];
    building: boolean;           // buildJobId set or any pending row
    importedConversations: number;
    unanalyzed: number;          // capped at UNANALYZED_COUNT_CAP
    bookContacts: number;
  };
  ```
- `analyzeImported` picks imported, closed conversations without `analysis` in the caller's workspace, sorts them by `closedAt` desc, and takes `ANALYZE_BATCH`. The i-th gets `delayMs = i * ANALYZE_SPACING_MS` and the workspace's methodology.

- [ ] **Step 1: Failing tests:**
  - `analyzes only unanalyzed imported conversations`.
  - `caps at 100 and reports remaining`: 105 seeded → `{ requested: 100, remaining: 5 }`.
  - `spaces the analysis jobs`: the scheduled `analyzeConversation` jobs have `scheduledTime` NOW, NOW+3000, NOW+6000, ….
  - `another workspace gets Not found` (for both functions).
  - `importStatus reports counts and building`: pending rows → `building: true`; after the build → `false`, with the counts right.
  - `importStatus is null when nothing was requested`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Analyze imported conversations on demand`

### Task 7: Demo seed with imported history

**Files:**
- Modify: `convex/demo.ts`, `convex/demo.test.ts`

**Interfaces:**
- Consumes: `buildContact` (Task 5), `ingestPayload` for one `smb_app_state_sync` envelope (Task 3).

What `seed` adds after the live scenarios:
- One `smb_app_state_sync` envelope through `ingestPayload`, giving book names to Ana ("Ana Souza"), Ben ("Ben Carter") and two history-only contacts: `15550100005` "Eva Lima" and `15550100006` "Frank Moss".
- `historyMessages` rows (`pending: true`, wamids `wamid.demo_hist_<pool>_<n>`) for Ana, Ben, Eva and Frank, 3 to 20 days before `now`, written so they segment into 6 conversations at the default window. One of them has a customer message with no reply.
- Then `buildContact` for each of the four, and finally the number patched with `historyImport: { state: "done", progress: 100, chunks: 3, messages: <rows>, conversations: 6, updatedAt: now }` and `contactsImport: { state: "received", updatedAt: now }`.

`reset` also deletes the number's `historyMessages` (`by_number_contact_sent_at` prefix) and deletes the storage blob of any deleted event that has a `storageId`.

- [ ] **Step 1: Failing tests in `demo.test.ts`:**
  - `seed creates imported conversations`: 6 conversations with `imported: true`, all closed, none with `analysis`.
  - `seed names contacts from the address book`: `dashboard.waiting` and `dashboard.conversations` show "Ana Souza".
  - `seed sets import states`.
  - `reset removes history rows`: `historyMessages` is empty afterwards.
  - Existing demo assertions keep passing. If a count of conversations in the existing tests changes, update it to include the 6 imported ones.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Seed imported history in the demo`

### Task 8: UI

**Files:**
- Copy: `mini-crm/src/components/ui/dialog.tsx` to `conversation-analyzer/src/components/ui/dialog.tsx`, unchanged.
- Create: `src/components/ImportBadges.tsx` (`export function ImportBadges({ number }: { number: Doc<"numbers"> })`) and `src/components/ImportCard.tsx` (`export function ImportCard({ numberId }: { numberId: Id<"numbers"> })`, which uses `api.history.importStatus` and `api.history.analyzeImported`).
- Modify: `src/routes/_app/numbers/index.tsx`, `numbers/$numberId.tsx`, `numbers/connected.tsx`, `conversations/$conversationId.tsx`, `src/components/ChatView.tsx`.

Behavior, copy as in Global Constraints:
- **`/numbers`:**
  - "Connect a number" toggles an inline panel with two native checkboxes (ticked by default, each with a `Label`), the connect note and a **Continue** button that calls `createSignupLink` with the two values.
  - The table gains an **Import** column with `ImportBadges`, or "—".
  - `ImportBadges` rules:
    - history `importing` + `buildJobId` → "Building history";
    - `importing` → "Importing history {progress}%";
    - `done` → "History imported";
    - `declined` → "History not shared";
    - `requested` → "Waiting for history";
    - contacts `received` → "Contacts imported".
- **`/numbers/$numberId`:**
  - `ImportCard` renders under the header when `importStatus` is not null. It shows the history state, its progress, the imported conversation count, the book contacts count, and the bulk button when `unanalyzed > 0`, behind the confirm `Dialog`. In the declined state it shows the declined copy.
  - Rows of `dashboard.conversations` with `imported` get the "Imported" badge after the contact name.
- **`/conversations/$conversationId`:**
  - The header name is `contact?.bookName ?? contact?.name ?? contact?.waId ?? contact?.userId ?? "Unknown contact"`.
  - The "Imported" badge sits next to the status line.
  - The re-analyze button reads "Analyze" when `analysis === undefined`.
- **`ChatView`:** `media_placeholder` renders as "[media]".
- **`/numbers/connected`:** show the connected copy when the found number has `historyImport`.

- [ ] **Step 1: Implement** the above.
- [ ] **Step 2: Run** `pnpm typecheck && pnpm build && pnpm test`. Expected: PASS.
- [ ] **Step 3: Browser check.** Start a local anonymous backend (`CONVEX_AGENT_MODE=anonymous pnpm exec convex dev`) and `pnpm dev`, sign up, run `pnpm exec convex run demo:seed '{"email":"<you>"}'`. Then check with browser-harness:
  - the Import column on `/numbers`;
  - the panel's checkboxes (untick one; the Continue request is not sent, since the env has fake keys; check that the button calls the action and shows the API error);
  - the Import card with "History imported" and the count;
  - the bulk dialog opens with the copy and Cancel closes it;
  - an imported conversation shows the badge, "Analyze" and "[media]" where relevant;
  - "Ana Souza" is the name shown.

  Stop both servers.
- [ ] **Step 4: Commit** `Show history and contacts import in the UI`

### Task 9: Docs and end-to-end check

**Files:**
- Modify: `conversation-analyzer/README.md`, `scripts/generate-readme.ts` (`KNOWN_FEATURES` gains `history-import` and `contacts-sync`), root `README.md` (via `pnpm readme`).

README content: as the spec's "Integração com o repo" (frontmatter features, "pipes.bot features used", the new section "Chat history and contacts import" with the flow, the files and the limitations, and the two Troubleshooting entries).

- [ ] **Step 1: Write the README changes; run** `pnpm readme` at the repo root, then `pnpm readme:check && pnpm test` (root). Expected: PASS, with no "unknown feature" warning.
- [ ] **Step 2: End-to-end with the simulator** (local anonymous backend, `PIPES_WEBHOOK_SECRET=whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw` set with `convex env set`):
  - (a) sign up once and read the workspace id with `pnpm exec convex data workspaces`;
  - (b) `pnpm exec convex run ingest:ingest` with an onboarded payload for `pn_abc123` carrying `metadata.workspaceId`, `importHistory: true` and `importContacts: true`;
  - (c) from the root, `pnpm simulate byon-v2/history-chunk --url <site>/webhooks/pipes --secret <whsec>`, then `history-complete`, `history-media` and `smb-app-state-sync`;
  - (d) `pnpm exec convex run history:build '{"numberId":"<id>"}'` instead of waiting 10 minutes;
  - (e) in the browser: "History imported", 3 imported conversations, "Sheena Nelson" as a name;
  - (f) on a second number, `history-declined` shows "History not shared".

  Stop the servers.
- [ ] **Step 3: Commit** `Document history and contacts import`

When you open the PR, list as **not verified**: a real Coexistence number with real history, large real chunks, and whether `SMB_SYNC_ENABLED` is on in pipes.bot production.
