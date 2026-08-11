-- =====================================================================
-- Dahora Expresso — Migration 20260810190000
-- Elegibilidade Autoritativa para Cliente Comercial Interno (is_internal = true)
-- =====================================================================

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
    SELECT rtx.id AS tx_id, rtx.tele_id, rtx.amount AS rider_earning, t.delivery_charge, t.client_id, t.completed_at, c.is_internal
    FROM public.rider_financial_transactions rtx
    JOIN public.teles t ON t.id = rtx.tele_id
    LEFT JOIN public.commercial_clients c ON c.id = t.client_id
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

    -- REGRA CANÔNICA DE ELEGIBILIDADE:
    -- Teles avulsas (client_id IS NULL), Teles de clientes internos (is_internal = true)
    -- ou Teles com liquidação coberta pelo cliente (v_is_covered = true) são ELEGÍVEIS.
    -- Teles de clientes externos não liquidadas são BLOQUEADAS.
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

REVOKE ALL ON FUNCTION public.admin_calculate_rider_weekly_settlement(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_calculate_rider_weekly_settlement(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
