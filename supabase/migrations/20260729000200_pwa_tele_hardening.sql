-- =====================================================================
-- Dahora Expresso — Migration: Endurecimento PWA Minhas Teles & Regras Financeiras
-- Timestamp: 20260729000200
-- =====================================================================

-- 1. Adicionar colunas rider_percentage e rider_id em public.teles se ainda não existirem
ALTER TABLE public.teles 
  ADD COLUMN IF NOT EXISTS rider_percentage NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS rider_id UUID REFERENCES public.fleet(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_teles_rider_percentage'
  ) THEN
    ALTER TABLE public.teles
      ADD CONSTRAINT check_teles_rider_percentage
      CHECK (rider_percentage IS NULL OR (rider_percentage >= 0 AND rider_percentage <= 100));
  END IF;
END $$;


-- 2. Função interna de cálculo financeiro (SEM EXECUTE PUBLIC/AUTHENTICATED/ANON)
CREATE OR REPLACE FUNCTION public.calculate_tele_financial_split_internal(p_tele_id UUID)
RETURNS TABLE (
  delivery_charge NUMERIC(12,2),
  rider_percentage NUMERIC(5,2),
  rider_earning_amount NUMERIC(12,2),
  company_earning_amount NUMERIC(12,2),
  pricing_rule_source TEXT,
  pricing_rule_version TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tele RECORD;
  v_client_pct NUMERIC(5,2);
  v_delivery_charge NUMERIC(12,2);
  v_rider_pct NUMERIC(5,2);
  v_rider_earning NUMERIC(12,2);
  v_company_earning NUMERIC(12,2);
  v_rule_source TEXT;
  v_rule_version TEXT;
BEGIN
  SELECT t.id, t.client_id, t.delivery_charge, t.pricing_rule_source, t.pricing_rule_version, t.rider_percentage
  INTO v_tele
  FROM public.teles t
  WHERE t.id = p_tele_id;

  IF v_tele.id IS NULL THEN
    RAISE EXCEPTION 'TELE_NOT_FOUND' USING HINT = 'Tele não encontrada.';
  END IF;

  v_delivery_charge := pg_catalog.round(COALESCE(v_tele.delivery_charge, 0.00)::NUMERIC, 2);
  v_rule_source := COALESCE(v_tele.pricing_rule_source, 'commercial_client_percentage');
  v_rule_version := COALESCE(v_tele.pricing_rule_version, 'v1_frozen');

  -- Prioridade 1: Regra congelada na Tele
  IF v_tele.rider_percentage IS NOT NULL THEN
    v_rider_pct := v_tele.rider_percentage;
  ELSE
    -- Prioridade 2: Regra do cliente comercial
    IF v_tele.client_id IS NOT NULL THEN
      SELECT c.rider_percentage INTO v_client_pct
      FROM public.commercial_clients c
      WHERE c.id = v_tele.client_id;

      IF v_client_pct IS NOT NULL THEN
        v_rider_pct := v_client_pct;
      END IF;
    END IF;

    -- Prioridade 3: Cliente interno padrão do sistema se não houver cliente na Tele
    IF v_rider_pct IS NULL THEN
      SELECT c.rider_percentage INTO v_client_pct
      FROM public.commercial_clients c
      WHERE c.establishment_name = 'Dahora Expresso'
      LIMIT 1;

      IF v_client_pct IS NOT NULL THEN
        v_rider_pct := v_client_pct;
      END IF;
    END IF;
  END IF;

  -- Se após todas as verificações nenhuma regra for encontrada: lançar exceção explícita
  IF v_rider_pct IS NULL THEN
    RAISE EXCEPTION 'MISSING_PRICING_RULE' USING HINT = 'Não foi possível determinar a regra de repasse desta entrega.';
  END IF;

  v_rider_earning := pg_catalog.round((v_delivery_charge * (v_rider_pct / 100.00)), 2);
  v_company_earning := pg_catalog.round((v_delivery_charge - v_rider_earning), 2);

  RETURN QUERY SELECT
    v_delivery_charge AS delivery_charge,
    v_rider_pct AS rider_percentage,
    v_rider_earning AS rider_earning_amount,
    v_company_earning AS company_earning_amount,
    v_rule_source AS pricing_rule_source,
    v_rule_version AS pricing_rule_version;
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_tele_financial_split_internal(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calculate_tele_financial_split_internal(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.calculate_tele_financial_split_internal(UUID) FROM authenticated;


-- 3. Função de leitura get_tele_rider_earning (Somente Leitura, STABLE, sem side-effects)
CREATE OR REPLACE FUNCTION public.get_tele_rider_earning(p_tele_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_earning NUMERIC(12,2);
  v_status TEXT;
BEGIN
  SELECT t.status INTO v_status FROM public.teles t WHERE t.id = p_tele_id;

  -- Para Tele concluída, preferir o valor histórico do ledger
  IF v_status IN ('concluid', 'concluido', 'concluida', 'entregue') THEN
    SELECT r.amount INTO v_earning
    FROM public.rider_financial_transactions r
    WHERE r.tele_id = p_tele_id AND r.type = 'credito_entrega'
    LIMIT 1;

    IF v_earning IS NOT NULL THEN
      RETURN pg_catalog.round(v_earning, 2);
    END IF;
  END IF;

  -- Para Tele ativa ou fallback, calcular pelo snapshot sem escrever no banco
  SELECT s.rider_earning_amount INTO v_earning
  FROM public.calculate_tele_financial_split_internal(p_tele_id) s;

  RETURN COALESCE(pg_catalog.round(v_earning, 2), 0.00);
END;
$$;

REVOKE ALL ON FUNCTION public.get_tele_rider_earning(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_tele_rider_earning(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_tele_rider_earning(UUID) TO authenticated;


-- 4. Função interna central de conclusão complete_tele_internal (Com INTEGER para version)
CREATE OR REPLACE FUNCTION public.complete_tele_internal(
  p_tele_id UUID,
  p_expected_version INTEGER,
  p_actor_user_id UUID,
  p_actor_type TEXT,
  p_completion_source TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_tele RECORD;
  v_split RECORD;
  v_new_version INTEGER;
  v_key_client TEXT;
  v_key_rider TEXT;
  v_key_company TEXT;
  v_key_event TEXT;
  v_key_audit TEXT;
BEGIN
  SELECT t.id, t.status, t.version, t.motoboy_id, t.client_id, t.rider_percentage
  INTO v_tele
  FROM public.teles t
  WHERE t.id = p_tele_id
  FOR UPDATE;

  IF v_tele.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  -- Idempotência: Se já estiver concluída, retornar estado atual sem duplicar ledgers ou auditorias
  IF v_tele.status IN ('concluida', 'concluido', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', p_tele_id,
      'status', v_tele.status,
      'version', v_tele.version,
      'message', 'Tele já se encontra concluída.'
    );
  END IF;

  -- Concorrência: Verificar versão otimista se informada
  IF p_expected_version IS NOT NULL AND v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'TELE_VERSION_CONFLICT',
      'message', 'A entrega foi atualizada por outro usuário.',
      'current_version', v_tele.version
    );
  END IF;

  -- Obter cálculo financeiro centralizado
  BEGIN
    SELECT * INTO v_split FROM public.calculate_tele_financial_split_internal(p_tele_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CALCULATION_ERROR', 'message', SQLERRM);
  END;

  v_new_version := COALESCE(v_tele.version, 1) + 1;

  -- Atualizar a Tele congelando rider_percentage se estivesse nulo
  UPDATE public.teles
  SET status = 'concluida',
      completed_at = v_now,
      version = v_new_version,
      updated_at = v_now,
      rider_percentage = COALESCE(v_tele.rider_percentage, v_split.rider_percentage)
  WHERE id = p_tele_id;

  -- Lançamentos financeiros nos Ledgers com chaves estáveis e idempotentes
  v_key_client := pg_catalog.format('tele:%s:completion:client:v1', p_tele_id);
  v_key_rider := pg_catalog.format('tele:%s:completion:rider:v1', p_tele_id);
  v_key_company := pg_catalog.format('tele:%s:completion:company:v1', p_tele_id);

  IF v_tele.client_id IS NOT NULL AND v_split.delivery_charge > 0 THEN
    INSERT INTO public.client_financial_transactions (
      client_id, tele_id, type, direction, amount, description, idempotency_key, created_at, created_by
    ) VALUES (
      v_tele.client_id, p_tele_id, 'cobranca_entrega', 'debit', v_split.delivery_charge,
      pg_catalog.format('Cobrança de entrega Tele #%s', p_tele_id), v_key_client, v_now, p_actor_user_id
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  IF v_tele.motoboy_id IS NOT NULL AND v_split.rider_earning_amount > 0 THEN
    INSERT INTO public.rider_financial_transactions (
      rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at
    ) VALUES (
      v_tele.motoboy_id, p_tele_id, 'credito_entrega', 'credit', v_split.rider_earning_amount,
      pg_catalog.format('Repasse de entrega Tele #%s', p_tele_id), v_key_rider, v_now
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  IF v_split.company_earning_amount > 0 THEN
    INSERT INTO public.company_financial_transactions (
      tele_id, type, amount, description, idempotency_key, created_at
    ) VALUES (
      p_tele_id, 'taxa_entrega', v_split.company_earning_amount,
      pg_catalog.format('Taxa de serviço da empresa Tele #%s', p_tele_id), v_key_company, v_now
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  -- Evento e Auditoria Imutáveis
  v_key_event := pg_catalog.format('tele:%s:completion:event:v1', p_tele_id);
  v_key_audit := pg_catalog.format('tele:%s:completion:audit:v1', p_tele_id);

  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    p_tele_id,
    'tele_completed',
    pg_catalog.jsonb_build_object(
      'tele_id', p_tele_id, 'completion_source', p_completion_source,
      'delivery_charge', v_split.delivery_charge, 'rider_earning', v_split.rider_earning_amount,
      'company_earning', v_split.company_earning_amount, 'version', v_new_version
    ),
    v_key_event,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    p_actor_type, p_actor_user_id::text, 'tele_completed', pg_catalog.format('teles:%s', p_tele_id),
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'source', p_completion_source, 'version', v_new_version),
    v_key_audit,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'status', 'concluida',
    'version', v_new_version,
    'completed_at', v_now,
    'rider_earning_amount', v_split.rider_earning_amount,
    'company_earning_amount', v_split.company_earning_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_tele_internal(UUID, INTEGER, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_tele_internal(UUID, INTEGER, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.complete_tele_internal(UUID, INTEGER, UUID, TEXT, TEXT) FROM authenticated;


-- 5. RPC mark_my_tele_collected (INTEGER version)
CREATE OR REPLACE FUNCTION public.mark_my_tele_collected(
  p_tele_id UUID,
  p_expected_version INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_fleet_id UUID;
  v_tele RECORD;
  v_client_pct NUMERIC(5,2);
  v_new_version INTEGER;
  v_key_event TEXT;
  v_key_audit TEXT;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT f.id INTO v_fleet_id FROM public.fleet f WHERE f.user_id = v_user_id;

  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não encontrado.');
  END IF;

  SELECT t.id, t.status, t.version, t.motoboy_id, t.client_id, t.rider_percentage
  INTO v_tele
  FROM public.teles t
  WHERE t.id = p_tele_id
  FOR UPDATE;

  IF v_tele.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele.motoboy_id IS NULL OR v_tele.motoboy_id <> v_fleet_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'FORBIDDEN_NOT_YOUR_TELE', 'message', 'Esta entrega não pertence a você.');
  END IF;

  IF v_tele.status IN ('cancelada', 'cancelado') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_CANCELLED', 'message', 'Esta entrega foi cancelada.');
  END IF;

  IF v_tele.status IN ('concluida', 'concluido', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_COMPLETED', 'message', 'Esta entrega já foi concluída.');
  END IF;

  IF v_tele.status NOT IN ('motoboy_designado', 'indo_coletar', 'aguardando_coleta') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_TRANSITION', 'message', 'Transição para coletada inválida a partir do status atual.');
  END IF;

  IF p_expected_version IS NOT NULL AND v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_VERSION_CONFLICT', 'message', 'A tele foi alterada por outro usuário.', 'current_version', v_tele.version);
  END IF;

  v_new_version := COALESCE(v_tele.version, 1) + 1;

  -- Se a Tele não possuir rider_percentage congelado, congela no momento da coleta
  IF v_tele.rider_percentage IS NULL THEN
    IF v_tele.client_id IS NOT NULL THEN
      SELECT c.rider_percentage INTO v_client_pct FROM public.commercial_clients c WHERE c.id = v_tele.client_id;
    END IF;
    IF v_client_pct IS NULL THEN
      SELECT c.rider_percentage INTO v_client_pct FROM public.commercial_clients c WHERE c.establishment_name = 'Dahora Expresso' LIMIT 1;
    END IF;
  END IF;

  UPDATE public.teles
  SET status = 'coletada',
      version = v_new_version,
      updated_at = v_now,
      rider_percentage = COALESCE(v_tele.rider_percentage, v_client_pct)
  WHERE id = p_tele_id;

  v_key_event := pg_catalog.format('tele:%s:collected:event:v1', p_tele_id);
  v_key_audit := pg_catalog.format('tele:%s:collected:audit:v1', p_tele_id);

  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    p_tele_id,
    'tele_collected',
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'previous_status', v_tele.status, 'new_status', 'coletada', 'actor_user_id', v_user_id),
    v_key_event,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'rider', v_user_id::text, 'tele_collected', pg_catalog.format('teles:%s', p_tele_id),
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'version', v_new_version),
    v_key_audit,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object('success', true, 'tele_id', p_tele_id, 'status', 'coletada', 'version', v_new_version, 'updated_at', v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_my_tele_collected(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_my_tele_collected(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_my_tele_collected(UUID, INTEGER) TO authenticated;


-- 6. RPC start_my_tele_delivery (INTEGER version)
CREATE OR REPLACE FUNCTION public.start_my_tele_delivery(
  p_tele_id UUID,
  p_expected_version INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_fleet_id UUID;
  v_tele RECORD;
  v_new_version INTEGER;
  v_key_event TEXT;
  v_key_audit TEXT;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT f.id INTO v_fleet_id FROM public.fleet f WHERE f.user_id = v_user_id;

  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não encontrado.');
  END IF;

  SELECT t.id, t.status, t.version, t.motoboy_id
  INTO v_tele
  FROM public.teles t
  WHERE t.id = p_tele_id
  FOR UPDATE;

  IF v_tele.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele.motoboy_id IS NULL OR v_tele.motoboy_id <> v_fleet_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'FORBIDDEN_NOT_YOUR_TELE', 'message', 'Esta entrega não pertence a você.');
  END IF;

  IF v_tele.status NOT IN ('coletada') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_TRANSITION', 'message', 'A entrega precisa estar coletada para ser iniciada.');
  END IF;

  IF p_expected_version IS NOT NULL AND v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_VERSION_CONFLICT', 'message', 'A tele foi alterada por outro usuário.', 'current_version', v_tele.version);
  END IF;

  v_new_version := COALESCE(v_tele.version, 1) + 1;

  UPDATE public.teles
  SET status = 'em_entrega',
      version = v_new_version,
      updated_at = v_now
  WHERE id = p_tele_id;

  v_key_event := pg_catalog.format('tele:%s:delivery_started:event:v1', p_tele_id);
  v_key_audit := pg_catalog.format('tele:%s:delivery_started:audit:v1', p_tele_id);

  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    p_tele_id,
    'tele_delivery_started',
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'previous_status', v_tele.status, 'new_status', 'em_entrega', 'actor_user_id', v_user_id),
    v_key_event,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'rider', v_user_id::text, 'tele_delivery_started', pg_catalog.format('teles:%s', p_tele_id),
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'version', v_new_version),
    v_key_audit,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object('success', true, 'tele_id', p_tele_id, 'status', 'em_entrega', 'version', v_new_version, 'updated_at', v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.start_my_tele_delivery(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_my_tele_delivery(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.start_my_tele_delivery(UUID, INTEGER) TO authenticated;


-- 7. RPC complete_my_tele (INTEGER version, chama complete_tele_internal e atualiza fleet.status)
CREATE OR REPLACE FUNCTION public.complete_my_tele(
  p_tele_id UUID,
  p_expected_version INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_fleet_id UUID;
  v_tele RECORD;
  v_other_active_count INTEGER;
  v_result JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT f.id INTO v_fleet_id FROM public.fleet f WHERE f.user_id = v_user_id;

  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não encontrado.');
  END IF;

  SELECT t.id, t.status, t.motoboy_id
  INTO v_tele
  FROM public.teles t
  WHERE t.id = p_tele_id;

  IF v_tele.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele.motoboy_id IS NULL OR v_tele.motoboy_id <> v_fleet_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'FORBIDDEN_NOT_YOUR_TELE', 'message', 'Esta entrega não pertence a você.');
  END IF;

  IF v_tele.status NOT IN ('em_entrega', 'concluid', 'concluido', 'concluida', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_TRANSITION', 'message', 'A entrega precisa estar em_entrega para ser finalizada.');
  END IF;

  -- Delegar conclusão para a função central
  v_result := public.complete_tele_internal(p_tele_id, p_expected_version, v_user_id, 'rider', 'rider_pwa');

  -- Se a conclusão foi bem-sucedida, verificar se o motoboy possui outras Teles ativas
  IF (v_result->>'success')::boolean = true THEN
    SELECT count(*) INTO v_other_active_count
    FROM public.teles t
    WHERE t.motoboy_id = v_fleet_id
      AND t.status IN ('motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega')
      AND t.id <> p_tele_id;

    IF v_other_active_count = 0 THEN
      UPDATE public.fleet
      SET status = 'Disponível',
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = v_fleet_id;
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_my_tele(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_my_tele(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_my_tele(UUID, INTEGER) TO authenticated;


-- 8. RPC complete_tele (Administrativo, INTEGER version)
CREATE OR REPLACE FUNCTION public.complete_tele(
  p_tele_id UUID,
  p_expected_version INTEGER DEFAULT NULL,
  p_completion_source TEXT DEFAULT 'operator'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  RETURN public.complete_tele_internal(p_tele_id, p_expected_version, v_user_id, 'operator', p_completion_source);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) TO authenticated;


-- 9. RPC assign_rider_to_tele (Atualizando motoboy_id e rider_id se existir)
CREATE OR REPLACE FUNCTION public.assign_rider_to_tele(
  p_tele_id UUID,
  p_motoboy_id UUID,
  p_expected_version INTEGER,
  p_reason TEXT DEFAULT NULL,
  p_reassignment_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tele_record RECORD;
  v_rider_record RECORD;
  v_current_active INTEGER;
  v_client_pct NUMERIC(5,2);
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
  SELECT id, version, status, motoboy_id, client_id, rider_percentage
  INTO v_tele_record
  FROM public.teles
  WHERE id = p_tele_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele_record.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT', 'message', 'A tele foi alterada por outro usuário.');
  END IF;

  IF v_tele_record.status IN ('concluida', 'concluido', 'cancelada', 'cancelado', 'Entregue') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_STATUS', 'message', 'Tele concluída ou cancelada não pode ser reatribuída.');
  END IF;

  IF v_tele_record.motoboy_id IS NOT NULL AND v_tele_record.motoboy_id <> p_motoboy_id THEN
    IF btrim(COALESCE(p_reassignment_reason, '')) = '' THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'REASSIGNMENT_REASON_REQUIRED', 'message', 'Motivo da reatribuição é obrigatório.');
    END IF;
  END IF;

  SELECT id, name, simultaneous_limit INTO v_rider_record
  FROM public.fleet
  WHERE id = p_motoboy_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'RIDER_NOT_FOUND', 'message', 'Entregador não encontrado.');
  END IF;

  SELECT count(*) INTO v_current_active
  FROM public.teles
  WHERE motoboy_id = p_motoboy_id
    AND status IN ('motoboy_designado', 'a_caminho_coleta', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega', 'em_rota_entrega');

  IF v_current_active >= COALESCE(v_rider_record.simultaneous_limit, 3) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'RIDER_LIMIT_REACHED', 'message', 'Entregador atingiu o limite de teles simultâneas.');
  END IF;

  IF v_tele_record.rider_percentage IS NULL AND v_tele_record.client_id IS NOT NULL THEN
    SELECT c.rider_percentage INTO v_client_pct
    FROM public.commercial_clients c
    WHERE c.id = v_tele_record.client_id;
  END IF;

  UPDATE public.teles
  SET motoboy_id = p_motoboy_id,
      rider_id = p_motoboy_id,
      status = 'motoboy_designado',
      version = v_tele_record.version + 1,
      rider_percentage = COALESCE(v_tele_record.rider_percentage, v_client_pct),
      updated_at = v_now
  WHERE id = p_tele_id;

  UPDATE public.fleet
  SET status = 'Em entrega', updated_at = v_now
  WHERE id = p_motoboy_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'rider_id', p_motoboy_id,
    'rider_name', v_rider_record.name,
    'status', 'motoboy_designado',
    'version', v_tele_record.version + 1,
    'updated_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_rider_to_tele(UUID, UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_rider_to_tele(UUID, UUID, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_rider_to_tele(UUID, UUID, INTEGER, TEXT, TEXT) TO authenticated;
