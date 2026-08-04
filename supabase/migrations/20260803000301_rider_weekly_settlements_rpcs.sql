-- =====================================================================
-- Dahora Expresso — Migration 20260803000301
-- Fase 3A: Conjunto Completo de RPCs Especializadas (9 RPCs + Consultas)
-- =====================================================================

-- 1. RPC admin_allocate_client_payment_to_teles
CREATE OR REPLACE FUNCTION public.admin_allocate_client_payment_to_teles(
  p_client_transaction_id UUID,
  p_tele_ids UUID[],
  p_amounts NUMERIC[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_client_tx RECORD;
  v_tele_id UUID;
  v_alloc_amount NUMERIC(10,2);
  v_tele_charge NUMERIC(10,2);
  v_total_allocated NUMERIC(10,2);
  v_i INT;
  v_count INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  SELECT * INTO v_client_tx FROM public.client_financial_transactions WHERE id = p_client_transaction_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TRANSACTION_NOT_FOUND', 'message', 'Transação do cliente não encontrada.');
  END IF;

  IF v_client_tx.type <> 'pagamento_recebido' OR v_client_tx.direction <> 'credit' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_TRANSACTION_TYPE', 'message', 'Transação deve ser um pagamento recebido.');
  END IF;

  IF p_tele_ids IS NULL OR pg_catalog.array_length(p_tele_ids, 1) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_INPUT', 'message', 'Nenhuma Tele especificada para alocação.');
  END IF;

  FOR v_i IN 1..pg_catalog.array_length(p_tele_ids, 1) LOOP
    v_tele_id := p_tele_ids[v_i];
    v_alloc_amount := ROUND(p_amounts[v_i], 2);

    SELECT delivery_charge INTO v_tele_charge FROM public.teles WHERE id = v_tele_id;
    IF FOUND THEN
      SELECT COALESCE(SUM(allocated_amount), 0.00) INTO v_total_allocated 
      FROM public.client_payment_allocations 
      WHERE tele_id = v_tele_id AND client_transaction_id <> p_client_transaction_id;

      v_total_allocated := v_total_allocated + v_alloc_amount;

      INSERT INTO public.client_payment_allocations (
        client_id, client_transaction_id, tele_id, allocated_amount, is_fully_covered, allocated_by
      ) VALUES (
        v_client_tx.client_id, p_client_transaction_id, v_tele_id, v_alloc_amount, (v_total_allocated >= v_tele_charge), v_user_id
      ) ON CONFLICT (client_transaction_id, tele_id) DO UPDATE 
        SET allocated_amount = EXCLUDED.allocated_amount, is_fully_covered = (v_total_allocated >= v_tele_charge);

      -- Se a Tele ficou 100% coberta, atualizar status do item em settlement_items para eligible
      IF v_total_allocated >= v_tele_charge THEN
        UPDATE public.rider_weekly_settlement_items
        SET funding_status = 'eligible', eligible_amount = original_amount, blocked_amount = 0.00
        WHERE tele_id = v_tele_id AND funding_status = 'blocked_client_unpaid';
      END IF;

      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('success', true, 'allocated_count', v_count);
END;
$$;

-- 2. RPC admin_calculate_rider_weekly_settlement
CREATE OR REPLACE FUNCTION public.admin_calculate_rider_weekly_settlement(
  p_rider_id UUID,
  p_period_start TIMESTAMPTZ,
  p_period_end TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_settlement_id UUID;
  v_status TEXT := 'open';
  v_gross NUMERIC(12,2) := 0.00;
  v_base_rider NUMERIC(12,2) := 0.00;
  v_platform NUMERIC(12,2) := 0.00;
  v_consumables NUMERIC(12,2) := 0.00;
  v_credits NUMERIC(12,2) := 0.00;
  v_pos_adj NUMERIC(12,2) := 0.00;
  v_neg_adj NUMERIC(12,2) := 0.00;
  v_reversals NUMERIC(12,2) := 0.00;
  v_net NUMERIC(12,2) := 0.00;
  v_eligible NUMERIC(12,2) := 0.00;
  v_blocked NUMERIC(12,2) := 0.00;

  v_rec RECORD;
  v_is_covered BOOLEAN;
  v_item_funding TEXT;
  v_item_elig NUMERIC(12,2);
  v_item_block NUMERIC(12,2);
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  INSERT INTO public.rider_weekly_settlements (
    rider_id, period_start, period_end, status
  ) VALUES (
    p_rider_id, p_period_start, p_period_end, 'calculated'
  ) ON CONFLICT (rider_id, period_start, period_end) DO UPDATE
    SET calculated_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
  RETURNING id INTO v_settlement_id;

  -- 1. Processar Teles concluídas no período por completed_at
  FOR v_rec IN 
    SELECT rtx.id AS tx_id, rtx.tele_id, rtx.amount AS rider_earning, t.delivery_charge, t.client_id, t.completed_at
    FROM public.rider_financial_transactions rtx
    JOIN public.teles t ON t.id = rtx.tele_id
    WHERE rtx.rider_id = p_rider_id
      AND rtx.type = 'credito_entrega'
      AND t.completed_at >= p_period_start
      AND t.completed_at < p_period_end
  LOOP
    v_gross := v_gross + v_rec.delivery_charge;
    v_base_rider := v_base_rider + v_rec.rider_earning;
    v_platform := v_platform + (v_rec.delivery_charge - v_rec.rider_earning);

    SELECT COALESCE(is_fully_covered, false) INTO v_is_covered
    FROM public.client_payment_allocations
    WHERE tele_id = v_rec.tele_id
    LIMIT 1;

    IF v_rec.client_id IS NULL OR v_is_covered THEN
      v_item_funding := 'eligible';
      v_item_elig := v_rec.rider_earning;
      v_item_block := 0.00;
      v_eligible := v_eligible + v_rec.rider_earning;
    ELSE
      v_item_funding := 'blocked_client_unpaid';
      v_item_elig := 0.00;
      v_item_block := v_rec.rider_earning;
      v_blocked := v_blocked + v_rec.rider_earning;
    END IF;

    INSERT INTO public.rider_weekly_settlement_items (
      settlement_id, source_type, source_id, tele_id, client_id, original_amount, eligible_amount, blocked_amount, direction, funding_status, occurred_at, description
    ) VALUES (
      v_settlement_id, 'rider_earning', v_rec.tx_id, v_rec.tele_id, v_rec.client_id, v_rec.rider_earning, v_item_elig, v_item_block, 'credit', v_item_funding, v_rec.completed_at, 'Repasse Tele (85%)'
    ) ON CONFLICT (source_type, source_id) DO UPDATE
      SET funding_status = EXCLUDED.funding_status, eligible_amount = EXCLUDED.eligible_amount, blocked_amount = EXCLUDED.blocked_amount;
  END LOOP;

  -- 2. Processar Consumíveis por occurred_at
  FOR v_rec IN 
    SELECT id, amount, item_name, occurred_at 
    FROM public.rider_consumable_purchases
    WHERE motoboy_id = p_rider_id
      AND occurred_at >= p_period_start
      AND occurred_at < p_period_end
  LOOP
    v_consumables := v_consumables + v_rec.amount;
    INSERT INTO public.rider_weekly_settlement_items (
      settlement_id, source_type, source_id, original_amount, eligible_amount, direction, funding_status, occurred_at, description
    ) VALUES (
      v_settlement_id, 'consumable', v_rec.id, v_rec.amount, v_rec.amount, 'debit', 'eligible', v_rec.occurred_at, 'Consumível: ' || v_rec.item_name
    ) ON CONFLICT (source_type, source_id) DO NOTHING;
  END LOOP;

  -- 3. Processar Créditos por created_at
  FOR v_rec IN 
    SELECT id, amount, description, created_at
    FROM public.rider_credits_ledger
    WHERE motoboy_id = p_rider_id
      AND created_at >= p_period_start
      AND created_at < p_period_end
  LOOP
    v_credits := v_credits + v_rec.amount;
    INSERT INTO public.rider_weekly_settlement_items (
      settlement_id, source_type, source_id, original_amount, eligible_amount, direction, funding_status, occurred_at, description
    ) VALUES (
      v_settlement_id, 'credit', v_rec.id, v_rec.amount, v_rec.amount, 'credit', 'eligible', v_rec.created_at, 'Crédito: ' || v_rec.description
    ) ON CONFLICT (source_type, source_id) DO NOTHING;
  END LOOP;

  v_net := v_base_rider - v_consumables + v_credits + v_pos_adj - v_neg_adj - v_reversals;
  v_eligible := v_eligible - v_consumables + v_credits;
  IF v_eligible < 0 THEN v_eligible := 0.00; END IF;

  IF v_blocked > 0 THEN v_status := 'partially_blocked'; ELSE v_status := 'calculated'; END IF;

  UPDATE public.rider_weekly_settlements
  SET gross_delivery_amount = v_gross,
      base_rider_amount = v_base_rider,
      platform_amount = v_platform,
      consumables_amount = v_consumables,
      credits_amount = v_credits,
      net_amount = v_net,
      eligible_amount = v_eligible,
      blocked_amount = v_blocked,
      status = v_status,
      calculated_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_settlement_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'settlement_id', v_settlement_id,
    'gross', v_gross,
    'base_rider', v_base_rider,
    'platform', v_platform,
    'consumables', v_consumables,
    'credits', v_credits,
    'net', v_net,
    'eligible', v_eligible,
    'blocked', v_blocked,
    'status', v_status
  );
END;
$$;

-- 3. RPC admin_close_rider_weekly_settlement
CREATE OR REPLACE FUNCTION public.admin_close_rider_weekly_settlement(
  p_settlement_id UUID,
  p_expected_version INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_settlement RECORD;
  v_target_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  SELECT * INTO v_settlement FROM public.rider_weekly_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SETTLEMENT_NOT_FOUND', 'message', 'Fechamento não encontrado.');
  END IF;

  IF v_settlement.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'VERSION_CONFLICT', 'message', 'O fechamento foi modificado por outro operador.');
  END IF;

  IF v_settlement.blocked_amount > 0 THEN
    v_target_status := 'partially_blocked';
  ELSE
    v_target_status := 'pending';
  END IF;

  UPDATE public.rider_weekly_settlements
  SET status = v_target_status,
      closed_at = pg_catalog.clock_timestamp(),
      version = v_settlement.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_settlement_id;

  RETURN pg_catalog.jsonb_build_object('success', true, 'settlement_id', p_settlement_id, 'status', v_target_status, 'version', v_settlement.version + 1);
END;
$$;

-- 4. RPC admin_create_rider_payment_batch
CREATE OR REPLACE FUNCTION public.admin_create_rider_payment_batch(
  p_settlement_id UUID,
  p_expected_version INT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_settlement RECORD;
  v_batch_id UUID;
  v_item RECORD;
  v_count INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT id INTO v_batch_id FROM public.rider_payment_batches WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object('success', true, 'batch_id', v_batch_id, 'is_idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_settlement FROM public.rider_weekly_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SETTLEMENT_NOT_FOUND', 'message', 'Fechamento não encontrado.');
  END IF;

  IF v_settlement.eligible_amount <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'NO_ELIGIBLE_FUNDS', 'message', 'Não há valores elegíveis para pagamento neste fechamento.');
  END IF;

  INSERT INTO public.rider_payment_batches (
    rider_id, settlement_id, batch_type, total_paid_amount, status, idempotency_key
  ) VALUES (
    v_settlement.rider_id, p_settlement_id, 'regular_weekly', v_settlement.eligible_amount, 'pending', p_idempotency_key
  ) RETURNING id INTO v_batch_id;

  FOR v_item IN 
    SELECT id, eligible_amount 
    FROM public.rider_weekly_settlement_items 
    WHERE settlement_id = p_settlement_id AND funding_status = 'eligible' AND direction = 'credit'
    FOR UPDATE
  LOOP
    INSERT INTO public.rider_payment_batch_items (
      batch_id, settlement_item_id, amount_paid
    ) VALUES (
      v_batch_id, v_item.id, v_item.eligible_amount
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('success', true, 'batch_id', v_batch_id, 'total_amount', v_settlement.eligible_amount, 'items_count', v_count);
END;
$$;

-- 5. RPC admin_mark_rider_payment_batch_paid
CREATE OR REPLACE FUNCTION public.admin_mark_rider_payment_batch_paid(
  p_batch_id UUID,
  p_expected_version INT,
  p_payment_method TEXT DEFAULT 'PIX',
  p_payment_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_batch RECORD;
  v_settlement RECORD;
  v_target_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  SELECT * INTO v_batch FROM public.rider_payment_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'BATCH_NOT_FOUND', 'message', 'Lote de pagamento não encontrado.');
  END IF;

  IF v_batch.status = 'paid' THEN
    RETURN pg_catalog.jsonb_build_object('success', true, 'batch_id', p_batch_id, 'status', 'paid', 'is_idempotent', true);
  END IF;

  IF v_batch.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'VERSION_CONFLICT', 'message', 'Lote de pagamento foi alterado por outro operador.');
  END IF;

  UPDATE public.rider_payment_batches
  SET status = 'paid',
      paid_at = pg_catalog.clock_timestamp(),
      paid_by = v_user_id,
      payment_method = p_payment_method,
      payment_reference = p_payment_reference,
      notes = p_notes,
      version = v_batch.version + 1
  WHERE id = p_batch_id;

  UPDATE public.rider_weekly_settlement_items
  SET funding_status = 'paid', paid_amount = eligible_amount
  WHERE id IN (SELECT settlement_item_id FROM public.rider_payment_batch_items WHERE batch_id = p_batch_id);

  IF v_batch.settlement_id IS NOT NULL THEN
    SELECT * INTO v_settlement FROM public.rider_weekly_settlements WHERE id = v_batch.settlement_id FOR UPDATE;
    
    -- REGRA CRÍTICA: Se ainda houver blocked_amount > 0, o status do settlement permanece 'partially_blocked'!
    -- Somente fica 'paid' se blocked_amount = 0 e eligible_amount foi totalmente pago.
    IF v_settlement.blocked_amount > 0 THEN
      v_target_status := 'partially_blocked';
    ELSE
      v_target_status := 'paid';
    END IF;

    UPDATE public.rider_weekly_settlements
    SET paid_amount = paid_amount + v_batch.total_paid_amount,
        status = v_target_status,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_batch.settlement_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object('success', true, 'batch_id', p_batch_id, 'status', 'paid', 'paid_amount', v_batch.total_paid_amount);
END;
$$;

-- 6. RPC admin_reverse_rider_payment_batch
CREATE OR REPLACE FUNCTION public.admin_reverse_rider_payment_batch(
  p_batch_id UUID,
  p_expected_version INT,
  p_reason TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_batch RECORD;
  v_settlement RECORD;
  v_target_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'REASON_REQUIRED', 'message', 'Motivo do estorno é obrigatório.');
  END IF;

  SELECT * INTO v_batch FROM public.rider_payment_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'BATCH_NOT_FOUND', 'message', 'Lote de pagamento não encontrado.');
  END IF;

  IF v_batch.status = 'reversed' THEN
    RETURN pg_catalog.jsonb_build_object('success', true, 'batch_id', p_batch_id, 'status', 'reversed', 'is_idempotent', true);
  END IF;

  UPDATE public.rider_payment_batches
  SET status = 'reversed',
      notes = COALESCE(notes, '') || ' [ESTORNO: ' || p_reason || ']',
      version = v_batch.version + 1
  WHERE id = p_batch_id;

  UPDATE public.rider_weekly_settlement_items
  SET funding_status = 'eligible', paid_amount = 0.00
  WHERE id IN (SELECT settlement_item_id FROM public.rider_payment_batch_items WHERE batch_id = p_batch_id);

  IF v_batch.settlement_id IS NOT NULL THEN
    SELECT * INTO v_settlement FROM public.rider_weekly_settlements WHERE id = v_batch.settlement_id FOR UPDATE;
    
    IF v_settlement.blocked_amount > 0 THEN
      v_target_status := 'partially_blocked';
    ELSE
      v_target_status := 'pending';
    END IF;

    UPDATE public.rider_weekly_settlements
    SET paid_amount = GREATEST(0.00, paid_amount - v_batch.total_paid_amount),
        status = v_target_status,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_batch.settlement_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object('success', true, 'batch_id', p_batch_id, 'status', 'reversed');
END;
$$;

-- 7. RPC admin_reopen_rider_weekly_settlement (REABERTURA AUDITADA)
CREATE OR REPLACE FUNCTION public.admin_reopen_rider_weekly_settlement(
  p_settlement_id UUID,
  p_expected_version INT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_settlement RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'REASON_REQUIRED', 'message', 'Motivo da reabertura é obrigatório.');
  END IF;

  SELECT * INTO v_settlement FROM public.rider_weekly_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SETTLEMENT_NOT_FOUND', 'message', 'Fechamento não encontrado.');
  END IF;

  IF v_settlement.status = 'paid' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CANNOT_REOPEN_PAID', 'message', 'Fechamento já pago não pode ser reaberto sem estorno formal dos lotes.');
  END IF;

  IF v_settlement.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'VERSION_CONFLICT', 'message', 'O fechamento foi alterado por outro operador.');
  END IF;

  UPDATE public.rider_weekly_settlements
  SET status = 'open',
      version = v_settlement.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_settlement_id;

  RETURN pg_catalog.jsonb_build_object('success', true, 'settlement_id', p_settlement_id, 'status', 'open', 'version', v_settlement.version + 1);
END;
$$;

-- 8. RPC get_admin_rider_weekly_settlement (Consulta Sanitizada do Cabeçalho)
CREATE OR REPLACE FUNCTION public.get_admin_rider_weekly_settlement(
  p_settlement_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_settlement RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  SELECT * INTO v_settlement FROM public.rider_weekly_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SETTLEMENT_NOT_FOUND', 'message', 'Fechamento não encontrado.');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'settlement', pg_catalog.jsonb_build_object(
      'id', v_settlement.id,
      'rider_id', v_settlement.rider_id,
      'period_start', v_settlement.period_start,
      'period_end', v_settlement.period_end,
      'gross_delivery_amount', v_settlement.gross_delivery_amount,
      'base_rider_amount', v_settlement.base_rider_amount,
      'platform_amount', v_settlement.platform_amount,
      'consumables_amount', v_settlement.consumables_amount,
      'credits_amount', v_settlement.credits_amount,
      'net_amount', v_settlement.net_amount,
      'eligible_amount', v_settlement.eligible_amount,
      'blocked_amount', v_settlement.blocked_amount,
      'paid_amount', v_settlement.paid_amount,
      'status', v_settlement.status,
      'version', v_settlement.version,
      'created_at', v_settlement.created_at
    )
  );
END;
$$;

-- 9. RPC get_admin_rider_settlement_items (Consulta Sanitizada dos Itens)
CREATE OR REPLACE FUNCTION public.get_admin_rider_settlement_items(
  p_settlement_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_items JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', item.id,
      'source_type', item.source_type,
      'source_id', item.source_id,
      'tele_id', item.tele_id,
      'client_id', item.client_id,
      'original_amount', item.original_amount,
      'eligible_amount', item.eligible_amount,
      'blocked_amount', item.blocked_amount,
      'paid_amount', item.paid_amount,
      'direction', item.direction,
      'funding_status', item.funding_status,
      'occurred_at', item.occurred_at,
      'description', item.description
    ) ORDER BY item.occurred_at ASC
  ) INTO v_items
  FROM public.rider_weekly_settlement_items item
  WHERE item.settlement_id = p_settlement_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'settlement_id', p_settlement_id,
    'items', COALESCE(v_items, '[]'::jsonb)
  );
END;
$$;

-- 10. RPC get_my_rider_weekly_settlements (Dedicada ao PWA do Motoboy)
CREATE OR REPLACE FUNCTION public.get_my_rider_weekly_settlements(
  p_period_start TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_rider_id UUID;
  v_settlement RECORD;
  v_items JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT id INTO v_rider_id FROM public.fleet WHERE user_id = v_user_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não vinculado.');
  END IF;

  SELECT * INTO v_settlement 
  FROM public.rider_weekly_settlements 
  WHERE rider_id = v_rider_id 
    AND (p_period_start IS NULL OR period_start = p_period_start)
  ORDER BY period_start DESC 
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', true, 'has_settlement', false, 'settlement', NULL, 'items', '[]'::jsonb);
  END IF;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', item.id,
      'source_type', item.source_type,
      'tele_id', item.tele_id,
      'amount', item.original_amount,
      'eligible_amount', item.eligible_amount,
      'blocked_amount', item.blocked_amount,
      'direction', item.direction,
      'funding_status', item.funding_status,
      'occurred_at', item.occurred_at,
      'description', item.description
    ) ORDER BY item.occurred_at ASC
  ) INTO v_items
  FROM public.rider_weekly_settlement_items item
  WHERE item.settlement_id = v_settlement.id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'has_settlement', true,
    'settlement', pg_catalog.jsonb_build_object(
      'id', v_settlement.id,
      'period_start', v_settlement.period_start,
      'period_end', v_settlement.period_end,
      'gross_delivery_amount', v_settlement.gross_delivery_amount,
      'base_rider_amount', v_settlement.base_rider_amount,
      'consumables_amount', v_settlement.consumables_amount,
      'credits_amount', v_settlement.credits_amount,
      'net_amount', v_settlement.net_amount,
      'eligible_amount', v_settlement.eligible_amount,
      'blocked_amount', v_settlement.blocked_amount,
      'paid_amount', v_settlement.paid_amount,
      'status', v_settlement.status
    ),
    'items', COALESCE(v_items, '[]'::jsonb)
  );
END;
$$;

-- Permissões de Execução nas 9 RPCs + Consultas
REVOKE ALL ON FUNCTION public.admin_allocate_client_payment_to_teles(UUID, UUID[], NUMERIC[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_calculate_rider_weekly_settlement(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_close_rider_weekly_settlement(UUID, INT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_create_rider_payment_batch(UUID, INT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_mark_rider_payment_batch_paid(UUID, INT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reverse_rider_payment_batch(UUID, INT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reopen_rider_weekly_settlement(UUID, INT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_rider_weekly_settlement(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_rider_settlement_items(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_rider_weekly_settlements(TIMESTAMPTZ) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_allocate_client_payment_to_teles(UUID, UUID[], NUMERIC[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_calculate_rider_weekly_settlement(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_close_rider_weekly_settlement(UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_rider_payment_batch(UUID, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_mark_rider_payment_batch_paid(UUID, INT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reverse_rider_payment_batch(UUID, INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reopen_rider_weekly_settlement(UUID, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_rider_weekly_settlement(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_rider_settlement_items(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_rider_weekly_settlements(TIMESTAMPTZ) TO authenticated;
