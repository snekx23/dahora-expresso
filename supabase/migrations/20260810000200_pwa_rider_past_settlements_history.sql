-- =====================================================================
-- Dahora Expresso — Additive Migration 20260810000200
-- Bloque Financeiro 2: Histórico de Repasses Semanais Anteriores do Motoboy (Pendente / Pago)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_my_rider_weekly_settlements_history()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_fleet_id UUID;
  v_current_week_start DATE;
  v_history JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT f.id INTO v_fleet_id FROM public.fleet f WHERE f.user_id = v_user_id;
  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não encontrado.');
  END IF;

  -- Calcular o início da semana atual (Segunda-feira 00:00:00 no fuso America/Sao_Paulo)
  v_current_week_start := (pg_catalog.date_trunc('week', pg_catalog.clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'))::date;

  -- Agregar semanas encerradas anteriores a v_current_week_start
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', s.id,
        'period_start', s.period_start,
        'period_end', s.period_end,
        'period_label', pg_catalog.concat(
          pg_catalog.to_char(s.period_start, 'DD/MM'), 
          ' – ', 
          pg_catalog.to_char(s.period_end, 'DD/MM/YYYY')
        ),
        'net_amount', pg_catalog.round(s.net_amount, 2),
        'deliveries_count', s.deliveries_count,
        'status', s.status,
        'status_label', CASE s.status
          WHEN 'paid' THEN 'Pago'
          WHEN 'pending' THEN 'Pendente'
          WHEN 'calculated' THEN 'Pendente'
          WHEN 'open' THEN 'Pendente'
          WHEN 'partially_blocked' THEN 'Parcialmente Bloqueado'
          WHEN 'reopened' THEN 'Reaberto para Revisão'
          WHEN 'reversed' THEN 'Estornado'
          WHEN 'cancelled' THEN 'Cancelado'
          ELSE 'Pendente'
        END,
        'paid_at', s.paid_at
      ) ORDER BY s.period_start DESC
    ),
    '[]'::jsonb
  ) INTO v_history
  FROM (
    -- 1. Semanas encerradas com registro autoritativo em rider_weekly_settlements
    SELECT 
      ws.id,
      ws.period_start::date AS period_start,
      (ws.period_end::date) AS period_end,
      COALESCE(ws.net_amount, 0.00) AS net_amount,
      COALESCE((
        SELECT COUNT(DISTINCT item.tele_id)::int 
        FROM public.rider_weekly_settlement_items item 
        WHERE item.settlement_id = ws.id AND item.tele_id IS NOT NULL
      ), 0) AS deliveries_count,
      ws.status,
      COALESCE(pb.paid_at, CASE WHEN ws.status = 'paid' THEN ws.updated_at ELSE NULL END) AS paid_at
    FROM public.rider_weekly_settlements ws
    LEFT JOIN public.rider_payment_batches pb ON pb.settlement_id = ws.id AND pb.status = 'paid'
    WHERE ws.rider_id = v_fleet_id
      AND ws.period_start::date < v_current_week_start

    UNION ALL

    -- 2. Semanas encerradas com lançamentos no ledger vivo que ainda não possuem linha em rider_weekly_settlements
    SELECT 
      NULL::uuid AS id,
      (pg_catalog.date_trunc('week', tx.competency_date))::date AS period_start,
      ((pg_catalog.date_trunc('week', tx.competency_date))::date + 6) AS period_end,
      SUM(CASE WHEN LOWER(tx.direction) = 'credit' THEN tx.amount ELSE -tx.amount END) AS net_amount,
      COUNT(DISTINCT tx.tele_id) FILTER (WHERE tx.type IN ('credito_entrega', 'CREDIT_TELE') AND tx.tele_id IS NOT NULL)::int AS deliveries_count,
      'pending'::text AS status,
      NULL::timestamptz AS paid_at
    FROM public.rider_financial_transactions tx
    WHERE tx.rider_id = v_fleet_id
      AND tx.competency_date < v_current_week_start
      AND NOT EXISTS (
        SELECT 1 FROM public.rider_weekly_settlements ws2 
        WHERE ws2.rider_id = v_fleet_id 
          AND ws2.period_start::date = (pg_catalog.date_trunc('week', tx.competency_date))::date
      )
    GROUP BY (pg_catalog.date_trunc('week', tx.competency_date))::date
  ) s;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'history', COALESCE(v_history, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_rider_weekly_settlements_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_weekly_settlements_history() TO authenticated;
