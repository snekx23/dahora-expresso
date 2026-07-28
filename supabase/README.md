# Backend & Banco de Dados (Supabase Dahora Expresso)

Este diretório contém as migrations versionadas e a estrutura de banco de dados exclusiva do produto Dahora Expresso.

## Baseline de Migrations (Timestamped & Purged)

A estrutura de banco de dados é mantida na pasta `supabase/migrations/` em uma sequência timestamped sem resíduos de marketplaces:

1. `20260727000100_init_core_schema.sql`: Usuários, perfis administrativas, frotas, cidades e solicitações de entregas.
2. `20260727000200_commercial_clients.sql`: Clientes comerciais, usuários vinculados (`client_users`), ledger do cliente e auditoria.
3. `20260727000300_rider_credits_consumables.sql`: Consumíveis e créditos dos motoboys.
4. `20260727000400_dispatch_concurrency_rpc.sql`: Controle de concorrência otimista e RPC `assign_rider_to_tele`.
5. `20260727000500_tele_completion_ledger_rpc.sql`: Conclusão idempotente, cancelamento controlado e ledgers do motoboy/empresa.
6. `20260727000600_security_and_client_rpc.sql`: RPC `create_client_tele`, resolução de frete no backend e idempotência por cliente.

## Diretrizes Obrigatórias de Aplicação
> **ATENÇÃO:** Nunca execute scripts SQL avulsos no Supabase Editor (como scripts antigos do Garra Delivery). A aplicação do banco deve ocorrer exclusivamente através dos arquivos de migração versionados em `supabase/migrations/`.
> 
> As tabelas legadas `pending_deliveries` e `client_history` pertencem a sistemas antigos e foram substituídas pelas tabelas `public.teles` e `public.tele_eventos`.

## Entrada de Dados
O Dahora Expresso opera exclusivamente via entrada direta de Teles pelo Painel do Cliente Comercial e despacho via Centro de Operações.
