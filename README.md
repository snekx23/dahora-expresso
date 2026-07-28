# Dahora Expresso

Plataforma de logística de entregas (teles) com painel administrativo, área do
parceiro/comércio e app do motoboy (PWA). Os pedidos são criados manualmente no painel
administrativo ou solicitados pelos parceiros em sua área dedicada.

🔗 **App no ar:** https://dahora-expresso.guigui-couto23.workers.dev

---

## Estrutura do projeto

```
dahora-expresso/
├── public/                  # o app (frontend, vanilla JS)
│   ├── index.html           # painel admin + área do parceiro (login)
│   ├── app.js               # lógica do painel
│   ├── motoboy.html         # app do motoboy (PWA)
│   ├── motoboy.js           # lógica do app do motoboy
│   ├── style.css            # estilos
│   ├── logo.jpg             # logo
│   ├── manifest*.json       # PWA (instalável)
│   └── sw.js                # service worker (offline / cache)
├── supabase/                # backend (banco + RPCs operacionais)
│   └── migrations/          # baseline de migrations timestamped
├── index.js                 # Cloudflare Worker (serve a pasta public/)
├── wrangler.jsonc           # config do deploy (worker "dahora-expresso")
└── vercel.json              # config de fallback (Vercel)
```

## Tecnologias

- **Frontend:** HTML + CSS + JavaScript puro (sem framework), [Leaflet](https://leafletjs.com) (mapa), [Chart.js](https://www.chartjs.org) (gráficos), [Lucide](https://lucide.dev) (ícones)
- **Backend:** [Supabase](https://supabase.com) — Postgres, Realtime, Auth e Edge Functions
- **Hospedagem:** Cloudflare Workers (serve os arquivos de `public/`)

## Perfis de acesso

| Perfil | O que faz |
|--------|-----------|
| **Administrador** | Gerencia teles, frota de motoboys, financeiro, repasse semanal, integrações |
| **Parceiro / Comércio** | Solicita entregas, rastreia o motoboy, vê histórico e avaliações |
| **Motoboy** | App PWA: recebe teles, navega no mapa e finaliza entregas (login por PIN) |



---

## Rodar localmente

Qualquer servidor de arquivos estáticos apontando pra pasta `public/` serve.
Exemplos:

```bash
# Python
python -m http.server 5599 --directory public

# ou Node
npx serve public
```

Depois abra `http://localhost:5599`.

## Deploy

> O **frontend** (app) e o **backend** (funções Supabase) são deployados
> separadamente.

### Frontend (Cloudflare Worker)

```bash
npx wrangler deploy
```

Publica os arquivos de `public/` no worker `dahora-expresso`
(https://dahora-expresso.guigui-couto23.workers.dev). Precisa estar logado na conta
Cloudflare dona do worker.

### Backend (Edge Functions do Supabase)

Veja o passo a passo em [`supabase/README.md`](supabase/README.md).

---

## Banco de dados (Supabase)

> **Aviso Importante:** A única fonte oficial de schema do Dahora Expresso é o diretório de migrations versionadas em [`supabase/migrations/`](supabase/migrations/). Nunca execute scripts SQL avulsos ou legados do antigo sistema Garra Delivery.

### Baseline Oficial de Migrations
1. `20260727000100_init_core_schema.sql` (Estrutura base das tabelas `public.fleet`, `public.teles`, `public.tele_eventos`, `public.cidades`)
2. `20260727000200_commercial_clients.sql` (`public.commercial_clients`, `public.client_users`, `public.system_audit_logs`)
3. `20260727000300_rider_credits_consumables.sql` (`public.rider_credits_ledger`, `public.rider_consumable_purchases`)
4. `20260727000400_dispatch_concurrency_rpc.sql` (Versão otimista e RPC `assign_rider_to_tele`)
5. `20260727000500_tele_completion_ledger_rpc.sql` (Ledgers imutáveis e RPCs `complete_tele` / `cancel_tele`)
6. `20260727000600_security_and_client_rpc.sql` (`tele_code_seq`, RPC `create_admin_tele` e autorização centralizada)

*Nota:* As tabelas legadas `pending_deliveries` e `client_history` foram descontinuadas e unificadas em `public.teles`.
