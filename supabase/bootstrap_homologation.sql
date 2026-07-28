-- =====================================================================
-- DAHORA EXPRESSO — HOMOLOGAÇÃO APENAS
-- NÃO EXECUTAR EM PRODUÇÃO
-- GERADO A PARTIR DAS MIGRATIONS OFICIAIS
-- =====================================================================

-- File: 20260727000100_init_core_schema.sql
-- =====================================================================
-- Dahora Expresso — Baseline Migration 1: Core Schema
-- Timestamp: 20260727000100
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabela 'user_profiles' (Perfis e Permissões de Usuários)
CREATE TABLE public.user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operador', 'gerente', 'motoboy', 'client_user')),
  access_level TEXT DEFAULT 'operador',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Tabela 'cidades' (Municípios Atendidos)
CREATE TABLE public.cidades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL UNIQUE,
  uf VARCHAR(2) NOT NULL DEFAULT 'RS',
  ativa BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Tabela 'fleet' (Frota de Motoboys)
CREATE TABLE public.fleet (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  motoboy_code TEXT UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  vehicle TEXT,
  plate TEXT,
  status TEXT NOT NULL DEFAULT 'Ativo',
  simultaneous_limit INTEGER NOT NULL DEFAULT 3,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  last_seen TIMESTAMPTZ,
  battery_level INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fleet_status_idx ON public.fleet (status);
CREATE INDEX fleet_user_id_idx ON public.fleet (user_id);

-- 4. Tabela 'teles' (Solicitações de Entregas)
CREATE TABLE public.teles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tele_code TEXT UNIQUE,
  client_id UUID,
  motoboy_id UUID REFERENCES public.fleet(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'solicitada' CHECK (status IN ('solicitada', 'aguardando_despacho', 'motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_rota', 'em_entrega', 'concluido', 'concluida', 'entregue', 'cancelado', 'cancelada')),
  version INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'manual_admin',
  pickup_address TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_reference TEXT,
  recipient_name TEXT,
  recipient_phone TEXT,
  notes TEXT,
  total_order_amount NUMERIC(12,2) DEFAULT 0.00,
  delivery_charge NUMERIC(12,2) NOT NULL DEFAULT 15.00,
  pricing_rule_source TEXT DEFAULT 'fallback_default',
  pricing_rule_version TEXT DEFAULT 'v1_fallback',
  client_request_idempotency_key TEXT,
  admin_request_idempotency_key TEXT,
  payment_method TEXT DEFAULT 'Faturado',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  CONSTRAINT teles_client_idempotency_unique UNIQUE (client_id, client_request_idempotency_key)
);

CREATE INDEX teles_status_idx ON public.teles (status);
CREATE INDEX teles_motoboy_id_idx ON public.teles (motoboy_id);
CREATE INDEX teles_created_at_idx ON public.teles (created_at);

-- 5. Tabela 'tele_eventos' (Timeline Imutável de Eventos da Tele)
CREATE TABLE public.tele_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tele_id UUID NOT NULL REFERENCES public.teles(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  payload JSONB DEFAULT '{}'::jsonb,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tele_eventos_tele_id_idx ON public.tele_eventos (tele_id, created_at);

-- RLS Inicial nas Tabelas Core
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tele_eventos ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_profiles_select ON public.user_profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY cidades_select ON public.cidades FOR SELECT TO authenticated USING (true);
CREATE POLICY fleet_select ON public.fleet FOR SELECT TO authenticated USING (true);
CREATE POLICY teles_select ON public.teles FOR SELECT TO authenticated USING (true);
CREATE POLICY tele_eventos_select ON public.tele_eventos FOR SELECT TO authenticated USING (true);


-- File: 20260727000200_commercial_clients.sql
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


-- File: 20260727000300_rider_credits_consumables.sql
-- =====================================================================
-- Dahora Expresso — Baseline Migration 3: Consumíveis e Créditos dos Motoboys
-- Timestamp: 20260727000300
-- =====================================================================

-- 1. Tabela 'rider_credits_ledger'
CREATE TABLE public.rider_credits_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  motoboy_id UUID NOT NULL REFERENCES public.fleet(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT NOT NULL,
  target_date DATE NOT NULL DEFAULT CURRENT_DATE,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rider_credits_ledger_motoboy_idx ON public.rider_credits_ledger (motoboy_id);

-- 2. Tabela 'consumables_catalog' (Catálogo Oficial de Consumíveis)
CREATE TABLE public.consumables_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Consumível',
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Tabela 'rider_consumable_purchases' (Lançamentos de Consumo do Motoboy)
CREATE TABLE public.rider_consumable_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  motoboy_id UUID NOT NULL REFERENCES public.fleet(id) ON DELETE CASCADE,
  motoboy_name TEXT,
  categoria TEXT DEFAULT 'Consumível',
  item_name TEXT NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  amount NUMERIC(10,2) NOT NULL,
  observacao TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rider_consumables_motoboy_idx ON public.rider_consumable_purchases (motoboy_id);

-- RLS
ALTER TABLE public.rider_credits_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumables_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_consumable_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY rider_credits_ledger_select ON public.rider_credits_ledger FOR SELECT TO authenticated USING (true);
CREATE POLICY consumables_catalog_select ON public.consumables_catalog FOR SELECT TO authenticated USING (true);
CREATE POLICY rider_consumable_purchases_select ON public.rider_consumable_purchases FOR SELECT TO authenticated USING (true);


-- File: 20260727000400_dispatch_concurrency_rpc.sql
-- =====================================================================
-- Dahora Expresso — Baseline Migration 4: Despacho Seguro & Concorrência
-- Timestamp: 20260727000400
-- =====================================================================

CREATE INDEX IF NOT EXISTS teles_motoboy_status_idx ON public.teles (motoboy_id, status);
CREATE INDEX IF NOT EXISTS teles_status_updated_idx ON public.teles (status, updated_at);
CREATE INDEX IF NOT EXISTS fleet_id_status_idx ON public.fleet (id, status);

-- RPC assign_rider_to_tele com auth.uid() estrito, search_path='' e validação de papéis
CREATE OR REPLACE FUNCTION public.assign_rider_to_tele(
  p_tele_id TEXT,
  p_rider_id TEXT,
  p_expected_version INTEGER,
  p_reason TEXT DEFAULT NULL,
  p_operation_source TEXT DEFAULT 'owner_control_center'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_role TEXT;
  v_tele RECORD;
  v_rider RECORD;
  v_active_count INTEGER := 0;
  v_previous_rider_id TEXT := NULL;
  v_previous_status TEXT := NULL;
  v_new_status TEXT := 'motoboy_designado';
  v_event_type TEXT := 'rider_assigned';
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_new_version INTEGER;
  v_reason_norm TEXT;
BEGIN
  -- 1. Validar Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Validar Papel Autorizado (admin, gerente, operador em user_profiles ou client_users)
  SELECT role INTO v_user_role FROM public.user_profiles WHERE user_id = v_user_id AND is_active = true;
  IF v_user_role IS NULL THEN
    SELECT role INTO v_user_role FROM public.client_users WHERE user_id = v_user_id AND status = 'ativo';
  END IF;

  IF v_user_role IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Usuário sem permissão operacional para despachar.');
  END IF;

  -- 3. Lock transacional da Tele
  SELECT * INTO v_tele 
  FROM public.teles 
  WHERE id::text = p_tele_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  -- 4. Validar Estado Imutável ou Inválido
  v_previous_status := v_tele.status;
  IF v_previous_status IN ('concluido', 'concluida', 'entregue', 'cancelado', 'cancelada') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_STATUS_INVALID', 'message', 'Não é possível despachar uma Tele concluída ou cancelada.');
  END IF;

  -- 5. Validar Versão Otimista
  IF v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 
      'error_code', 'TELE_VERSION_CONFLICT', 
      'message', 'Esta Tele foi atualizada por outro operador. Os dados serão recarregados.',
      'current_version', v_tele.version
    );
  END IF;

  -- 6. Lock transacional do Motoboy
  SELECT * INTO v_rider 
  FROM public.fleet 
  WHERE id::text = p_rider_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_NOT_FOUND', 'message', 'Motoboy não encontrado na frota.');
  END IF;

  IF v_rider.status IN ('Indisponível', 'Bloqueado', 'Inativo') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_UNAVAILABLE', 'message', 'Motoboy indisponível para novos despachos.');
  END IF;

  -- 7. Validar Reatribuição (Troca com motivo obrigatório)
  v_previous_rider_id := v_tele.motoboy_id::text;
  v_reason_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_reason, '')), '');

  IF v_previous_rider_id IS NOT NULL AND v_previous_rider_id <> '' AND v_previous_rider_id <> p_rider_id THEN
    IF v_reason_norm IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'REASSIGN_REASON_REQUIRED', 'message', 'Motivo obrigatório para trocar de motoboy.');
    END IF;
    v_event_type := 'rider_reassigned';
    
    IF v_previous_status IN ('aguardando_coleta', 'coletada', 'em_entrega') THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'REASSIGN_BLOCKED_ADVANCED_STATUS', 'message', 'Troca de motoboy não permitida nesta fase da entrega.');
    END IF;
  END IF;

  -- 8. Validar Capacidade Simultânea
  SELECT pg_catalog.count(*) INTO v_active_count
  FROM public.teles
  WHERE motoboy_id::text = p_rider_id
    AND status IN ('novo', 'solicitada', 'aguardando_despacho', 'atribuido', 'motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_rota', 'em_entrega');

  IF v_active_count >= COALESCE(v_rider.simultaneous_limit, 3) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 
      'error_code', 'RIDER_CAPACITY_REACHED', 
      'message', pg_catalog.format('Capacidade limite atingida para %s (%s/%s).', v_rider.name, v_active_count, COALESCE(v_rider.simultaneous_limit, 3)),
      'rider_name', v_rider.name,
      'active_count', v_active_count,
      'limit', COALESCE(v_rider.simultaneous_limit, 3)
    );
  END IF;

  -- 9. Atualizar Tele
  v_new_version := COALESCE(v_tele.version, 1) + 1;

  UPDATE public.teles
  SET 
    motoboy_id = p_rider_id,
    status = v_new_status,
    version = v_new_version,
    updated_at = v_now
  WHERE id::text = p_tele_id;

  UPDATE public.fleet
  SET delivery = p_tele_id, last_seen = v_now
  WHERE id::text = p_rider_id;

  -- 10. Evento e Auditoria
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, created_at)
  VALUES (
    v_tele.id, v_event_type,
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'rider_id', p_rider_id, 'previous_rider_id', v_previous_rider_id, 'reason', v_reason_norm, 'actor_user_id', v_user_id, 'source', p_operation_source),
    v_now
  );

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, created_at)
  VALUES ('user', v_user_id::text, v_event_type, pg_catalog.format('teles:%s', p_tele_id), pg_catalog.jsonb_build_object('rider_id', p_rider_id, 'reason', v_reason_norm, 'version', v_new_version), v_now);

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'rider_id', p_rider_id,
    'rider_name', v_rider.name,
    'status', v_new_status,
    'version', v_new_version,
    'active_count', v_active_count + 1,
    'simultaneous_limit', COALESCE(v_rider.simultaneous_limit, 3),
    'updated_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_rider_to_tele(TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_rider_to_tele(TEXT, TEXT, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_rider_to_tele(TEXT, TEXT, INTEGER, TEXT, TEXT) TO authenticated;


-- File: 20260727000500_tele_completion_ledger_rpc.sql
-- =====================================================================
-- Dahora Expresso — Baseline Migration 5: Conclusão, Cancelamento & Ledger
-- Timestamp: 20260727000500
-- =====================================================================

-- 1. Tabela 'rider_financial_transactions'
CREATE TABLE IF NOT EXISTS public.rider_financial_transactions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id                TEXT NOT NULL REFERENCES public.fleet(id) ON DELETE RESTRICT,
  tele_id                 TEXT,
  type                    TEXT NOT NULL CHECK (type IN ('credito_entrega', 'ajuste_credito', 'ajuste_debito', 'estorno')),
  direction               TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount                  NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  description             TEXT NOT NULL,
  idempotency_key         TEXT UNIQUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_transaction_id UUID REFERENCES public.rider_financial_transactions(id)
);

CREATE INDEX IF NOT EXISTS rider_fin_tx_rider_idx ON public.rider_financial_transactions (rider_id);

-- 2. Tabela 'company_financial_transactions'
CREATE TABLE IF NOT EXISTS public.company_financial_transactions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tele_id                 TEXT,
  type                    TEXT NOT NULL CHECK (type IN ('taxa_entrega', 'estorno')),
  amount                  NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  description             TEXT NOT NULL,
  idempotency_key         TEXT UNIQUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.rider_financial_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_financial_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY rider_fin_tx_select ON public.rider_financial_transactions FOR SELECT TO authenticated USING (true);
CREATE POLICY company_fin_tx_select ON public.company_financial_transactions FOR SELECT TO authenticated USING (true);

-- RPC complete_tele (Conclusão Idempotente com Arredondamento Monetário, search_path='' e auth.uid())
CREATE OR REPLACE FUNCTION public.complete_tele(
  p_tele_id TEXT,
  p_expected_version INTEGER,
  p_completion_source TEXT DEFAULT 'operator'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_tele RECORD;
  v_rider RECORD;
  v_client RECORD;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_new_version INTEGER;
  v_valor_cliente NUMERIC(10,2);
  v_valor_motoboy NUMERIC(10,2);
  v_taxa_empresa NUMERIC(10,2);
  v_rider_pct NUMERIC(5,2) := 80.00;
  v_key_tele TEXT;
  v_key_client TEXT;
  v_key_rider TEXT;
  v_key_company TEXT;
  v_key_event TEXT;
  v_key_audit TEXT;
BEGIN
  -- 1. Validar Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Lock transacional da Tele
  SELECT * INTO v_tele 
  FROM public.teles 
  WHERE id::text = p_tele_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  -- Chaves Idempotentes Determinísticas
  v_key_tele := pg_catalog.format('tele:%s:completion:v1', p_tele_id);
  v_key_client := pg_catalog.format('tele:%s:client_debit:v1', p_tele_id);
  v_key_rider := pg_catalog.format('tele:%s:rider_credit:v1', p_tele_id);
  v_key_company := pg_catalog.format('tele:%s:company_fee:v1', p_tele_id);
  v_key_event := pg_catalog.format('tele:%s:completion:event:v1', p_tele_id);
  v_key_audit := pg_catalog.format('tele:%s:completion:audit:v1', p_tele_id);

  -- 3. Idempotência: Retornar resultado existente se já concluída
  IF v_tele.status IN ('concluido', 'concluida', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', p_tele_id,
      'status', 'concluida',
      'version', v_tele.version,
      'message', 'Tele já havia sido concluída anteriormente.'
    );
  END IF;

  IF v_tele.status IN ('cancelado', 'cancelada') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_ALREADY_CANCELLED', 'message', 'Não é possível concluir uma Tele cancelada.');
  END IF;

  -- 4. Validar Versão Otimista
  IF v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 
      'error_code', 'TELE_VERSION_CONFLICT', 
      'message', 'Esta Tele foi atualizada por outro operador. Os dados serão recarregados.',
      'current_version', v_tele.version
    );
  END IF;

  -- 5. Validar Motoboy Atribuído
  IF v_tele.motoboy_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_WITHOUT_RIDER', 'message', 'A Tele precisa ter um motoboy atribuído antes de ser concluída.');
  END IF;

  -- 6. Resolução da Regra Financeira & Arredondamento Monetário Sem Resíduo
  v_valor_cliente := pg_catalog.round(COALESCE(v_tele.delivery_charge, v_tele.valor, 15.00), 2);
  IF v_valor_cliente <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_FINANCIAL_DATA_INCOMPLETE', 'message', 'Valor da Tele é inválido ou incompleto.');
  END IF;

  -- Buscar porcentagem configurada no cliente (se existir)
  IF v_tele.client_id IS NOT NULL THEN
    SELECT rider_percentage INTO v_rider_pct 
    FROM public.commercial_clients 
    WHERE id = v_tele.client_id;
    v_rider_pct := COALESCE(v_rider_pct, 80.00);
  END IF;

  -- Cálculo com resíduo alocado na taxa da empresa (Garante: valor_cliente = valor_motoboy + taxa_empresa)
  v_valor_motoboy := pg_catalog.round(v_valor_cliente * v_rider_pct / 100.0, 2);
  v_taxa_empresa := v_valor_cliente - v_valor_motoboy;
  v_new_version := COALESCE(v_tele.version, 1) + 1;

  -- 7. Atualizar Tele
  UPDATE public.teles
  SET 
    status = 'concluida',
    completed_at = v_now,
    version = v_new_version,
    updated_at = v_now
  WHERE id::text = p_tele_id;

  -- 8. Lançamentos nos Ledgers
  IF v_tele.client_id IS NOT NULL THEN
    INSERT INTO public.client_financial_transactions (
      client_id, tele_id, type, direction, amount, description, idempotency_key, created_at, created_by
    ) VALUES (
      v_tele.client_id, v_tele.id, 'cobranca_entrega', 'debit', v_valor_cliente,
      pg_catalog.format('Débito referente à entrega #%s', p_tele_id), v_key_client, v_now, v_user_id
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  INSERT INTO public.rider_financial_transactions (
    rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at
  ) VALUES (
    v_tele.motoboy_id::text, p_tele_id, 'credito_entrega', 'credit', v_valor_motoboy,
    pg_catalog.format('Crédito de entrega #%s', p_tele_id), v_key_rider, v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.company_financial_transactions (
    tele_id, type, amount, description, idempotency_key, created_at
  ) VALUES (
    p_tele_id, 'taxa_entrega', v_taxa_empresa,
    pg_catalog.format('Taxa de serviço sobre entrega #%s', p_tele_id), v_key_company, v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  -- 9. Evento Imutável Idempotente
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_tele.id,
    'tele_completed',
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'previous_status', v_tele.status, 'new_status', 'concluida', 'actor_user_id', v_user_id, 'source', p_completion_source, 'valor_cliente', v_valor_cliente, 'valor_motoboy', v_valor_motoboy, 'taxa_empresa', v_taxa_empresa),
    v_key_event,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  -- 10. Log de Auditoria Idempotente
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'user', v_user_id::text, 'tele_completed', pg_catalog.format('teles:%s', p_tele_id),
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'source', p_completion_source, 'valor_cliente', v_valor_cliente, 'version', v_new_version),
    v_key_audit, v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'status', 'concluida',
    'version', v_new_version,
    'valor_cliente', v_valor_cliente,
    'valor_motoboy', v_valor_motoboy,
    'taxa_empresa', v_taxa_empresa,
    'completed_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_tele(TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_tele(TEXT, INTEGER, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_tele(TEXT, INTEGER, TEXT) TO authenticated;

-- RPC cancel_tele (Cancelamento Controlado com search_path='' e auth.uid())
CREATE OR REPLACE FUNCTION public.cancel_tele(
  p_tele_id TEXT,
  p_expected_version INTEGER,
  p_reason TEXT,
  p_charge_policy TEXT DEFAULT 'sem_cobranca'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_tele RECORD;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_new_version INTEGER;
  v_key_event TEXT := pg_catalog.format('tele:%s:cancellation:event:v1', p_tele_id);
  v_key_audit TEXT := pg_catalog.format('tele:%s:cancellation:audit:v1', p_tele_id);
  v_reason_norm TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  v_reason_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  IF v_reason_norm IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CANCELLATION_REASON_REQUIRED', 'message', 'Motivo do cancelamento é obrigatório.');
  END IF;

  SELECT * INTO v_tele FROM public.teles WHERE id::text = p_tele_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele.status IN ('concluido', 'concluida', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_ALREADY_COMPLETED', 'message', 'Não é possível cancelar uma Tele que já foi concluída.');
  END IF;

  IF v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_VERSION_CONFLICT', 'message', 'Esta Tele foi atualizada por outro operador. Os dados serão recarregados.');
  END IF;

  v_new_version := COALESCE(v_tele.version, 1) + 1;

  UPDATE public.teles
  SET 
    status = 'cancelada',
    cancelled_at = v_now,
    cancellation_reason = v_reason_norm,
    version = v_new_version,
    updated_at = v_now
  WHERE id::text = p_tele_id;

  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_tele.id, 'tele_cancelled',
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'reason', v_reason_norm, 'policy', p_charge_policy, 'actor_user_id', v_user_id, 'cancelled_at', v_now),
    v_key_event, v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES ('user', v_user_id::text, 'tele_cancelled', pg_catalog.format('teles:%s', p_tele_id), pg_catalog.jsonb_build_object('reason', v_reason_norm, 'policy', p_charge_policy), v_key_audit, v_now)
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object('success', true, 'tele_id', p_tele_id, 'status', 'cancelada', 'version', v_new_version);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_tele(TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_tele(TEXT, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_tele(TEXT, INTEGER, TEXT, TEXT) TO authenticated;


-- File: 20260727000600_security_and_client_rpc.sql
-- =====================================================================
-- Dahora Expresso — Baseline Migration 6: RPC do Cliente, Idempotência & Preço
-- Timestamp: 20260727000600
-- =====================================================================

-- 1. Colunas de Idempotência, Referência e Precificação em public.teles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'client_request_idempotency_key'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN client_request_idempotency_key TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_reference'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_reference TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_charge'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_charge NUMERIC(10,2) DEFAULT 15.00;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'pricing_rule_source'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN pricing_rule_source TEXT DEFAULT 'fallback_default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'pricing_rule_version'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN pricing_rule_version TEXT DEFAULT 'v1_fallback';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'tele_code'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN tele_code TEXT UNIQUE;
  END IF;
END $$;

-- Sequence Transacional de Códigos de Tele (#TEL-XXXXXX)
CREATE SEQUENCE IF NOT EXISTS public.tele_code_seq START WITH 100001;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teles_client_idempotency_unique'
  ) THEN
    ALTER TABLE public.teles ADD CONSTRAINT teles_client_idempotency_unique UNIQUE (client_id, client_request_idempotency_key);
  END IF;
END $$;

-- 2. Função Centralizada de Resolução de Frete (resolve_delivery_charge)
CREATE OR REPLACE FUNCTION public.resolve_delivery_charge(
  p_client_id UUID,
  p_pickup_address TEXT,
  p_delivery_address TEXT,
  p_reference_data JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  delivery_charge NUMERIC(10,2),
  rule_source TEXT,
  rule_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Fallback temporário controlado de R$ 15,00.
  RETURN QUERY SELECT 15.00::NUMERIC(10,2), 'fallback_default'::TEXT, 'v1_fallback'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_delivery_charge(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_delivery_charge(UUID, TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_delivery_charge(UUID, TEXT, TEXT, JSONB) TO authenticated;

-- 3. RPC Centralizada do Cliente Comercial (create_client_tele)
CREATE OR REPLACE FUNCTION public.create_client_tele(
  p_pickup_address TEXT,
  p_delivery_address TEXT,
  p_recipient_name TEXT,
  p_recipient_phone TEXT,
  p_idempotency_key TEXT,
  p_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_order_value NUMERIC DEFAULT 0.00,
  p_operation_source TEXT DEFAULT 'client_portal'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_client RECORD;
  v_client_user RECORD;
  v_inserted_tele RECORD;
  v_existing_tele RECORD;
  v_tele_id UUID := pg_catalog.gen_random_uuid();
  v_delivery_charge NUMERIC(10,2);
  v_pricing_source TEXT;
  v_pricing_version TEXT;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_pickup_norm TEXT;
  v_delivery_norm TEXT;
  v_recipient_name_norm TEXT;
  v_recipient_phone_raw TEXT;
  v_recipient_phone_norm TEXT;
  v_idempotency_key_norm TEXT;
  v_reference_norm TEXT;
  v_notes_norm TEXT;
  v_op_source_norm TEXT;
  v_order_value NUMERIC(12,2);
  c_max_order_value CONSTANT NUMERIC(12,2) := 50000.00;
BEGIN
  -- 1. Validar Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Normalização e Validação do operation_source
  v_op_source_norm := pg_catalog.btrim(COALESCE(p_operation_source, 'client_portal'));
  IF v_op_source_norm = '' THEN
    v_op_source_norm := 'client_portal';
  END IF;
  IF v_op_source_norm <> 'client_portal' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION_SOURCE', 'message', 'Origem da operação inválida para a área do cliente. Apenas "client_portal" é permitido.');
  END IF;

  -- 3. Normalização e Validação da Idempotency Key
  v_idempotency_key_norm := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF v_idempotency_key_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED', 'message', 'A chave de idempotência é obrigatória para criar solicitação.');
  END IF;
  IF pg_catalog.length(v_idempotency_key_norm) < 5 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_TOO_SHORT', 'message', 'A chave de idempotência deve conter no mínimo 5 caracteres.');
  END IF;
  IF pg_catalog.length(v_idempotency_key_norm) > 100 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_TOO_LONG', 'message', 'A chave de idempotência excede o tamanho máximo de 100 caracteres.');
  END IF;

  -- 4. Resolver client_id pelo Usuário Autenticado em client_users
  SELECT * INTO v_client_user 
  FROM public.client_users 
  WHERE user_id = v_user_id AND status = 'ativo' 
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_ACCESS_DENIED', 'message', 'Usuário não possui vínculo ativo com cliente comercial.');
  END IF;

  -- 5. Validar Cliente Comercial Ativo
  SELECT * INTO v_client 
  FROM public.commercial_clients 
  WHERE id = v_client_user.client_id AND lifecycle_status = 'ativo';

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_INACTIVE_OR_BLOCKED', 'message', 'Cadastro do cliente comercial está inativo ou bloqueado.');
  END IF;

  -- 6. Normalização e Validação de Endereço de Coleta (pickup_address)
  v_pickup_norm := pg_catalog.btrim(COALESCE(p_pickup_address, ''));
  IF v_pickup_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PICKUP_ADDRESS_REQUIRED', 'message', 'Endereço de coleta é obrigatório.');
  END IF;
  IF pg_catalog.length(v_pickup_norm) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PICKUP_ADDRESS_TOO_LONG', 'message', 'Endereço de coleta excede o limite máximo de 500 caracteres.');
  END IF;

  -- 7. Normalização e Validação de Endereço de Entrega (delivery_address)
  v_delivery_norm := pg_catalog.btrim(COALESCE(p_delivery_address, ''));
  IF v_delivery_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_REQUIRED', 'message', 'Endereço de entrega é obrigatório.');
  END IF;
  IF pg_catalog.length(v_delivery_norm) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_TOO_LONG', 'message', 'Endereço de entrega excede o limite máximo de 500 caracteres.');
  END IF;

  -- 8. Validar Endereços Claramente Idênticos
  IF pg_catalog.lower(v_pickup_norm) = pg_catalog.lower(v_delivery_norm) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SAME_PICKUP_AND_DELIVERY_ADDRESS', 'message', 'Endereço de coleta e de entrega não podem ser idênticos.');
  END IF;

  -- 9. Normalização e Validação do Destinatário (recipient_name)
  v_recipient_name_norm := pg_catalog.btrim(COALESCE(p_recipient_name, ''));
  IF v_recipient_name_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_REQUIRED', 'message', 'Nome do destinatário é obrigatório.');
  END IF;
  IF pg_catalog.length(v_recipient_name_norm) > 150 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_TOO_LONG', 'message', 'Nome do destinatário excede o limite máximo de 150 caracteres.');
  END IF;

  -- 10. Normalização e Validação do Telefone do Destinatário (recipient_phone)
  v_recipient_phone_raw := pg_catalog.btrim(COALESCE(p_recipient_phone, ''));
  IF v_recipient_phone_raw = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é obrigatório.');
  END IF;
  IF v_recipient_phone_raw LIKE '+%' THEN
    v_recipient_phone_norm := '+' || pg_catalog.regexp_replace(pg_catalog.substr(v_recipient_phone_raw, 2), '[^0-9]', '', 'g');
  ELSE
    v_recipient_phone_norm := pg_catalog.regexp_replace(v_recipient_phone_raw, '[^0-9]', '', 'g');
  END IF;
  IF v_recipient_phone_norm = '' OR v_recipient_phone_norm = '+' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é inválido.');
  END IF;
  IF pg_catalog.length(v_recipient_phone_norm) > 30 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_TOO_LONG', 'message', 'Telefone do destinatário excede o limite máximo de 30 caracteres.');
  END IF;

  -- 11. Normalização e Validação da Referência (p_reference)
  v_reference_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_reference, '')), '');
  IF v_reference_norm IS NOT NULL AND pg_catalog.length(v_reference_norm) > 300 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_REFERENCE_TOO_LONG', 'message', 'A referência da entrega excede o limite máximo de 300 caracteres.');
  END IF;

  -- 12. Normalização e Validação das Observações (p_notes)
  v_notes_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_notes, '')), '');
  IF v_notes_norm IS NOT NULL AND pg_catalog.length(v_notes_norm) > 1000 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'NOTES_TOO_LONG', 'message', 'As observações da entrega excedem o limite máximo de 1000 caracteres.');
  END IF;

  -- 13. Validação Centralizada do Valor do Pedido (p_order_value)
  v_order_value := pg_catalog.round(COALESCE(p_order_value, 0.00)::NUMERIC, 2);
  IF v_order_value < 0.00 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_ORDER_VALUE', 'message', 'Valor do pedido não pode ser negativo.');
  END IF;
  IF v_order_value > c_max_order_value THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ORDER_VALUE_LIMIT_EXCEEDED', 'message', pg_catalog.format('Valor do pedido excede o limite máximo permitido de R$ %s.', c_max_order_value));
  END IF;

  -- 14. Resolver Frete da Tele no Backend
  SELECT delivery_charge, rule_source, rule_version INTO v_delivery_charge, v_pricing_source, v_pricing_version
  FROM public.resolve_delivery_charge(v_client_user.client_id, v_pickup_norm, v_delivery_norm);

  -- 15. Inserção Atômica Idempotente com ON CONFLICT DO NOTHING
  INSERT INTO public.teles (
    id, client_id, status, origin, address, dest_name, dest_phone, notes,
    total_order_amount, valor, delivery_charge, pricing_rule_source, pricing_rule_version,
    delivery_reference, version, client_request_idempotency_key, created_at, updated_at
  ) VALUES (
    v_tele_id, v_client_user.client_id, 'solicitada', v_pickup_norm, v_delivery_norm,
    v_recipient_name_norm, v_recipient_phone_norm, v_notes_norm, v_order_value,
    v_delivery_charge, v_delivery_charge, v_pricing_source, COALESCE(v_pricing_version, 'v1_fallback'),
    v_reference_norm, 1, v_idempotency_key_norm, v_now, v_now
  )
  ON CONFLICT (client_id, client_request_idempotency_key) DO NOTHING
  RETURNING id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at
  INTO v_inserted_tele;

  -- 16. Tratamento de Idempotência se o INSERT não inseriu nova linha
  IF v_inserted_tele.id IS NULL THEN
    SELECT id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at
    INTO v_existing_tele
    FROM public.teles
    WHERE client_id = v_client_user.client_id AND client_request_idempotency_key = v_idempotency_key_norm;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', v_existing_tele.id,
      'status', v_existing_tele.status,
      'client_id', v_existing_tele.client_id,
      'delivery_charge', v_existing_tele.delivery_charge,
      'delivery_reference', v_existing_tele.delivery_reference,
      'pricing_rule_source', v_existing_tele.pricing_rule_source,
      'pricing_rule_version', v_existing_tele.pricing_rule_version,
      'version', v_existing_tele.version,
      'created_at', v_existing_tele.created_at,
      'message', 'Solicitação já processada anteriormente.'
    );
  END IF;

  -- 17. Inserir Evento Imutável em tele_eventos (Apenas para nova Tele inserida)
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_inserted_tele.id, 'tele_requested',
    pg_catalog.jsonb_build_object('client_id', v_client_user.client_id, 'source', v_op_source_norm, 'actor_user_id', v_user_id, 'delivery_reference', v_reference_norm),
    pg_catalog.format('tele:%s:request:event:v1', v_inserted_tele.id),
    v_now
  );

  -- 18. Inserir Log de Auditoria do Sistema (Apenas para nova Tele inserida)
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'client_user', v_user_id::text, 'create_tele', pg_catalog.format('teles:%s', v_inserted_tele.id),
    pg_catalog.jsonb_build_object('client_id', v_client_user.client_id, 'source', v_op_source_norm, 'delivery_reference', v_reference_norm),
    pg_catalog.format('tele:%s:request:audit:v1', v_inserted_tele.id),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'is_idempotent', false,
    'tele_id', v_inserted_tele.id,
    'status', v_inserted_tele.status,
    'client_id', v_inserted_tele.client_id,
    'delivery_charge', v_inserted_tele.delivery_charge,
    'delivery_reference', v_inserted_tele.delivery_reference,
    'pricing_rule_source', v_inserted_tele.pricing_rule_source,
    'pricing_rule_version', v_inserted_tele.pricing_rule_version,
    'version', v_inserted_tele.version,
    'created_at', v_inserted_tele.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated;

-- 3.b Função Centralizada de Autorização e Consulta de Papel
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role TEXT;
  v_is_active BOOLEAN := false;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN 'anon';
  END IF;

  -- 1. Consultar fonte oficial de perfis de usuários (user_profiles)
  SELECT role, is_active INTO v_role, v_is_active
  FROM public.user_profiles
  WHERE user_id = v_user_id;

  IF FOUND AND v_is_active IS TRUE THEN
    RETURN v_role;
  END IF;

  -- 2. Consultar se é usuário cliente comercial
  SELECT role INTO v_role
  FROM public.client_users
  WHERE user_id = v_user_id AND status = 'ativo';

  IF FOUND THEN
    RETURN 'client_user';
  END IF;

  RETURN 'authenticated_unprivileged';
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_has_permission(p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  v_role := public.get_current_user_role();

  IF v_role IN ('owner', 'admin') THEN
    RETURN true;
  ELSIF v_role = 'operador' THEN
    RETURN p_permission IN (
      'tele.create_admin',
      'tele.assign_rider',
      'tele.complete',
      'tele.cancel',
      'client.manage',
      'fleet.manage'
    );
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.get_current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO authenticated;

REVOKE ALL ON FUNCTION public.current_user_has_permission(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_has_permission(TEXT) TO authenticated;

-- 4. RPC Administrativa para Criação de Tele Manual pelo Operador/Admin (create_admin_tele)
CREATE OR REPLACE FUNCTION public.create_admin_tele(
  p_client_id UUID,
  p_pickup_address TEXT,
  p_delivery_address TEXT,
  p_recipient_name TEXT,
  p_recipient_phone TEXT,
  p_idempotency_key TEXT,
  p_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_order_value NUMERIC DEFAULT 0.00,
  p_operation_source TEXT DEFAULT 'owner_panel'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_role TEXT;
  v_client RECORD;
  v_inserted_tele RECORD;
  v_existing_tele RECORD;
  v_tele_id UUID := pg_catalog.gen_random_uuid();
  v_delivery_charge NUMERIC(10,2);
  v_pricing_source TEXT;
  v_pricing_version TEXT;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_pickup_norm TEXT;
  v_delivery_norm TEXT;
  v_recipient_name_norm TEXT;
  v_recipient_phone_raw TEXT;
  v_recipient_phone_norm TEXT;
  v_idempotency_key_norm TEXT;
  v_reference_norm TEXT;
  v_notes_norm TEXT;
  v_op_source_norm TEXT;
  v_order_value NUMERIC(12,2);
  c_max_order_value CONSTANT NUMERIC(12,2) := 50000.00;
BEGIN
  -- 1. Validar Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Validar Autorização Centralizada do Operador/Admin via Permission Check
  IF NOT public.current_user_has_permission('tele.create_admin') AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Usuário sem permissão operacional para criar Teles administrativamente.');
  END IF;

  -- 3. Validar Seleção de Cliente Comercial Obrigatório
  IF p_client_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_SELECTION_REQUIRED', 'message', 'Selecione um cliente comercial cadastrado.');
  END IF;

  -- 4. Validar Cliente Comercial e Lifecycle Status
  SELECT * INTO v_client 
  FROM public.commercial_clients 
  WHERE id = p_client_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_NOT_FOUND', 'message', 'O cliente comercial selecionado não foi encontrado.');
  END IF;

  IF v_client.lifecycle_status IN ('suspenso', 'cancelado', 'inativo') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_INACTIVE_OR_BLOCKED', 'message', 'O cliente comercial selecionado está inativo, suspenso ou bloqueado.');
  END IF;

  -- 5. Normalização do operation_source
  v_op_source_norm := pg_catalog.btrim(COALESCE(p_operation_source, 'owner_panel'));
  IF v_op_source_norm = '' THEN
    v_op_source_norm := 'owner_panel';
  END IF;

  -- 6. Normalização e Validação da Idempotency Key
  v_idempotency_key_norm := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF v_idempotency_key_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED', 'message', 'A chave de idempotência é obrigatória para criar solicitação.');
  END IF;
  IF pg_catalog.length(v_idempotency_key_norm) < 5 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_TOO_SHORT', 'message', 'A chave de idempotência deve conter no mínimo 5 caracteres.');
  END IF;
  IF pg_catalog.length(v_idempotency_key_norm) > 100 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_TOO_LONG', 'message', 'A chave de idempotência excede o tamanho máximo de 100 caracteres.');
  END IF;

  -- 7. Normalização de Endereços
  v_pickup_norm := pg_catalog.btrim(COALESCE(p_pickup_address, ''));
  IF v_pickup_norm = '' THEN
    v_pickup_norm := v_client.address;
  END IF;
  IF pg_catalog.length(v_pickup_norm) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PICKUP_ADDRESS_TOO_LONG', 'message', 'Endereço de coleta excede o limite máximo de 500 caracteres.');
  END IF;

  v_delivery_norm := pg_catalog.btrim(COALESCE(p_delivery_address, ''));
  IF v_delivery_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_REQUIRED', 'message', 'Endereço de entrega é obrigatório.');
  END IF;
  IF pg_catalog.length(v_delivery_norm) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_TOO_LONG', 'message', 'Endereço de entrega excede o limite máximo de 500 caracteres.');
  END IF;

  IF pg_catalog.lower(v_pickup_norm) = pg_catalog.lower(v_delivery_norm) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SAME_PICKUP_AND_DELIVERY_ADDRESS', 'message', 'Endereço de coleta e de entrega não podem ser idênticos.');
  END IF;

  -- 8. Normalização do Destinatário
  v_recipient_name_norm := pg_catalog.btrim(COALESCE(p_recipient_name, ''));
  IF v_recipient_name_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_REQUIRED', 'message', 'Nome do destinatário é obrigatório.');
  END IF;
  IF pg_catalog.length(v_recipient_name_norm) > 150 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_TOO_LONG', 'message', 'Nome do destinatário excede o limite máximo de 150 caracteres.');
  END IF;

  v_recipient_phone_raw := pg_catalog.btrim(COALESCE(p_recipient_phone, ''));
  IF v_recipient_phone_raw = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é obrigatório.');
  END IF;
  IF v_recipient_phone_raw LIKE '+%' THEN
    v_recipient_phone_norm := '+' || pg_catalog.regexp_replace(pg_catalog.substr(v_recipient_phone_raw, 2), '[^0-9]', '', 'g');
  ELSE
    v_recipient_phone_norm := pg_catalog.regexp_replace(v_recipient_phone_raw, '[^0-9]', '', 'g');
  END IF;
  IF v_recipient_phone_norm = '' OR v_recipient_phone_norm = '+' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é inválido.');
  END IF;
  IF pg_catalog.length(v_recipient_phone_norm) > 30 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_TOO_LONG', 'message', 'Telefone do destinatário excede o limite máximo de 30 caracteres.');
  END IF;

  -- 9. Normalização de Referência e Observações
  v_reference_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_reference, '')), '');
  IF v_reference_norm IS NOT NULL AND pg_catalog.length(v_reference_norm) > 300 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_REFERENCE_TOO_LONG', 'message', 'A referência da entrega excede o limite máximo de 300 caracteres.');
  END IF;

  v_notes_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_notes, '')), '');
  IF v_notes_norm IS NOT NULL AND pg_catalog.length(v_notes_norm) > 1000 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'NOTES_TOO_LONG', 'message', 'As observações da entrega excedem o limite máximo de 1000 caracteres.');
  END IF;

  -- 10. Validação do Valor do Pedido
  v_order_value := pg_catalog.round(COALESCE(p_order_value, 0.00)::NUMERIC, 2);
  IF v_order_value < 0.00 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_ORDER_VALUE', 'message', 'Valor do pedido não pode ser negativo.');
  END IF;
  IF v_order_value > c_max_order_value THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ORDER_VALUE_LIMIT_EXCEEDED', 'message', pg_catalog.format('Valor do pedido excede o limite máximo permitido de R$ %s.', c_max_order_value));
  END IF;

  -- 11. Resolver Frete da Tele no Backend
  SELECT delivery_charge, rule_source, rule_version INTO v_delivery_charge, v_pricing_source, v_pricing_version
  FROM public.resolve_delivery_charge(p_client_id, v_pickup_norm, v_delivery_norm);

  -- 12. Inserção Atômica Idempotente com ON CONFLICT DO NOTHING
  INSERT INTO public.teles (
    id, client_id, status, origin, address, dest_name, dest_phone, notes,
    total_order_amount, valor, delivery_charge, pricing_rule_source, pricing_rule_version,
    delivery_reference, version, client_request_idempotency_key, created_at, updated_at
  ) VALUES (
    v_tele_id, p_client_id, 'solicitada', v_pickup_norm, v_delivery_norm,
    v_recipient_name_norm, v_recipient_phone_norm, v_notes_norm, v_order_value,
    v_delivery_charge, v_delivery_charge, v_pricing_source, COALESCE(v_pricing_version, 'v1_fallback'),
    v_reference_norm, 1, v_idempotency_key_norm, v_now, v_now
  )
  ON CONFLICT (client_id, client_request_idempotency_key) DO NOTHING
  RETURNING id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at
  INTO v_inserted_tele;

  -- 13. Idempotência se o INSERT não inseriu nova linha
  IF v_inserted_tele.id IS NULL THEN
    SELECT id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at
    INTO v_existing_tele
    FROM public.teles
    WHERE client_id = p_client_id AND client_request_idempotency_key = v_idempotency_key_norm;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', v_existing_tele.id,
      'status', v_existing_tele.status,
      'client_id', v_existing_tele.client_id,
      'delivery_charge', v_existing_tele.delivery_charge,
      'delivery_reference', v_existing_tele.delivery_reference,
      'pricing_rule_source', v_existing_tele.pricing_rule_source,
      'pricing_rule_version', v_existing_tele.pricing_rule_version,
      'version', v_existing_tele.version,
      'created_at', v_existing_tele.created_at,
      'message', 'Solicitação já processada anteriormente.'
    );
  END IF;

  -- 14. Inserir Evento Imutável em tele_eventos
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_inserted_tele.id, 'tele_requested',
    pg_catalog.jsonb_build_object('client_id', p_client_id, 'source', v_op_source_norm, 'actor_user_id', v_user_id, 'delivery_reference', v_reference_norm),
    pg_catalog.format('tele:%s:request:event:v1', v_inserted_tele.id),
    v_now
  );

  -- 15. Inserir Log de Auditoria
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'admin_user', v_user_id::text, 'create_admin_tele', pg_catalog.format('teles:%s', v_inserted_tele.id),
    pg_catalog.jsonb_build_object('client_id', p_client_id, 'source', v_op_source_norm, 'delivery_reference', v_reference_norm),
    pg_catalog.format('tele:%s:request:audit:v1', v_inserted_tele.id),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'is_idempotent', false,
    'tele_id', v_inserted_tele.id,
    'status', v_inserted_tele.status,
    'client_id', v_inserted_tele.client_id,
    'delivery_charge', v_inserted_tele.delivery_charge,
    'delivery_reference', v_inserted_tele.delivery_reference,
    'pricing_rule_source', v_inserted_tele.pricing_rule_source,
    'pricing_rule_version', v_inserted_tele.pricing_rule_version,
    'version', v_inserted_tele.version,
    'created_at', v_inserted_tele.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated;
