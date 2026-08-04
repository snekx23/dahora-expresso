-- =====================================================================
-- Dahora Expresso — Baseline Migration 5: Conclusão, Cancelamento & Ledger
-- Timestamp: 20260727000500
-- =====================================================================

-- 1. Tabela 'rider_financial_transactions'
CREATE TABLE IF NOT EXISTS public.rider_financial_transactions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id UUID NOT NULL REFERENCES public.fleet(id) ON DELETE RESTRICT,
  tele_id  UUID REFERENCES public.teles(id) ON DELETE RESTRICT,
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
  tele_id UUID REFERENCES public.teles(id) ON DELETE RESTRICT,
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
  p_tele_id UUID,
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
    v_tele.motoboy_id, p_tele_id, 'credito_entrega', 'credit', v_valor_motoboy,
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

REVOKE ALL ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) TO authenticated;

-- RPC cancel_tele (Cancelamento Controlado com search_path='' e auth.uid())
CREATE OR REPLACE FUNCTION public.cancel_tele(
  p_tele_id UUID,
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

REVOKE ALL ON FUNCTION public.cancel_tele(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_tele(UUID, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_tele(UUID, INTEGER, TEXT, TEXT) TO authenticated;