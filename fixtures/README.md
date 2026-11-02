# Fixtures

Webhook payloads used by the simulator, the mock API and the tests.

- `byon-v2/` holds API v2 envelopes (BYON Apps with an `ak_` key).
- `sandbox/` holds legacy Meta-shaped payloads (sandbox numbers with a `pk_` key).

| File | Source | Kind |
| --- | --- | --- |
| `byon-v2/message-contact-request.json` | https://docs.pipes.bot/fixtures/byon-v2/message-contact-request.json | docs file |
| `byon-v2/message-image.json` | https://docs.pipes.bot/fixtures/byon-v2/message-image.json | docs file |
| `byon-v2/message-text-bsuid-only.json` | https://docs.pipes.bot/fixtures/byon-v2/message-text-bsuid-only.json | docs file |
| `byon-v2/message-text-parent-bsuid.json` | https://docs.pipes.bot/fixtures/byon-v2/message-text-parent-bsuid.json | docs file |
| `byon-v2/message-text-username-with-phone.json` | https://docs.pipes.bot/fixtures/byon-v2/message-text-username-with-phone.json | docs file |
| `byon-v2/message-text.json` | https://docs.pipes.bot/fixtures/byon-v2/message-text.json | docs file |
| `byon-v2/status-delivered-bsuid.json` | https://docs.pipes.bot/fixtures/byon-v2/status-delivered-bsuid.json | docs file |
| `byon-v2/status-failed.json` | https://docs.pipes.bot/fixtures/byon-v2/status-failed.json | docs file |
| `byon-v2/system-user-changed-number.json` | https://docs.pipes.bot/fixtures/byon-v2/system-user-changed-number.json | docs file |
| `byon-v2/system-user-changed-user-id.json` | https://docs.pipes.bot/fixtures/byon-v2/system-user-changed-user-id.json | docs file |
| `byon-v2/template-status-update.json` | https://docs.pipes.bot/fixtures/byon-v2/template-status-update.json | docs file |
| `byon-v2/smb-message-echo.json` | `byon/coexistence.mdx` (Message echoes) | docs example |
| `byon-v2/number-onboarded.json` | `byon/webhook-delivery.mdx` (The `number.onboarded` event) | docs example |
| `byon-v2/history-chunk.json` | `pipes-bot docs/byon-v2-migration.mdx (Chat history and contacts)` | docs example |
| `byon-v2/history-complete.json` | `pipes-bot docs/byon-v2-migration.mdx (Chat history and contacts)` | docs example |
| `byon-v2/history-declined.json` | `pipes-bot docs/byon-v2-migration.mdx (Chat history and contacts)` | docs example |
| `byon-v2/history-media.json` | `pipes-bot docs/byon-v2-migration.mdx (Chat history and contacts)` | docs example |
| `byon-v2/smb-app-state-sync.json` | `pipes-bot docs/byon-v2-migration.mdx (Chat history and contacts)` | docs example |
| `byon-v2/test-webhook.json` | `webhooks/payload.mdx` (Test payloads, Test Webhook) | docs example |
| `sandbox/test-connection.json` | `webhooks/payload.mdx` (Test payloads, Test Connection) | docs example |
| `sandbox/message-text.json` | `webhooks/payload.mdx` (Legacy payload, Text) | docs example |
| `sandbox/message-image.json` | `webhooks/payload.mdx` (Legacy payload, Image) | docs example |

`docs file` rows are copies of files published at docs.pipes.bot. `docs example` rows are built by hand from the JSON examples on the given `.mdx` page of the docs.

`pnpm fixtures:sync` refreshes only the `docs file` rows. Edit `docs example` rows by hand when the docs change.
