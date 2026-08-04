-- Migration: 20260729000100_pwa_tele_status_transitions.sql
-- Transições operacionais backend-authoritative e calculo de ganho do motoboy

CREATE OR REPLACE FUNCTION public.get_tele_rider_earning(p_tele_id UUID)
RETURNS NUMERIC(10,2)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tele RECORD;
  v_rider_pct NUMERIC(5,2) := 80.00;
  v_charge NUMERIC(10,2);
  v_ledger_amount NUMERIC(10,2);
BEGIN
  -- 1. Se concluida, buscar valor oficial gravado no ledger
  SELECT amount INTO v_ledger_amount
  FROM public.rider_financial_transactions
  WHERE tele_id::text = p_tele_id::text AND type = 'credito_entrega'
  LIMIT 1;

  IF v_ledger_amount IS NOT NULL THEN
    RETURN v_ledger_amount;
  END IF;

  -- 2. Se ativa, calcular valor authoritative com base na porcentagem do cliente comercial
  SELECT client_id, delivery_charge INTO v_tele
  FROM public.teles
  WHERE id::text = p_tele_id::text;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_tele.client_id IS NOT NULL THEN
    SELECT rider_percentage INTO v_rider_pct
    FROM public.commercial_clients
    WHERE id = v_tele.client_id;
    v_rider_pct := COALESCE(v_rider_pct, 80.00);
  END IF;

  v_charge := pg_catalog.round(COALESCE(v_tele.delivery_charge, 0.00), 2);
  IF v_charge <= 0 THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.round(v_charge * v_rider_pct / 100.0, 2);
END;
$$;


-- Lógica central interna de conclusão de Tele (não exposta diretamente ao frontend)
CREATE OR REPLACE FUNCTION public.complete_tele_internal(
  p_tele_id UUID,
  p_expected_version BIGINT,
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
  v_tele RECORD;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_new_version BIGINT;
  v_valor_cliente NUMERIC(10,2);
  v_valor_motoboy NUMERIC(10,2);
  v_taxa_empresa NUMERIC(10,2);
  v_rider_pct NUMERIC(5,2) := 80.00;
  v_key_client TEXT;
  v_key_rider TEXT;
  v_key_company TEXT;
  v_key_event TEXT;
  v_key_audit TEXT;
BEGIN
  -- 1. Trava transacional única
  SELECT * INTO v_tele
  FROM public.teles
  WHERE id = p_tele_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  -- Chaves Idempotentes Determinísticas
  v_key_client := pg_catalog.format('tele:%s:client_debit:v1', p_tele_id);
  v_key_rider := pg_catalog.format('tele:%s:rider_credit:v1', p_tele_id);
  v_key_company := pg_catalog.format('tele:%s:company_fee:v1', p_tele_id);
  v_key_event := pg_catalog.format('tele:%s:completion:event:v1', p_tele_id);
  v_key_audit := pg_catalog.format('tele:%s:completion:audit:v1', p_tele_id);

  -- 2. Idempotência: Se já concluída, retornar resultado existente sem recalcular ledgers
  IF v_tele.status IN ('concluida', 'concluido', 'entregue') THEN
    v_valor_motoboy := public.get_tele_rider_earning(p_tele_id);
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', p_tele_id,
      'status', 'concluida',
      'version', v_tele.version,
      'valor_motoboy', v_valor_motoboy,
      'message', 'Tele já havia sido concluída anteriormente.'
    );
  END IF;

  IF v_tele.status IN ('cancelada', 'cancelado') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_ALREADY_CANCELLED', 'message', 'Não é possível concluir uma Tele cancelada.');
  END IF;

  -- 3. Trava de versão otimista
  IF p_expected_version IS NOT NULL AND v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'TELE_VERSION_CONFLICT',
      'message', 'Esta entrega foi atualizada em outro dispositivo. Os dados foram recarregados.',
      'current_version', v_tele.version
    );
  END IF;

  IF v_tele.motoboy_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_WITHOUT_RIDER', 'message', 'A Tele precisa ter um motoboy atribuído antes de ser concluída.');
  END IF;

  -- 4. Cálculo financeiro authoritative
  v_valor_cliente := pg_catalog.round(COALESCE(v_tele.delivery_charge, v_tele.total_order_amount, 15.00), 2);
  IF v_valor_cliente <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_FINANCIAL_DATA_INCOMPLETE', 'message', 'Valor da Tele é inválido ou incompleto.');
  END IF;

  IF v_tele.client_id IS NOT NULL THEN
    SELECT rider_percentage INTO v_rider_pct
    FROM public.commercial_clients
    WHERE id = v_tele.client_id;
    v_rider_pct := COALESCE(v_rider_pct, 80.00);
  END IF;

  v_valor_motoboy := pg_catalog.round(v_valor_cliente * v_rider_pct / 100.0, 2);
  v_taxa_empresa := v_valor_cliente - v_valor_motoboy;
  v_new_version := COALESCE(v_tele.version, 1) + 1;

  -- 5. Atualização atômica do registro da Tele
  UPDATE public.teles
  SET
    status = 'concluida',
    completed_at = v_now,
    version = v_new_version,
    updated_at = v_now
  WHERE id = p_tele_id;

  -- 6. Lançamentos nos Ledgers
  IF v_tele.client_id IS NOT NULL THEN
    INSERT INTO public.client_financial_transactions (
      client_id, tele_id, type, direction, amount, description, idempotency_key, created_at, created_by
    ) VALUES (
      v_tele.client_id, v_tele.id, 'cobranca_entrega', 'debit', v_valor_cliente,
      pg_catalog.format('Débito referente à entrega #%s', p_tele_id), v_key_client, v_now, p_actor_user_id
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

  -- 7. Registro de Eventos e Auditoria
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_tele.id,
    'tele_completed',
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'previous_status', v_tele.status, 'new_status', 'concluida', 'actor_user_id', p_actor_user_id, 'source', p_completion_source, 'valor_cliente', v_valor_cliente, 'valor_motoboy', v_valor_motoboy, 'taxa_empresa', v_taxa_empresa),
    v_key_event,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    p_actor_type, p_actor_user_id::text, 'tele_completed', pg_catalog.format('teles:%s', p_tele_id),
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'source', p_completion_source, 'valor_cliente', v_valor_cliente, 'version', v_new_version),
    v_key_audit,
    v_now
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


-- RPC 1: Marcar como coletada
CREATE OR REPLACE FUNCTION public.mark_my_tele_collected(
  p_tele_id UUID,
  p_expected_version BIGINT DEFAULT NULL
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
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_new_version BIGINT;
  v_key_event TEXT;
  v_key_audit TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT id INTO v_fleet_id
  FROM public.fleet
  WHERE user_id = v_user_id;

  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Seu usuário não possui um perfil de motoboy vinculado.');
  END IF;

  SELECT * INTO v_tele
  FROM public.teles
  WHERE id = p_tele_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele.motoboy_id IS NULL OR v_tele.motoboy_id <> v_fleet_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'FORBIDDEN_NOT_YOUR_TELE', 'message', 'Esta entrega não está atribuída a você.');
  END IF;

  IF v_tele.status IN ('concluida', 'concluido', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_ALREADY_COMPLETED', 'message', 'Esta entrega já foi concluída.');
  END IF;

  IF v_tele.status IN ('cancelada', 'cancelado') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_ALREADY_CANCELLED', 'message', 'Não é possível coletar uma entrega cancelada.');
  END IF;

  IF v_tele.status NOT IN ('motoboy_designado', 'indo_coletar', 'aguardando_coleta') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_TRANSITION', 'message', pg_catalog.format('Status atual "%s" não permite marcação de coleta.', v_tele.status));
  END IF;

  IF p_expected_version IS NOT NULL AND v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'TELE_VERSION_CONFLICT',
      'message', 'Esta entrega foi atualizada em outro dispositivo. Os dados serão recarregados.',
      'current_version', v_tele.version
    );
  END IF;

  v_new_version := COALESCE(v_tele.version, 1) + 1;

  UPDATE public.teles
  SET
    status = 'coletada',
    updated_at = v_now,
    version = v_new_version
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

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'status', 'coletada',
    'version', v_new_version,
    'updated_at', v_now
  );
END;
$$;


-- RPC 2: Iniciar entrega
CREATE OR REPLACE FUNCTION public.start_my_tele_delivery(
  p_tele_id UUID,
  p_expected_version BIGINT DEFAULT NULL
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
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_new_version BIGINT;
  v_key_event TEXT;
  v_key_audit TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT id INTO v_fleet_id
  FROM public.fleet
  WHERE user_id = v_user_id;

  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Seu usuário não possui um perfil de motoboy vinculado.');
  END IF;

  SELECT * INTO v_tele
  FROM public.teles
  WHERE id = p_tele_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele.motoboy_id IS NULL OR v_tele.motoboy_id <> v_fleet_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'FORBIDDEN_NOT_YOUR_TELE', 'message', 'Esta entrega não está atribuída a você.');
  END IF;

  IF v_tele.status NOT IN ('coletada') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_TRANSITION', 'message', pg_catalog.format('Status atual "%s" não permite iniciar entrega (deve estar "coletada").', v_tele.status));
  END IF;

  IF p_expected_version IS NOT NULL AND v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'TELE_VERSION_CONFLICT',
      'message', 'Esta entrega foi atualizada em outro dispositivo. Os dados serão recarregados.',
      'current_version', v_tele.version
    );
  END IF;

  v_new_version := COALESCE(v_tele.version, 1) + 1;

  UPDATE public.teles
  SET
    status = 'em_entrega',
    updated_at = v_now,
    version = v_new_version
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

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'status', 'em_entrega',
    'version', v_new_version,
    'updated_at', v_now
  );
END;
$$;


-- RPC 3: Finalizar entrega (motoboy)
CREATE OR REPLACE FUNCTION public.complete_my_tele(
  p_tele_id UUID,
  p_expected_version BIGINT DEFAULT NULL
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

  SELECT id INTO v_fleet_id
  FROM public.fleet
  WHERE user_id = v_user_id;

  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Seu usuário não possui um perfil de motoboy vinculado.');
  END IF;

  SELECT * INTO v_tele
  FROM public.teles
  WHERE id = p_tele_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele.motoboy_id IS NULL OR v_tele.motoboy_id <> v_fleet_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'FORBIDDEN_NOT_YOUR_TELE', 'message', 'Esta entrega não está atribuída a você.');
  END IF;

  IF v_tele.status NOT IN ('em_entrega', 'concluida', 'concluido', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_TRANSITION', 'message', pg_catalog.format('Status atual "%s" não permite finalização (deve estar "em_entrega").', v_tele.status));
  END IF;

  -- Invocar lógica central de baixa
  v_result := public.complete_tele_internal(p_tele_id, p_expected_version, v_user_id, 'rider', 'rider_pwa');

  -- Atualizar status do motoboy considerando OUTRAS teles ativas
  IF (v_result->>'success')::boolean = true THEN
    SELECT COUNT(*) INTO v_other_active_count
    FROM public.teles
    WHERE motoboy_id = v_fleet_id
      AND id <> p_tele_id
      AND status IN ('motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega');

    IF v_other_active_count = 0 THEN
      UPDATE public.fleet
      SET status = 'Disponível', updated_at = pg_catalog.clock_timestamp()
      WHERE id = v_fleet_id;
    END IF;
  END IF;

  RETURN v_result;
END;
$$;


-- Atualizar complete_tele para delegar para complete_tele_internal
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

  RETURN public.complete_tele_internal(p_tele_id, p_expected_version::BIGINT, v_user_id, 'operator', p_completion_source);
END;
$$;


-- Permissões e Segurança
REVOKE EXECUTE ON FUNCTION public.complete_tele_internal(UUID, BIGINT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_tele_internal(UUID, BIGINT, UUID, TEXT, TEXT) FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_tele_rider_earning(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_tele_rider_earning(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_tele_rider_earning(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.mark_my_tele_collected(UUID, BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_my_tele_collected(UUID, BIGINT) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_my_tele_collected(UUID, BIGINT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.start_my_tele_delivery(UUID, BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.start_my_tele_delivery(UUID, BIGINT) FROM anon;
GRANT EXECUTE ON FUNCTION public.start_my_tele_delivery(UUID, BIGINT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.complete_my_tele(UUID, BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_my_tele(UUID, BIGINT) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_my_tele(UUID, BIGINT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_tele(UUID, INTEGER, TEXT) TO authenticated;
