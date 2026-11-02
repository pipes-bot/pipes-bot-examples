# conversation-analyzer — import de histórico e de contatos (Coexistence)

Data: 2026-11-01
Status: design aprovado em conversa, aguardando revisão desta spec

## Objetivo

Quando um número que já roda no WhatsApp Business app é conectado (Coexistence), o analyzer pede ao pipes.bot o histórico de conversas (até 180 dias) e a agenda de contatos do celular.

- **Histórico:** vira conversas passadas, já fechadas, com métricas de tempo de resposta calculadas em código. Elas entram nas estatísticas pelas datas reais e levam um badge **Imported**. A análise de IA dessas conversas só roda sob demanda, para não gastar OpenRouter com 6 meses de conversa sem ninguém pedir.
- **Contatos:** dão nome a quem hoje aparece só como número. O nome da agenda vence o nome de perfil do WhatsApp.

O app continua só observando: nunca envia mensagem.

**Sucesso:** conectar um número Coexistence com os dois checkboxes marcados e aceitar compartilhar o histórico no celular. Em alguns minutos a página do número mostra o progresso do import. Depois aparecem as conversas antigas com métricas, os contatos com o nome da agenda, e um botão analisa as importadas em lote. Sem número real, a demo mostra conversas importadas, contatos com nome de agenda e o card de import.

## Decisões

| Decisão | Escolha |
| --- | --- |
| Onde | No próprio `conversation-analyzer/`, sem cópia. O código novo fica em arquivos próprios; o código existente ganha só ganchos |
| Quem decide | Dois checkboxes na tela **Connect a number** ("Import chat history (up to 6 months)", "Import contacts"), marcados por padrão, enviados em `POST /v1/apps/token` como `importHistory` / `importContacts` |
| O que o histórico vira | Conversas `closed` com `imported: true`, métricas calculadas, sem análise de IA automática |
| Estatísticas | As importadas entram no overview pelo `closedAt` real (a data da última mensagem). A nota média continua considerando só as analisadas |
| Análise | Sob demanda: botão **Analyze** por conversa (reaproveita `reanalyze`) e **Analyze imported conversations (N)** por número, até 100 por clique, espaçadas ~3s |
| Pipeline do histórico | Staging e depois build com debounce (abordagem A). O chunk cru vai para o file storage do Convex |
| Nome exibido | `bookName` (agenda) → `name` (perfil do WhatsApp) → `waId` / `userId` |
| Mídia do histórico | Não é baixada. `media_placeholder` aparece como `[media]`. O follow-up `history` que traz só `messages[]` é ignorado |

## Contexto (pipes.bot, `origin/main`, conferido em 2026-11-01)

Fonte: `docs/superpowers/specs/2026-11-01-coexistence-history-contacts-sync-design.md` e a seção "Chat history and contacts (Coexistence)" de `docs/byon-v2-migration.mdx`, ambos no repo pipes-bot.

- `POST /v1/apps/token` aceita os booleans opcionais `importHistory` e `importContacts`. Quando presentes, eles vencem o switch da App, nas duas direções. Um valor que não é boolean responde 400. Numa App legacy, são ignorados.
- `number.onboarded` traz `data.importHistory` e `data.importContacts` (booleans), indicando se o import foi pedido para aquele número.
- O import só vale para números Coexistence e só é pedido uma vez, até 24h depois de conectar. A escolha de compartilhar o histórico é feita no celular.
- Eventos v2 `field: "history"`:
  - `whatsapp.history[]` traz `metadata { phase, chunk_order, progress }` e `threads[] { id, messages[] }`;
  - uma mensagem enviada pela empresa tem `to`; uma do cliente tem só `from`;
  - toda mensagem tem `history_context.status`;
  - chunks chegam fora de ordem, e o de `progress: 100` não é necessariamente o último;
  - um chunk pode ter milhares de mensagens;
  - a recusa chega como um único evento com `history[].errors[].code === 2593109`;
  - a mídia vem como `type: "media_placeholder"`, sem id; depois vem um follow-up `history` com `whatsapp.messages[]` (sem o wrapper `history`), mas só para mídia dos últimos 14 dias.
- Eventos v2 `field: "smb_app_state_sync"`: `whatsapp.state_sync[]` com itens `{ type: "contact", contact: { full_name, first_name, phone_number }, action: "add" | "remove", metadata: { timestamp } }`. Chegam primeiro com a lista inicial e depois a cada edição feita no celular.
- Esses dois tipos de evento não usam a fila offline do pipes.bot. Se o webhook falha, o pipes.bot responde erro à Meta e a Meta tenta de novo.
- O docs público (`pipes-bot-docs`, `byon/coexistence.mdx`) ainda diz que o pipes.bot não importa conversas passadas. O PR de docs previsto na spec do pipes-bot não saiu. Isso não bloqueia este trabalho, mas o README aponta a página certa.

## Arquitetura

```
pipes.bot ──POST /webhooks/pipes──► httpAction (assinatura, parse)
                                      │
                ┌─────────────────────┴───────────────────────┐
     field "history"                                   qualquer outro
                │                                             │
   summarizeHistory(payload)                       mutation ingest (como hoje;
   corpo cru → ctx.storage.store()                 + smb_app_state_sync → contactsSync)
                │
   mutation history.receive ──► events (resumo + storageId)
                │ agenda
   action history.processChunk ──► mutation history.stage (lotes de 500) ──► historyMessages (pending)
                │ reagenda (debounce 10 min)
   mutation history.build (um contato por vez, encadeada) ──► conversations (imported) + messages
```

Arquivos novos:

- `convex/lib/history.ts`: funções puras. `summarizeHistory`, `flattenHistory` e `segmentMessages`.
- `convex/history.ts`: `receive`, `processChunk`, `stage`, `build`, `analyzeImported` e a query `importStatus`.
- `convex/contactsSync.ts`: `applyStateSync`, chamada pelo `ingest`.

Ganchos no código existente:

- `webhook.ts`: o desvio para `history`.
- `ingest.ts`: `smb_app_state_sync` entra em `ENVELOPE_FIELDS`. O `onboardNumber` grava o que foi pedido e faz o replay de `history` parked.
- `numbers.ts`: `createSignupLink` recebe as flags.
- `dashboard.ts`: nome exibido e `imported` nas respostas.
- UI: checkboxes, card de import, badges, botões de análise.

## Modelo de dados

`numbers` ganha:

```ts
historyImport: v.optional(v.object({
  state: v.union(
    v.literal("requested"),  // number.onboarded disse importHistory: true
    v.literal("importing"),  // chegou ao menos um chunk com mensagens
    v.literal("done"),       // progress 100 visto e build sem contatos pendentes
    v.literal("declined"),   // erro 2593109
  ),
  progress: v.number(),      // maior progress visto, 0–100
  chunks: v.number(),        // chunks com mensagens recebidos
  messages: v.number(),      // mensagens gravadas no staging
  conversations: v.number(), // conversas importadas existentes (recalculado pelo build)
  updatedAt: v.number(),
  buildJobId: v.optional(v.id("_scheduled_functions")),
})),
contactsImport: v.optional(v.object({
  state: v.union(v.literal("requested"), v.literal("received")),
  updatedAt: v.number(),
})),
```

Quando o campo está ausente, o import não foi pedido. O estado "montando" não é guardado: a UI deduz isso de `buildJobId` presente ou de existirem linhas `pending`.

`contacts` ganha `bookName?: string`, `bookUpdatedAt?: number` (o `metadata.timestamp` do último evento aplicado, em ms) e `bookRemovedAt?: number`. Também ganha o índice `by_number` (`["numberId"]`), usado para contar os contatos com `bookName`.

`messages` ganha `imported?: true`, marcando as mensagens que o build gravou a partir do staging.

`conversations` ganha `imported?: true` e o índice `by_number_imported` (`["numberId", "imported"]`), usado por `analyzeImported` e pela contagem do card.

`events` ganha `storageId?: Id<"_storage">`. Para `history`, `payload` guarda só `{ field, pipes: { poolNumberId }, summary }`, e o corpo cru fica no storage. Nenhum documento passa de 1 MiB.

Tabela nova `historyMessages` (staging; continua existindo depois do build para permitir rebuild):

```ts
historyMessages: defineTable({
  numberId: v.id("numbers"),
  contactId: v.id("contacts"),
  wamid: v.string(),
  source: v.union(v.literal("customer"), v.literal("phone")),
  type: v.string(),
  text: v.optional(v.string()),
  sentAt: v.number(),
  pending: v.optional(v.literal(true)),
})
  .index("by_wamid", ["wamid"])
  .index("by_number_contact_sent_at", ["numberId", "contactId", "sentAt"])
  .index("by_number_pending", ["numberId", "pending"]),
```

## Conexão

- `numbers.createSignupLink` passa a receber `{ importHistory: v.boolean(), importContacts: v.boolean() }` e envia os dois no corpo de `POST /v1/apps/token`, junto com `redirectUrl` e `metadata`.
- Em `/numbers`, o botão **Connect a number** abre um painel inline com os dois checkboxes, ambos marcados, e um botão **Continue**. A nota do painel diz: "Only for numbers on the WhatsApp Business app. Your phone will ask whether to share chat history. WhatsApp allows the import once, right after connecting."
- `onboardNumber`: quando `data.importHistory === true` e o número ainda não tem `historyImport`, grava `{ state: "requested", progress: 0, chunks: 0, messages: 0, conversations: 0, updatedAt: now }`. Para contatos é igual, com `{ state: "requested" }`. Um `number.onboarded` repetido nunca regride um estado que já avançou.
- Um número que muda de workspace leva o estado do import. As conversas importadas ficam com o workspace antigo, como já acontece com as ao vivo.

## Pipeline do histórico

### `lib/history.ts`, funções puras

- `summarizeHistory(payload)` devolve `{ declined, progress?, phase?, chunkOrder?, messageCount, mediaFollowUp }` e tolera qualquer formato:
  - `declined`: algum `history[].errors[].code === 2593109`;
  - `progress`: o maior `history[].metadata.progress` numérico;
  - `messageCount`: a soma de `threads[].messages[]`;
  - `mediaFollowUp`: não há `history[]`, mas há `whatsapp.messages[]`.
- `flattenHistory(payload)` devolve linhas `{ threadId, wamid, source, type, text?, sentAt }`.
  - O contato é o `thread.id`.
  - `source` é `phone` quando a mensagem tem `to`, e `customer` caso contrário.
  - `type` e `text` vêm do `contentOf` de `lib/payload.ts`. `media_placeholder` não tem texto.
  - `sentAt` vem de `waTimestampMs`. Mensagens sem `id` ou sem timestamp válido são descartadas: no histórico não existe um "agora" que sirva de fallback.
- `segmentMessages(messages, inactivityMs)` ordena por `sentAt` (desempate por wamid) e abre um segmento novo quando o intervalo para a mensagem anterior é **maior** que `inactivityMs`. Um intervalo exatamente igual à janela fica no mesmo segmento, como em `closeIfIdle`.

### `webhook.ts`

Depois da assinatura e do parse:

- `field === "history"`:
  - calcula `summarizeHistory`;
  - se `messageCount > 0`, faz `ctx.storage.store(new Blob([body], { type: "application/json" }))`;
  - chama `internal.history.receive` com `{ webhookId, poolNumberId, summary, storageId? }`;
  - se a mutation responder `duplicate` ou `ignored`, a action apaga o blob.
- Qualquer outro campo segue para o `ingest`, como hoje.

O limite de corpo de um HTTP action do Convex (20 MiB) cobre os chunks esperados. Se um chunk passar disso, o Convex responde erro, o pipes.bot responde erro à Meta, e isso vai documentado em Troubleshooting.

### `history.receive` (mutation interna)

1. Deduplica por `webhookId` na tabela `events`. Se já existe, responde `duplicate`.
2. Número desconhecido: grava o evento `parked` com o `storageId` e responde.
3. Número sem `historyImport`: `ignored`.
4. `declined`: `historyImport.state = "declined"`, evento `processed`.
5. `mediaFollowUp` ou `messageCount === 0`: `ignored`.
6. Caso contrário:
   - se o estado não é `declined` nem `done`, passa a `importing`;
   - `progress = max(progress, summary.progress)`;
   - incrementa `chunks`;
   - agenda `history.processChunk({ numberId, eventId, storageId })`;
   - o evento fica `processed`.

   Num número já `done`, um chunk atrasado também é processado: o estado volta para `importing` até o próximo build.

O replay do `onboardNumber` passa a tratar eventos `history` parked. Ele aplica os mesmos passos 3 a 6 com o resumo guardado e muda o estado do evento para `processed` ou `ignored`. Os blobs de eventos ignorados são apagados na mesma mutation (`ctx.storage.delete` é permitido em mutations).

### `history.processChunk` (action interna)

- Lê o blob com `ctx.storage.get` e o passa por `flattenHistory`.
- Chama `history.stage` em lotes de 500 linhas.
- Se o blob não existe mais, termina sem erro.
- Uma exceção no parse deixa um log; o chunk se perde. A Meta não reenvia um evento que já foi aceito, e isso vai documentado.

### `history.stage` (mutation interna)

Para cada linha:

1. Resolve o contato com o `resolveContact` de `ingest.ts` (exportado), usando `{ waId: threadId }`.
2. Pula a linha se o wamid já existe em `historyMessages`.
3. Insere com `pending: true`.

Ao final:

- incrementa `historyImport.messages`;
- cancela o `buildJobId` anterior;
- agenda `history.build({ numberId })` para daqui a 10 minutos (`BUILD_DEBOUNCE_MS`);
- grava o novo `buildJobId`.

### `history.build` (mutation interna, encadeada)

1. Pega uma linha qualquer com `pending: true` do número (`by_number_pending`). Se não existir nenhuma, recalcula `historyImport.conversations` (contagem de `by_number_imported` no workspace atual) e limpa o `buildJobId`. Se `progress === 100`, marca `done`. Termina.
2. Para o contato dessa linha:
   - desfaz o build anterior (rebuild idempotente): apaga as conversas `imported` do contato com as mensagens delas, e apaga as mensagens `imported` que tinham sido juntadas a uma conversa ao vivo do contato. Numa conversa ao vivo que perdeu mensagens, `openedAt` e `initiatedBy` voltam a vir da primeira mensagem que sobrou;
   - carrega todo o `historyMessages` do contato e descarta os wamids que já existem em `messages`. Depois do passo anterior, só sobram ali mensagens do tráfego ao vivo;
   - segmenta com a janela `inactivityMinutes` atual do workspace.
3. Fronteira com o ao vivo: seja `last` o último segmento e `live` a conversa não importada do contato com o menor `openedAt` maior ou igual ao fim de `last`. Se `live` está `open` e `live.openedAt - last.end <= inactivityMs`:
   - as mensagens de `last` entram em `live`;
   - `openedAt` passa a ser o início de `last`;
   - `initiatedBy` vem da primeira mensagem de `last`;
   - `lastTurn` e `waitingSince` não mudam, porque continuam decididos pelo tráfego ao vivo;
   - essas mensagens são gravadas com `imported: true`, e o próximo rebuild as encontra pelas conversas do contato.
4. Cada segmento restante vira uma conversa:

   ```ts
   {
     workspaceId: number.workspaceId,
     numberId,
     contactId,
     imported: true,
     status: "closed",
     initiatedBy,
     openedAt,
     lastActivityAt: end,
     closedAt: end,
     lastTurn,
     metrics: computeMetrics(msgs),
   }
   ```

   Sem `analysis` e sem agendamento de fechamento. As mensagens vão para `messages` com `imported: true`, `direction`, `source`, `type`, `text` e `sentAt`, sem os tempos de entrega e leitura (`history_context.status` não é usado).
5. Limpa o `pending` das linhas do contato e agenda `history.build({ numberId })` imediatamente, para o próximo contato.

Uma mutation por contato. O limite de leitura e escrita do Convex por transação limita o tamanho de um único contato a alguns milhares de mensagens. Para um exemplo, isso fica documentado, não tratado.

### Limitações aceitas

- Mudar `inactivityMinutes` depois não re-segmenta as importadas.
- Um rebuild por chunk atrasado descarta a análise das importadas daquele contato. Na prática o chunk chega minutos depois, antes de alguém analisar.
- O `MAX_CONVERSATIONS = 1000` do overview pode cortar uma janela de 30 dias de um número grande. O comportamento já existe e não muda.
- O transcript da IA mostra só a hora (`HH:MM`). Uma conversa importada que atravessa a meia-noite fica com horas que parecem fora de ordem. O comportamento também já existe.

## Contatos (`smb_app_state_sync`)

- `ENVELOPE_FIELDS` ganha `smb_app_state_sync`, então ganha deduplicação, parking e replay de graça. `projectEnvelope` chama `applyStateSync(ctx, number, whatsapp)`.
- Para cada `state_sync[]` com `type === "contact"` e `contact.phone_number` não vazio:
  - `at = waTimestampMs(metadata.timestamp, now)`.
  - O contato é encontrado por `by_number_wa_id` com `waId = phone_number`.
  - Se `contact.bookUpdatedAt > at`, o item é ignorado (evento mais antigo que o já aplicado).
  - `add`: cria ou atualiza o contato com `bookName = full_name ?? first_name`, `bookUpdatedAt = at` e `bookRemovedAt` limpo. Item sem nome nenhum: grava só o `bookUpdatedAt`.
  - `remove`: se o contato existe, limpa `bookName` e grava `bookUpdatedAt = at` e `bookRemovedAt = at`. Nada é apagado, porque as conversas apontam para o contato.
- O primeiro evento aplicado marca `contactsImport = { state: "received", updatedAt }`. Edições depois disso só atualizam o `updatedAt`. Se o número não tem `contactsImport`, os eventos são aplicados mesmo assim: o pipes.bot só entrega o que foi pedido.
- Nome exibido: um helper `contactDisplayName(contact)` em `dashboard.ts` usa `bookName ?? name`. O `contactLabel` (o número) não muda. `overview`, `waiting`, `conversations` e `conversation` usam o helper.

## Análise sob demanda

- **Por conversa:** a mutation `conversations.reanalyze` já aceita qualquer conversa fechada. Na tela da conversa, uma importada sem `analysis` mostra o botão **Analyze** no lugar do resultado.
- **Em lote:** a mutation pública `history.analyzeImported({ numberId })`:
  - checa a autorização com `requireNumber`;
  - pega até 100 conversas `imported`, fechadas, sem `analysis`, do workspace atual (`by_number_imported`), das mais recentes para as mais antigas;
  - para cada uma, chama `requestAnalysis` com um `delayMs` de `i * 3000`. `requestAnalysis` ganha esse parâmetro opcional, com padrão 0.
  - Responde `{ requested, remaining }`.
- A query `history.importStatus({ numberId })` devolve:
  - `historyImport` e `contactsImport`;
  - `building`: `buildJobId` presente ou alguma linha `pending`;
  - `importedConversations`;
  - `unanalyzed`: importadas sem `analysis`, contadas até 1000;
  - `bookContacts`: contatos com `bookName`.

## Interface

- **`/numbers`:** o painel de conexão descrito em Conexão. A tabela ganha a coluna **Import** com um badge:
  - "Importing history 40%"
  - "Building history"
  - "History imported"
  - "History not shared"
  - "Waiting for history" (estado `requested`)
  - "Contacts imported"

  O traço "—" aparece quando nada foi pedido.
- **`/numbers/$numberId`:** um card **Import** quando há `historyImport` ou `contactsImport`. Ele mostra:
  - estado e progresso do histórico;
  - quantidade de conversas importadas;
  - quantidade de contatos com nome da agenda;
  - o botão **Analyze imported conversations (N)**, com um diálogo de confirmação ("This runs the AI analysis on N conversations using your OpenRouter key.");
  - em `declined`: "The business chose not to share chat history on the phone. WhatsApp only allows the import once, so it can't be requested again for this number."
- **Listas de conversa e `/conversations/$conversationId`:** badge **Imported** na linha e no header; botão **Analyze** quando a importada ainda não foi analisada.
- **`/numbers/connected`:** quando o número foi conectado com import, mostra "If you shared chat history on the phone, past conversations appear here in a few minutes."

## Demo

`demo.ts` ganha, no número de demo:

- 4 contatos com `bookName`, um deles diferente do nome de perfil, para mostrar a prioridade;
- linhas de `historyMessages` de 3 a 20 dias atrás, que resultam em uns 6 segmentos, com respostas rápidas, lentas e uma sem resposta.

O seed chama a mesma lógica de build que a mutation (uma função `buildContact(ctx, number, contactId)` exportada de `history.ts`). Ele não usa storage, porque uma mutation não pode chamar `storage.store`. O número de demo fica com `historyImport: { state: "done", progress: 100, ... }` e `contactsImport: { state: "received" }`. As importadas da demo ficam sem análise, para mostrar o botão.

## Tratamento de erros

| Situação | Comportamento |
| --- | --- |
| Assinatura inválida | 401, como hoje |
| Webhook repetido | `duplicate`, o blob recém-salvo é apagado |
| Chunk malformado | `summarizeHistory`/`flattenHistory` nunca lançam; o que não dá para ler é descartado |
| Blob sumiu antes do `processChunk` | Termina sem erro |
| History de número sem import pedido | `ignored`, blob apagado |
| Evento de recusa depois de chunks | Estado vira `declined`; as conversas já montadas ficam |
| `state_sync` com item sem `phone_number` | Item ignorado |
| `createSignupLink` sem flags (cliente antigo) | O validator exige os dois booleans; a UI sempre envia |

## Fixtures

Em `fixtures/byon-v2/`, como linhas "docs example". A coluna de fonte da tabela em `fixtures/README.md` aponta `pipes-bot docs/byon-v2-migration.mdx (Chat history and contacts)`.

- `history-chunk.json`: o exemplo da doc (phase 0, progress 40, uma thread com texto e `media_placeholder`).
- `history-complete.json`: o mesmo formato, com progress 100 e outra thread.
- `history-declined.json`: o exemplo de erro `2593109`.
- `history-media.json`: o follow-up com `whatsapp.messages[]`.
- `smb-app-state-sync.json`: o exemplo da doc, mais um item `remove`.

## Testes

Vitest + `convex-test`, no estilo dos testes atuais.

- **`lib/history.test.ts`:**
  - `summarizeHistory`: chunk, completo, recusa, follow-up de mídia, `null`, arrays com formato errado;
  - `flattenHistory`: `thread.id` como contato, `to` virando `phone`, `media_placeholder`, descarte sem id ou sem timestamp;
  - `segmentMessages`: intervalo maior e igual à janela, entrada fora de ordem, desempate.
- **`history.test.ts`:**
  - **receive**: duplicata (o webhook remove o blob), número desconhecido fica parked e o replay processa depois do `number.onboarded`, import não pedido vira `ignored`, recusa vira `declined`, `progress` nunca diminui;
  - **stage**: wamid repetido entre chunks, debounce (o segundo chunk cancela o build agendado);
  - **build**:
    - segmentos e métricas; `imported`, `closedAt` = última mensagem;
    - nenhuma análise agendada;
    - wamid ao vivo descartado;
    - junção com a conversa ao vivo aberta, e sem junção quando ela está fechada ou fora da janela;
    - rebuild idempotente com chunk atrasado (sem duplicar conversas nem mensagens), inclusive quando houve junção com uma conversa ao vivo;
    - `done` só com progress 100;
    - as importadas aparecem em `dashboard.overview`;
  - **analyzeImported**: só as importadas sem análise, limite de 100, delays crescentes, authz entre workspaces.
- **`contactsSync.test.ts`:** `add` cria e atualiza, `remove` limpa o nome sem apagar, evento mais antigo ignorado, `contactsImport` marcado, prioridade `bookName` → `name` → número em `waiting` e `conversations`.
- **`webhook.test.ts`:** `history` vai para o storage e não chega ao `ingest`; um chunk acima de 1 MiB é aceito; os outros campos seguem como hoje.
- **`numbers.test.ts`:** `createSignupLink` envia `importHistory` e `importContacts` no corpo.
- **`ingest.test.ts`:** `number.onboarded` com as flags grava os estados `requested` e não regride.
- **`demo.test.ts`:** o seed cria importadas, contatos de agenda e os estados de import.

## Integração com o repo

- README do analyzer:
  - frontmatter `features` ganha `history-import` e `contacts-sync`;
  - "pipes.bot features used" ganha os dois eventos e as flags do token;
  - seção nova "Chat history and contacts import" com o fluxo, os arquivos e as limitações (uma vez, 24h, só Coexistence, a escolha é do celular, sem mídia, contatos muito grandes);
  - Troubleshooting:
    - o histórico nunca chega: número não é Coexistence, a empresa recusou, passou de 24h, ou o import está desligado no pipes.bot;
    - os nomes da agenda não aparecem: `Import contacts` estava desmarcado na conexão.
- `scripts/generate-readme.ts`: `KNOWN_FEATURES` ganha `history-import` e `contacts-sync` (sem isso o gerador avisa "unknown feature"), e o README raiz é regenerado.
- `fixtures/README.md`: as linhas novas.

## Fora do escopo

- Pedir o import para números já conectados (a Meta não permite).
- Apps legacy.
- Baixar ou mostrar mídia do histórico.
- Re-segmentar as importadas quando a janela de inatividade muda.
- Filtro Live / Imported no overview.
- Usar `history_context.status` como tempo de entrega ou de leitura.
- Uma cópia separada do app.

## Critérios de aceite

1. `pnpm test`, typecheck e build do analyzer passam.
2. Com Convex local anônimo, o simulador e chaves fake, em sequência:
   - `number-onboarded` (com as flags);
   - `history-chunk` e depois `history-complete`;
   - depois do debounce, as conversas importadas aparecem fechadas, com métricas, e o card mostra "History imported".
3. `history-declined` mostra "History not shared".
4. `smb-app-state-sync` mostra o nome da agenda nas listas, e o `remove` volta para o nome de perfil ou o número.
5. Na demo, no browser, aparecem o card de import, os badges **Imported** e o botão **Analyze imported conversations**. O diálogo de confirmação abre.
6. Ficam como não verificados no PR: um número Coexistence real com histórico real, chunks grandes reais, e se o import está ligado em produção no pipes.bot (`SMB_SYNC_ENABLED`).
