-- =====================================================================
-- Dahora Expresso — Módulo de Visão Geral do Cliente Comercial (Overview)
-- Migration: 20260818160000_client_overview_rpcs.sql
-- =====================================================================

-- Helper interno para montar o resumo da visão geral por client_id
CREATE OR REPLACE FUNCTION public.internal_build_client_overview_payload(
  p_client_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now_sp TIMESTAMPTZ;
  v_today_start_sp TIMESTAMPTZ;
  v_month_start_sp TIMESTAMPTZ;
  v_client_exists BOOLEAN;
  v_establishment_name TEXT;
  
  v_today_created INT := 0;
  v_current_pending INT := 0;
  v_current_active INT := 0;
  v_today_completed INT := 0;
  v_today_canceled INT := 0;

  v_month_created INT := 0;
  v_month_completed INT := 0;
  v_month_canceled INT := 0;

  v_avg_duration_min NUMERIC := NULL;
  v_completion_rate NUMERIC := NULL;
  v_terminal_total INT := 0;

  v_days_array JSONB := '[]'::jsonb;
  v_day_idx INT;
  v_cur_day_date DATE;
  v_cur_day_start TIMESTAMPTZ;
  v_cur_day_end TIMESTAMPTZ;
  v_day_created INT;
  v_day_completed INT;
BEGIN
  -- Validar existência do cliente
  SELECT EXISTS(SELECT 1 FROM public.commercial_clients WHERE id = p_client_id),
         establishment_name
  INTO v_client_exists, v_establishment_name
  FROM public.commercial_clients
  WHERE id = p_client_id;

  IF NOT COALESCE(v_client_exists, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'CLIENT_NOT_FOUND',
      'message', 'Estabelecimento comercial não localizado.'
    );
  END IF;

  -- Definir timestamps de referência no fuso America/Sao_Paulo
  v_now_sp := clock_timestamp();
  v_today_start_sp := date_trunc('day', v_now_sp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_month_start_sp := date_trunc('month', v_now_sp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';

  -- 1. Contagens de Hoje
  SELECT COUNT(*) INTO v_today_created
  FROM public.teles
  WHERE client_id = p_client_id
    AND created_at >= v_today_start_sp;

  SELECT COUNT(*) INTO v_current_pending
  FROM public.teles
  WHERE client_id = p_client_id
    AND status IN ('solicitada', 'aguardando_despacho');

  SELECT COUNT(*) INTO v_current_active
  FROM public.teles
  WHERE client_id = p_client_id
    AND status IN ('motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_rota', 'em_entrega');

  SELECT COUNT(*) INTO v_today_completed
  FROM public.teles
  WHERE client_id = p_client_id
    AND status IN ('concluido', 'concluida', 'entregue')
    AND completed_at >= v_today_start_sp;

  SELECT COUNT(*) INTO v_today_canceled
  FROM public.teles
  WHERE client_id = p_client_id
    AND status IN ('cancelado', 'cancelada')
    AND cancelled_at >= v_today_start_sp;

  -- 2. Contagens do Mês
  SELECT COUNT(*) INTO v_month_created
  FROM public.teles
  WHERE client_id = p_client_id
    AND created_at >= v_month_start_sp;

  SELECT COUNT(*) INTO v_month_completed
  FROM public.teles
  WHERE client_id = p_client_id
    AND status IN ('concluido', 'concluida', 'entregue')
    AND completed_at >= v_month_start_sp;

  SELECT COUNT(*) INTO v_month_canceled
  FROM public.teles
  WHERE client_id = p_client_id
    AND status IN ('cancelado', 'cancelada')
    AND cancelled_at >= v_month_start_sp;

  -- 3. Performance
  SELECT ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60.0)::numeric, 1)
  INTO v_avg_duration_min
  FROM public.teles
  WHERE client_id = p_client_id
    AND status IN ('concluido', 'concluida', 'entregue')
    AND completed_at IS NOT NULL
    AND completed_at >= v_month_start_sp
    AND completed_at > created_at;

  v_terminal_total := v_month_completed + v_month_canceled;
  IF v_terminal_total > 0 THEN
    v_completion_rate := ROUND((v_month_completed * 100.0 / v_terminal_total)::numeric, 1);
  END IF;

  -- 4. Gráfico dos Últimos 7 Dias (D-6 a D-0 em America/Sao_Paulo)
  v_days_array := '[]'::jsonb;
  FOR v_day_idx IN 0..6 LOOP
    v_cur_day_date := ((v_now_sp AT TIME ZONE 'America/Sao_Paulo')::date - (6 - v_day_idx));
    v_cur_day_start := v_cur_day_date::timestamp AT TIME ZONE 'America/Sao_Paulo';
    v_cur_day_end := (v_cur_day_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

    SELECT COUNT(*) INTO v_day_created
    FROM public.teles
    WHERE client_id = p_client_id
      AND created_at >= v_cur_day_start
      AND created_at < v_cur_day_end;

    SELECT COUNT(*) INTO v_day_completed
    FROM public.teles
    WHERE client_id = p_client_id
      AND status IN ('concluido', 'concluida', 'entregue')
      AND completed_at >= v_cur_day_start
      AND completed_at < v_cur_day_end;

    v_days_array := v_days_array || jsonb_build_object(
      'date', to_char(v_cur_day_date, 'YYYY-MM-DD'),
      'label', to_char(v_cur_day_date, 'DD/MM'),
      'total', v_day_created,
      'completed', v_day_completed
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'client_id', p_client_id,
    'establishment_name', COALESCE(v_establishment_name, 'Cliente Comercial'),
    'generated_at', v_now_sp,
    'timezone', 'America/Sao_Paulo',
    'today', jsonb_build_object(
      'total_created', v_today_created,
      'pending', v_current_pending,
      'active', v_current_active,
      'completed', v_today_completed,
      'canceled', v_today_canceled
    ),
    'month', jsonb_build_object(
      'total_created', v_month_created,
      'completed', v_month_completed,
      'canceled', v_month_canceled
    ),
    'performance', jsonb_build_object(
      'avg_delivery_minutes', v_avg_duration_min,
      'completion_rate', v_completion_rate
    ),
    'last_7_days', v_days_array
  );
END;
$$;

-- REVOKE ALL ON FUNCTION public.internal_build_client_overview_payload(UUID) FROM PUBLIC, anon, authenticated;


-- =====================================================================
-- 1. RPC AUTENTICADA DO CLIENTE COMERCIAL (get_client_dashboard_overview)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_client_dashboard_overview()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_client_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'AUTHENTICATION_REQUIRED',
      'message', 'Autenticação necessária.'
    );
  END IF;

  -- Resolver o client_id ativo do usuário comercial
  SELECT client_id INTO v_client_id
  FROM public.client_users
  WHERE user_id = v_user_id
    AND status = 'ativo'
  LIMIT 1;

  IF v_client_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'CLIENT_NOT_FOUND',
      'message', 'Estabelecimento comercial não localizado ou inativo.'
    );
  END IF;

  RETURN public.internal_build_client_overview_payload(v_client_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_client_dashboard_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_client_dashboard_overview() TO authenticated;


-- =====================================================================
-- 2. RPC ADMINISTRATIVA PARA IMPERSONAÇÃO (admin_get_client_dashboard_overview)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_get_client_dashboard_overview(
  p_client_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin_user() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'FORBIDDEN',
      'message', 'Acesso negado. Requer perfil administrativo.'
    );
  END IF;

  IF p_client_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_CLIENT_ID',
      'message', 'ID do cliente comercial é obrigatório.'
    );
  END IF;

  RETURN public.internal_build_client_overview_payload(p_client_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_client_dashboard_overview(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_client_dashboard_overview(UUID) TO authenticated;

-- =====================================================================
-- 3. RECONCILIAÇÃO ADITIVA DE IDEMPOTÊNCIA PARA CRÉDITOS E CONSUMÍVEIS
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_create_rider_consumable(
  p_motoboy_id UUID,
  p_category TEXT,
  p_item_name TEXT,
  p_quantity NUMERIC,
  p_unit_amount NUMERIC,
  p_notes TEXT DEFAULT NULL,
  p_competency_date DATE DEFAULT CURRENT_DATE,
  p_request_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_motoboy RECORD;
  v_category_norm TEXT;
  v_total_amount NUMERIC(10,2);
  v_op_key TEXT;
  v_tx_key TEXT;
  v_purchase RECORD;
  v_tx RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem registrar consumíveis.');
  END IF;

  SELECT f.id, f.name INTO v_motoboy FROM public.fleet f WHERE f.id = p_motoboy_id;
  IF v_motoboy.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_NOT_FOUND', 'message', 'Motoboy não encontrado.');
  END IF;

  IF p_item_name IS NULL OR pg_catalog.btrim(p_item_name) = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ITEM_NAME_REQUIRED', 'message', 'O nome do item é obrigatório.');
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_QUANTITY', 'message', 'A quantidade deve ser maior que zero.');
  END IF;

  IF p_unit_amount IS NULL OR p_unit_amount < 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_UNIT_AMOUNT', 'message', 'O valor unitário não pode ser negativo.');
  END IF;

  v_category_norm := LOWER(pg_catalog.btrim(COALESCE(p_category, 'consumivel')));
  IF v_category_norm NOT IN ('vale', 'consumivel', 'consumível') THEN
    v_category_norm := 'consumivel';
  END IF;

  v_total_amount := pg_catalog.round(p_quantity * p_unit_amount, 2);

  IF p_request_idempotency_key IS NOT NULL AND pg_catalog.btrim(p_request_idempotency_key) <> '' THEN
    v_op_key := pg_catalog.btrim(p_request_idempotency_key);
    SELECT * INTO v_purchase FROM public.rider_consumable_purchases WHERE idempotency_key = v_op_key;
    IF v_purchase.id IS NOT NULL THEN
      SELECT * INTO v_tx FROM public.rider_financial_transactions WHERE idempotency_key = pg_catalog.format('consumable:%s:rider_debit:v1', v_purchase.id);
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'idempotent', true,
        'purchase', pg_catalog.to_jsonb(v_purchase),
        'transaction', pg_catalog.to_jsonb(v_tx)
      );
    END IF;
  ELSE
    v_op_key := pg_catalog.format('admin-consumable:%s', gen_random_uuid());
  END IF;

  INSERT INTO public.rider_consumable_purchases (
    motoboy_id, motoboy_name, categoria, item_name, quantidade, valor_unitario, amount, observacao, competency_date, status, idempotency_key
  ) VALUES (
    v_motoboy.id, v_motoboy.name, v_category_norm, pg_catalog.btrim(p_item_name), p_quantity::integer, p_unit_amount, v_total_amount, p_notes, COALESCE(p_competency_date, CURRENT_DATE), 'active', v_op_key
  )
  RETURNING * INTO v_purchase;

  v_tx_key := pg_catalog.format('consumable:%s:rider_debit:v1', v_purchase.id);

  INSERT INTO public.rider_financial_transactions (
    rider_id, tele_id, type, direction, amount, description, competency_date, idempotency_key
  ) VALUES (
    v_motoboy.id, NULL, 'ajuste_debito', 'debit', v_total_amount, pg_catalog.format('Consumível: %s', v_purchase.item_name), COALESCE(p_competency_date, CURRENT_DATE), v_tx_key
  )
  ON CONFLICT (idempotency_key) DO UPDATE
  SET amount = EXCLUDED.amount,
      competency_date = EXCLUDED.competency_date
  RETURNING * INTO v_tx;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'idempotent', false,
    'purchase', pg_catalog.to_jsonb(v_purchase),
    'transaction', pg_catalog.to_jsonb(v_tx)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_rider_adjustment(
  p_motoboy_id UUID,
  p_direction TEXT,
  p_amount NUMERIC,
  p_description TEXT,
  p_target_date DATE DEFAULT CURRENT_DATE,
  p_request_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_motoboy RECORD;
  v_dir_norm TEXT;
  v_tx_type TEXT;
  v_amount NUMERIC(10,2);
  v_op_key TEXT;
  v_tx_key TEXT;
  v_adj RECORD;
  v_tx RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem registrar ajustes.');
  END IF;

  SELECT f.id, f.name INTO v_motoboy FROM public.fleet f WHERE f.id = p_motoboy_id;
  IF v_motoboy.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_NOT_FOUND', 'message', 'Motoboy não encontrado.');
  END IF;

  v_dir_norm := LOWER(pg_catalog.btrim(COALESCE(p_direction, '')));
  IF v_dir_norm NOT IN ('credit', 'debit') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DIRECTION', 'message', 'Direção inválida. Use credit ou debit.');
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_AMOUNT', 'message', 'O valor do ajuste deve ser maior que zero.');
  END IF;

  IF p_description IS NULL OR pg_catalog.btrim(p_description) = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DESCRIPTION_REQUIRED', 'message', 'A descrição do ajuste é obrigatória.');
  END IF;

  v_amount := pg_catalog.round(p_amount, 2);
  v_tx_type := CASE WHEN v_dir_norm = 'credit' THEN 'ajuste_credito' ELSE 'ajuste_debito' END;

  IF p_request_idempotency_key IS NOT NULL AND pg_catalog.btrim(p_request_idempotency_key) <> '' THEN
    v_op_key := pg_catalog.btrim(p_request_idempotency_key);
    SELECT * INTO v_adj FROM public.rider_credits_ledger WHERE idempotency_key = v_op_key;
    IF v_adj.id IS NOT NULL THEN
      SELECT * INTO v_tx FROM public.rider_financial_transactions WHERE idempotency_key = pg_catalog.format('adjustment:%s:%s:v1', v_adj.id, v_dir_norm);
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'idempotent', true,
        'adjustment', pg_catalog.to_jsonb(v_adj),
        'transaction', pg_catalog.to_jsonb(v_tx)
      );
    END IF;
  ELSE
    v_op_key := pg_catalog.format('admin-adjustment:%s', gen_random_uuid());
  END IF;

  INSERT INTO public.rider_credits_ledger (
    motoboy_id, amount, description, target_date, direction, status, idempotency_key
  ) VALUES (
    v_motoboy.id, v_amount, pg_catalog.btrim(p_description), COALESCE(p_target_date, CURRENT_DATE), v_dir_norm, 'active', v_op_key
  )
  RETURNING * INTO v_adj;

  v_tx_key := pg_catalog.format('adjustment:%s:%s:v1', v_adj.id, v_dir_norm);

  INSERT INTO public.rider_financial_transactions (
    rider_id, tele_id, type, direction, amount, description, competency_date, idempotency_key
  ) VALUES (
    v_motoboy.id, NULL, v_tx_type, v_dir_norm, v_amount, pg_catalog.btrim(p_description), COALESCE(p_target_date, CURRENT_DATE), v_tx_key
  )
  ON CONFLICT (idempotency_key) DO UPDATE
  SET amount = EXCLUDED.amount,
      competency_date = EXCLUDED.competency_date
  RETURNING * INTO v_tx;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'idempotent', false,
    'adjustment', pg_catalog.to_jsonb(v_adj),
    'transaction', pg_catalog.to_jsonb(v_tx)
  );
END;
$$;

-- =====================================================================
-- 4. CORREÇÃO DA CLÁUSULA ON CONFLICT EM complete_tele_internal
-- =====================================================================
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
    ) ON CONFLICT (client_id, idempotency_key) DO NOTHING;
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
