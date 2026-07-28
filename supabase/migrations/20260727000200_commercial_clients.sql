-- =====================================================================
-- Dahora Expresso — Baseline Migration 2: Clientes Comerciais & Ledgers
-- Timestamp: 20260727000200
-- =====================================================================

-- Sequence para Código CLI-XXXXXX
CREATE SEQUENCE IF NOT EXISTS public.commercial_client_code_seq START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION public.generate_commercial_client_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN 'CLI-' || pg_catalog.lpad(nextval('public.commercial_client_code_seq')::text, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.generate_commercial_client_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_commercial_client_code() FROM anon;
GRANT EXECUTE ON FUNCTION public.generate_commercial_client_code() TO authenticated;

-- 1. Tabela 'commercial_clients'
CREATE TABLE IF NOT EXISTS public.commercial_clients (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_code             TEXT UNIQUE NOT NULL DEFAULT public.generate_commercial_client_code(),
  establishment_name      TEXT NOT NULL,
  responsible_name        TEXT NOT NULL,
  phone                   TEXT NOT NULL,
  email                   TEXT NOT NULL UNIQUE,
  address                 TEXT NOT NULL,
  document                TEXT NOT NULL UNIQUE,
  lifecycle_status        TEXT NOT NULL DEFAULT 'ativo' CHECK (lifecycle_status IN ('ativo', 'inativo', 'suspenso', 'bloqueado')),
  financial_status        TEXT NOT NULL DEFAULT 'em_dia' CHECK (financial_status IN ('em_dia', 'pendente', 'inadimplente', 'bloqueado_financeiro')),
  pricing_rule_type       TEXT NOT NULL DEFAULT 'padrao_operacao' CHECK (pricing_rule_type IN ('padrao_operacao', 'porcentagem_custom', 'valor_fixo_custom')),
  rider_percentage        NUMERIC(5,2) DEFAULT 80.00 CHECK (rider_percentage >= 0 AND rider_percentage <= 100),
  company_percentage      NUMERIC(5,2) DEFAULT 20.00 CHECK (company_percentage >= 0 AND company_percentage <= 100),
  rider_fixed_amount      NUMERIC(10,2) DEFAULT NULL,
  company_fixed_fee       NUMERIC(10,2) DEFAULT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vincular client_id em public.teles
ALTER TABLE public.teles 
  ADD CONSTRAINT fk_teles_client_id 
  FOREIGN KEY (client_id) REFERENCES public.commercial_clients(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS teles_client_idx ON public.teles (client_id);

-- 2. Tabela 'client_users'
CREATE TABLE IF NOT EXISTS public.client_users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES public.commercial_clients(id) ON DELETE RESTRICT,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  role       TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin', 'operador', 'financeiro')),
  status     TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'suspenso')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(client_id, user_id)
);

CREATE INDEX IF NOT EXISTS client_users_client_idx ON public.client_users (client_id);
CREATE INDEX IF NOT EXISTS client_users_user_idx ON public.client_users (user_id);

-- 3. Tabela 'client_financial_transactions'
CREATE TABLE IF NOT EXISTS public.client_financial_transactions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL REFERENCES public.commercial_clients(id) ON DELETE RESTRICT,
  tele_id                 UUID REFERENCES public.teles(id) ON DELETE SET NULL,
  type                    TEXT NOT NULL CHECK (type IN ('cobranca_entrega', 'pagamento_recebido', 'credito_concedido', 'ajuste_debito', 'estorno')),
  direction               TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount                  NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  description             TEXT NOT NULL,
  idempotency_key         TEXT UNIQUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              UUID REFERENCES auth.users(id),
  reversed_transaction_id UUID REFERENCES public.client_financial_transactions(id)
);

CREATE INDEX IF NOT EXISTS client_fin_tx_client_idx ON public.client_financial_transactions (client_id);

-- 4. Tabela 'system_audit_logs'
CREATE TABLE IF NOT EXISTS public.system_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_resource TEXT NOT NULL,
  details         JSONB DEFAULT '{}'::jsonb,
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_audit_logs_action_idx ON public.system_audit_logs (action);

-- RLS em Clientes Comerciais
ALTER TABLE public.commercial_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_financial_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY commercial_clients_select ON public.commercial_clients FOR SELECT TO authenticated USING (true);
CREATE POLICY client_users_select ON public.client_users FOR SELECT TO authenticated USING (true);
CREATE POLICY client_financial_transactions_select ON public.client_financial_transactions FOR SELECT TO authenticated USING (true);
