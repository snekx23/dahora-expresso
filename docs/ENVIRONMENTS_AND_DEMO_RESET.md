# Arquitetura de Ambientes e Reset Autoritativo de Demonstração

Este documento detalha o isolamento arquitetural entre os ambientes de **Produção** e **Demonstração (Demo)** do Dahora Expresso, a autorização server-side e o funcionamento autoritativo do procedimento de restauração de demonstração.

---

## 1. Separação Estrita de Ambientes

O Dahora Expresso adota separação física total entre os projetos de banco de dados e deployments de frontend:

| Propriedade | Ambiente de PRODUÇÃO | Ambiente DEMO (Demonstração) |
|---|---|---|
| **Projeto Supabase** | Instância Dedicada de Produção (Projeto A) | Instância Dedicada de Demonstração (Projeto B) |
| **Deployment Cloudflare** | `dahoraexpresso.pages.dev` | `dahoraexpresso-demo.pages.dev` |
| **Variáveis Runtime** | `APP_ENV=production`<br>`ENVIRONMENT_KIND=production`<br>`DEMO_RESET_ENABLED=false` | `APP_ENV=demo`<br>`ENVIRONMENT_KIND=demo`<br>`DEMO_RESET_ENABLED=true` |
| **Contas de Acesso** | Donos reais e Clientes comerciais reais | `Admin Demo`, `Cliente Demo`, `Motoboy Demo` |
| **RPC de Reset** | **Não instalada** / Recusada | Instalada via `supabase/migrations-demo/` |
| **Integridade** | Dados Reais e Imutáveis | Dados 100% Descartáveis e Restauráveis |

---

## 2. Configuração de Banco (`public.environment_settings`)

A validação de ambiente ocorre no banco de dados via PostgreSQL e RLS:

- A tabela `public.environment_settings` define se o banco aceita operações de reset.
- A constraint `chk_reset_enabled` proíbe `reset_enabled = true` em qualquer `environment_kind` diferente de `'demo'`.
- A tabela registra os UUIDs canônicos das entidades-base:
  - `demo_admin_user_id` (Apenas este UUID pode autorizar a RPC de reset)
  - `demo_client_user_id` e `demo_rider_user_id`
  - `demo_client_id`, `demo_rider_id` e `internal_client_id`

---

## 3. Fluxo de Autorização Server-Side

```text
[Frontend / UI]
   └─ runtime-config decide APENAS exibição visual (UX) do botão
   └─ Invoca Supabase Edge Function via Bearer Token JWT do usuário

[Supabase Edge Function: reset-demo-environment]
   └─ Aceita somente requisições POST com Bearer Token
   └─ Invoca RPC PostgreSQL public.reset_demo_environment(p_confirmation)
   └─ Processa expurgo de Auth Users extras retornados após COMMIT

[PostgreSQL RPC: public.reset_demo_environment]
   └─ SECURITY DEFINER / search_path = ''
   └─ Valida auth.uid() == environment_settings.demo_admin_user_id
   └─ Exige pg_try_advisory_xact_lock(88998899) (Trava ACID contra concorrência)
   └─ Exclui Teles, transações e usuários extras em transação única
   └─ Insere IDs de Auth Users extras em public.demo_auth_cleanup_queue
   └─ Restaura saldos e status das contas base
```

---

## 4. Reconciliação e Fila de Auth Users (`public.demo_auth_cleanup_queue`)

- A RPC insere os UUIDs de `auth.users` adicionais criados durante a demonstração na tabela `public.demo_auth_cleanup_queue` com status `'pending'`.
- Após a transação ACID ser concluída com sucesso no banco, a Edge Function executa `admin.deleteUser(uid)` utilizando a chave de servidor apenas no ambiente isolado da Edge Function.
- Caso ocorra falha temporária na remoção de algum Auth User, o status é gravado como `'failed'`, permitindo reprocessamento posterior sem corromper a base pública já restaurada.

---

## 5. Diretrizes de Segurança Invioláveis

1. **Frontend é apenas UX**: Alterar variáveis em `window.SUPABASE_CONFIG` no DevTools de um navegador **jamais autoriza o reset**. A autorização final é checada pela RPC no Postgres (`auth.uid() = demo_admin_user_id`).
2. **Sem Segredos em Produção**: Chaves privadas ou `service_role` **nunca são enviadas ao navegador**.
3. **Isolamento de Migrações**: A migração `supabase/migrations-demo/20260805009900_demo_environment_reset_rpc.sql` é mantida em pasta separada e **jamais é aplicada ao banco de Produção**.
