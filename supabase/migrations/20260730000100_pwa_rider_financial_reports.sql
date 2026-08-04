-- =====================================================================
-- Dahora Expresso — Migration: Relatórios e Extrato Financeiro do Motoboy
-- Timestamp: 20260730000100
-- =====================================================================

-- 1. Triggers de sincronização para garantir rider_financial_transactions como ÚNICA fonte da verdade

-- Sync rider_consumable_purchases -> rider_financial_transactions
CREATE OR REPLACE FUNCTION public.trg_sync_consumable_to_rider_financial_tx()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.rider_financial_transactions
    WHERE idempotency_key = pg_catalog.format('consumable:%s:rider_debit:v1', OLD.id);
    RETURN OLD;
  ELSIF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
    IF NEW.motoboy_id IS NOT NULL AND NEW.amount > 0 THEN
      INSERT INTO public.rider_financial_transactions (
        rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at
      ) VALUES (
        NEW.motoboy_id, NULL, 'ajuste_debito', 'debit', NEW.amount,
        COALESCE(NEW.item_name, NEW.observacao, 'Consumível'),
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

DROP TRIGGER IF EXISTS trg_sync_consumable_to_financial_tx ON public.rider_consumable_purchases;
CREATE TRIGGER trg_sync_consumable_to_financial_tx
AFTER INSERT OR UPDATE OR DELETE ON public.rider_consumable_purchases
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_consumable_to_rider_financial_tx();

-- Sync rider_credits_ledger -> rider_financial_transactions
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

DROP TRIGGER IF EXISTS trg_sync_credits_to_financial_tx ON public.rider_credits_ledger;
CREATE TRIGGER trg_sync_credits_to_financial_tx
AFTER INSERT OR UPDATE OR DELETE ON public.rider_credits_ledger
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_credits_to_rider_financial_tx();

-- Backfill de consumíveis existentes se houver
INSERT INTO public.rider_financial_transactions (
  rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at
)
SELECT 
  c.motoboy_id, NULL, 'ajuste_debito', 'debit', c.amount,
  COALESCE(c.item_name, c.observacao, 'Consumível'),
  pg_catalog.format('consumable:%s:rider_debit:v1', c.id),
  c.created_at
FROM public.rider_consumable_purchases c
WHERE c.motoboy_id IS NOT NULL AND c.amount > 0
ON CONFLICT (idempotency_key) DO NOTHING;

-- Backfill de créditos existentes se houver
INSERT INTO public.rider_financial_transactions (
  rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at
)
SELECT 
  l.motoboy_id, NULL,
  CASE WHEN l.amount >= 0 THEN 'ajuste_credito' ELSE 'ajuste_debito' END,
  CASE WHEN l.amount >= 0 THEN 'credit' ELSE 'debit' END,
  ABS(l.amount),
  COALESCE(l.description, 'Crédito Administrativo'),
  pg_catalog.format('credit:%s:%s:v1', l.id, CASE WHEN l.amount >= 0 THEN 'rider_credit' ELSE 'rider_debit' END),
  l.created_at
FROM public.rider_credits_ledger l
WHERE l.motoboy_id IS NOT NULL AND l.amount <> 0
ON CONFLICT (idempotency_key) DO NOTHING;


-- 2. Função interna helper para cálculo da semana operacional (America/Sao_Paulo)
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
  v_isodow INT;
  v_days_back INT;
  v_start_tz TIMESTAMP;
  v_end_tz TIMESTAMP;
  v_payment_tz TIMESTAMP;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_next_reset TIMESTAMPTZ;
  v_next_payment TIMESTAMPTZ;
BEGIN
  v_ref_tz := p_reference_timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_isodow := EXTRACT(ISODOW FROM v_ref_tz); -- 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun

  IF v_isodow >= 3 THEN
    v_days_back := v_isodow - 3;
  ELSE
    v_days_back := v_isodow + 4;
  END IF;

  v_start_tz := date_trunc('day', v_ref_tz) - (v_days_back || ' days')::interval;
  v_end_tz := v_start_tz + interval '7 days';
  v_payment_tz := v_start_tz + interval '1 day'; -- Quinta-feira

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


-- 3. Função interna normalizada de lançamentos do motoboy
CREATE OR REPLACE FUNCTION public.get_rider_financial_entries_internal(
  p_rider_id UUID,
  p_period_start TIMESTAMPTZ,
  p_period_end_exclusive TIMESTAMPTZ
)
RETURNS TABLE (
  transaction_id UUID,
  rider_id UUID,
  tele_id UUID,
  tele_code TEXT,
  delivery_address_summary TEXT,
  source_type TEXT,
  transaction_category TEXT,
  direction TEXT,
  amount NUMERIC(12,2),
  description TEXT,
  transaction_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    r.id AS transaction_id,
    r.rider_id,
    r.tele_id,
    COALESCE(t.tele_code, CASE WHEN r.tele_id IS NOT NULL THEN SUBSTRING(r.tele_id::text FROM 1 FOR 8) ELSE NULL END) AS tele_code,
    COALESCE(t.delivery_address, '') AS delivery_address_summary,
    r.type AS source_type,
    CASE 
      WHEN r.type = 'credito_entrega' THEN 'delivery_earning'
      WHEN r.type = 'ajuste_credito' THEN 'credit'
      WHEN r.type = 'ajuste_debito' AND r.idempotency_key LIKE 'consumable:%' THEN 'consumable'
      WHEN r.type = 'ajuste_debito' THEN 'negative_adjustment'
      WHEN r.type = 'estorno' AND r.direction = 'credit' THEN 'refund'
      WHEN r.type = 'estorno' AND r.direction = 'debit' THEN 'other_discount'
      WHEN r.direction = 'credit' THEN 'positive_adjustment'
      ELSE 'other_discount'
    END AS transaction_category,
    r.direction,
    pg_catalog.round(r.amount, 2) AS amount,
    r.description,
    r.created_at AS transaction_at,
    r.created_at
  FROM public.rider_financial_transactions r
  LEFT JOIN public.teles t ON t.id = r.tele_id
  WHERE r.rider_id = p_rider_id
    AND r.created_at >= p_period_start
    AND r.created_at < p_period_end_exclusive;
END;
$$;

REVOKE ALL ON FUNCTION public.get_rider_financial_entries_internal(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_rider_financial_entries_internal(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.get_rider_financial_entries_internal(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;


-- 4. RPC segura: public.get_my_rider_financial_summary
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
  v_start_ts TIMESTAMPTZ;
  v_end_ts TIMESTAMPTZ;
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
    v_start_ts := v_week.period_start;
    v_end_ts := v_week.period_end_exclusive;
    v_period_label := 'Semana Operacional';
  ELSE
    IF p_start_date > p_end_date THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DATE_RANGE', 'message', 'A data inicial não pode ser posterior à data final.');
    END IF;

    IF (p_end_date - p_start_date) > 366 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'MAX_PERIOD_EXCEEDED', 'message', 'O período máximo de consulta é de 366 dias.');
    END IF;

    v_start_ts := (p_start_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo';
    v_end_ts := ((p_end_date + 1)::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo';
    
    SELECT * INTO v_week FROM public.get_rider_week_period_internal(pg_catalog.clock_timestamp());
    v_period_label := 'Período Personalizado';
  END IF;

  SELECT
    COALESCE(COUNT(DISTINCT tele_id) FILTER (WHERE transaction_category = 'delivery_earning' AND tele_id IS NOT NULL), 0)::INT,
    COALESCE(SUM(amount) FILTER (WHERE transaction_category = 'delivery_earning'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE transaction_category = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE transaction_category = 'positive_adjustment'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE transaction_category = 'consumable'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE transaction_category = 'negative_adjustment'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE transaction_category = 'refund'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE transaction_category = 'other_discount'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0.00),
    MAX(transaction_at)
  INTO
    v_completed_deliveries_count,
    v_delivery_earnings,
    v_credits_total,
    v_adjustments_positive_total,
    v_consumables_total,
    v_adjustments_negative_total,
    v_refunds_total,
    v_other_discounts_total,
    v_gross_total,
    v_deductions_total,
    v_last_transaction_at
  FROM public.get_rider_financial_entries_internal(v_fleet_id, v_start_ts, v_end_ts);

  v_net_total := pg_catalog.round((v_gross_total - v_deductions_total), 2);

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'period_start', v_start_ts,
    'period_end_exclusive', v_end_ts,
    'period_label', v_period_label,
    'completed_deliveries_count', v_completed_deliveries_count,
    'delivery_earnings', pg_catalog.round(v_delivery_earnings, 2),
    'credits_total', pg_catalog.round(v_credits_total, 2),
    'adjustments_positive_total', pg_catalog.round(v_adjustments_positive_total, 2),
    'consumables_total', pg_catalog.round(v_consumables_total, 2),
    'adjustments_negative_total', pg_catalog.round(v_adjustments_negative_total, 2),
    'refunds_total', pg_catalog.round(v_refunds_total, 2),
    'other_discounts_total', pg_catalog.round(v_other_discounts_total, 2),
    'gross_total', pg_catalog.round(v_gross_total, 2),
    'deductions_total', pg_catalog.round(v_deductions_total, 2),
    'net_total', v_net_total,
    'next_reset_at', v_week.next_reset_at,
    'next_payment_at', v_week.next_payment_at,
    'last_transaction_at', v_last_transaction_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) TO authenticated;


-- 5. RPC segura: public.get_my_rider_financial_statement
CREATE OR REPLACE FUNCTION public.get_my_rider_financial_statement(
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_offset INTEGER DEFAULT 0
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
  v_start_ts TIMESTAMPTZ;
  v_end_ts TIMESTAMPTZ;
  v_limit INT := p_limit;
  v_offset INT := p_offset;
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

  IF v_limit IS NULL OR v_limit < 1 THEN v_limit := 30; END IF;
  IF v_limit > 100 THEN v_limit := 100; END IF;
  IF v_offset IS NULL OR v_offset < 0 THEN v_offset := 0; END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    SELECT * INTO v_week FROM public.get_rider_week_period_internal(pg_catalog.clock_timestamp());
    v_start_ts := v_week.period_start;
    v_end_ts := v_week.period_end_exclusive;
  ELSE
    IF p_start_date > p_end_date THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DATE_RANGE', 'message', 'A data inicial não pode ser posterior à data final.');
    END IF;
    IF (p_end_date - p_start_date) > 366 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'MAX_PERIOD_EXCEEDED', 'message', 'O período máximo de consulta é de 366 dias.');
    END IF;

    v_start_ts := (p_start_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo';
    v_end_ts := ((p_end_date + 1)::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo';
  END IF;

  SELECT COUNT(*)::INT INTO v_total_count
  FROM public.get_rider_financial_entries_internal(v_fleet_id, v_start_ts, v_end_ts);

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'transaction_id', e.transaction_id,
      'source_type', e.source_type,
      'transaction_category', e.transaction_category,
      'direction', e.direction,
      'amount', e.amount,
      'description', e.description,
      'tele_id', e.tele_id,
      'tele_code', e.tele_code,
      'delivery_address_summary', e.delivery_address_summary,
      'transaction_at', e.transaction_at,
      'created_at', e.created_at
    )
  ), '[]'::jsonb) INTO v_items
  FROM (
    SELECT *
    FROM public.get_rider_financial_entries_internal(v_fleet_id, v_start_ts, v_end_ts)
    ORDER BY transaction_at DESC, created_at DESC, transaction_id DESC
    LIMIT v_limit OFFSET v_offset
  ) e;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'total_count', v_total_count,
    'limit', v_limit,
    'offset', v_offset,
    'has_more', (v_offset + v_limit < v_total_count),
    'items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INTEGER, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INTEGER, INTEGER) TO authenticated;
