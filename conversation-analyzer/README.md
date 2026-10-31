---
title: Conversation analyzer
description: Connect WhatsApp Business numbers, capture every reply sent from the phone, and score each conversation on response time and your support methodology
type: app
stack: [tanstack-router, convex, better-auth, openrouter, typescript]
features: [webhooks, byon-v2, embedded-signup, coexistence, echoes]
---

# Conversation analyzer

## What it shows

Work in progress. Connect WhatsApp Business numbers, capture every reply sent from the phone, and score each conversation on response time and your support methodology.

## Run locally

```bash
pnpm install
CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once   # local anonymous deployment, no account needed
pnpm convex                                                # keep the local backend running
pnpm dev                                                   # web app
pnpm test
```
