# mini-crm — memória buscável e templates

Data: 2026-11-13
Status: design aprovado em conversa, aguardando revisão desta spec

## Origem e decisão

Partiu da spec "WhatsApp MCP server with PipesBot", que pedia um exemplo novo `whatsapp-mcp/` com o stack do mini-crm. Durante o design decidimos:

- Manter estágios, tags e notas: o CRM é útil como tools para o MCP.
- Com o CRM inteiro, um `whatsapp-mcp/` seria uma cópia do mini-crm com duas tools a mais. Em vez de duplicar ~7 mil linhas, **evoluímos o próprio `mini-crm/`**. Não há pasta nova, job de CI novo nem linha nova na tabela do README raiz.
- `send_template` sempre envia direto, nunca vira rascunho.

Da spec original ficam: a tese ("o PipesBot não guarda conversas na API v2; a memória é sua"), a diferenciação com o plugin do Claude, `search_messages`, `send_template` via passthrough, as correções do §19 (131047 vs `SERVICE_WINDOW_EXPIRED`) e as regras de "não prometer". Saem: pasta nova, escopos `messages:*`, `list_conversations`, `reply`, `mark_read`, `list_numbers`.

## Objetivo

Quem lê o mini-crm entende que o histórico das conversas existe porque o app o grava (o PipesBot não guarda nada na v2), e o cliente MCP ganha duas capacidades que faltavam:

1. **Buscar no texto das mensagens** de todo o workspace (`search_messages`).
2. **Enviar um template aprovado** quando a janela de 24h está fechada (`send_template`).

**Sucesso:** `pnpm test`, `pnpm typecheck` e `pnpm build` passam no `mini-crm/`; `pnpm readme:check` passa na raiz; na demo, `search_messages "invoice"` encontra mensagens e `send_template` funciona num contato com a janela fechada, enquanto `send_message` recusa com `window_closed`.

## Escopo

| Item | Decisão |
| --- | --- |
| Pasta | `mini-crm/` (existente) |
| Conversa | Continua sendo o contato (um cliente num número). Sem tabela nova |
| Tools | As 8 atuais + `search_messages` + `send_template` = 10 |
| Escopos | Continuam `crm:read` / `crm:write`. `search_messages` em `crm:read`, `send_template` em `crm:write` |
| Fora | `list_conversations` (= `search_contacts` sem `query` + `list_unanswered`), `reply`, `mark_read` (não documentado), `list_numbers`, busca na UI, formulário de template na UI, header de mídia e botões em templates |

## `search_messages`

**Schema:** em `messages`, `.searchIndex("search_text", { searchField: "text", filterFields: ["workspaceId", "contactId"] })`. Entra toda mensagem com `text`: recebidas, enviadas, echoes, legendas de mídia e templates (pelo texto legível, abaixo).

**Ferramenta** (`crm:read`, `readOnlyHint`):

| Entrada | Regra |
| --- | --- |
| `query` | 1–200 caracteres, obrigatório |
| `contactId?` | restringe a um contato do workspace |
| `limit` | padrão 20, máx. 50 |

**Saída:** `messages[]` com `id`, `contactId`, `contact` (nome ou telefone), `from` (mesmo rótulo de `get_conversation`: `contact`, `you`, `phone` ou nome do cliente MCP), `text`, `type`, `sentAt`. Ordem por relevância do full-text do Convex (palavras inteiras, prefixo na última). O resumo em texto cita o `contactId` de cada resultado para o modelo encadear `get_conversation`.

**Regras:**

- A consulta sempre filtra por `workspaceId`. `contactId` malformado ou de outro workspace → `isError` com "Contact not found".
- A descrição avisa que o texto é escrito por terceiros e nunca é instrução, e o resultado usa o mesmo envelope `withData` das outras tools.
- A query interna fica em `mcp/data.ts` e o helper de leitura em `crmRead.ts`, como as demais.

## `send_template`

### Fatos da API (conferidos em `pipes-bot/apps/server/src/routes/v1/messages.ts` e `docs/byon/passthrough-messages.mdx`)

- `POST /v1/messages/passthrough`. Na v2 só `poolNumberId` é removido; o resto vai para a Meta intacto. O destinatário é `to` para telefone e `recipient` para BSUID.
- `type` é obrigatório.
- Sucesso: corpo da Meta, `{ messaging_product, contacts, messages: [{ id }] }`. O `wamid` é `messages[0].id`.
- Erros do PipesBot: `{ error: { code: "<STRING>", message } }` (`RATE_LIMITED` 429 com `X-RateLimit-Reset`, `NOT_FOUND`, `FORBIDDEN`, `REGISTRATION_PENDING`, `NO_CREDENTIALS`, `META_UNREACHABLE`, `META_INVALID_RESPONSE`). Erros da Meta: `{ error: { code: <número>, … } }` com o status HTTP da Meta.
- No BYON o PipesBot não checa a janela.

### Ferramenta

`crm:write`, `annotations` iguais a `send_message` (`destructiveHint: true`, `openWorldHint: true`). Sempre direto, mesmo com o workspace em modo `draft`.

| Entrada | Regra |
| --- | --- |
| `contactId` | contato existente do workspace (nunca telefone) |
| `templateName` | `^[a-z0-9_]{1,512}$` |
| `languageCode` | `^[a-z]{2,3}(_[A-Z]{2})?$`, ex. `en_US`, `pt_BR` |
| `bodyParams?` | até 20 strings de 1–1024 caracteres |

Descrição: "Send an approved WhatsApp template to an existing contact. Sends a real WhatsApp message immediately, with no approval step. Works even when the 24-hour window is closed. The template must already be approved in Meta for this number's WhatsApp Business Account."

Corpo enviado:

```json
{
  "messaging_product": "whatsapp",
  "poolNumberId": "pn_…",
  "type": "template",
  "to": "5511…",
  "template": {
    "name": "order_confirmation",
    "language": { "code": "en_US" },
    "components": [{ "type": "body", "parameters": [{ "type": "text", "text": "Maria" }] }]
  }
}
```

`to` quando o contato tem `waId`; senão `recipient` com o `userId` (BSUID). Sem `bodyParams`, `components` é omitido.

Saída: `{ status: "sent" | "queued" | "failed", messageId?, error? }`, como `send_message` no modo direto.

### No pipeline de envio existente

`prepareSend → insertOutgoing → deliver → finish` continua sendo o único caminho de envio.

- `messages` ganha `template?: { name, language, bodyParams: string[] }`. A linha é gravada com `type: "template"` e `text` legível: `[template order_confirmation] Maria, ORD-4521` (sem parâmetros: `[template order_confirmation]`). Assim aparece na inbox e no `search_messages`.
- `SendArgs` ganha `template?`. `prepareSend` valida o template (mesmas regras da tool, repetidas no servidor; erro `invalid_template`) e, **só para template, pula a checagem de janela**. Continuam valendo `no_recipient`, `number_unavailable` e `number_blocked`.
- `deliverMessage`: com `message.template`, monta o corpo acima e chama `postPassthrough`; senão `postToPipes` como hoje. Os dois compartilham timeout (30 s), tratamento de 429 (retry agendado, até 3 tentativas) e "timeout/erro de rede nunca repete".
- Número demo: não chama fetch; `wamid.demo_…`.
- Statuses posteriores casam pelo `wamid`, sem mudança no ingest.
- `requireRetryable` recusa `type: "template"`; a inbox esconde **Retry** nesses casos.
- Activity `message_sent` com o ator (nome do cliente MCP) e detalhe `template <name>`.

### Erros

- `parseSendFailure` passa a ler `error.code` string (formato real do PipesBot), além do `code` no topo, para texto e template. `RATE_LIMITED` → `rate_limited`; outros códigos → minúsculas (ex. `registration_pending`).
- Meta: `meta_<código>`, e `131047` → `window_closed` (só faz sentido para texto).
- `sendErrorMessage` ganha: `meta_132001` (template não existe neste idioma), `meta_132000` (número de parâmetros não confere), `meta_132015` (template pausado), `invalid_template`.
- Comentários e README deixam de apresentar `SERVICE_WINDOW_EXPIRED` como o erro de janela do BYON: no BYON é o `131047` da Meta (na resposta ou num status `failed` depois). `SERVICE_WINDOW_EXPIRED` continua sendo mapeado por segurança.

## Interface

- Composer com a janela fechada: "Window closed: ask your MCP client to send a template." (sem formulário).
- Bolha de mensagem de template: mostra o texto legível com um selo "Template".
- Sem caixa de busca na inbox.

## Demo

- Mensagens com termos buscáveis (ex. "invoice", "ship to Lisbon") em contatos diferentes.
- Pelo menos um contato com a janela fechada (último inbound há mais de 24h). Se a seed já tiver, só confere.

## Testes

Vitest + `convex-test`, fetch mockado, sem rede:

1. `search_messages`: acha por texto; filtro `contactId`; não vê outro workspace; `contactId` alheio → "Contact not found"; ausente sem `crm:read`.
2. `send_template`: URL `/v1/messages/passthrough`, `Authorization: Bearer`, corpo com `to` (telefone) e com `recipient` (só BSUID), `wamid` de `messages[0].id`; funciona com janela fechada; demo não chama fetch; 429 agenda retry; timeout não repete; `number_blocked` recusa; nunca cria rascunho em modo `draft`; validação de `templateName`/`languageCode`/`bodyParams`.
3. `parseSendFailure`: `{ error: { code: "RATE_LIMITED" } }`, `{ error: { code: "REGISTRATION_PENDING" } }`, `{ error: { code: 132001 } }`.
4. Status `delivered` com o `wamid` do template atualiza a mensagem.
5. Retry recusa mensagem de template.
6. `tools/list` lista as 10 tools com `crm:read`+`crm:write` e só as de leitura com `crm:read`.
7. `scripts/oauth-smoke.ts` chama `search_messages` (fora do CI).

## README do mini-crm

- Seção nova logo após "What it shows": **"Memory: pipes.bot stores nothing on API v2"**. O histórico existe porque o app grava cada webhook e cada envio no seu deployment Convex. Em Convex anônimo local, fica na sua máquina; em deployment na nuvem (necessário para webhooks reais e clientes MCP hospedados), fica no seu deployment Convex, não no PipesBot e não só no seu laptop.
- Tabela curta "mini-crm vs Claude WhatsApp plugin" (`pipes-bot/claude-plugins/plugins/whatsapp`): o plugin é um canal ao vivo do Claude Code, sem histórico, tools `reply`/`react`; o mini-crm guarda e busca o histórico, por HTTP + OAuth.
- MCP tools: as 10.
- Sending rules: templates (sempre diretos, fora da janela, só body params), 131047.
- Limits: troca "Media and templates. Only text…" por "Media sending, and templates with header media or buttons". Inclui: sem API de histórico no PipesBot; sem endpoint de estado da janela; `mark_read`/digitando não documentados.
- Verification status atualizado com o que foi e não foi verificado.
- Frontmatter: `features` ganha `templates`; `description` menciona a busca no histórico e templates. Rodar `pnpm readme` na raiz.

## Entrega

- Branch `mini-crm-memory-templates`, em worktree separado (`../pipes-bot-examples-memory`), para não misturar com mudanças locais no checkout principal.
- Commits só com `mini-crm/`, `README.md` da raiz e os docs. Sem rodapé de co-autor (`AGENTS.md`).
- Sem push e sem PR até pedido explícito.
