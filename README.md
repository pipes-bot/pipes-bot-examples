# pipes.bot examples

Working examples for the [pipes.bot](https://docs.pipes.bot) WhatsApp API: webhook receivers, message senders and small apps. Each folder is standalone, with its own dependencies and README. Pick one, copy it and run it.

## Using an example

Copy a folder into a new directory with [degit](https://github.com/Rich-Harris/degit):

```bash
npx degit pipes-bot/examples/<folder> my-app
cd my-app
```

Then follow the "Run locally" section of that example's README.

## Examples

<!-- examples:start -->

<!-- examples:end -->

## Testing without a phone

You can exercise a webhook starter without a WhatsApp number or a pipes.bot account. This repo ships a mock pipes.bot API and a webhook simulator. Run these from the repo root (`pnpm install` first).

1. Start the mock API. It listens on port 4010 and accepts the send endpoints:

   ```bash
   pnpm mock-api
   ```

2. In another terminal, start a starter pointed at the mock API. Replace `<folder>` with the starter's directory and follow its README for the install and start commands:

   ```bash
   cd <folder>
   PIPES_API_BASE_URL=http://localhost:4010 PIPES_API_KEY=ak_test PIPES_WEBHOOK_SECRET=whsec_test PORT=3000 <start command>
   ```

3. Send a signed fixture to the starter's webhook. The secret must match the one the starter uses:

   ```bash
   pnpm simulate byon-v2/message-text --url http://localhost:3000/webhook --secret whsec_test
   ```

Fixtures live in [`fixtures/`](./fixtures). `byon-v2/*` fixtures are API v2 envelopes for BYON apps (`ak_` keys). `sandbox/*` fixtures use the legacy payload for sandbox numbers (`pk_` keys). See [`fixtures/README.md`](./fixtures/README.md) for the full list.

## Adding an example

1. Create a top-level folder with a self-contained project. Do not import from other examples, `scripts/` or `fixtures/`.
2. Start the folder's `README.md` with this frontmatter. All fields are required:

   ```yaml
   ---
   title: Webhook echo (Hono)
   description: Receives webhooks and replies with the same text.
   type: starter # starter | app
   stack: [hono, node]
   features: [webhooks, sandbox]
   ---
   ```

   Known `features`: `webhooks`, `websocket`, `sandbox`, `byon-v2`, `coexistence`, `echoes`, `embedded-signup`, `templates`, `media`, `mcp`. An unknown feature prints a warning.

3. Use these README sections, in this order: What it shows, pipes.bot features used, Run locally, Deploy, How it works, and Going to production (starters only).
4. Regenerate the table above with `pnpm readme`. `pnpm readme:check` exits 1 if the table is out of date.

Other root scripts: `pnpm test` runs the tooling tests, `pnpm smoke` runs the smoke check, and `pnpm fixtures:sync` refreshes the fixtures copied from docs.pipes.bot.
