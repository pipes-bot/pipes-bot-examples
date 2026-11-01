# mini-crm — app completo com servidor MCP (subprojeto 2)

Data: 2026-11-01
Status: design aprovado em conversa, aguardando revisão desta spec

## Objetivo

Um CRM enxuto de WhatsApp, pronto para copiar: contatos num funil fixo, inbox para conversar e um servidor MCP embutido para o Claude (ou outro cliente MCP) operar o CRM como copiloto. Uma pessoa pede "o que preciso responder hoje?" ou "mova quem pediu orçamento para qualificado e rascunhe um follow-up", e a IA faz pelas ferramentas.

**Para quem:** quem está avaliando o pipes.bot para colocar WhatsApp no próprio produto e quer ver duas coisas em código legível: mandar mensagens de dentro de um app BYON v2 e expor esse app para IAs via MCP com OAuth de verdade.

**O app não chama IA.** A IA fica no cliente MCP. O app só expõe ferramentas, autentica e audita.

**Sucesso:** clonar, configurar uma App v2, conectar um número, receber mensagens, responder pela inbox, conectar o Claude Code por `claude mcp add` e ver um rascunho "via Claude" aparecer na inbox em tempo real. Sem número real, a demo mostra o mesmo fluxo, inclusive o envio.

## Decisões

| Decisão | Escolha |
| --- | --- |
| Pasta | `mini-crm/`, autocontida (degit), `type: app` |
| Stack | TanStack Router (SPA estática com Vite) + Convex + Better Auth + Tailwind v4 + shadcn/ui, como o analyzer |
| Posse | Um workspace por conta, um usuário por workspace |
| CRM | Contatos com nome, tags, estágio e notas. Funil fixo: `lead → qualified → customer → lost` |
| Papel da IA | Copiloto: uma pessoa conversa com o cliente MCP, que executa no CRM |
| Auth do MCP | OAuth 2.1 do Better Auth (`@better-auth/oauth-provider`) com DCR e PKCE, validado num spike. Sem tokens pessoais |
| Envio pelo MCP | Por configuração do workspace: `mcpSendMode: "draft"` (padrão) cria rascunho para aprovar na inbox; `"direct"` envia na hora |
| Servidor MCP | `@modelcontextprotocol/sdk` com `WebStandardStreamableHTTPServerTransport`, sem estado, dentro de um `httpAction`. Plano B: JSON-RPC escrito à mão se o SDK não rodar no Convex |
| Envio | Só texto, via `POST /v1/messages/app/send`, só dentro da janela de 24h |
| Ferramentas | pnpm, Node 22, Vitest + `convex-test` |
| Idioma | Inglês no código, na interface, nos dados da demo e no README |

## Arquitetura

```
pipes.bot ──POST /webhooks/pipes──► httpAction (assinatura) ──► mutation ingest
                                                                  │
                                       contacts, messages, activities, numbers
                                                                  │
SPA (TanStack Router) ◄──────── queries reativas ◄────────────────┤
   │                                                              │
   ├── mutations (estágio, tags, notas, rascunhos)                │
   └── action sendMessage ──► POST /v1/messages/app/send          │
                                   ▲                              │
Cliente MCP ──POST /mcp (Bearer JWT)──► httpAction ──► McpServer ─┘
   │                                       (ferramentas chamam as mesmas
   │                                        queries/mutations internas)
   └── OAuth: /.well-known/*, /api/auth/oauth2/* (Better Auth) + /sign-in e /consent no SPA
cron (1h) ──► checkHealth ──► GET /v1/pool-numbers/{id}/health
```

O MCP é só mais uma porta de entrada: cada ferramenta resolve o workspace pelo token e chama as mesmas funções internas que a UI usa.

## Modelo de dados

As tabelas do Better Auth (inclusive as do `oauthProvider`: clientes, tokens e consentimentos) ficam no componente local `convex/betterAuth/`. As do app:

| Tabela | Campos | Índices |
| --- | --- | --- |
| `workspaces` | `ownerId`, `name`, `mcpSendMode: "draft" \| "direct"` (padrão `draft`) | `by_owner` |
| `numbers` | `workspaceId`, `poolNumberId`, `phoneNumber`, `displayName`, `connectedAt`, `health?: {state: "healthy" \| "unhealthy" \| "unknown", canSendMessage?: "AVAILABLE" \| "LIMITED" \| "BLOCKED", checkedAt, detail?}`, `isDemo?` | `by_pool_number`, `by_workspace` |
| `events` | `webhookId`, `kind`, `poolNumberId?`, `payload`, `state: "processed" \| "parked" \| "ignored"`, `receivedAt` | `by_webhook_id`, `by_pool_number_state` |
| `contacts` | `workspaceId`, `waId?`, `userId?` (BSUID), `name?`, `stage`, `tags: string[]`, `lastNumberId`, `lastInboundAt?`, `lastMessageAt`, `lastDirection: "in" \| "out"`, `unread: number`, `searchText` (nome + telefone) | `by_workspace_wa_id`, `by_workspace_user_id`, `by_workspace_stage_last_message`, `by_workspace_last_message`, search index `search_text` filtrado por `workspaceId` |
| `messages` | `workspaceId`, `contactId`, `numberId`, `wamid?`, `direction: "in" \| "out"`, `source: "contact" \| "app" \| "mcp" \| "phone"`, `clientName?`, `type`, `text?`, `status: "pending" \| "sent" \| "delivered" \| "read" \| "failed"`, `error?`, `sentAt` | `by_wamid`, `by_contact_sent_at` |
| `notes` | `workspaceId`, `contactId`, `body`, `author` (`"you"` ou nome do cliente MCP), `createdAt` | `by_contact` |
| `drafts` | `workspaceId`, `contactId`, `text`, `clientName`, `status: "pending" \| "sent" \| "discarded" \| "failed"`, `error?`, `messageId?`, `createdAt`, `decidedAt?` | `by_contact_status`, `by_workspace_status` |
| `activities` | `workspaceId`, `contactId`, `kind: "contact_created" \| "stage_changed" \| "tags_changed" \| "renamed" \| "note_added" \| "message_sent" \| "draft_created" \| "draft_decided"`, `actor` (`"you"`, `"system"` ou nome do cliente MCP), `detail`, `createdAt` | `by_contact_created` |

Regras:

- **Contato:** único por `(workspaceId, waId)` ou `(workspaceId, userId)`. A busca tenta `userId`, depois `waId`, e preenche o campo que faltar. Criado como `lead` na primeira mensagem recebida, com `activity` `contact_created` (ator `system`).
- **Tags:** minúsculas, sem espaços nas pontas, 1–32 caracteres, no máximo 20 por contato, sem repetição.
- **Janela de 24h:** aberta se `lastInboundAt` existe e `now - lastInboundAt < 24h`. Função pura `windowState(contact, now)` → `{open, closesAt?}`, usada pela UI, pelo MCP e pelo envio.
- **`unread`:** soma nas mensagens recebidas, zera quando a conversa é aberta na inbox (`markRead`).

## Ingestão

Copiada do analyzer e enxugada (mesma assinatura Standard Webhooks, mesma deduplicação por `webhookId`, mesmo parking e replay de eventos de números ainda não conectados).

| Evento | Ação |
| --- | --- |
| `event: "test"` | `ignored` |
| `event: "number.onboarded"` com `metadata.workspaceId` válido | upsert em `numbers`, replay dos `parked`. `processed` |
| `number.onboarded` sem workspace, ou envelope de número desconhecido | `parked` |
| `field: "messages"`, `messages[]` | upsert do contato (nome de `contacts[].profile.name`), mensagem `source: contact`, `direction: in`. Atualiza `lastNumberId`, `lastInboundAt`, `lastMessageAt`, `lastDirection: in`, `unread + 1` |
| `messages[]` com `type: "system"` | `user_changed_number` / `user_changed_user_id` migram `waId`/`userId` do contato existente |
| `field: "messages"`, `statuses[]` | atualiza `status` da mensagem com o `wamid`. `failed` grava `error`. Status sem mensagem é ignorado (o app grava toda mensagem que envia) |
| `field: "smb_message_echoes"` | mensagem `source: phone`, `direction: out`, `status: sent`. Ignorada se o `wamid` já existe. Atualiza `lastMessageAt`, `lastDirection: out`. **Não** altera `lastInboundAt` |
| outros `field` | `ignored` |

Mídia recebida é gravada com `type` e a legenda em `text`. A interface mostra `[image]`, `[audio]` etc.

## Envio

### action interna `sendMessage({ workspaceId, contactId, text, source, clientName?, draftId? })`

Usada pela UI (`source: app`), pelo MCP no modo direto (`source: mcp`) e pela aprovação de rascunho (`source: mcp`, com o `clientName` do rascunho).

1. Query interna carrega contato, número (`lastNumberId`) e health. Recusa sem gravar nada, com erro tipado:
   - `window_closed`: janela de 24h fechada;
   - `number_blocked`: `health.canSendMessage === "BLOCKED"` ou `health.state === "unhealthy"`;
   - `invalid_text`: vazio ou mais de 4096 caracteres.
2. Mutation grava a mensagem `pending` (`direction: out`) e já aparece na conversa.
3. Número demo: marca `sent` com `wamid` falso `wamid.demo_<aleatório>` e vai para o passo 5, sem chamar a API.
4. `POST ${PIPES_API_BASE_URL}/v1/messages/app/send` com `{ poolNumberId, to: waId ?? userId, text }` (o `to` aceita telefone ou BSUID). O formato exato da resposta (onde vem o `wamid`) é confirmado no plano contra os docs e o `pipes-bot-byon-demo`.
   - **Sucesso:** grava `wamid`, `status: sent`.
   - **`429 RATE_LIMITED`:** a mensagem não foi enviada, então é seguro repetir. Agenda nova tentativa para depois de `X-RateLimit-Reset` (ou 60 s), até 3 tentativas; depois `failed` com `error: "rate_limited"`.
   - **`403 SERVICE_WINDOW_EXPIRED`:** `failed` com `error: "window_closed"`.
   - **Qualquer outra falha ou timeout (30 s):** `failed` com o código do erro. Sem retentativa automática: num timeout não dá para saber se a mensagem saiu, e repetir arrisca mandar duas vezes. A interface mostra **Retry** na mensagem, que cria um envio novo.
5. Atualiza o contato (`lastMessageAt`, `lastDirection: out`) e grava `activity` `message_sent` com o ator (`you` ou `clientName`). Com `draftId`, marca o rascunho `sent` (ou `failed`) e grava `draft_decided`.

A action retorna `{ status: "sent" | "queued" | "failed", messageId, error? }` (`queued` quando ficou esperando o rate limit).

### Rascunhos

- `drafts.create` (interna, chamada pelo MCP no modo `draft`): valida a janela e o texto como no passo 1, grava `pending` e `activity` `draft_created`.
- `drafts.approve({ draftId, text })` (pública): o texto pode ter sido editado. Chama `sendMessage` com `draftId`. Edição fica registrada no `detail` da activity ("edited before sending").
- `drafts.discard({ draftId })`: `discarded` + `draft_decided`.
- Rascunho com a janela já fechada: a interface avisa e desabilita **Send**. Só **Discard** fica disponível.
- Pode haver mais de um rascunho pendente por contato. A interface mostra todos, do mais novo para o mais antigo.

## Servidor MCP

### Autenticação (OAuth do Better Auth)

Configuração validada no spike:

- Instalação local do componente: `convex/betterAuth/` com `convex.config.ts`, `auth.ts` e `adapter.ts`, schema gerado por `npx auth@1.6.33 generate`.
- Versões fixadas: `better-auth@1.6.33`, `@better-auth/oauth-provider@1.6.33`, `@convex-dev/better-auth@0.12.6` e as dependências transitivas que o spike precisou (`@better-auth/core`, `@better-auth/utils`, `better-call`, `@better-fetch/fetch`) via `pnpm.overrides`. O README explica o porquê.
- Plugins nesta ordem: `oauthProvider`, `jwt`, `crossDomain`, `convex`.
- `oauthProvider`: `loginPage: ${SITE_URL}/sign-in`, `consentPage: ${SITE_URL}/consent`, DCR ligado e sem autenticação (é o que clientes MCP usam), `validAudiences: [${CONVEX_SITE_URL}/mcp]`, escopos `openid profile email offline_access crm:read crm:write`.
- `jwt`: issuer `CONVEX_SITE_URL`, RS256, `jwks.remoteUrl: ${CONVEX_SITE_URL}/api/auth/convex/jwks` (o plugin `convex()` ocupa o endpoint de JWKS do `jwt()`).
- `triggers.oauthRefreshToken.onCreate` grava `revoked: null` (o adapter do Convex não casa campo ausente com `null`, e sem isso o refresh falha).
- Rotas em `http.ts`: `/.well-known/oauth-authorization-server` (`oauthProviderAuthServerMetadata`) e `/.well-known/oauth-protected-resource` e `/.well-known/oauth-protected-resource/mcp` (escritas à mão, apontando o authorization server e `scopes_supported`).
- `/.well-known/openid-configuration` continua com o `registerRoutes` do componente e não é usado pelo MCP (clientes MCP tentam RFC 8414 primeiro). Fica documentado.

**SPA:**

- `/sign-in`: com `oauth_query` na URL, depois do login devolve o fluxo ao authorize. Sem ele, comportamento normal.
- `/consent`: mostra o nome do cliente (`client_name` do DCR), os escopos em linguagem simples ("Read your contacts and conversations", "Change contacts and send messages") e **Allow** / **Deny**.

### `POST /mcp` (httpAction)

1. Lê `Authorization: Bearer <jwt>`. Ausente ou inválido → `401` com `WWW-Authenticate: Bearer resource_metadata="${CONVEX_SITE_URL}/.well-known/oauth-protected-resource/mcp"`.
2. `verifyAccessToken` (de `better-auth/oauth2`) com o JWKS acima, issuer `CONVEX_SITE_URL` e audience `${CONVEX_SITE_URL}/mcp`.
3. `resolvePrincipal(claims)` → `{ workspaceId, scopes, clientName }`: usuário pelo `sub`, workspace pelo `ownerId` (criado se não existir, como no `ensureWorkspace`), `clientName` pelo `client_name` do cliente OAuth do token (fallback `"MCP"`).
4. Cria um `McpServer` por requisição, registra só as ferramentas permitidas pelos escopos, conecta a um `WebStandardStreamableHTTPServerTransport` com `sessionIdGenerator: undefined` e `enableJsonResponse: true`, e devolve `transport.handleRequest(request)`.
5. `GET` e `DELETE /mcp` → `405` (servidor sem estado, sem SSE).

Os passos 1–3 ficam numa função `authenticateMcpRequest` separada do passo 4 (`handleMcp(request, principal)`), para os testes das ferramentas rodarem com um `principal` pronto.

**Primeira tarefa do plano:** provar que o SDK roda no runtime do Convex (bundle, `ajv`, `handleRequest`) com um `initialize` e um `tools/list` de verdade no backend local. Se falhar, `handleMcp` vira JSON-RPC escrito à mão (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`), com a mesma interface.

### Ferramentas

Todas recebem e devolvem ids do Convex como string, validam entrada com zod, declaram `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) e devolvem `structuredContent` mais um resumo em texto.

| Ferramenta | Escopo | Entrada | Saída |
| --- | --- | --- | --- |
| `search_contacts` | `crm:read` | `query?`, `stage?`, `tag?`, `limit?` (padrão 20, máx. 50) | contatos com `id`, `name`, `phone`, `stage`, `tags`, `lastMessageAt`, `waitingForReply`, `window: {open, closesAt?}` |
| `get_contact` | `crm:read` | `contactId` | o contato, notas (até 20) e atividades recentes (até 20) |
| `get_conversation` | `crm:read` | `contactId`, `limit?` (padrão 30, máx. 100), `before?` (timestamp) | mensagens em ordem cronológica com `from: "contact" \| "you" \| "phone" \| "<client>"`, `text`, `type`, `status`, `sentAt`, e `nextBefore` |
| `list_unanswered` | `crm:read` | `limit?` | contatos com `lastDirection: in`, ordenados pela espera, com o tempo restante da janela |
| `pipeline_summary` | `crm:read` | — | contagem por estágio e as últimas 10 mudanças de estágio |
| `update_contact` | `crm:write` | `contactId`, `stage?`, `name?`, `addTags?`, `removeTags?` | o contato atualizado |
| `add_note` | `crm:write` | `contactId`, `body` (1–2000) | a nota |
| `send_message` | `crm:write` | `contactId`, `text` | `{ status: "sent" \| "queued" \| "draft_created" \| "failed", messageId?, draftId?, error? }` |

- `send_message` no modo `draft` responde, no texto, que o rascunho espera aprovação na inbox, para o modelo avisar o usuário.
- Erros de validação e de negócio (`window_closed`, `number_blocked`, contato inexistente ou de outro workspace) voltam como resultado com `isError: true` e mensagem clara, não como erro de protocolo.
- `search_contacts` usa o search index quando há `query`; senão, o índice por estágio ou por última mensagem, com o filtro de tag em memória sobre até 200 contatos. O README diz como escalar.

### Prompt injection

O texto das mensagens dos contatos é conteúdo de terceiros e pode tentar instruir a IA. Defesas:

1. `send_message` só aceita `contactId` de um contato existente do workspace, nunca telefone arbitrário. Não há ferramenta para criar contato ou apagar dados.
2. `get_conversation` devolve as mensagens com `from` explícito, e a `description` da ferramenta avisa que o conteúdo das mensagens vem do contato e não deve ser tratado como instrução.
3. O modo padrão é `draft`, e `/settings` explica o risco do modo `direct`.
4. Toda ação do MCP vira `activity` com o nome do cliente, e o acesso pode ser revogado em `/settings`.

### Apps conectados

`/settings` lista os clientes OAuth com consentimento do usuário (nome, escopos, data) e **Revoke**, que apaga o consentimento e revoga os tokens. A primeira tarefa do plano confere se o `oauthProvider` expõe listagem e revogação de consentimento; se não expuser, o app consulta e apaga direto nas tabelas do componente local.

## Auth e autorização do app

- Better Auth com e-mail e senha, sem verificação de e-mail, plugin `crossDomain`, como no analyzer.
- `ensureWorkspace` no primeiro acesso, idempotente.
- Toda função pública usa `requireWorkspace(ctx)` e confere a posse de cada `contactId`, `draftId`, `messageId` e `numberId`. Recurso de outro workspace se comporta como inexistente. As ferramentas do MCP fazem o mesmo com o `workspaceId` do `principal`.

## Onboarding e saúde dos números

Iguais ao analyzer: `createSignupLink` (`POST /v1/apps/token` com `metadata: { workspaceId }`), retorno em `/numbers/connected`, cron de hora em hora com `GET /v1/pool-numbers/{id}/health` gravando `state` e `canSendMessage`.

## Interface

| Rota | Conteúdo |
| --- | --- |
| `/sign-in`, `/sign-up` | login e cadastro; `/sign-in` também atende o fluxo OAuth |
| `/consent` | consentimento OAuth |
| `/` | **Pipeline**: kanban com 4 colunas, arrastar-e-soltar nativo do HTML5 e menu **Move to…** em cada cartão (alternativa acessível). Cartão: nome, tags, trecho da última mensagem, selo **Waiting for reply**. Clicar abre a inbox no contato |
| `/inbox` | lista de contatos por última mensagem, filtros **All**, **Waiting for reply**, **Has draft**, contador de não lidas |
| `/inbox/$contactId` | conversa com selo de origem em cada mensagem enviada (You, Phone, via Claude), status e **Retry** nas falhas; cartões de rascunho com texto editável, **Send** e **Discard**; campo de resposta, desabilitado com explicação quando a janela está fechada; painel lateral com estágio, tags, notas e linha do tempo de atividades |
| `/numbers`, `/numbers/connected` | como no analyzer |
| `/settings` | nome do workspace; modo de envio do MCP com o aviso de risco; URL do MCP com botão de copiar e instruções curtas por cliente; apps conectados com **Revoke**; demo **Load demo data** / **Reset demo data** |

Rotas autenticadas redirecionam para `/sign-in` sem sessão. Tudo é reativo: rascunho criado pelo MCP, mensagem nova e mudança de estágio aparecem sem recarregar.

## Demo

- `demo.seed` (mutation pública, só no workspace do próprio usuário): cria um número `isDemo` por um `number.onboarded` sintético e injeta pela mesma `ingest`, com timestamps no passado, cerca de 12 contatos espalhados pelo funil, com tags e notas, incluindo:
  - contatos aguardando resposta, com a janela aberta;
  - um contato com a janela fechada;
  - respostas pelo celular (echoes);
  - um rascunho pendente "via Claude".
- `demo.reset`: apaga o número demo e tudo que depende dele.
- Envios para o número demo são simulados (ver Envio, passo 3). A demo inteira funciona sem chave do pipes.bot.

## Variáveis de ambiente

| Onde | Variável | Obrigatória |
| --- | --- | --- |
| Convex | `PIPES_API_KEY` (`ak_`) | sim, exceto para usar só a demo |
| Convex | `PIPES_APP_SLUG` | sim, exceto para usar só a demo |
| Convex | `PIPES_WEBHOOK_SECRET` (`whsec_`) | sim, exceto para usar só a demo |
| Convex | `PIPES_API_BASE_URL` | não (padrão `https://api.pipes.bot`) |
| Convex | `SITE_URL` | sim |
| Convex | `BETTER_AUTH_SECRET` | sim |
| Vite | `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` | sim |

`CONVEX_SITE_URL` é fornecida pelo Convex. `.env.example` documenta as duas listas.

## Tratamento de erros

| Situação | Comportamento |
| --- | --- |
| Assinatura inválida / timestamp fora da tolerância | 401 |
| Corpo não JSON ou não objeto | 400 |
| Webhook duplicado | 200, sem efeito |
| Erro inesperado em `ingest` | 500, nada gravado, pipes.bot tenta de novo |
| `/mcp` sem token ou token inválido / expirado / audience errada | 401 com `WWW-Authenticate` |
| Ferramenta sem o escopo | não aparece em `tools/list`; chamada direta → erro de protocolo "unknown tool" |
| Janela fechada | recusa antes de gravar (UI e MCP) ou `failed` se a API responder `SERVICE_WINDOW_EXPIRED` |
| 429 do pipes.bot | `queued`, até 3 tentativas depois do reset, depois `failed` |
| Outra falha de envio ou timeout | `failed` + **Retry** manual |
| Falha do `/v1/apps/token` | erro na tela de números |
| Falha do health check | `health.state = "unknown"` |

## Testes

Vitest + `convex-test` (`edge-runtime`), sem backend rodando, mais um smoke de OAuth contra o backend local.

| Grupo | Casos |
| --- | --- |
| Puras | `windowState` (sem inbound, dentro, exatamente 24h, fora); normalização e limite de tags; formatação de `from` |
| Assinatura | vetor de teste do repo, assinatura errada, timestamp fora da tolerância, 400 para corpo inválido |
| `ingest` | dedup; parking e replay; contato novo como `lead` com activity; contato por BSUID; echo vira `phone` e não abre janela; echo com `wamid` repetido ignorado; status atualiza mensagem, `failed` grava erro; `user_changed_number` migra o contato; `unread` |
| `sendMessage` (`fetch` mockado) | sucesso grava `wamid` e activity; janela fechada e número bloqueado recusam sem gravar; `SERVICE_WINDOW_EXPIRED`; 429 vira `queued` e depois `sent`, e `failed` após 3; timeout vira `failed` sem nova chamada; número demo não chama `fetch` |
| Rascunhos | criar; aprovar com texto editado; descartar; aprovar com janela fechada recusa |
| MCP (`t.fetch("/mcp")` com JSON-RPC real) | sem token → 401 com `WWW-Authenticate`; `initialize`; `tools/list` com e sem `crm:write`; cada ferramenta com sucesso e com contato de outro workspace; `send_message` nos modos `draft` e `direct`; `isError` em `window_closed` |
| Autorização | usuário não lê nem altera contato, rascunho ou número de outro workspace |
| Demo | `demo.seed` gera os contatos e o rascunho esperados; `demo.reset` limpa |

Para os testes do MCP, `authenticateMcpRequest` é substituível: um token de teste fixo resolve para um `principal` conhecido, só no ambiente de teste.

**Smoke de OAuth (`scripts/oauth-smoke.ts`):** contra o backend Convex local (deploy anônimo), repete o spike de ponta a ponta: discovery (RFC 9728 e 8414), DCR, authorize com PKCE, login por e-mail com `oauth_query`, consentimento, troca do código por token (com `resource`), `tools/list` em `/mcp`, refresh e chamada com token revogado → 401. Roda à mão (`pnpm smoke:oauth`) e não entra no CI, porque precisa do backend local.

Frontend: typecheck e build.

## Integração com o repo

- `mini-crm/README.md` com frontmatter:
  ```yaml
  ---
  title: Mini CRM with MCP
  description: A WhatsApp CRM with a pipeline, an inbox and a built-in MCP server so Claude can read contacts, update the pipeline and draft replies
  type: app
  stack: [tanstack-router, convex, better-auth, mcp, typescript]
  features: [webhooks, byon-v2, embedded-signup, coexistence, echoes, mcp]
  ---
  ```
  São todos valores conhecidos pelo `scripts/generate-readme.ts` (sem warning). OAuth fica no `stack` implícito do Better Auth, não é recurso do pipes.bot.
- README do app: o que faz; arquitetura; configurar a App v2 (echoes ligados, webhook `https://<deployment>.convex.site/webhooks/pipes`); rodar local; demo; por que as versões do Better Auth estão fixadas e os ajustes do spike; conectar clientes MCP (Claude Code com `claude mcp add --transport http mini-crm https://<deployment>.convex.site/mcp`, conectores personalizados do claude.ai, ChatGPT em modo desenvolvedor; Grok como não verificado); segurança (prompt injection, modo rascunho, escopos, revogação); deploy (SPA estática + `npx convex deploy`); limites conhecidos (rate limit de 60/min por chave compartilhado entre números, busca com filtro em memória, sem templates) e extensões.
- `.gitignore`, `.env.example` e lockfile pnpm próprios. Fixtures copiados de `fixtures/byon-v2/`.
- CI: job `mini-crm` com `pnpm install --frozen-lockfile`, `vitest run`, typecheck e `vite build`.

## Fora do escopo

Mídia enviada · templates e mensagens fora da janela · equipe, convites e atribuição de conversas · campos e estágios editáveis · IA dentro do app · criar ou apagar contatos pelo MCP · fila round-robin de envio entre números · desconectar números · BYON legacy, sandbox e WebSocket · verificação de e-mail · tokens pessoais de API. O README lista os mais pedidos como extensões.

## Critérios de aceite

1. `pnpm test`, typecheck e `vite build` passam em `mini-crm/`, e o job novo do CI roda os três.
2. Com o backend Convex local, `pnpm smoke:oauth` passa de ponta a ponta.
3. Com o backend local, `demo.seed` popula funil e inbox; responder um contato da demo pela inbox marca a mensagem como `sent`; uma chamada `send_message` pelo MCP no modo `draft` faz o rascunho aparecer na inbox.
4. Um fixture assinado mandado com `simulate` para `/webhooks/pipes` é aceito (200) e um com assinatura errada é recusado (401).
5. Conectar um cliente MCP real (Claude Code, claude.ai, ChatGPT), enviar com chave real e os fluxos no navegador são verificados manualmente pelo usuário. Se não forem, o PR diz isso.
6. `pnpm readme:check` na raiz passa com o app na seção "Apps".
