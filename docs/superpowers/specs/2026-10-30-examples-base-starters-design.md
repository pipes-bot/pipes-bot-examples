# pipes.bot examples — base do repo + starters (subprojeto 0)

Data: 2026-10-30
Status: aprovado em conversa, aguardando revisão desta spec

## Objetivo

Criar um repositório de exemplos do pipes.bot, no estilo de `vercel/next.js/examples`, que mostre o potencial da plataforma e sirva de ponto de partida para quem integra. O README raiz lista cada exemplo e o que ele tem de diferente.

O repositório é **misto**:

- **Starters** (`with-*`): exemplos mínimos, um por tecnologia, para ver o pipes.bot funcionando em minutos e inspirar o uso em stacks diferentes.
- **Apps completos**: 2–3 aplicações com qualidade de produção, que copiam bem para um projeto real.

Esta spec cobre só o **subprojeto 0**: a estrutura do repo, as ferramentas da raiz, os fixtures e os 4 starters. Cada app completo terá sua própria spec.

## Decisões já tomadas

| Decisão | Escolha |
| --- | --- |
| Perfil do repo | Misto: starters enxutos + 2–3 apps completos de produção |
| Independência | Cada exemplo é autocontido e copiável com `npx degit pipes-bot/examples/<pasta>`. Sem workspace na raiz, sem pacotes compartilhados entre exemplos |
| Idioma | Inglês em código, READMEs e mensagens de log (alinhado com docs.pipes.bot) |
| Modos dos starters | Sandbox (`pk_`) **e** BYON API v2 (`ak_`), escolhido pelo prefixo da chave |
| BYON legacy | Fora do escopo dos starters. O README aponta para os docs |
| Stack dos apps completos (próximas specs) | TanStack Router (SPA estática) + Convex (httpActions, tempo real, scheduler, storage) + Better Auth (componente Convex, plugin `crossDomain`). Apps usam webhooks v2, não WebSocket |
| IA nos apps completos (próximas specs) | OpenRouter, via Vercel AI SDK (`@openrouter/ai-sdk-provider`) nas actions do Convex. Modelo configurável por `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` (padrão: Claude, slug confirmado em cada plano). Saída estruturada sempre validada (zod) com retry. README avisa sobre privacidade e restrição a provedores sem retenção de dados. Starters não usam IA |
| Commits e PRs | Sem rodapé de co-autoria ou "Generated with Claude Code" (ver `AGENTS.md`) |

### Roadmap de subprojetos

0. **Base do repo + starters + fixtures** (esta spec)
1. `conversation-analyzer`: onboarding BYON, recebe todos os webhooks incluindo echoes de coexistence, e analisa cada atendimento (tempo de resposta, aderência a uma metodologia etc.)
2. `mini-crm`: CRM com servidor MCP embutido. Qualquer cliente MCP (Grok, Claude) pode atender através dele
3. `ai-handoff`: a IA atende e pausa quando um humano responde pelo app do celular (detectado pelo echo)

## Estrutura do repositório

```
pipes-bot-examples/
├── README.md                     # intro + tabela gerada (entre marcadores)
├── AGENTS.md                     # regras para agentes (commit/PR style)
├── CLAUDE.md                     # @AGENTS.md
├── LICENSE                       # MIT
├── package.json                  # só ferramentas da raiz, sem workspaces
├── .nvmrc                        # 22
├── fixtures/
│   ├── README.md                 # origem de cada fixture
│   ├── byon-v2/*.json
│   └── sandbox/*.json
├── scripts/
│   ├── generate-readme.ts
│   ├── simulate-webhook.ts
│   ├── mock-pipes-api.ts
│   ├── smoke.ts
│   └── sync-fixtures.ts
├── .github/workflows/ci.yml
├── with-hono-bun/
├── with-fastapi/
├── with-nextjs-route-handler/
└── with-websocket-node/
```

As ferramentas da raiz rodam em Node ≥ 22.18, executando `.ts` direto (type stripping nativo). A única dependência é `yaml`, para ler o frontmatter.

## Convenções de cada exemplo

### Frontmatter do README

Todo `<exemplo>/README.md` começa com:

```yaml
---
title: Hono + Bun webhook
description: Receive and reply to WhatsApp messages with a single Hono file on Bun
type: starter            # starter | app
stack: [hono, bun, typescript]
features: [webhooks, sandbox, byon-v2]
---
```

- `type`, `stack`, `features` e `title` são obrigatórios. `generate-readme.ts` falha com mensagem clara se faltar algum ou se `type` for inválido.
- Valores conhecidos de `features`: `webhooks`, `websocket`, `sandbox`, `byon-v2`, `coexistence`, `echoes`, `embedded-signup`, `templates`, `media`, `mcp`. Um valor desconhecido gera aviso, não erro.

### Seções do README (nesta ordem)

1. What it shows
2. pipes.bot features used
3. Run locally
4. Deploy
5. How it works
6. Going to production (só nos starters)

### Variáveis de ambiente

Todo exemplo traz um `.env.example`. Os nomes são os mesmos em todos:

| Variável | Uso |
| --- | --- |
| `PIPES_API_KEY` | `pk_...` (sandbox) ou `ak_...` (BYON v2). Define o modo |
| `PIPES_WEBHOOK_SECRET` | Segredo do webhook do sandbox, ou `whsec_...` do App BYON |
| `PIPES_API_BASE_URL` | Opcional, padrão `https://api.pipes.bot`. Usado pelo mock nos testes |
| `PORT` | Opcional, padrão `3000` |

## Starters

### Contrato comum (webhook starters)

Todo starter webhook implementa exatamente este comportamento, em ~80–120 linhas:

1. **Na inicialização**, lê `PIPES_API_KEY`. Se faltar, ou se o prefixo não for `pk_` nem `ak_`, encerra com mensagem clara. O prefixo define o modo.
2. **Lê o body cru** antes de qualquer parse.
3. **Valida a assinatura** do modo ativo com comparação em tempo constante:
   - Sandbox: `X-Pipes-Signature` = HMAC-SHA256 **hex** do body com o segredo cru. Se `PIPES_WEBHOOK_SECRET` não estiver definido, pula a validação com um aviso no startup (os docs tornam o segredo opcional no sandbox).
   - BYON v2: Standard Webhooks. O conteúdo assinado é `{webhook-id}.{webhook-timestamp}.{body}` e a chave é o base64-decode do que vem depois de `whsec_`. Aceita qualquer `v1,<sig>` da lista separada por espaço e rejeita timestamps com mais de 5 min de diferença. No modo BYON, `PIPES_WEBHOOK_SECRET` é obrigatório.
   - Assinatura inválida: **401**. JSON inválido: **400**.
4. **Payloads de teste** (`{"test": true}` no sandbox, `{"event": "test"}` no BYON): responde 200 sem processar.
5. **Deduplica** por `webhook-id` (BYON) ou pelo id da mensagem (sandbox), usando um `Set` em memória limitado a 1.000 entradas, com um comentário avisando que em produção isso vai para o banco.
6. **Filtra o que merece resposta:**
   - Sandbox: `entry[0].changes[0].value.messages[]` com `type === "text"`.
   - BYON v2: `field === "messages"` **e** `whatsapp.messages[]` com `type === "text"`. Ignora `statuses`, `smb_message_echoes`, `message_template_status_update`, eventos de sistema e `number.onboarded` (estes só são logados). Ignorar o echo evita que o bot responda a si mesmo.
   - Remetente no v2: `message.from ?? message.from_user_id` (usuários com BSUID podem não ter telefone).
7. **Responde 200 antes de enviar.** O envio acontece depois da resposta, no idioma de cada stack.
8. **Envia `Echo: <texto>`:**
   - Sandbox: `POST {base}/v1/messages/send` com `{ conversationId, text }`, usando `pipes.conversationId`.
   - BYON v2: `POST {base}/v1/messages/app/send` com `{ poolNumberId, to, text }`, usando `pipes.poolNumberId`.
   - Falha no envio é logada (status + body) e não derruba o processo.
9. Loga uma linha por evento: `received <kind> <id>`, `replied <id>`, `skipped <reason> <id>` e `duplicate <id>`. O smoke test não depende desses logs, mas eles ajudam quem roda local.

### Particularidades de cada starter

| Starter | Ensina | Run | Envio após 200 |
| --- | --- | --- | --- |
| `with-hono-bun` | O mínimo possível, num arquivo | `bun run index.ts` | promise sem `await`, com `.catch` |
| `with-fastapi` | Python, `await request.body()`, `hmac.compare_digest`, `httpx` | `uv run main.py` (deps em `pyproject.toml`) | `BackgroundTasks` |
| `with-nextjs-route-handler` | Serverless, `app/api/webhook/route.ts`, botão "Deploy to Vercel" | `pnpm dev` | `after()` de `next/server` |
| `with-websocket-node` | Sem URL pública | `pnpm start` (`node index.ts` com type stripping, dependência `ws`) | n/a |

**`with-websocket-node`** segue o contrato acima onde se aplica (modo pelo prefixo, filtros, dedup, logs), com estas diferenças:

- Conecta em `wss://api.pipes.bot/ws?apiKey=<key>`. Com `pk_` a conexão tem escopo de usuário, com `ak_` escopo de App.
- Sandbox: recebe frames `whatsapp_message` e responde com frames `whatsapp_reply` `{ conversationId, toNumber, text }`.
- BYON v2: recebe frames `event` (envelope v2) e responde com frames `send` `{ requestId, poolNumberId, message }` (corpo Meta, `to` ou `recipient`). Loga cada `send_result`.
- Manda ping a cada 25s e reconecta com backoff exponencial (1s, 2s, 4s… até 30s), zerando o contador depois de conectar.
- Não usa `PIPES_WEBHOOK_SECRET`.

### "Going to production" nos starters

Seção curta em cada README:

- No sandbox o número é compartilhado, não há templates e só dá para responder dentro da janela de 24h.
- O que muda no BYON v2: chave `ak_`, assinatura `whsec_`, envelope v2 e `app/send`.
- Mover a deduplicação para o banco.
- Links para os apps completos e para docs.pipes.bot.

## Fixtures

`fixtures/` guarda os eventos usados pelo `simulate` e pelo smoke test.

### `fixtures/byon-v2/`

- **Copiados** de `https://docs.pipes.bot/fixtures/byon-v2/<name>.json` (11 arquivos): `message-text`, `message-text-username-with-phone`, `message-text-bsuid-only`, `message-text-parent-bsuid`, `message-image`, `message-contact-request`, `status-delivered-bsuid`, `status-failed`, `system-user-changed-number`, `system-user-changed-user-id`, `template-status-update`.
- **Montados a partir dos exemplos dos docs** (não estão publicados como arquivo):
  - `smb-message-echo.json`: do exemplo em `byon/coexistence.mdx` (`field: "smb_message_echoes"`, `whatsapp.message_echoes[]`).
  - `number-onboarded.json`: do exemplo em `byon/webhook-delivery.mdx` (sem `id` no body).
  - `test-webhook.json`: botão "Test Webhook" do App (`webhooks/payload.mdx`).

### `fixtures/sandbox/` (payload legacy)

Todos montados a partir de `webhooks/payload.mdx`: `message-text.json`, `message-image.json` e `test-connection.json` (`{"test": true, "source": "pipes.bot"}`).

### Origem e atualização

- `fixtures/README.md` lista cada arquivo com a origem: "docs file" (URL) ou "docs example" (página `.mdx`).
- `pnpm fixtures:sync` baixa de novo apenas os arquivos de origem "docs file" e mostra o diff. Os outros são mantidos à mão.
- Fora do escopo, mas vale registrar: publicar o echo, o `number.onboarded` e os fixtures do sandbox em `pipes-bot-docs/public/fixtures/` deixaria uma fonte única. É uma mudança no repo de docs, a fazer depois.

## Ferramentas da raiz

Scripts do `package.json`:

| Script | Faz |
| --- | --- |
| `pnpm readme` | Lê o frontmatter de `*/README.md` e reescreve a tabela entre `<!-- examples:start -->` e `<!-- examples:end -->` no README raiz. Dois grupos (Starters, Apps), colunas: Example (link) · Stack · pipes.bot features · Description. Ordem alfabética por pasta |
| `pnpm readme:check` | Igual, mas não escreve. Sai com código 1 se o resultado for diferente do arquivo |
| `pnpm simulate <fixture> [--url] [--secret] [--times N] [--bad-signature]` | Envia um fixture assinado. O modo vem da pasta (`byon-v2/` ou `sandbox/`). Padrões: `--url http://localhost:3000/webhook`, `--secret` de `PIPES_WEBHOOK_SECRET`, `--times 1`. No BYON, `webhook-id` = `id` do envelope ou, se não houver, um id estável derivado do nome do fixture. `--times 2` testa a deduplicação |
| `pnpm mock-api [--port 4010]` | Sobe um mock da API do pipes.bot que aceita `POST /v1/messages/send` e `/v1/messages/app/send`, registra cada chamada e responde no formato real. Também expõe `GET /__calls` e `DELETE /__calls` para o smoke test |
| `pnpm smoke [starter]` | Smoke test descrito abaixo |
| `pnpm fixtures:sync` | Ver Fixtures |

Para testar local sem celular, rode o starter com `PIPES_API_BASE_URL=http://localhost:4010` e `pnpm mock-api` em outro terminal. Assim o `simulate` exercita o fluxo inteiro, inclusive o envio da resposta.

## Smoke test

`scripts/smoke.ts` roda cada starter webhook (ou só o passado como argumento) uma vez **por modo**:

1. Sobe o mock da API.
2. Sobe o starter com `PIPES_API_KEY` fictícia do modo, um segredo de teste e `PIPES_API_BASE_URL` apontando para o mock. Espera a porta abrir (timeout de 30s).
3. Roda a matriz de casos e verifica o status HTTP e as chamadas registradas no mock (com uma espera curta, porque o envio acontece depois do 200).
4. Encerra os processos e imprime um resumo. Sai com 1 se qualquer caso falhar.

Matriz de casos:

| Modo | Caso | HTTP esperado | Chamadas de envio esperadas |
| --- | --- | --- | --- |
| sandbox | `message-text` | 200 | 1 em `/v1/messages/send`, texto `Echo: …`, `conversationId` do fixture |
| sandbox | `message-image` | 200 | 0 |
| sandbox | `test-connection` | 200 | 0 |
| sandbox | `message-text` com `--bad-signature` | 401 | 0 |
| sandbox | `message-text` com `--times 2` | 200, 200 | 1 |
| byon-v2 | `message-text`, `message-text-username-with-phone` | 200 | 1 cada em `/v1/messages/app/send`, `poolNumberId` do fixture e `to` = telefone (`from`) |
| byon-v2 | `message-text-bsuid-only`, `message-text-parent-bsuid` | 200 | 1 cada, com `to` = BSUID (`from_user_id`), porque não há `from` |
| byon-v2 | `message-image`, `message-contact-request` | 200 | 0 |
| byon-v2 | `smb-message-echo` | 200 | 0 (não responde a si mesmo) |
| byon-v2 | `status-delivered-bsuid`, `status-failed`, `system-*`, `template-status-update`, `number-onboarded`, `test-webhook` | 200 | 0 |
| byon-v2 | `message-text` com `--bad-signature` | 401 | 0 |
| byon-v2 | `message-text` com timestamp de 10 min atrás | 401 | 0 |
| byon-v2 | `message-text` com `--times 2` | 200, 200 | 1 |

`with-websocket-node` não entra no smoke test (precisaria de um servidor WebSocket real). No CI ele passa só por typecheck.

## CI

`.github/workflows/ci.yml`, em push e pull request:

1. **readme**: `pnpm install` + `pnpm readme:check`.
2. **smoke**: configura Node 22, Bun, Python + uv e pnpm, instala as dependências de cada starter e roda `pnpm smoke`.
3. **typecheck**: `tsc --noEmit` em `with-websocket-node`, `with-nextjs-route-handler`, `with-hono-bun` e `scripts/`.

## README raiz

- O que é o pipes.bot, em um parágrafo, com link para docs.pipes.bot.
- Como usar um exemplo: `npx degit pipes-bot/examples/<folder> my-app`.
- Tabela gerada (Starters, Apps).
- Testar sem celular: `mock-api` + `simulate`.
- Como contribuir com um novo exemplo: frontmatter, seções obrigatórias, `pnpm readme`.

## Fora do escopo

- Apps completos (subprojetos 1–3, com specs próprias).
- BYON legacy nos starters.
- Envio de mídia, templates e mensagens interativas nos starters.
- Criar o repositório no GitHub ou publicar qualquer coisa (só com pedido explícito).
- Mudanças em `pipes-bot-docs` (publicar os fixtures que faltam).

## Critérios de aceite

- `pnpm readme:check` passa e o README raiz lista os 4 starters com stack e features corretos.
- `pnpm smoke` passa para os 3 starters webhook nos dois modos, com a matriz completa.
- `with-websocket-node` passa no typecheck. Conectado com uma chave real (`pk_` ou `ak_`), responde `Echo: <texto>` a uma mensagem de texto. Esta verificação é manual e fica registrada no PR.
- Cada starter webhook tem no máximo ~120 linhas de código (fora README e configs).
- Cada README segue o frontmatter e as seções obrigatórias.
- Nenhum commit ou PR contém rodapé de co-autoria.
