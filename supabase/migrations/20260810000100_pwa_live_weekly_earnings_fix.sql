-- =====================================================================
-- Dahora Expresso — Additive Migration: PWA Live Weekly Earnings & Statement Fix
-- Timestamp: 20260810000100
-- File: supabase/migrations/20260810000100_pwa_live_weekly_earnings_fix.sql
-- =====================================================================

-- 1. Triggers de sincronização para garantir rider_financial_transactions como ÚNICA fonte da verdade
CREATE OR REPLACE FUNCTION public.trg_sync_consumables_to_rider_financial_tx()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.rider_financial_transactions
    WHERE idempotency_key LIKE pg_catalog.format('consumable:%s:%%', OLD.id);
    RETURN OLD;
  ELSIF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
    IF NEW.motoboy_id IS NOT NULL AND NEW.amount <> 0 THEN
      INSERT INTO public.rider_financial_transactions (
        rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at
      ) VALUES (
        NEW.motoboy_id, NULL, 'ajuste_debito', 'debit', ABS(NEW.amount),
        COALESCE(NEW.item_name, 'Consumível / Equipamento'),
        pg_catalog.format('consumable:%s:rider_debit:v1', NEW.id),
        NEW.created_at
      )
      ON CONFLICT (idempotency_key) DO UPDATE
      SET amount = EXCLUDED.amount,
          description = EXCLUDED.description;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_consumables_to_rider_financial_tx ON public.rider_consumable_purchases;
CREATE TRIGGER trg_sync_consumables_to_rider_financial_tx
AFTER INSERT OR UPDATE OR DELETE ON public.rider_consumable_purchases
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_consumables_to_rider_financial_tx();

CREATE OR REPLACE FUNCTION public.trg_sync_credits_to_rider_financial_tx()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.rider_financial_transactions
    WHERE idempotency_key LIKE pg_catalog.format('credit:%s:%%', OLD.id);
    RETURN OLD;
  ELSIF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
    IF NEW.motoboy_id IS NOT NULL AND NEW.amount <> 0 THEN
      IF NEW.amount > 0 THEN
        INSERT INTO public.rider_financial_transactions (
          rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at
        ) VALUES (
          NEW.motoboy_id, NULL, 'ajuste_credito', 'credit', NEW.amount,
          COALESCE(NEW.description, 'Crédito Administrativo'),
          pg_catalog.format('credit:%s:rider_credit:v1', NEW.id),
          NEW.created_at
        )
        ON CONFLICT (idempotency_key) DO UPDATE
        SET amount = EXCLUDED.amount,
            description = EXCLUDED.description;
      ELSE
        INSERT INTO public.rider_financial_transactions (
          rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at
        ) VALUES (
          NEW.motoboy_id, NULL, 'ajuste_debito', 'debit', ABS(NEW.amount),
          COALESCE(NEW.description, 'Débito Administrativo'),
          pg_catalog.format('credit:%s:rider_debit:v1', NEW.id),
          NEW.created_at
        )
        ON CONFLICT (idempotency_key) DO UPDATE
        SET amount = EXCLUDED.amount,
            description = EXCLUDED.description;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_credits_to_rider_financial_tx ON public.rider_credits_ledger;
CREATE TRIGGER trg_sync_credits_to_rider_financial_tx
AFTER INSERT OR UPDATE OR DELETE ON public.rider_credits_ledger
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_credits_to_rider_financial_tx();

-- 2. Atualizar RPC get_rider_week_period_internal para Regra Seg-Dom (Monday 00:00:00 -> Next Monday 00:00:00 Exclusive)
CREATE OR REPLACE FUNCTION public.get_rider_week_period_internal(
  p_reference_timestamp TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp()
)
RETURNS TABLE (
  period_start TIMESTAMPTZ,
  period_end_exclusive TIMESTAMPTZ,
  next_reset_at TIMESTAMPTZ,
  next_payment_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ref_tz TIMESTAMP;
  v_start_tz TIMESTAMP;
  v_end_tz TIMESTAMP;
  v_payment_tz TIMESTAMP;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_next_reset TIMESTAMPTZ;
  v_next_payment TIMESTAMPTZ;
BEGIN
  v_ref_tz := p_reference_timestamp AT TIME ZONE 'America/Sao_Paulo';
  
  -- date_trunc('week', ...) no Postgres trunca sempre para SEGUNDA-FEIRA 00:00:00
  v_start_tz := pg_catalog.date_trunc('week', v_ref_tz);
  v_end_tz := v_start_tz + interval '7 days'; -- Próxima segunda-feira 00:00:00 exclusivo
  v_payment_tz := v_start_tz + interval '9 days'; -- Quarta-feira da semana seguinte (payout)

  v_period_start := v_start_tz AT TIME ZONE 'America/Sao_Paulo';
  v_period_end := v_end_tz AT TIME ZONE 'America/Sao_Paulo';
  v_next_reset := v_period_end;
  v_next_payment := v_payment_tz AT TIME ZONE 'America/Sao_Paulo';

  RETURN QUERY SELECT v_period_start, v_period_end, v_next_reset, v_next_payment;
END;
$$;

REVOKE ALL ON FUNCTION public.get_rider_week_period_internal(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_rider_week_period_internal(TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.get_rider_week_period_internal(TIMESTAMPTZ) FROM authenticated;

-- 3. Atualizar RPC public.get_my_rider_financial_summary
CREATE OR REPLACE FUNCTION public.get_my_rider_financial_summary(
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_fleet_id UUID;
  v_week RECORD;
  v_start_date DATE;
  v_end_date DATE;
  v_period_label TEXT;
  
  v_completed_deliveries_count INT := 0;
  v_delivery_earnings NUMERIC(12,2) := 0.00;
  v_credits_total NUMERIC(12,2) := 0.00;
  v_adjustments_positive_total NUMERIC(12,2) := 0.00;
  v_consumables_total NUMERIC(12,2) := 0.00;
  v_adjustments_negative_total NUMERIC(12,2) := 0.00;
  v_refunds_total NUMERIC(12,2) := 0.00;
  v_other_discounts_total NUMERIC(12,2) := 0.00;
  v_gross_total NUMERIC(12,2) := 0.00;
  v_deductions_total NUMERIC(12,2) := 0.00;
  v_net_total NUMERIC(12,2) := 0.00;
  v_last_transaction_at TIMESTAMPTZ := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT f.id INTO v_fleet_id FROM public.fleet f WHERE f.user_id = v_user_id;
  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não encontrado.');
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    SELECT * INTO v_week FROM public.get_rider_week_period_internal(pg_catalog.clock_timestamp());
    v_start_date := (v_week.period_start AT TIME ZONE 'America/Sao_Paulo')::date;
    v_end_date := (v_week.period_end_exclusive AT TIME ZONE 'America/Sao_Paulo')::date - 1;
    v_period_label := 'Semana Operacional';
  ELSE
    IF p_start_date > p_end_date THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DATE_RANGE', 'message', 'A data inicial não pode ser posterior à data final.');
    END IF;
    IF (p_end_date - p_start_date) > 366 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'MAX_PERIOD_EXCEEDED', 'message', 'O período máximo de consulta é de 366 dias.');
    END IF;
    v_start_date := p_start_date;
    v_end_date := p_end_date;
    v_period_label := 'Período Personalizado';
  END IF;

  SELECT
    COALESCE(COUNT(DISTINCT tele_id) FILTER (WHERE (type IN ('credito_entrega', 'CREDIT_TELE')) AND tele_id IS NOT NULL), 0)::INT,
    COALESCE(SUM(amount) FILTER (WHERE type IN ('credito_entrega', 'CREDIT_TELE')), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type IN ('ajuste_credito', 'CREDIT_BONUS') AND LOWER(direction) = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'estorno' AND LOWER(direction) = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type IN ('ajuste_debito', 'DEBIT_CONSUMABLE') AND LOWER(direction) = 'debit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'estorno' AND LOWER(direction) = 'debit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE LOWER(direction) = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE LOWER(direction) = 'debit'), 0.00),
    MAX(created_at)
  INTO
    v_completed_deliveries_count,
    v_delivery_earnings,
    v_credits_total,
    v_adjustments_positive_total,
    v_consumables_total,
    v_adjustments_negative_total,
    v_gross_total,
    v_deductions_total,
    v_last_transaction_at
  FROM public.rider_financial_transactions
  WHERE rider_id = v_fleet_id
    AND competency_date >= v_start_date
    AND competency_date <= v_end_date;

  v_net_total := v_gross_total - v_deductions_total;

  SELECT * INTO v_week FROM public.get_rider_week_period_internal(pg_catalog.clock_timestamp());

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'period_label', v_period_label,
    'period_start', v_start_date,
    'period_end', v_end_date,
    'next_payment_at', v_week.next_payment_at,
    'next_reset_at', v_week.period_end_exclusive,
    'completed_deliveries_count', v_completed_deliveries_count,
    'delivery_earnings', v_delivery_earnings,
    'credits_total', (v_credits_total + v_adjustments_positive_total),
    'credits_display_total', (v_credits_total + v_adjustments_positive_total),
    'adjustments_positive_total', v_adjustments_positive_total,
    'consumables_total', v_consumables_total,
    'adjustments_negative_total', v_adjustments_negative_total,
    'refunds_total', 0.00,
    'other_discounts_total', 0.00,
    'gross_total', v_gross_total,
    'deductions_total', v_deductions_total,
    'deductions_display_total', v_deductions_total,
    'net_total', v_net_total,
    'last_transaction_at', v_last_transaction_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) TO authenticated;

-- 4. Atualizar RPC public.get_my_rider_financial_statement com sanitização de títulos e descrições
CREATE OR REPLACE FUNCTION public.get_my_rider_financial_statement(
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL,
  p_limit INT DEFAULT 30,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_fleet_id UUID;
  v_week RECORD;
  v_start_date DATE;
  v_end_date DATE;
  v_limit INT;
  v_offset INT;
  v_total_count INT := 0;
  v_items JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT f.id INTO v_fleet_id FROM public.fleet f WHERE f.user_id = v_user_id;
  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não encontrado.');
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    SELECT * INTO v_week FROM public.get_rider_week_period_internal(pg_catalog.clock_timestamp());
    v_start_date := (v_week.period_start AT TIME ZONE 'America/Sao_Paulo')::date;
    v_end_date := (v_week.period_end_exclusive AT TIME ZONE 'America/Sao_Paulo')::date - 1;
  ELSE
    v_start_date := p_start_date;
    v_end_date := p_end_date;
  END IF;

  v_limit := COALESCE(p_limit, 30);
  IF v_limit < 1 THEN v_limit := 30; END IF;
  IF v_limit > 100 THEN v_limit := 100; END IF;

  v_offset := COALESCE(p_offset, 0);
  IF v_offset < 0 THEN v_offset := 0; END IF;

  SELECT COUNT(*) INTO v_total_count
  FROM public.rider_financial_transactions
  WHERE rider_id = v_fleet_id
    AND competency_date >= v_start_date
    AND competency_date <= v_end_date;

  SELECT COALESCE(pg_catalog.jsonb_agg(stmt.item_row), '[]'::jsonb) INTO v_items
  FROM (
    SELECT pg_catalog.jsonb_build_object(
      'id', r.id,
      'transaction_id', r.id,
      'tele_id', r.tele_id,
      'tele_code', COALESCE(t.tele_code, CASE WHEN r.tele_id IS NOT NULL THEN pg_catalog.concat('TEL-', pg_catalog.substr(r.tele_id::text, 1, 8)) ELSE NULL END),
      'type', r.type,
      'direction', r.direction,
      'amount', pg_catalog.round(r.amount, 2),
      'description', r.description,
      'title', CASE 
        WHEN t.tele_code IS NOT NULL THEN t.tele_code 
        WHEN r.tele_id IS NOT NULL THEN pg_catalog.concat('TEL-', pg_catalog.substr(r.tele_id::text, 1, 8)) 
        ELSE COALESCE(r.description, 'Lançamento Financeiro') 
      END,
      'sanitized_description', CASE 
        WHEN r.type IN ('credito_entrega', 'CREDIT_TELE') THEN 'Entrega concluída' 
        ELSE pg_catalog.btrim(pg_catalog.regexp_replace(COALESCE(r.description, 'Lançamento Financeiro'), '#[0-9a-fA-F-]{36}', '', 'g'))
      END,
      'competency_date', r.competency_date,
      'created_at', r.created_at,
      'transaction_category', CASE
        WHEN r.type IN ('credito_entrega', 'CREDIT_TELE') THEN 'delivery_earning'
        WHEN (r.type IN ('ajuste_credito', 'CREDIT_BONUS') AND r.idempotency_key LIKE 'credit:%') THEN 'credit'
        WHEN r.type IN ('ajuste_credito', 'CREDIT_BONUS') THEN 'positive_adjustment'
        WHEN (r.type IN ('ajuste_debito', 'DEBIT_CONSUMABLE') AND r.idempotency_key LIKE 'consumable:%') THEN 'consumable'
        WHEN r.type IN ('ajuste_debito', 'DEBIT_PENALTY') THEN 'negative_adjustment'
        WHEN r.type = 'estorno' AND LOWER(r.direction) = 'credit' THEN 'positive_adjustment'
        WHEN r.type = 'estorno' AND LOWER(r.direction) = 'debit' THEN 'negative_adjustment'
        ELSE 'other_discount'
      END
    ) AS item_row
    FROM public.rider_financial_transactions r
    LEFT JOIN public.teles t ON t.id = r.tele_id
    WHERE r.rider_id = v_fleet_id
      AND r.competency_date >= v_start_date
      AND r.competency_date <= v_end_date
    ORDER BY r.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) stmt;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'total_count', v_total_count,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INT, INT) TO authenticated;
