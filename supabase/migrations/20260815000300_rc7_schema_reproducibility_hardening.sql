-- =====================================================================
-- Dahora Expresso — Migration de Reprodutibilidade do Schema (Gate RC.7.1)
-- File: supabase/migrations/20260815000300_rc7_schema_reproducibility_hardening.sql
-- =====================================================================

-- 1. DROPAR ASSINATURAS SOBRECARREGADAS LEGADAS
DROP FUNCTION IF EXISTS public.list_admin_rider_weekly_settlements(date, uuid, text, uuid, integer, integer, text);

-- 2. ADICIONAR COLUNAS REQUERIDAS (IF NOT EXISTS)
ALTER TABLE public.rider_weekly_settlements ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS settlement_id UUID REFERENCES public.rider_weekly_settlements(id) ON DELETE CASCADE;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS batch_type TEXT DEFAULT 'weekly_settlement';
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS total_paid_amount NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS paid_by UUID;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS reversed_by UUID;
ALTER TABLE public.rider_payment_batches ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

ALTER TABLE public.rider_payment_batch_items ADD COLUMN IF NOT EXISTS settlement_item_id UUID;
ALTER TABLE public.rider_payment_batch_items ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10,2) DEFAULT 0.00;

ALTER TABLE public.rider_weekly_settlement_items ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.rider_consumable_purchases ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ DEFAULT NOW();

-- 3. ADICIONAR CONSTRAINTS ÚNICAS CANÔNICAS
ALTER TABLE public.rider_weekly_settlement_items DROP CONSTRAINT IF EXISTS rider_weekly_settlement_items_unique_key;
ALTER TABLE public.rider_weekly_settlement_items ADD CONSTRAINT rider_weekly_settlement_items_unique_key UNIQUE (settlement_id, source_type, source_id);

ALTER TABLE public.rider_weekly_settlement_items DROP CONSTRAINT IF EXISTS rider_weekly_settlement_items_source_key;
ALTER TABLE public.rider_weekly_settlement_items ADD CONSTRAINT rider_weekly_settlement_items_source_key UNIQUE (source_type, source_id);

ALTER TABLE public.client_payment_allocations DROP CONSTRAINT IF EXISTS client_payment_allocations_tx_tele_key;
ALTER TABLE public.client_payment_allocations ADD CONSTRAINT client_payment_allocations_tx_tele_key UNIQUE (client_transaction_id, tele_id);

-- 4. FUNCTION E TRIGGER DE PREVENÇÃO DE DUPLO PAGAMENTO (ensure_batch_item_cap)
CREATE OR REPLACE FUNCTION public.ensure_batch_item_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_already_paid NUMERIC(12,2) := 0.00;
  v_current_eligible NUMERIC(12,2) := 0.00;
  v_original_amount NUMERIC(12,2) := 0.00;
BEGIN
  SELECT eligible_amount, original_amount INTO v_current_eligible, v_original_amount
  FROM public.rider_weekly_settlement_items
  WHERE id = NEW.settlement_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NOT_FOUND: Item de fechamento % não encontrado.', NEW.settlement_item_id;
  END IF;

  SELECT COALESCE(SUM(pbi.amount_paid), 0.00) INTO v_already_paid
  FROM public.rider_payment_batch_items pbi
  JOIN public.rider_payment_batches pb ON pb.id = pbi.batch_id
  WHERE pbi.settlement_item_id = NEW.settlement_item_id
    AND pb.status <> 'reversed'
    AND pbi.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF (v_already_paid + NEW.amount_paid) > v_current_eligible THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT_DENIED: Tentativa de pagar R$ % para um item com R$ % elegíveis liberados (já pago: R$ %).',
      NEW.amount_paid, v_current_eligible, v_already_paid;
  END IF;

  IF (v_already_paid + NEW.amount_paid) > v_original_amount THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT_DENIED: Tentativa de pagar R$ % excedendo o valor original total do item (R$ %).',
      NEW.amount_paid, v_original_amount;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_double_item_payment ON public.rider_payment_batch_items;
CREATE TRIGGER trg_prevent_double_item_payment
  BEFORE INSERT OR UPDATE ON public.rider_payment_batch_items
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_batch_item_cap();

-- 5. ATUALIZAÇÃO DE RPCS CANÔNICAS
CREATE OR REPLACE FUNCTION public.admin_calculate_rider_weekly_settlement(
  p_rider_id UUID,
  p_period_start TIMESTAMPTZ DEFAULT NULL,
  p_period_end TIMESTAMPTZ DEFAULT NULL
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
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado.');
  END IF;

  v_start := COALESCE(p_period_start, date_trunc('week', NOW()));
  v_end := COALESCE(p_period_end, v_start + interval '7 days');

  INSERT INTO public.rider_weekly_settlements (
    rider_id, period_start, period_end, status
  ) VALUES (
    p_rider_id, v_start, v_end, 'calculated'
  ) ON CONFLICT (rider_id, period_start, period_end) DO UPDATE
    SET calculated_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
  RETURNING id INTO v_settlement_id;

  -- 1. Processar Teles concluídas no período por completed_at
  FOR v_rec IN 
    SELECT rtx.id AS tx_id, rtx.tele_id, rtx.amount AS rider_earning, COALESCE(t.delivery_charge, t.total_order_amount, 15.00) AS delivery_charge, t.client_id, t.completed_at, c.is_internal
    FROM public.rider_financial_transactions rtx
    JOIN public.teles t ON t.id = rtx.tele_id
    LEFT JOIN public.commercial_clients c ON c.id = t.client_id
    WHERE rtx.rider_id = p_rider_id
      AND rtx.type = 'credito_entrega'
      AND t.completed_at >= v_start
      AND t.completed_at < v_end
  LOOP
    v_gross := v_gross + v_rec.delivery_charge;
    v_base_rider := v_base_rider + v_rec.rider_earning;
    v_platform := v_platform + (v_rec.delivery_charge - v_rec.rider_earning);

    SELECT COALESCE(is_fully_covered, false) INTO v_is_covered
    FROM public.client_payment_allocations
    WHERE tele_id = v_rec.tele_id
    LIMIT 1;

    IF v_rec.client_id IS NULL OR COALESCE(v_rec.is_internal, false) IS TRUE OR v_is_covered THEN
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
      AND occurred_at >= v_start
      AND occurred_at < v_end
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
      AND created_at >= v_start
      AND created_at < v_end
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
      version = version + 1,
      calculated_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_settlement_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'settlement_id', v_settlement_id,
    'gross', v_gross,
    'base_rider', v_base_rider,
    'platform', v_platform,
    'net', v_net,
    'eligible', v_eligible,
    'blocked', v_blocked,
    'status', v_status
  );
END;
$$;

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

    SELECT COALESCE(delivery_charge, total_order_amount, 15.00) INTO v_tele_charge FROM public.teles WHERE id = v_tele_id;
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

CREATE OR REPLACE FUNCTION public.admin_mark_rider_payment_batch_paid(
  p_batch_id UUID,
  p_expected_version INT,
  p_payment_method TEXT,
  p_payment_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
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
  SET funding_status = 'eligible', paid_amount = eligible_amount
  WHERE id IN (SELECT settlement_item_id::uuid FROM public.rider_payment_batch_items WHERE batch_id = p_batch_id);

  IF v_batch.settlement_id IS NOT NULL THEN
    SELECT * INTO v_settlement FROM public.rider_weekly_settlements WHERE id = v_batch.settlement_id FOR UPDATE;
    
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

CREATE OR REPLACE FUNCTION public.get_admin_rider_weekly_settlement_detail(
  p_settlement_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_exists BOOLEAN;
  v_settlement JSONB;
  v_summary JSONB;
  v_items JSONB;
  v_batches JSONB;
  v_latest_payment JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado. Requer perfil administrativo.');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.rider_weekly_settlements WHERE id = p_settlement_id) INTO v_exists;

  IF NOT v_exists THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SETTLEMENT_NOT_FOUND', 'message', 'Fechamento não encontrado.');
  END IF;

  SELECT jsonb_build_object(
    'id', s.id,
    'rider_id', s.rider_id,
    'rider_name', COALESCE(f.name, 'Motoboy Desconhecido'),
    'rider_code', COALESCE(f.user_id::text, 'MOTO-UNK'),
    'period_start', s.period_start,
    'period_end', s.period_end,
    'status', s.status,
    'status_label', CASE s.status
      WHEN 'open' THEN 'Em andamento'
      WHEN 'calculated' THEN 'Calculado'
      WHEN 'pending' THEN 'Pendente'
      WHEN 'partially_blocked' THEN 'Parcialmente bloqueado'
      WHEN 'paid' THEN 'Pago'
      WHEN 'reopened' THEN 'Reaberto'
      WHEN 'reversed' THEN 'Pagamento estornado'
      WHEN 'cancelled' THEN 'Cancelado'
      ELSE s.status
    END,
    'version', s.version,
    'created_at', s.created_at,
    'updated_at', s.updated_at
  ) INTO v_settlement
  FROM public.rider_weekly_settlements s
  LEFT JOIN public.fleet f ON f.id = s.rider_id::text
  WHERE s.id = p_settlement_id;

  SELECT jsonb_build_object(
    'gross_delivery_amount', s.gross_delivery_amount,
    'base_rider_amount', s.base_rider_amount,
    'platform_amount', s.platform_amount,
    'consumables_amount', s.consumables_amount,
    'credits_amount', s.credits_amount,
    'positive_adjustments_amount', s.positive_adjustments_amount,
    'negative_adjustments_amount', s.negative_adjustments_amount,
    'reversals_amount', s.reversals_amount,
    'net_amount', s.net_amount,
    'eligible_amount', s.eligible_amount,
    'blocked_amount', s.blocked_amount,
    'paid_amount', s.paid_amount,
    'unpaid_eligible_amount', GREATEST(0.00, s.eligible_amount - s.paid_amount)
  ) INTO v_summary
  FROM public.rider_weekly_settlements s
  WHERE s.id = p_settlement_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'source_type', i.source_type,
        'source_id', i.source_id,
        'tele_id', i.tele_id,
        'tele_code', COALESCE(t.codigo::text, 'TEL-UNK'),
        'client_id', i.client_id,
        'client_name', COALESCE(c.establishment_name, 'Cliente Comercial'),
        'original_amount', i.original_amount,
        'eligible_amount', i.eligible_amount,
        'blocked_amount', i.blocked_amount,
        'paid_amount', i.paid_amount,
        'unpaid_eligible_amount', GREATEST(0.00, i.eligible_amount - i.paid_amount),
        'remaining_amount', GREATEST(0.00, i.eligible_amount - i.paid_amount),
        'unexplained_difference', GREATEST(0.00, i.original_amount - (i.paid_amount + GREATEST(0.00, i.eligible_amount - i.paid_amount) + i.blocked_amount)),
        'direction', i.direction,
        'funding_status', i.funding_status,
        'funding_status_label', CASE 
          WHEN i.funding_status = 'eligible' AND i.blocked_amount > 0 AND i.eligible_amount > 0 THEN 'Parcialmente liberado'
          WHEN i.funding_status = 'eligible' THEN 'Liberado para pagamento'
          WHEN i.funding_status = 'blocked_client_unpaid' THEN 'Aguardando recebimento do cliente'
          WHEN i.funding_status = 'paid' THEN 'Pago'
          WHEN i.funding_status = 'reversed' THEN 'Estornado'
          ELSE i.funding_status
        END,
        'occurred_at', i.occurred_at,
        'description', i.description
      ) ORDER BY i.occurred_at ASC, i.id ASC
    ), '[]'::jsonb
  ) INTO v_items
  FROM public.rider_weekly_settlement_items i
  LEFT JOIN public.teles t ON t.id = i.tele_id
  LEFT JOIN public.commercial_clients c ON c.id = i.client_id
  WHERE i.settlement_id = p_settlement_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', b.id,
        'batch_type', b.batch_type,
        'batch_type_label', CASE b.batch_type
          WHEN 'regular_weekly' THEN 'Lote Semanal Regular'
          WHEN 'complementary_release' THEN 'Lote de Liberação Complementar'
          ELSE b.batch_type
        END,
        'total_paid_amount', b.total_paid_amount,
        'status', b.status,
        'status_label', CASE b.status
          WHEN 'draft' THEN 'Rascunho'
          WHEN 'pending' THEN 'Pendente'
          WHEN 'paid' THEN 'Pago'
          WHEN 'reversed' THEN 'Estornado'
          ELSE b.status
        END,
        'payment_method', b.payment_method,
        'payment_reference', b.payment_reference,
        'notes', b.notes,
        'paid_at', CASE WHEN b.status = 'paid' THEN b.paid_at ELSE NULL END,
        'paid_by_name', u.email,
        'version', b.version,
        'created_at', b.created_at,
        'reversed_at', CASE 
          WHEN b.status = 'reversed' THEN b.paid_at
          ELSE NULL 
        END,
        'reversal_reason', CASE 
          WHEN b.status = 'reversed' AND b.notes LIKE 'ESTORNO:%' THEN substring(b.notes from 10)
          WHEN b.status = 'reversed' AND b.notes IS NOT NULL AND b.notes <> '' AND b.notes NOT LIKE 'ESTORNO:%' THEN NULL
          ELSE NULL 
        END,
        'integrity_status', CASE
          WHEN b.status = 'paid' AND b.paid_at IS NULL THEN 'missing_paid_at'
          WHEN b.status = 'reversed' AND b.paid_at IS NULL AND b.notes NOT LIKE 'ESTORNO:%' THEN 'missing_reversal_timestamp'
          WHEN b.status = 'reversed' AND (b.notes IS NULL OR b.notes = '' OR b.notes NOT LIKE 'ESTORNO:%') THEN 'missing_reversal_reason'
          ELSE 'valid'
        END
      ) ORDER BY b.created_at DESC
    ), '[]'::jsonb
  ) INTO v_batches
  FROM public.rider_payment_batches b
  LEFT JOIN auth.users u ON u.id = b.paid_by
  WHERE b.settlement_id = p_settlement_id;

  SELECT jsonb_build_object(
    'batch_id', b.id,
    'paid_at', b.paid_at,
    'total_paid_amount', b.total_paid_amount,
    'payment_method', b.payment_method,
    'payment_reference', b.payment_reference
  ) INTO v_latest_payment
  FROM public.rider_payment_batches b
  WHERE b.settlement_id = p_settlement_id 
    AND b.status = 'paid' 
    AND b.paid_at IS NOT NULL
  ORDER BY b.paid_at DESC, b.id DESC
  LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'settlement', v_settlement,
    'summary', v_summary,
    'items', v_items,
    'batches', v_batches,
    'latest_payment', v_latest_payment
  );
END;
$$;

-- 6. PERMISSÕES E POLÍTICAS RLS AUTORITATIVAS
GRANT ALL ON public.rider_weekly_settlements TO authenticated;
GRANT ALL ON public.rider_weekly_settlement_items TO authenticated;
GRANT ALL ON public.rider_payment_batches TO authenticated;
GRANT ALL ON public.rider_payment_batch_items TO authenticated;

ALTER TABLE public.rider_weekly_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_weekly_settlement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_payment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_payment_batch_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rider_weekly_settlements_admin_write ON public.rider_weekly_settlements;
CREATE POLICY rider_weekly_settlements_admin_write ON public.rider_weekly_settlements FOR ALL TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

DROP POLICY IF EXISTS rider_weekly_settlement_items_admin_write ON public.rider_weekly_settlement_items;
CREATE POLICY rider_weekly_settlement_items_admin_write ON public.rider_weekly_settlement_items FOR ALL TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

DROP POLICY IF EXISTS rider_payment_batches_admin_write ON public.rider_payment_batches;
CREATE POLICY rider_payment_batches_admin_write ON public.rider_payment_batches FOR ALL TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

DROP POLICY IF EXISTS rider_payment_batch_items_admin_write ON public.rider_payment_batch_items;
CREATE POLICY rider_payment_batch_items_admin_write ON public.rider_payment_batch_items FOR ALL TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());
