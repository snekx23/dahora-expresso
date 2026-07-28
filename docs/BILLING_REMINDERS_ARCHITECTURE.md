# Arquitetura do Módulo Futuro: Cobranças & Lembretes (WhatsApp)

Este documento especifica a arquitetura conceitual e as regras de negócio para a futura integração de mensagens e lembretes automáticos de cobrança via **API Oficial do WhatsApp (Meta Business Platform / BSP Oficial)** no Dahora Expresso.

---

## 🎯 1. Escopo de Cobrança
O módulo atenderá a dois tipos principais de obrigações financeiras:
1. **Mensalidade SaaS**: Assinatura ou taxa fixa mensal do software Dahora Expresso.
2. **Fechamento de Teles do Período**: Fatura acumulada das entregas faturadas no período (semanal ou quinzenal).

---

## 🗄️ 2. Entidades Conceituais do Banco de Dados

### A. `billing_obligations` (Obrigações Financeiras)
- `id` (UUID)
- `client_id` (UUID - FK `commercial_clients`)
- `type` (`mensalidade_sistema` | `fechamento_teles`)
- `amount` (NUMERIC 10,2)
- `due_date` (DATE)
- `status` (`pending` | `scheduled` | `reminder_sent` | `client_replied` | `in_negotiation` | `paid` | `overdue` | `cancelled`)
- `period_start` / `period_end` (DATE)
- `created_at` / `updated_at` (TIMESTAMPTZ)

### B. `billing_reminders` (Fila de Lembretes Agendados)
- `id` (UUID)
- `obligation_id` (UUID - FK `billing_obligations`)
- `scheduled_for` (TIMESTAMPTZ)
- `reminder_stage` (`5_days_before` | `due_date` | `3_days_overdue` | `7_days_overdue`)
- `status` (`scheduled` | `sent` | `paused_client_replied` | `cancelled`)
- `created_at` (TIMESTAMPTZ)

### C. `billing_message_logs` (Histórico Imutável de Envio)
- `id` (UUID)
- `obligation_id` (UUID)
- `recipient_phone` (TEXT)
- `template_name` (TEXT)
- `whatsapp_message_id` (TEXT)
- `status` (`sent` | `delivered` | `read` | `failed`)
- `error_message` (TEXT)
- `sent_at` (TIMESTAMPTZ)

### D. `billing_conversations` (Estado do Atendimento Humano)
- `id` (UUID)
- `client_id` (UUID)
- `last_client_message_at` (TIMESTAMPTZ)
- `human_assignee_id` (UUID - FK `garra_perfis` ou `auth.users`)
- `status` (`bot_active` | `human_takeover` | `resolved`)

---

## 🛑 3. Regra de Ouro: Transição para Atendimento Humano

> [!IMPORTANT]
> **Interrupção Imediata de Disparos Automáticos ao Responder:**
> 1. Quando o cliente comercial enviar **qualquer mensagem de resposta** ao WhatsApp do sistema, o webhook de recebimento deve:
>    - Atualizar imediatamente `billing_conversations.status = 'human_takeover'`.
>    - Marcar a obrigação como `client_replied`.
>    - Alterar o status de todos os lembretes pendentes em `billing_reminders` para `paused_client_replied`.
> 2. **Alertar o Administrador**: Criar uma pendência/notificação no painel do administrador para que o atendente humano assuma o chat.
> 3. **Bloqueio de Robô**: Nenhuma automação continuará enviando cobranças insistentes após o cliente interagir.
> 4. **Baixa de Pagamento**: A confirmação do pagamento (`paid`) finaliza o ciclo e encerra os lembretes.

---

## 🛡️ 4. Diretrizes de Segurança, Compliance e Automação
- **Apenas APIs Oficiais**: Proibida a utilização de bibliotecas não oficiais de raspagem / simulação de navegador (ex: Baileys, Puppeteer, WhatsApp Web scraping). Toda comunicação ocorrerá via API Oficial da Meta / BSP parceiro.
- **Horário Comercial Estrito**: Os disparos de lembretes devem respeitar janelas entre **08:00 e 18:00** em dias úteis no fuso local (`America/Sao_Paulo`).
- **Respeito ao Opt-Out**: Se o cliente solicitar não receber notificações via WhatsApp, o campo `commercial_clients.opt_out_whatsapp` deve ser marcado como `true`.
- **Limite de Tentativas**: Máximo de 3 lembretes por fatura antes de escalação exclusivamente manual.
