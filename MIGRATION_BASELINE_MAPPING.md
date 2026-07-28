# Rastreabilidade e Mapeamento do Baseline Limpo de Migrations

Este documento registra a consolidação e purga do legado de migrations do Dahora Expresso. Todas as referencias a aplicativos de terceiros e marketplaces (iFood, 99Food, integration_targets) foram definitivamente removidas do produto.

---

## 📋 Tabela de Mapeamento

| Migration Antiga | Objeto / Finalidade | Status / Ação | Migration Nova no Baseline |
| :--- | :--- | :--- | :--- |
| `0001_init.sql` | Tabelas base (`users`, `teles`, `fleet`, `logs`) | Consolidado e limpo | `20260727000100_init_core_schema.sql` |
| `0002_ifood.sql` | Lojas e tokens iFood | **REMOVIDO** (Marketplace descartado) | *Nenhuma* |
| `0003_fix_unique.sql` | Restrição UNIQUE em `fleet.user_id` | Incorporado no schema base | `20260727000100_init_core_schema.sql` |
| `0004_garra_perfis.sql` | Tabela `garra_perfis` | Incorporado no schema base | `20260727000100_init_core_schema.sql` |
| `0005_cidades.sql` | Tabela `cidades` | Incorporado no schema base | `20260727000100_init_core_schema.sql` |
| `0006_99food_e_numero.sql` | Colunas e tokens 99Food | **REMOVIDO** (Marketplace descartado) | *Nenhuma* |
| `0007_add_99food_lojas.sql` | Colunas 99Food em lojas | **REMOVIDO** (Marketplace descartado) | *Nenhuma* |
| `0007_integration_target.sql` | `integration_targets`, tokens | **REMOVIDO** (Exclusivo de marketplaces) | *Nenhuma* |
| `0008_add_rider_consumables_columns.sql` | Consumíveis em `fleet` | Migrado | `20260727000300_rider_credits_consumables.sql` |
| `0009_food99_tokens_policy.sql` | RLS de tokens 99Food | **REMOVIDO** (Marketplace descartado) | *Nenhuma* |
| `0010_add_payment_to_client_history.sql` | Coluna em `client_history` | Incorporado no schema base | `20260727000100_init_core_schema.sql` |
| `0011_add_total_order_amount.sql` | Coluna `total_order_amount` | Incorporado no schema base | `20260727000100_init_core_schema.sql` |
| `0012_add_confirmation_code.sql` | Coluna `confirmation_code` | Incorporado no schema base | `20260727000100_init_core_schema.sql` |
| `0013_add_battery_level.sql` | Coluna `battery_level` | Incorporado no schema base | `20260727000100_init_core_schema.sql` |
| `0014_add_rider_credits.sql` | Tabela `rider_credits` | Migrado | `20260727000300_rider_credits_consumables.sql` |
| `0015_commercial_clients.sql` | Clientes Comerciais e Ledgers | Migrado | `20260727000200_commercial_clients.sql` |
| `0016_client_rls_policies.sql` | Políticas RLS | Migrado | `20260727000200_commercial_clients.sql` |
| `0017_dispatch_and_concurrency.sql` | Versão Otimista e RPC Despacho | Migrado e endurecido | `20260727000400_dispatch_concurrency_rpc.sql` |
| `0018_tele_completion_financial_ledger.sql` | Conclusão Idempotente e Ledger | Migrado e endurecido | `20260727000500_tele_completion_ledger_rpc.sql` |
| *Nova* | Endurecimento `SECURITY DEFINER`, `auth.uid()`, RPC `create_client_tele`, regras financeiras e idempotência | Criado no baseline | `20260727000600_security_and_client_rpc.sql` |

---

## 🎯 Resultado do Baseline Limpo
- **Total de Migrations Ativas**: 6 arquivos timestamped ordenáveis (`20260727000100` a `20260727000600`).
- **Resíduos de Marketplace**: ZERO.
- **Risco de Conflito de Nomes**: ELIMINADO.
