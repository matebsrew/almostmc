# Auditoria da arquitetura atual — ZernFlow / almostmc

**Parecer: BLOQUEIA o início do SaaS multiempresa até corrigir os riscos CRITICAL e HIGH abaixo.** O repositório já tem entidades e fluxos reaproveitáveis, mas o snapshot não sustenta a promessa de isolamento entre clientes.

**Base:** `dynknight/zernflow`, commit `acb6ef00df27600935468ee79ec6c40ec667d383` (`main`). `almostmc` foi criado como repositório privado; `upstream` aponta para o projeto original. Este é um clone privado com histórico, não um fork GitHub (`isFork=false`).

**Limite da evidência:** análise estática do código e das migrations nesse commit. Não conectei a Supabase/Zernio, não validei se os segredos ainda estão ativos, não executei ataques nem apliquei migrations. Portanto, comportamento do banco remoto, grants efetivos, políticas já implantadas e credenciais atuais continuam **não verificados**.

## Evidência crítica extraída

Os valores abaixo foram censurados neste relatório; os nomes e linhas são os do código auditado.

> `scripts/provision-single-tenant.js:4-6`: `SUPABASE_URL`, `SERVICE_ROLE_KEY` e `ZERNIO_KEY` recebem literais no código. `scripts/test-db.js:4` e `scripts/test-user.js:4` também contêm literal de `SERVICE_ROLE_KEY`.

O service-role JWT e a chave Zernio devem ser tratados como comprometidos. O código também contém senha fixa para a conta administrativa em `lib/supabase/middleware.ts:46-49`, repetida no provisionamento. A validade atual não foi testada. O upstream está público: [dynknight/zernflow](https://github.com/dynknight/zernflow). **Rotacionar/revogar essas credenciais é pré-requisito para qualquer uso real; tornar `almostmc` privado não revoga as cópias no histórico público.**

> `lib/supabase/middleware.ts:44-53`: quando `user` é nulo, chama `signInWithPassword` com a conta administrativa fixa e usa o usuário retornado.
>
> `lib/workspace.ts:73-87`: se não encontra membership, busca o primeiro workspace com service role e retorna `role: "owner"`.

Isso é autenticação compartilhada e fallback permissivo. Se a conta e a senha ainda forem válidas, visitantes sem login passam a usar a mesma identidade privilegiada. Essa validade não foi confirmada; a implementação, porém, está presente no snapshot.

> `supabase/migrations/00009_fix_broadcast_rls.sql:20-29`: `scheduled_jobs` permite `INSERT`, `SELECT` e `UPDATE` para qualquer usuário com `auth.uid() IS NOT NULL`.
>
> `supabase/migrations/00001_initial_schema.sql:245-254`: `scheduled_jobs` não tem `workspace_id`.
>
> `app/api/cron/jobs/route.ts:22-49,84-123`: o cron usa `createServiceClient()` e executa os jobs lidos da fila, inclusive `resume_flow`.

Qualquer usuário autenticado pode ler e alterar a fila global via Data API. O cron então processa os dados com service role. Isso quebra isolamento e integridade entre workspaces; o risco inclui alterar execuções agendadas e provocar ações de automação de outro cliente quando os identificadores necessários estiverem disponíveis.

> `app/api/webhooks/late/route.ts:120-145`: a validação HMAC só ocorre dentro de `if (channel.webhook_secret)`.
>
> `supabase/migrations/00001_initial_schema.sql:38-40`: `webhook_secret` é anulável.
>
> `app/api/v1/channels/sync/route.ts:86-95`: a sincronização cria canais sem preencher `webhook_secret`.

**Dedução:** canais criados por esse caminho ficam sem segredo e pulam a validação de assinatura. Como o handler usa service role e aciona o motor de fluxos, eventos forjados podem criar dados e disparar automações. Não consultei o banco para saber se canais atuais receberam segredo por outro caminho.

## Arquitetura encontrada

O README descreve Next.js App Router com Supabase (Postgres, Auth e Realtime), React Flow, Zernio e um motor próprio em `lib/flow-engine/`. O caminho real observado é:

`Dashboard/API → Supabase Auth + cliente com RLS`; `webhook Zernio → createServiceClient → channel → contato/conversa → trigger → executeFlow`; `cron → createServiceClient → scheduled_jobs/sequence_enrollments → execução/envio`.

O contexto comum de páginas e várias server actions passa por `getWorkspace()`. Parte das API routes repete a busca de usuário e membership; alguns helpers escolhem `.limit(1)` e ignoram o workspace selecionado no cookie. Não existe um `requireWorkspaceAccess()`/`requireWorkspaceRole()` centralizado.

O Graphify encontrou `getWorkspace` e os dois `createClient()` entre os nós mais conectados; também traçou `DashboardLayout()` e várias páginas até `getWorkspace`. O grafo é AST, sem extração semântica: 11 arquivos SQL ficaram sem símbolos por falta de `tree_sitter_sql`; `lib/flow-engine/index.ts` não foi extraído por erro do parser na linha 4. As conclusões de banco abaixo vêm da leitura direta das migrations, não do grafo.

## Modelo de workspace e tabelas

| Entidade | Boundary registrado | RLS observado |
|---|---|---|
| `workspaces` | própria chave `id` | SELECT e UPDATE para qualquer membro; sem política INSERT no `00002` |
| `workspace_members` | `workspace_id` + `user_id` | SELECT próprio; gestão com política de owner |
| `channels`, `contacts`, `tags`, `custom_field_definitions`, `flows`, `conversations`, `broadcasts`, `analytics_events`, `comment_logs`, `sequences`, `workspace_invites` | `workspace_id` direto | políticas de membership; `comment_logs` só tem SELECT de usuário |
| `contact_channels`, `contact_tags`, `contact_custom_fields`, `triggers`, `flow_sessions`, `messages`, `broadcast_recipients`, `sequence_enrollments`, `flow_versions` | herdado via entidade pai | políticas verificam uma relação-pai, com exceções de escrita |
| `scheduled_jobs` | **nenhum `workspace_id`** | políticas globais descritas acima |

Relações herdadas não equivalem a uma constraint de tenant. Exemplos: `conversations` armazena `workspace_id`, `channel_id` e `contact_id` como FKs independentes; `triggers` liga `flow_id` e `channel_id`; `sequence_enrollments` liga sequência, contato e canal. As políticas verificam o workspace da conversa, do flow, da sequência ou do broadcast, mas não provam que todos os pais referenciados pertencem ao mesmo workspace. IDs de outro workspace conhecidos permitem tentar criar relações cruzadas; esse ataque não foi executado.

## RLS e roles

As migrations habilitam RLS em `workspaces`, memberships, entidades de CRM/flows, mensagens, broadcasts, jobs, analytics, comentários, sequências, convites e versões. A base é real e reaproveitável, mas os predicados normalmente verificam apenas membership:

> `supabase/migrations/00002_rls_policies.sql:84-86`: `channels FOR ALL USING (is_workspace_member(workspace_id))`.
>
> `supabase/migrations/00002_rls_policies.sql:212-214`: `flows FOR ALL USING (is_workspace_member(workspace_id))`.

Não há separação de operações por `owner`, `admin` e `agent` nessas policies. Um membro pode fazer CRUD de canais, contatos, flows, broadcasts e configurações do workspace conforme os grants do banco. `workspace_members.role` e `workspace_invites.role` são `text`, sem constraint de valores. `platform_admin` não existe como modelo separado.

`workspace_invites` permite UPDATE quando o usuário autenticado tem o e-mail convidado:

> `supabase/migrations/00006_workspace_invites.sql:46-54`: `USING (... owner ...) OR email = (SELECT email FROM auth.users WHERE id = auth.uid())`.
>
> `lib/actions/team.ts:150-180`: `acceptInvite()` verifica e-mail/expiração/status e insere membership com `role: invite.role` usando service role.

A policy deixa o convidado atualizar toda a linha, não apenas `status`; manter o mesmo e-mail e trocar `role` para `owner` satisfaz a condição visível no código. Como a ação aceita o valor da linha via service role, há caminho estático de escalação. Confirmar no Postgres real e cobrir com teste de policy antes de considerar mitigado.

Outros pontos de banco:

- `workspace_members` policies de INSERT/UPDATE/DELETE consultam a própria tabela. A documentação Supabase descreve recursão de RLS em policies que se consultam; a falha runtime não foi confirmada neste banco. Ver [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
- `increment_unread`, `increment_broadcast_sent` e `increment_broadcast_failed` são `SECURITY DEFINER`, sem checagem de membership nem `SET search_path` no `00003`; não há GRANT/REVOKE explícito no arquivo. Supabase documenta execução ampla por padrão, mas os defaults mudam e os ACLs remotos não foram lidos. Ver [Supabase Database Functions](https://supabase.com/docs/guides/database/functions). Até inspecionar os grants reais, o acesso remoto a esses RPCs é **não verificado**.
- `createWorkspace()` tenta INSERT via cliente autenticado (`lib/actions/workspace.ts:53-68`), mas `supabase/migrations/00002_rls_policies.sql:21-29` só define SELECT/UPDATE de `workspaces`. Se o banco segue essas migrations, essa ação falha por RLS. O trigger de signup cria o workspace inicial com `SECURITY DEFINER` (`supabase/migrations/00001_initial_schema.sql:299-329`), caminho distinto.

## API routes, actions e service role

API routes existentes: `api/v1/{contacts,messages,flows,flows/[flowId],flows/[flowId]/publish,flows/[flowId]/versions,flows/[flowId]/versions/[versionId]/restore,broadcasts,broadcasts/[broadcastId]/send,channels,channels/connect,channels/sync,channels/test-key}`, `api/webhooks/late`, `api/cron/{jobs,sequences}`.

CRUD de contatos, flows, broadcasts, mensagens e versões geralmente chama `auth.getUser()`/consulta membership e filtra pelo workspace, ou depende de RLS. O problema é repetição manual, escolha de `.limit(1)` em alguns endpoints e ausência de autorização por role. O middleware passa todas as rotas `/api/*` sem autenticar (`lib/supabase/middleware.ts:37-42`), então cada rota precisa fechar essa fronteira.

Exceções relevantes:

- `POST /api/v1/channels/test-key` não chama `auth.getUser()` antes de aceitar `apiKey` do body e consultar a API Zernio (`app/api/v1/channels/test-key/route.ts:10-30`). Depois tenta gravar `workspaceId` recebido do body (`app/api/v1/channels/test-key/route.ts:33-43`) e retorna `accounts` (`app/api/v1/channels/test-key/route.ts:78`). RLS pode barrar a gravação, mas não protege a chamada externa nem o retorno.
- `GET /api/v1/channels` faz `.select("*")` e retorna o resultado inteiro (`app/api/v1/channels/route.ts:27-36`). Se `webhook_secret` estiver preenchido, ele sai no JSON para o membro que acessa essa rota.
- `/channels/connect` e `/channels/sync` buscam a primeira membership sem workspace escolhido e sem role Owner/Admin (`app/api/v1/channels/connect/route.ts:5-19`; `app/api/v1/channels/sync/route.ts:5-19`).
- `vercel.json:2-9` agenda ambos os crons uma vez ao dia (`0 0 * * *`), enquanto os comentários das rotas dizem que esperam intervalos de segundos.

| Uso de service role | Justificativa aparente | Risco/controle faltante |
|---|---|---|
| `lib/workspace.ts` | fallback para listar usuários e primeiro workspace | não deve conceder contexto de tenant/owner sem membership |
| `app/(dashboard)/dashboard/settings/team/page.tsx` | ler `auth.users` e lista de membros | filtro por workspace existe, mas depende do contexto inseguro |
| `app/invite/[inviteId]/page.tsx`, `lib/actions/team.ts::acceptInvite` | mostrar/aceitar convite antes de membership | verificar papel, estado e vínculo depois de qualquer mutação do convite |
| `app/api/webhooks/late/route.ts` | gravar evento sem sessão de usuário | precisa assinatura obrigatória e proteção contra replay |
| `app/api/cron/jobs/route.ts`, `lib/sequence-processor.ts` | processar fila/sequências | entrada da fila e payload precisam ser inacessíveis a clientes e validados |
| `scripts/provision-single-tenant.js`, `scripts/test-db.js`, `scripts/test-user.js` | manutenção/teste | contêm credencial privilegiada hardcoded; não executar |

`createServiceClient()` lê `SUPABASE_SERVICE_ROLE_KEY` em `lib/supabase/server.ts:30-42`. Não encontrei import desse helper em componentes client no grafo/revisão; isso não elimina as credenciais já hardcoded nos scripts.

## Riscos adicionais de execução

**SSRF pelo nó HTTP Request — HIGH.**

> `lib/flow-engine/engine.ts:622-634`: a URL, método, headers e body vêm do nó e são usados diretamente em `fetch(url, ...)`.

Não há validação de esquema/host, bloqueio de rede privada, política de redirect, timeout explícito ou limite de resposta na função (`lib/flow-engine/engine.ts:617-649`). O nó executa no servidor durante `executeFlow`; um cliente que possa publicar um flow pode tentar alcançar serviços internos ou causar consumo excessivo. Nenhum endpoint foi sondado.

**Credenciais sem proteção de coluna — HIGH.** `workspaces.late_api_key_encrypted` e `ai_api_key` são lidas/escritas como valores comuns. O provisionamento grava `ZERNIO_KEY` diretamente na coluna (`scripts/provision-single-tenant.js:40-46,57-61`); Settings também envia o valor direto pelo cliente (`app/(dashboard)/dashboard/settings/settings-view.tsx:120-140`). RLS na tabela filtra linhas, não oculta essas colunas de membros que podem ler o workspace. A criptografia anunciada pelo sufixo `_encrypted` não aparece nesse fluxo.

**Contexto multiworkspace inconsistente — MEDIUM.** `getWorkspace()` respeita `zernflow_workspace_id` quando há membership, mas a maioria dos helpers de API escolhe a primeira membership. O resultado não é necessariamente o workspace visível no switcher. É erro de contexto entre workspaces do mesmo usuário; não prova acesso sem membership.

**Idempotência e replay de webhook — MEDIUM/HIGH.** O handler verifica HMAC apenas quando há segredo, mas não há timestamp/replay guard para mensagens recebidas (`app/api/webhooks/late/route.ts:66-86,120-145`). `comment_logs` tem índice único; o fluxo de `message.received` não grava chave de evento equivalente. Replays podem recontar unread e executar automação novamente. Não testado.

## Recursos que podem ser preservados

- Flow Engine existente com Trigger, Condition, Send Message, HTTP Request, Human Takeover, Smart Delay, Comment Reply e Private Reply (`lib/flow-engine/engine.ts`, `components/flow-builder/`). Não criar outro motor.
- OAuth e sincronização de canais Zernio em `channels/connect`, callback e `channels/sync`.
- Workspaces, memberships, convites, CRM, inbox, sequences, broadcasts e analytics já têm schema e telas.
- Templates existem como array embutido em `app/(dashboard)/dashboard/flows/templates/templates-view.tsx`, não como catálogo global/workspace persistido.
- `analytics_events` já é por workspace; não substitui agregação de métricas para volume alto.

## Higiene de migrations e validação

- O README ainda instrui rodar migrations `00001`–`00009` (`README.md:54-58`); existe `00010_flow_versions.sql` (`supabase/migrations/00010_flow_versions.sql`).
- `supabase/migrations/ALL_MIGRATIONS.sql` diverge das migrations numeradas e não inclui `workspace_invites`, `sequences` nem as policies de `00009`; não usar esse arquivo como fonte de verdade.
- `package.json:5-9` oferece `lint` e `build`, sem scripts `test` ou `typecheck`. Existem scripts manuais (`scripts/test-db.js`, `scripts/test-user.js`, `scripts/smoke-test.mjs`), alguns deles usam service-role literal. Nenhum foi executado.
- Não há `supabase/tests/` listado no snapshot. Sem ambiente/fixtures, IDOR, grants, migrations e policies continuam sem prova dinâmica.

## Arquitetura recomendada e plano incremental

1. **Contenção antes de produto:** revogar/rotacionar o service-role, Zernio e senha compartilhada; remover credenciais do histórico controlado pelo produto e do deploy. A rotação da cópia pública upstream exige ação do mantenedor/conta correspondente; não foi feita nesta auditoria.
2. **Boundary central:** remover login automático e fallback para primeiro workspace; exigir sessão válida e membership. Implementar `requireWorkspaceAccess()`/`requireWorkspaceRole()` com workspace resolvido no servidor e resposta fail-closed. API, pages e actions devem usar o mesmo contexto.
3. **Schema/RLS:** migrations novas; role constraint `owner/admin/agent`; platform admin separado; políticas com operações e `WITH CHECK` explícitas; jobs sem leitura/escrita direta de cliente; RPCs `SECURITY DEFINER` com `search_path` fechado, grants mínimos e validação tenant; constraints compostas/validação de pais para bloquear referências cruzadas.
4. **Segredos e entradas privilegiadas:** retirar chaves de `workspaces` legível por membros, centralizar vault server-side, retornar allowlists em vez de `select *`, exigir assinatura webhook sempre e proteger replay; validar todos os payloads de cron/jobs; bloquear SSRF com controles de rede, timeout e tamanho.
5. **Prova adversarial:** Supabase/Postgres de teste com dois workspaces; controles positivos e negativos para GET/POST/PATCH/DELETE, policies/RPC, actions, APIs, convites, agente vs owner, jobs, webhooks e SSRF. Verificar migration limpa, lint, typecheck, testes e build. Não aceitar só status HTTP ou gate verde sem leitura do banco.
6. **Produto depois do hardening:** white-label → onboarding → templates → platform admin → entitlements → analytics → integrations → auditoria red team final, mantendo o Flow Engine e as telas existentes.

**Escopo desta entrega:** apenas este relatório de auditoria. Nenhum código de produto ou migration foi alterado; a implementação para aqui conforme a primeira etapa solicitada.
