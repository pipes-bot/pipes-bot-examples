# ai-handoff — atendimento por IA com passagem para humano (subprojeto 3)

Data: 2026-11-01
Status: design aprovado em conversa, aguardando revisão desta spec

## Objetivo

Um atendente de IA para WhatsApp, pronto para copiar. A IA responde os clientes com base em instruções e num FAQ escritos pelo dono. Quando não sabe a resposta, quando o cliente pede uma pessoa, quando chega mídia ou quando alguém da equipe responde pelo celular, ela sai da conversa. Um painel mostra o estado de cada conversa, quem está atendendo e quando a IA volta.

**Para quem:** quem está avaliando o pipes.bot e quer ver, em código legível, o problema mais difícil de um bot em coexistência: a IA e uma pessoa no mesmo número sem atropelar uma à outra. Os echoes (`smb_message_echoes`) são o sinal de que um humano entrou na conversa.

**A equipe responde só pelo celular.** O app é uma torre de controle: mostra, explica e permite assumir ou devolver a conversa. Ele não tem inbox para digitar respostas.

**Sucesso:** clonar, configurar uma App v2, conectar um número, ligar **AI replies**, mandar "oi" de outro telefone e receber a resposta da IA. Responder pelo WhatsApp Business no celular faz a IA parar. Depois de 30 minutos sem resposta da equipe, a IA volta na próxima mensagem do cliente. Sem número real e sem chave do OpenRouter, a demo mostra o mesmo fluxo com o simulador e um modelo determinístico.

## Decisões

| Decisão | Escolha |
| --- | --- |
| Pasta | `ai-handoff/`, autocontida (degit), `type: app` |
| Stack | TanStack Router (SPA estática com Vite) + Convex + Better Auth + Tailwind v4 + shadcn/ui + AI SDK 7 com `@openrouter/ai-sdk-provider`, como o analyzer |
| Posse | Um workspace por conta, um usuário por workspace |
| Conhecimento da IA | Instruções livres e um FAQ em texto, editados em `/settings`. Sem RAG |
| Ferramentas da IA | `request_human` e `save_request` |
| Quem responde quando | Máquina de estados pura (`transition`) com três modos: `ai`, `human`, `waiting_human` |
| Volta da IA | Depois de `idleMinutes` (padrão 30) sem resposta da equipe, avaliada na próxima mensagem do cliente (sem cron), ou pelo botão **Hand back to AI** |
| Interruptor | **AI replies** por número, desligado por padrão |
| Modelo | `OPENROUTER_MODEL`, padrão `anthropic/claude-sonnet-5.5`, roteamento ZDR (`{zdr: true, data_collection: "deny"}`). Sem `OPENROUTER_API_KEY`, modelo de demo determinístico |
| Envio | Só texto, via `POST /v1/messages/app/send`, só dentro da janela de 24h. Pipeline do mini-crm enxugado |
| Ferramentas | pnpm, Node 22.18+, Vitest + `convex-test` |
| Idioma | Inglês no código, na interface, nos dados da demo, no prompt e no README. A IA responde no idioma do cliente |

## Arquitetura

```
pipes.bot ──POST /webhooks/pipes──► httpAction (assinatura) ──► mutation ingest
                                                                  │
                                    transition(state, event, now) │ agenda/cancela
                                                                  ▼
                                   conversations, messages ──► scheduler: respond(conversationId, turn)
                                                                  │
                                                                  ▼
                                          action respond ──► generateText (OpenRouter ou demo)
                                                                  │ intents
                                                                  ▼
                                          mutation commitReply (turno ainda válido?)
                                                                  │
                                          action deliver ──► POST /v1/messages/app/send
SPA (TanStack Router) ◄── queries reativas (conversas, turnos, pedidos)
   └── mutations: takeOver, handBack, settings, aiEnabled, demo
cron (1h) ──► checkHealth ──► GET /v1/pool-numbers/{id}/health
```

Toda decisão de "quem fala agora" passa por `transition`. Ingestão, botões e o resultado da IA só produzem eventos.

## Modelo de dados

As tabelas do Better Auth ficam no componente, como no analyzer. As do app:

| Tabela | Campos | Índices |
| --- | --- | --- |
| `workspaces` | `ownerId`, `name`, `instructions` (≤ 4000), `faq` (≤ 16000), `idleMinutes` (padrão 30, 5–1440) | `by_owner` |
| `numbers` | `workspaceId`, `poolNumberId`, `phoneNumber`, `displayName`, `connectedAt`, `health?` (como no mini-crm), `isDemo?`, `aiEnabled` (padrão `false`) | `by_pool_number`, `by_workspace` |
| `events` | `webhookId`, `kind`, `poolNumberId?`, `payload`, `state: "processed" \| "parked" \| "ignored"`, `receivedAt` | `by_webhook_id`, `by_pool_number_state` |
| `conversations` | `workspaceId`, `numberId`, `waId?`, `userId?` (BSUID), `name?`, `mode: "ai" \| "human" \| "waiting_human"`, `modeChangedAt`, `handoffReason?: "phone_reply" \| "ai_request" \| "manual" \| "media" \| "limit" \| "ai_error"`, `handoffSummary?`, `humanActiveAt?`, `resumeAt?`, `aiTurn`, `pendingReplyJobId?`, `lastInboundAt?`, `lastMessageAt`, `lastFrom: "customer" \| "ai" \| "phone"`, `lastPreview`, `aiReplies: {windowStart, count}` | `by_number_wa_id`, `by_number_user_id`, `by_workspace_last_message`, `by_workspace_mode_changed` |
| `messages` | `workspaceId`, `conversationId`, `wamid?`, `direction: "in" \| "out"`, `source: "customer" \| "ai" \| "phone"`, `type`, `text?`, `status: "pending" \| "sent" \| "delivered" \| "read" \| "failed"`, `error?`, `sentAt` | `by_wamid`, `by_conversation_sent_at` |
| `requests` | `workspaceId`, `conversationId`, `summary` (≤ 500), `details` (≤ 2000), `customerName?` (≤ 80), `status: "open" \| "done"`, `createdAt`, `doneAt?` | `by_workspace_status_created`, `by_conversation` |
| `aiRuns` | `workspaceId`, `conversationId`, `turn`, `attempt`, `outcome: "sent" \| "handed_off" \| "empty" \| "dropped" \| "limited" \| "error"`, `dropReason?`, `toolCalls: {name, args}[]`, `model`, `replyPreview?`, `error?`, `usage?: {inputTokens, outputTokens}`, `startedAt`, `finishedAt` | `by_conversation_started` |

Regras:

- **Conversa:** uma por cliente por número, única por `(numberId, waId)` ou `(numberId, userId)`. A busca tenta `userId`, depois `waId`, e preenche o campo que faltar. Nasce em `mode: "ai"`, `aiTurn: 0`.
- **Janela de 24h:** função pura `windowState(conversation, now)`, como no mini-crm.
- **`aiTurn`:** contador que sobe a cada evento que invalida uma resposta em andamento. Uma resposta só é enviada se o `aiTurn` com que foi agendada ainda é o atual.
- **`aiRuns`:** o painel mostra os 50 mais recentes por conversa. Sem limpeza automática (fica como extensão no README).

## Máquina de estados

Função pura em `convex/lib/handoff.ts`:

```ts
transition(state, event, { now, idleMinutes, aiEnabled }) → { state, effects }
```

`effects` é uma lista de `{ kind: "schedule_reply", delayMs }` e `{ kind: "cancel_reply" }`. Quem chama (`ingest`, os botões e `commitReply`) aplica os efeitos na mesma mutation: `ctx.scheduler.runAfter` / `ctx.scheduler.cancel`, gravando `pendingReplyJobId`. Agendar sempre cancela o pendente antes ("debounce" de 4 s).

Eventos: `customer_text`, `customer_media`, `phone_echo`, `take_over`, `hand_back`, `ai_handoff {summary}`, `ai_limit`, `ai_error`.

| Modo atual | Evento | Novo estado | Efeitos |
| --- | --- | --- | --- |
| `ai` | `customer_text` | `ai`, `aiTurn + 1` | `schedule_reply(4 s)` |
| `ai` | `customer_media` | `waiting_human`, motivo `media`, `aiTurn + 1` | `cancel_reply` |
| `human`, `now < resumeAt` | `customer_text` / `customer_media` | sem mudança | nenhum |
| `human`, `now ≥ resumeAt` | `customer_text` | `ai`, limpa motivo, resumo e timers, `aiTurn + 1` | `schedule_reply(4 s)` |
| `human`, `now ≥ resumeAt` | `customer_media` | `waiting_human`, motivo `media`, `aiTurn + 1` | nenhum |
| `waiting_human` | `customer_text` / `customer_media` | sem mudança | nenhum |
| qualquer | `phone_echo` | `human`, motivo `phone_reply`, `humanActiveAt = now`, `resumeAt = now + idleMinutes`, `aiTurn + 1` | `cancel_reply` |
| qualquer | `take_over` | `human`, motivo `manual`, `humanActiveAt = now`, `resumeAt = now + idleMinutes`, `aiTurn + 1` | `cancel_reply` |
| `human` / `waiting_human` | `hand_back` | `ai`, limpa motivo, resumo e timers, `aiTurn + 1` | `schedule_reply(0)` se a última mensagem é do cliente |
| `ai` | `ai_handoff` | `waiting_human`, motivo `ai_request`, `handoffSummary`, `aiTurn + 1` | nenhum |
| `ai` | `ai_limit` | `waiting_human`, motivo `limit`, `aiTurn + 1` | nenhum |
| `ai` | `ai_error` | `waiting_human`, motivo `ai_error`, `aiTurn + 1` | nenhum |

Regras extras:

- **Com a IA desligada no número** (`aiEnabled: false`), os estados continuam sendo calculados, mas `schedule_reply` é removido dos efeitos.
- **Mensagem antiga:** uma mensagem do cliente com timestamp de mais de 15 minutos atrás (retentativa de webhook depois de uma queda, replay de evento parqueado) atualiza o estado mas não agenda resposta.
- **O `handoffSummary`** é mantido na passagem de `waiting_human` para `human` e só é limpo quando a conversa volta para `ai`.
- **Volta preguiçosa:** sem cron. Passado o `resumeAt`, o painel mostra "AI resumes on the next message".
- **`waiting_human` nunca volta sozinho:** só com **Hand back to AI**, ou com uma resposta da equipe pelo celular, que leva a `human` e liga o timer.
- **Combinações não listadas** (por exemplo, `ai_handoff` fora do modo `ai`) não mudam nada.

## Respondedor da IA

### action interna `respond({ conversationId, turn, attempt })`

1. Query interna carrega a conversa, o número, o workspace e as últimas 30 mensagens. Grava um `aiRun` `dropped` e para se:
   - `mode !== "ai"` ou `aiTurn !== turn` (`dropReason: "stale"`);
   - `aiEnabled` está desligado (`"ai_disabled"`);
   - a janela de 24h está fechada (`"window_closed"`).
2. **Limite:** com 20 respostas da IA na janela de uma hora (`aiReplies`), chama `commitReply` com o evento `ai_limit` e grava o `aiRun` como `limited`, sem chamar o modelo.
3. Decide a resposta com a implementação ativa:
   - **OpenRouter** (`OPENROUTER_API_KEY` definida): `generateText` com o modelo `OPENROUTER_MODEL`, roteamento ZDR, até 3 passos, timeout de 60 s, e as ferramentas abaixo.
   - **Demo** (sem chave): regras por palavra-chave (ver Demo).

   As duas devolvem o mesmo formato: `{ text, intents: { handoff?: {reason, summary}, requests: [...] }, toolCalls, usage? }`.
4. Chama `commitReply`.
5. **Erro do modelo:** na tentativa 1, agenda `respond` com `attempt: 2` daqui a 10 s. Na tentativa 2, chama `commitReply` com o evento `ai_error`. Nos dois casos, grava o `aiRun` como `error`.

### Prompt

O system prompt (em inglês) tem:

- As instruções e o FAQ do workspace, cada um entre marcadores (`<instructions>`, `<faq>`).
- As regras fixas:
  - responder em até cerca de 600 caracteres, no idioma do cliente, em texto simples;
  - não inventar preço, prazo, estoque nem política que não estejam nas instruções ou no FAQ;
  - chamar `request_human` quando não souber, quando o cliente pedir uma pessoa, reclamar ou o assunto for sensível, e nesse caso dizer ao cliente, numa frase, que alguém da equipe vai continuar;
  - chamar `save_request` quando o cliente fizer um pedido, orçamento ou reserva que a equipe precise tratar.

A conversa vai como uma única mensagem `user`, dentro de `<conversation>`. Cada linha é rotulada `Customer:`, `Assistant:` ou `Staff (phone):`, e a mídia aparece como `[image] legenda`. O prompt avisa que o conteúdo da conversa não é confiável e não pode mudar as regras.

### Ferramentas

As ferramentas só registram intenções. O efeito acontece em `commitReply`, e só se o turno ainda for válido.

| Ferramenta | Entrada (zod) | Intenção |
| --- | --- | --- |
| `request_human` | `{ reason: string ≤ 200, summary: string ≤ 500 }` | `handoff`. Chamada mais de uma vez, vale a última |
| `save_request` | `{ summary ≤ 500, details ≤ 2000, customerName? ≤ 80 }` | adiciona a `requests`. No máximo 3 por turno |

Entradas fora do limite são cortadas, não recusadas, para não quebrar o turno.

### mutation interna `commitReply({ conversationId, turn, attempt, decision | event })`

Tudo numa transação:

1. Se `mode !== "ai"` ou `aiTurn !== turn`: grava o `aiRun` como `dropped` (`"stale"`) e não faz mais nada. É o caso de um humano ter respondido ou de o botão ter sido usado enquanto a IA pensava.
2. Com um evento (`ai_limit`, `ai_error`), aplica `transition` e para.
3. Grava os `requests`.
4. Se há texto: aplica o corte de tamanho (fim de frase antes de 600 caracteres, ou 600 com `…`), grava a mensagem `pending` com `source: "ai"`, soma `aiReplies` e agenda `deliver`.
5. Se há `handoff`: aplica `transition` com `ai_handoff`.
6. Grava o `aiRun` com o resultado:
   - `handed_off` se houve `handoff`;
   - `sent` se houve texto;
   - `empty` se não houve nem texto nem intenção.

Uma vez gravada, a mensagem é entregue mesmo que o turno mude depois. A checagem que importa é a do passo 1, antes de qualquer gravação.

### Envio (`deliver`)

O pipeline do mini-crm, enxugado:

- Número com `canSendMessage === "BLOCKED"`: `failed` com o erro `number_blocked`, sem chamar a API.
- Número de demo: marca `sent` com `wamid.demo_<aleatório>` e agenda `delivered` para daqui a 2 s.
- `POST /v1/messages/app/send` com `{ poolNumberId, to: waId ?? userId, text }`:
  - **Sucesso:** grava o `wamid` e `status: sent`.
  - **429:** nova tentativa depois de `X-RateLimit-Reset` (ou 60 s), até 3 tentativas; depois `failed` com `rate_limited`.
  - **`SERVICE_WINDOW_EXPIRED`** ou o erro 131047 da Meta: `failed` com `window_closed`.
  - **Outra falha:** `failed` com o código.
  - **Timeout (30 s):** `failed` com `unknown`, sem nova tentativa, porque não dá para saber se a mensagem saiu.
- Qualquer `failed` de mensagem da IA aplica `ai_error`, se a conversa ainda estiver em `ai`. O erro aparece no cabeçalho da conversa.

## Ingestão

Copiada do mini-crm (mesma assinatura Standard Webhooks, deduplicação por `webhookId`, parking e replay), com conversas no lugar de contatos:

| Evento | Ação |
| --- | --- |
| `event: "test"` | `ignored` |
| `number.onboarded` com `metadata.workspaceId` válido | upsert em `numbers` (`aiEnabled: false`), replay dos `parked`. `processed` |
| `number.onboarded` sem workspace, ou envelope de número desconhecido | `parked` |
| `field: "messages"`, `messages[]` de texto | upsert da conversa, mensagem `source: customer`, atualiza `lastInboundAt`, `lastMessageAt`, `lastFrom`, `lastPreview`, depois `transition(customer_text)` |
| `messages[]` de mídia | mesma gravação (com `type` e a legenda em `text`), depois `transition(customer_media)` |
| `messages[]` com `type: "system"` | `user_changed_number` / `user_changed_user_id` migram `waId` / `userId` da conversa |
| `field: "messages"`, `statuses[]` | atualiza o `status` da mensagem com o `wamid`. `failed` grava o `error` e, se a mensagem for da IA, aplica `ai_error` |
| `field: "smb_message_echoes"` | ignorado se o `wamid` já existe. Senão, mensagem `source: phone` e `transition(phone_echo)`. Não altera `lastInboundAt` |
| outros `field` | `ignored` |

Mensagens enviadas pela API não geram echo, segundo a Meta. A deduplicação por `wamid` fica como defesa.

## Auth e autorização

- Better Auth com e-mail e senha, sem verificação de e-mail, com o plugin `crossDomain`. Mesma configuração e versões do analyzer, sem o provedor OAuth do mini-crm.
- `ensureWorkspace` no primeiro acesso, idempotente.
- Toda função pública usa `requireWorkspace(ctx)` e confere a posse de cada `conversationId`, `requestId` e `numberId`. Um recurso de outro workspace se comporta como inexistente.

## Onboarding e saúde dos números

Iguais ao analyzer:

- `createSignupLink` (`POST /v1/apps/token` com `metadata: { workspaceId }`);
- retorno em `/numbers/connected`;
- cron de hora em hora com `GET /v1/pool-numbers/{id}/health`.

Ligar ou desligar a IA (`numbers.setAiEnabled`) não responde mensagens antigas.

## Interface

| Rota | Conteúdo |
| --- | --- |
| `/sign-in`, `/sign-up` | login e cadastro |
| `/` | **Conversations**, com as abas abaixo. Cada linha mostra o nome (ou o telefone), a prévia, o selo do estado, o tempo até a IA voltar ("AI back in 12 min", "AI resumes on the next message") e o número. Um selo **AI off** aparece quando a IA está desligada no número |
| `/conversations/$id` | Cabeçalho com o estado, o motivo em linguagem simples, o resumo do handoff e o último erro, além de **Take over** e **Hand back to AI**. Abaixo: o chat com o selo de origem e o status de cada mensagem; os **AI turns** (recolhível), com o resultado, as ferramentas e os argumentos de cada turno; e o simulador, só nas conversas de demo |
| `/requests` | Pedidos **Open** e **Done**, com o resumo, os detalhes, o nome do cliente, o link para a conversa e o botão **Mark done** |
| `/numbers`, `/numbers/connected` | Como no analyzer, mais o interruptor **AI replies** em cada número |
| `/settings` | Nome do workspace, **Instructions**, **FAQ** (com contador de caracteres), **Minutes before the AI resumes**, o status do modelo ("OpenRouter: `<modelo>`" ou "Demo model — set OPENROUTER_API_KEY") e a demo: **Load demo data**, **New demo conversation** e **Reset demo data** |

As abas de `/`:

- **Needs human:** conversas em `waiting_human`, das que esperam há mais tempo para as mais recentes.
- **With staff:** conversas em `human`.
- **AI:** conversas em `ai`.
- **All.**

O simulador tem dois campos:

- **Send as customer** chama `demo.simulateInbound`;
- **Reply as staff from phone** chama `demo.simulateEcho`.

Os dois montam um payload v2 e chamam a mesma função interna de ingestão do webhook.

As rotas autenticadas redirecionam para `/sign-in` sem sessão. Tudo é reativo, inclusive a resposta da IA aparecendo uns 4 s depois da mensagem simulada.

## Demo

- **`demo.seed`** (mutation pública, só no workspace do próprio usuário) cria um número `isDemo` com `aiEnabled: true` por um `number.onboarded` sintético e injeta, pela mesma ingestão, com timestamps no passado:
  - uma conversa atendida pela IA;
  - uma em `waiting_human` (`ai_request`) com resumo;
  - uma em `human` com o timer rodando;
  - uma em `waiting_human` (`media`);
  - um pedido salvo em aberto;
  - os `aiRuns` correspondentes.
- **`demo.newConversation`** cria um cliente de demo novo e manda a primeira mensagem dele.
- **`demo.reset`** apaga o número de demo e tudo o que depende dele.
- **Modelo de demo**, quando não há `OPENROUTER_API_KEY`, com palavras-chave sem diferenciar maiúsculas:
  - `human`, `agent`, `person`, `humano`, `atendente`, `pessoa` → `request_human`, mais "Sure — someone from our team will take it from here.";
  - `order`, `quote`, `buy`, `book`, `pedido`, `orçamento`, `comprar` → `save_request` com a última mensagem como detalhe, mais "Got it — I saved your request and the team will confirm.";
  - qualquer outra coisa → "Thanks for your message! This is a demo reply — set OPENROUTER_API_KEY to answer with a real model."

  Ele também vale para números reais quando falta a chave. O painel avisa.
- **Sem chave do pipes.bot:** a demo inteira funciona.

## Variáveis de ambiente

| Onde | Variável | Obrigatória |
| --- | --- | --- |
| Convex | `PIPES_API_KEY`, `PIPES_APP_SLUG`, `PIPES_WEBHOOK_SECRET` | sim, exceto para usar só a demo |
| Convex | `PIPES_API_BASE_URL` | não (padrão `https://api.pipes.bot`) |
| Convex | `SITE_URL`, `BETTER_AUTH_SECRET` | sim |
| Convex | `OPENROUTER_API_KEY` | não (sem ela, modelo de demo) |
| Convex | `OPENROUTER_MODEL` | não (padrão `anthropic/claude-sonnet-5.5`) |
| Vite | `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` | sim |

## Tratamento de erros

| Situação | Comportamento |
| --- | --- |
| Assinatura inválida ou timestamp fora da tolerância | 401 |
| Corpo que não é JSON ou não é objeto | 400 |
| Webhook duplicado | 200, sem efeito |
| Erro inesperado em `ingest` | 500, nada gravado, o pipes.bot tenta de novo |
| Humano responde ou botão é usado enquanto a IA pensa | turno `dropped` (`stale`), nada enviado |
| Erro ou timeout do modelo | nova tentativa em 10 s; depois `waiting_human` com `ai_error` |
| Resposta longa demais | cortada no fim de frase antes de 600 caracteres |
| Limite de 20 respostas por hora | `waiting_human` com `limit`, sem chamar o modelo |
| Número BLOCKED, janela fechada, outra falha de envio | mensagem `failed`, `waiting_human` com `ai_error`, erro no cabeçalho |
| 429 do pipes.bot | até 3 tentativas depois do reset, depois `failed` |
| Timeout no envio | `failed` com `unknown`, sem nova tentativa |
| Falha do `/v1/apps/token` | erro na tela de números |
| Falha do health check | `health.state = "unknown"` |

**Injeção de prompt.** As ferramentas só agem sobre a conversa atual, não enviam mensagens e não leem outros dados. Os campos têm limite de tamanho. A IA não tem acesso a nada além do prompt. O texto do cliente aparece no painel como texto puro.

## Testes

Vitest + `convex-test` (`edge-runtime`), sem rede, com relógio falso e `t.finishAllScheduledFunctions` para o scheduler.

| Grupo | Casos |
| --- | --- |
| `transition` (pura) | todas as linhas da tabela; `aiEnabled: false` remove `schedule_reply`; mensagem antiga não agenda; `hand_back` com a última mensagem do cliente e sem ela; combinação não listada não muda nada |
| Puras | `windowState`; corte de tamanho; montagem do prompt e da conversa rotulada; modelo de demo |
| Assinatura | vetor de teste do repo, assinatura errada, timestamp fora da tolerância, 400 para corpo inválido |
| `ingest` | dedup; parking e replay; conversa nova; cliente por BSUID; echo vira `phone` e passa para `human`; echo com `wamid` repetido ignorado; status atualiza a mensagem; status `failed` de mensagem da IA aplica `ai_error`; `user_changed_number` migra a conversa |
| Respondedor (`MockLanguageModelV4`) | texto vira mensagem enviada e `aiRun` `sent`; `request_human` leva a `waiting_human` com o resumo; `save_request` cria pedido e a conversa continua em `ai`; resposta vazia → `empty`; erro → nova tentativa → `ai_error` |
| Corridas | echo entre o agendamento e o `commitReply` → `dropped`, nada enviado; duas mensagens do cliente em menos de 4 s → uma resposta; **Take over** no meio de um turno → `dropped` |
| Volta | em `human` antes do `resumeAt` não responde; depois do `resumeAt` volta para `ai` e responde; `waiting_human` não volta sozinho |
| Limites | 20 respostas por hora → `limit`; IA desligada; janela fechada |
| `deliver` (`fetch` mockado) | sucesso grava o `wamid`; BLOCKED não chama a API; 429 tenta de novo e depois `failed`; timeout vira `failed` sem nova chamada; número de demo não chama `fetch` |
| Autorização | usuário não lê nem altera conversa, pedido ou número de outro workspace |
| Demo | `demo.seed` gera os estados esperados; o simulador passa pela ingestão; `demo.reset` limpa |

Frontend: typecheck e build. Na verificação final, um smoke headless com Playwright (rodado de `/tmp`, contra o backend Convex local anônimo): carregar a demo, mandar uma mensagem como cliente e ver a resposta da IA, pedir uma pessoa e ver o handoff, responder como equipe e ver o timer, salvar um pedido e vê-lo em `/requests`.

## Integração com o repo

- `ai-handoff/README.md` com frontmatter:
  ```yaml
  ---
  title: AI handoff
  description: An AI agent answers WhatsApp customers from your instructions and FAQ, and steps aside when your team replies from the phone or a customer needs a person
  type: app
  stack: [tanstack-router, convex, better-auth, openrouter, typescript]
  features: [webhooks, byon-v2, embedded-signup, coexistence, echoes]
  ---
  ```
- O README do app cobre:
  - o que o app faz, com um diagrama dos estados em Mermaid;
  - a arquitetura;
  - como configurar a App v2 (echoes ligados, webhook `https://<deployment>.convex.site/webhooks/pipes`);
  - como rodar local e usar a demo;
  - como a IA decide: o prompt, as ferramentas, os turnos e as corridas;
  - como personalizar: as instruções, o modelo e como adicionar uma ferramenta;
  - **Privacidade:** as mensagens dos clientes vão para o OpenRouter e o provedor do modelo, com roteamento ZDR. A recomendação é avisar os clientes de que há IA no atendimento;
  - os limites conhecidos: rate limit de 60/min por chave, sem mídia para a IA, sem templates, sem horário comercial;
  - o deploy;
  - as extensões.
- `.gitignore`, `.env.example` e lockfile pnpm próprios. Fixtures copiados de `fixtures/byon-v2/`.
- CI: job `ai-handoff` com `pnpm install --frozen-lockfile`, `vitest run`, typecheck e `vite build`.

## Fora do escopo

Mídia lida pela IA (áudio, imagem) · templates e mensagens fora da janela · RAG e upload de documentos · horário comercial · notificações fora do painel · equipe, convites e atribuição · responder pelo painel · streaming · limpeza de `aiRuns` · BYON legacy, sandbox e WebSocket · verificação de e-mail. O README lista os mais pedidos como extensões.

## Critérios de aceite

1. `pnpm test`, typecheck e `vite build` passam em `ai-handoff/`, e o job novo do CI roda os três.
2. Com o backend Convex local e sem `OPENROUTER_API_KEY`:
   - `demo.seed` popula todos os estados;
   - uma mensagem simulada recebe a resposta do modelo de demo;
   - "I want a person" leva a `waiting_human`;
   - uma resposta simulada da equipe leva a `human` com o timer;
   - "I want a quote" cria um pedido.
3. Um fixture assinado mandado com `simulate` para `/webhooks/pipes` é aceito (200) e um com assinatura errada é recusado (401).
4. O smoke headless com Playwright passa.
5. Verificação manual do usuário:
   - o modelo real via OpenRouter, que usa a chave do usuário e só roda com permissão;
   - o envio com chave real do pipes.bot;
   - um número real com echoes do celular.

   O que não for verificado fica dito no PR.
6. `pnpm readme:check` na raiz passa com o app na seção "Apps".
