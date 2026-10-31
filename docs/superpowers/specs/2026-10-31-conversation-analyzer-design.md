# conversation-analyzer — app completo (subprojeto 1)

Data: 2026-10-31
Status: design aprovado em conversa, aguardando revisão desta spec

## Objetivo

Um app completo, pronto para copiar, que conecta números BYON (API v2) de cada usuário, recebe todos os webhooks, incluindo os echoes de coexistence, e analisa cada atendimento: tempos de resposta calculados em código e aderência a uma metodologia avaliada por IA.

**Para quem:** quem está avaliando o pipes.bot para colocar WhatsApp no próprio produto. O exemplo mostra, em código legível, o que os docs de [Build a platform](https://docs.pipes.bot/docs/byon/build-a-platform) e [Coexistence](https://docs.pipes.bot/docs/byon/coexistence) pedem.

**O app só observa.** Não manda mensagens. A equipe atende pelo WhatsApp Business no celular, e o echo é o que permite ver essas respostas.

**Sucesso:** clonar, configurar uma App v2 com echoes ligados, conectar um número, conversar pelo celular e ver o atendimento aparecer, fechar e ser analisado em tempo real. Sem número real, o seed mostra o mesmo fluxo.

## Decisões

| Decisão | Escolha |
| --- | --- |
| Pasta | `conversation-analyzer/`, autocontida (degit), `type: app` |
| Stack | TanStack Router (SPA estática com Vite) + Convex (httpActions, tempo real, scheduler, crons) + Better Auth (componente Convex, plugin `crossDomain`) + Tailwind v4 + shadcn/ui |
| IA | OpenRouter via Vercel AI SDK (`@openrouter/ai-sdk-provider`), `generateObject` com zod |
| Posse dos números | Um workspace por conta. `metadata.workspaceId` no token de signup amarra o `number.onboarded` ao workspace |
| Atendimento | Abre na primeira mensagem sem atendimento aberto e fecha por inatividade (padrão 120 min, configurável por workspace) |
| Metodologia | Checklist editável por workspace, com um padrão. A IA avalia cada passo e cita a evidência. A nota é calculada em código |
| Demo sem número | `npx convex run demo:seed` injeta cenários pela mesma função de ingestão |
| Arquitetura | Log bruto (`events`) + projeção normalizada, tudo em Convex nativo, sem `workflow`/`workpool` |
| Ferramentas | pnpm, Node 22, Vitest + `convex-test` |
| Idioma | Inglês no código, na interface e no README |

## Arquitetura

```
pipes.bot ──POST /webhooks/pipes──► httpAction (verifica assinatura)
                                       │
                                       ▼
                                 mutation ingest ──► events, numbers, contacts,
                                       │             conversations, messages, statuses
                                       ▼
                         scheduler: closeIfIdle(conversationId)
                                       │
                                       ▼
                         fecha + computeMetrics ──► action analyzeConversation ──► OpenRouter
                                                                                     │
SPA (TanStack Router) ◄── queries reativas ◄──────────── conversations.analysis ◄────┘
       │
       └── action createSignupLink ──► POST /v1/apps/token ──► app.pipes.bot/apps/<slug>?token=
cron (1h) ──► action checkHealth ──► GET /v1/pool-numbers/{id}/health
```

## Modelo de dados

As tabelas do Better Auth são do componente. As do app:

| Tabela | Campos | Índices |
| --- | --- | --- |
| `workspaces` | `ownerId`, `name`, `inactivityMinutes` (padrão 120), `methodology: {id, name, description}[]` | `by_owner` |
| `numbers` | `workspaceId`, `poolNumberId`, `phoneNumber`, `displayName`, `connectedAt`, `health?: {state: "healthy" \| "unhealthy" \| "unknown", checkedAt, detail?}`, `isDemo?` | `by_pool_number` (único por lógica), `by_workspace` |
| `events` | `webhookId`, `kind` (valor de `field` ou `event`), `poolNumberId?`, `payload`, `state: "processed" \| "parked" \| "ignored"`, `receivedAt` | `by_webhook_id`, `by_pool_number_state` |
| `contacts` | `numberId`, `waId?`, `userId?` (BSUID), `name?` | `by_number_wa_id`, `by_number_user_id` |
| `conversations` | `workspaceId`, `numberId`, `contactId`, `status: "open" \| "closed"`, `initiatedBy: "customer" \| "business"`, `openedAt`, `lastActivityAt`, `lastTurn: "customer" \| "business"`, `closedAt?`, `closeJobId?`, `metrics?`, `analysis?` | `by_contact_status`, `by_number_closed_at`, `by_workspace_status` |
| `messages` | `conversationId`, `wamid`, `direction: "inbound" \| "outbound"`, `source: "customer" \| "phone" \| "api"`, `type`, `text?`, `sentAt` (timestamp do WhatsApp, ms), `deliveredAt?`, `readAt?`, `failedAt?` | `by_wamid`, `by_conversation_sent_at` |
| `statuses` | `numberId`, `wamid`, `status`, `timestamp`, `recipient` (wa_id ou BSUID) | `by_wamid`, `by_number_recipient` |

`analysis` contém `state: "pending" | "running" | "done" | "failed" | "skipped"`, `reason?` (motivo de `skipped`/`failed`), `methodology` (snapshot dos passos), `summary?`, `steps?: {stepId, verdict, evidence, reason}[]`, `score?` (0–100 ou ausente), `model?`, `analyzedAt?`.

`metrics` contém `firstResponseSeconds?`, `avgResponseSeconds?`, `maxResponseSeconds?`, `unansweredTurns`, `answered`, `durationSeconds`, `counts: {customer, phone, api}`.

## Ingestão

### httpAction `POST /webhooks/pipes`

1. Lê o corpo cru. Verifica Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`; chave = base64-decode do segredo após `whsec_`; HMAC-SHA256 sobre `${id}.${ts}.${raw}`; lista `v1,<b64>` separada por espaço; tolerância de 300 s; comparação em tempo constante). Inválida → 401.
2. Corpo que não é JSON ou não é objeto → 400.
3. Chama `internal.ingest.ingest({ webhookId, payload })` e responde 200. Não há resposta antecipada: a mutation é rápida e transacional, e um erro nela devolve 500 para o pipes.bot tentar de novo.

### mutation interna `ingest`

1. `webhookId` já existe em `events` → retorna (duplicado).
2. Grava o evento bruto com `state` provisório.
3. Roteia:

| Evento | Ação |
| --- | --- |
| `event: "test"` | `ignored` |
| `event: "number.onboarded"` com `metadata.workspaceId` de um workspace existente | upsert em `numbers` (`poolNumberId = data.numberId`), depois replay dos eventos `parked` daquele `poolNumberId` em ordem de `receivedAt`. `processed` |
| `event: "number.onboarded"` sem metadata ou com workspace inexistente | `parked` e log `unassigned number <numberId>` |
| envelope com `pipes.poolNumberId` desconhecido | `parked` |
| `field: "messages"`, `whatsapp.messages[]` | cada mensagem → `messages` com `source: customer`. Remetente = `from` se for string não vazia, senão `from_user_id`. Abre ou continua o atendimento |
| `field: "messages"`, `whatsapp.statuses[]` | atualiza a `message` do `wamid`. Se não existir, grava em `statuses` |
| `field: "smb_message_echoes"`, `whatsapp.message_echoes[]` | cada echo → `messages` com `source: phone`, `direction: outbound`. Destinatário = `to` se for string não vazia, senão `to_user_id`. Incorpora os `statuses` com o mesmo `wamid` e os apaga. Nunca é tratado como mensagem do cliente |
| `messages[]` com `type: "system"` (troca de número ou de BSUID) | atualiza `waId`/`userId` do contato |
| qualquer outro `field` (ex.: `message_template_status_update`) | `ignored` |

Listas ausentes ou que não são array são tratadas como vazias. Uma mensagem com `wamid` já gravado é ignorada (o mesmo conteúdo pode vir em eventos diferentes).

A transação do Convex elimina a corrida descrita nos docs entre parking e replay: as duas operações nunca rodam ao mesmo tempo.

### Contatos

Busca por `userId` (BSUID) e depois por `waId` dentro do número. Cria se não existir. Preenche o campo que faltar quando um evento trouxer os dois (`contacts[]` do envelope traz `wa_id` e `user_id`). `name` vem de `contacts[].profile.name` quando presente.

## Ciclo do atendimento

- **Abertura:** uma mensagem (de qualquer origem) para um contato sem atendimento `open` cria um. `initiatedBy` é `customer` ou `business` conforme a origem da primeira mensagem.
- **Atividade:** cada mensagem atualiza `lastActivityAt` e `lastTurn`, cancela `closeJobId` e agenda `closeIfIdle` para `Date.now() + inactivityMinutes`. O agendamento usa o relógio de chegada; as métricas usam `sentAt`.
- **`closeIfIdle`:** retorna sem fazer nada se o atendimento não está `open` ou se `lastActivityAt + inactivityMinutes` ainda não passou. Senão, fecha (função `closeConversation`, reutilizada pelo seed):
  1. Converte os `statuses` órfãos do número cujo `recipient` é o contato e cujo `timestamp` está entre `openedAt` e o fechamento em `messages` com `source: api`, sem texto, `sentAt` = timestamp do status `sent` (ou o mais antigo). Apaga os statuses convertidos.
  2. `metrics = computeMetrics(messages)`.
  3. `status = closed`, `closedAt`.
  4. `analysis = { state: "pending", methodology: snapshot }` e agenda `analyzeConversation`.
- **Depois do fechamento:** uma mensagem nova abre outro atendimento. Statuses atrasados só atualizam a mensagem.

## Métricas (`computeMetrics`, função pura)

Mensagens ordenadas por `sentAt`. Um **turno do cliente** é uma sequência de mensagens `customer` sem mensagem da empresa (`phone` ou `api`) entre elas.

- `firstResponseSeconds`: do primeiro `customer` até a primeira mensagem da empresa depois dele. Ausente se `initiatedBy: business` ou se nunca houve resposta.
- `avgResponseSeconds` / `maxResponseSeconds`: do início de cada turno respondido até a primeira resposta seguinte. Ausentes se nenhum turno foi respondido.
- `unansweredTurns`: turnos sem resposta seguinte.
- `answered`: houve ao menos uma mensagem da empresa depois de uma do cliente.
- `durationSeconds`: da primeira à última mensagem.
- `counts`: mensagens por `source`.

Horário comercial fica fora (ver Fora do escopo).

## Análise por IA

### `analyzeConversation(conversationId)` (action interna)

1. Carrega atendimento, mensagens e snapshot via query interna.
2. `skipped` sem chamar a IA quando:
   - `metrics.answered` é falso → `reason: "no-reply"`;
   - `OPENROUTER_API_KEY` não está definida → `reason: "no-api-key"`.
3. Marca `running`.
4. Monta a transcrição:
   ```
   [14:02] Customer: ...
   [14:09] Agent (phone): ...
   [14:10] Agent (API): [content not available]
   [14:11] Customer: [image] legenda
   ```
5. `generateObject` com `@openrouter/ai-sdk-provider`, modelo `OPENROUTER_MODEL` (padrão: um modelo Claude; o slug é confirmado no plano), pedindo ao OpenRouter só provedores sem retenção de dados (`data_collection: "deny"`; nome exato da opção confirmado no plano). Schema:
   ```ts
   z.object({
     summary: z.string().max(400),
     steps: z.array(z.object({
       stepId: z.string(),
       verdict: z.enum(["met", "not_met", "not_applicable"]),
       evidence: z.string().nullable(),
       reason: z.string(),
     })),
   })
   ```
   O prompt pede o resumo e os motivos no idioma da conversa, e a evidência como trecho literal.
6. Validação em código:
   - os `stepId`s precisam ser exatamente os do snapshot (sem faltar, sobrar ou repetir); senão, nova tentativa (até 2 retentativas, 3 chamadas no total);
   - `evidence` precisa aparecer na transcrição depois de normalizar espaços e caixa; senão, vira `null` e o veredito fica;
   - `score = round(100 * met / (met + not_met))`; ausente se `met + not_met = 0`.
7. Grava `done` com `summary`, `steps`, `score`, `model`, `analyzedAt`. Esgotou as tentativas, timeout ou erro HTTP → `failed` com `reason`.

A chamada ao modelo fica atrás de uma função injetável para os testes usarem o mock do AI SDK.

### Ações do usuário

- **Retry** (análise `failed`): agenda de novo com o mesmo snapshot.
- **Re-analyze** (qualquer atendimento fechado): novo snapshot do checklist atual e agenda.

### Metodologia padrão

1. `greet` — Greet the customer
2. `understand` — Confirm what the customer needs
3. `resolve` — Answer or give a clear next step
4. `close` — Check the customer is satisfied before ending

O editor em `/settings` gera `id` estável para passos novos (slug do nome + sufixo curto) e não reaproveita ids removidos.

## Auth e autorização

- Better Auth via `@convex-dev/better-auth`, plugin `crossDomain` (SPA e `convex.site` em origens diferentes). Só e-mail e senha, sem verificação de e-mail. O README mostra onde adicionar provedores OAuth.
- No primeiro acesso, `ensureWorkspace` cria o workspace com nome padrão e a metodologia padrão. Idempotente.
- Toda query/mutation/action pública usa `requireWorkspace(ctx)` e confere a posse de cada `numberId`/`conversationId` recebido. Recurso de outro workspace se comporta como inexistente.

## Onboarding de números

1. **Connect a number** chama a action `createSignupLink`: `POST ${PIPES_API_BASE_URL}/v1/apps/token` com `Authorization: Bearer ${PIPES_API_KEY}`, `redirectUrl: ${SITE_URL}/numbers/connected`, `metadata: { workspaceId }`. Devolve `https://app.pipes.bot/apps/${PIPES_APP_SLUG}?token=<token>`. Erro da API → mensagem clara na interface.
2. A SPA redireciona.
3. `/numbers/connected?numberId=&phone=` mostra "Waiting for confirmation…" e muda para "Connected" quando a query reativa encontra o número **no workspace do usuário**. O `numberId` da URL nunca concede posse. Depois de 3 minutos sem evento, a tela lista as causas prováveis: webhook URL da App errada, App que não é v2, segredo errado.

O token dura 15 minutos e é de uso único; cada clique cria um novo.

## Saúde dos números

Cron de hora em hora: action `checkHealth` chama `GET /v1/pool-numbers/{poolNumberId}/health` para cada número que não é demo e grava `health`. Falha da chamada → `unknown` com `detail`. A lista de números mostra o selo. Desconectar fica fora do escopo.

## Interface

| Rota | Conteúdo |
| --- | --- |
| `/sign-in`, `/sign-up` | login e cadastro |
| `/` | visão geral do workspace (7 ou 30 dias): total de atendimentos, mediana de `firstResponseSeconds`, % respondidos, nota média; lista **Waiting for reply** (atendimentos `open` com `lastTurn: customer`, tempo de espera correndo no cliente) |
| `/numbers` | números com selo de saúde e **Connect a number** |
| `/numbers/connected` | retorno do signup |
| `/numbers/$numberId` | as mesmas estatísticas do número e a lista de atendimentos, filtro aberto/fechado |
| `/conversations/$conversationId` | chat com selo de origem (phone/API) em cada resposta, métricas, resumo, passos com veredito e evidência, **Retry** / **Re-analyze** |
| `/settings` | nome do workspace, minutos de inatividade, editor do checklist (adicionar, editar, remover, reordenar) |

As estatísticas vêm de queries indexadas por `numberId + closedAt` (ou `workspaceId`), limitadas a 1000 atendimentos. O README aponta `@convex-dev/aggregate` para escalar.

Rotas autenticadas redirecionam para `/sign-in` sem sessão.

## Variáveis de ambiente

| Onde | Variável | Obrigatória |
| --- | --- | --- |
| Convex | `PIPES_API_KEY` (`ak_`) | sim |
| Convex | `PIPES_APP_SLUG` | sim |
| Convex | `PIPES_WEBHOOK_SECRET` (`whsec_`) | sim |
| Convex | `PIPES_API_BASE_URL` | não (padrão `https://api.pipes.bot`) |
| Convex | `SITE_URL` | sim |
| Convex | `BETTER_AUTH_SECRET` | sim |
| Convex | `OPENROUTER_API_KEY` | não (sem ela, análises ficam `skipped`) |
| Convex | `OPENROUTER_MODEL` | não |
| Vite | `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` | sim |

`.env.example` documenta as duas listas.

## Seed de demonstração

Funções internas (só executáveis com a chave de deploy ou pelo CLI):

- `demo:seed({ email })`: acha o workspace do usuário com esse e-mail, cria um número `pn_demo_<aleatório>` (via um `number.onboarded` sintético, marcado `isDemo: true`) e injeta pela mesma `ingest` (com `webhookId`s sintéticos) quatro cenários com timestamps no passado:
  1. rápido e aderente à metodologia;
  2. respostas lentas;
  3. sem resposta;
  4. misto: respostas pelo celular (echo) e pela API (statuses órfãos).
  Depois chama `closeConversation` em cada um, sem esperar a inatividade.
- `demo:reset({ email })`: apaga números demo daquele workspace e tudo que pende deles.

## Tratamento de erros

| Situação | Comportamento |
| --- | --- |
| Assinatura inválida, timestamp fora da tolerância | 401 |
| Corpo não JSON ou não objeto | 400 |
| Webhook duplicado | 200, sem efeito |
| Erro inesperado em `ingest` | 500 (pipes.bot tenta de novo; nada foi gravado) |
| Evento de número desconhecido | `parked` até o `number.onboarded` |
| `number.onboarded` sem workspace | `parked`, log `unassigned number` |
| Falha do OpenRouter ou saída inválida | até 3 chamadas, depois `failed` + Retry |
| Falha do `/v1/apps/token` | erro mostrado na tela de números |
| Falha do health check | `health.state = "unknown"` |

## Testes

Vitest + `convex-test`, sem backend rodando.

| Grupo | Casos |
| --- | --- |
| `computeMetrics` | turnos, primeira resposta, turnos sem resposta, iniciado pela empresa, só mensagens do cliente, `api` sem texto |
| Transcrição e validação | formatação por origem e mídia; `stepId` faltando/sobrando/repetido; evidência inexistente descartada; nota com todos `not_applicable` |
| Assinatura | vetor de teste do repo (`msg_p5jXN8AQM9LWM0D4loKWxJek`), assinatura errada, timestamp fora da tolerância, múltiplas assinaturas, 400 para corpo inválido |
| `ingest` | dedup por `webhookId`; parking e replay; `number.onboarded` sem metadata; echo nunca vira `customer`; status antes do echo incorporado; statuses órfãos viram `api` no fechamento; `closeIfIdle` ignorado após atividade nova; mensagem depois do fechamento abre outro atendimento; troca de número/BSUID; remetente só com BSUID |
| `analyzeConversation` | mock do modelo: sucesso; retry por `stepId` faltando; `failed` após 3 chamadas; `skipped` sem chave e sem resposta |
| Autorização | usuário não lê nem altera número/atendimento de outro workspace |
| Seed | `demo:seed` gera 4 atendimentos fechados com as métricas esperadas; `demo:reset` limpa |

Os fixtures do app são cópias dos de `fixtures/byon-v2/` (o app precisa ser autocontido). O README do app diz de onde vêm.

## Integração com o repo

- `conversation-analyzer/README.md` com frontmatter:
  ```yaml
  ---
  title: Conversation analyzer
  description: Connect WhatsApp Business numbers, capture every reply sent from the phone, and score each conversation on response time and your support methodology
  type: app
  stack: [tanstack-router, convex, better-auth, openrouter, typescript]
  features: [webhooks, byon-v2, embedded-signup, coexistence, echoes]
  ---
  ```
  O gerador já agrupa `type: app` na seção "Apps" da tabela.
- README do app: o que faz, como configurar a App v2 (API v2, echoes ligados em **Forward messages sent from the phone**, webhook `https://<deployment>.convex.site/webhooks/pipes`), rodar local, seed, `simulate` da raiz apontado para o `convex.site`, deploy (SPA estática em Vercel/Netlify + `npx convex deploy`), aviso de privacidade da IA, limites conhecidos e extensões.
- `.gitignore`, `.env.example` e lockfile pnpm próprios.
- CI: novo job `conversation-analyzer` com `pnpm install --frozen-lockfile`, `vitest run`, typecheck e `vite build` (timeout e cache como os outros jobs). O smoke da raiz não muda.

## Fora do escopo

Ranking por atendente (o echo não identifica quem respondeu) · horário comercial · mandar mensagens · desconectar números · organizações e convites · exibir mídia · BYON legacy, sandbox e WebSocket · verificação de e-mail e OAuth. O README lista esses itens como extensões possíveis.

## Critérios de aceite

1. `pnpm test`, typecheck e `vite build` passam em `conversation-analyzer/`, e o job novo do CI roda os três.
2. Com um deploy Convex de dev, `demo:seed` gera quatro atendimentos fechados que aparecem no painel com métricas e, com `OPENROUTER_API_KEY`, análise `done`.
3. Um fixture assinado mandado com `simulate` para `https://<deployment>.convex.site/webhooks/pipes` é aceito (200) e um com assinatura errada é recusado (401).
4. O fluxo real (conectar número, conversar pelo celular, ver o atendimento fechar e ser analisado) é verificado manualmente pelo usuário. Se não for feito, o PR diz isso.
5. `pnpm readme:check` na raiz passa com o app na seção "Apps".
