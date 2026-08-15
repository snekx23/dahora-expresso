-- =====================================================================
-- Dahora Expresso — Migration Corretiva Aditiva (Gate RC.11.4)
-- File: supabase/migrations/20260815000400_restore_admin_rider_weekly_settlements.sql
-- Restauração Autoritativa da RPC list_admin_rider_weekly_settlements
-- =====================================================================

-- 1. LIMPAR ASSINATURAS ANTERIORES PARA EVITAR OVERLOAD AMBÍGUO (PGRST203)
DROP FUNCTION IF EXISTS public.list_admin_rider_weekly_settlements(date, uuid, text, uuid, integer, integer, text);
DROP FUNCTION IF EXISTS public.list_admin_rider_weekly_settlements(timestamptz, uuid, text, uuid, integer, integer);

-- 2. CRIAR ASSINATURA CANÔNICA COMPATÍVEL COM O FRONTEND E MULTI-TENANT
CREATE OR REPLACE FUNCTION public.list_admin_rider_weekly_settlements(
  p_period_start DATE DEFAULT NULL,
  p_workspace_id UUID DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_rider_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_period_shortcut TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_limit INT;
  v_offset INT;
  v_ref_date DATE;
  v_trunc_date DATE;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_total_count INT := 0;
  v_settlements JSONB := '[]'::jsonb;
BEGIN
  -- Autorização básica
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado. Requer perfil administrativo.');
  END IF;

  -- Sanitizar limitação e paginação
  v_limit := COALESCE(p_limit, 50);
  IF v_limit < 1 THEN v_limit := 1; END IF;
  IF v_limit > 100 THEN v_limit := 100; END IF;

  v_offset := COALESCE(p_offset, 0);
  IF v_offset < 0 THEN v_offset := 0; END IF;

  -- Validar status opcional se fornecido
  IF p_status IS NOT NULL AND btrim(p_status) <> '' THEN
    IF p_status NOT IN ('open', 'calculated', 'pending', 'partially_blocked', 'paid', 'reopened', 'reversed', 'cancelled', 'not_calculated') THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS', 'message', 'Status canônico inválido.');
    END IF;
  END IF;

  -- Delimitação operacional por America/Sao_Paulo convertida autoritativamente
  IF p_period_shortcut = 'previous_week' THEN
    v_ref_date := ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '7 days')::date;
  ELSIF p_period_shortcut = 'current_week' THEN
    v_ref_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date;
  ELSIF p_period_start IS NOT NULL THEN
    v_ref_date := p_period_start;
  ELSE
    -- Padrão: semana atual
    v_ref_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date;
  END IF;

  v_trunc_date := date_trunc('week', v_ref_date)::date;
  v_period_start := (v_trunc_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_period_end := v_period_start + INTERVAL '7 days';

  -- Executar consulta com CTE agregada em única chamada
  WITH fleet_riders AS (
    SELECT f.id AS rider_id, f.name AS rider_name, f.user_id::text AS rider_code
    FROM public.fleet f
    WHERE (p_rider_id IS NULL OR f.id = p_rider_id)
  ),
  filtered_settlements AS (
    SELECT 
      s.id AS settlement_id,
      fr.rider_id,
      fr.rider_name,
      fr.rider_code,
      COALESCE(s.period_start, v_period_start) AS period_start,
      COALESCE(s.period_end, v_period_end) AS period_end,
      COALESCE(s.status, 'not_calculated') AS status,
      CASE COALESCE(s.status, 'not_calculated')
        WHEN 'open' THEN 'Em andamento'
        WHEN 'calculated' THEN 'Calculado'
        WHEN 'pending' THEN 'Pendente'
        WHEN 'partially_blocked' THEN 'Parcialmente bloqueado'
        WHEN 'paid' THEN 'Pago'
        WHEN 'reopened' THEN 'Reaberto'
        WHEN 'reversed' THEN 'Pagamento estornado'
        WHEN 'cancelled' THEN 'Cancelado'
        WHEN 'not_calculated' THEN 'Não calculado'
        ELSE s.status
      END AS status_label,
      COALESCE(s.base_rider_amount, 0.00) AS base_rider_amount,
      COALESCE(s.consumables_amount, 0.00) AS consumables_amount,
      COALESCE(s.credits_amount, 0.00) AS credits_amount,
      COALESCE(s.positive_adjustments_amount, 0.00) AS positive_adjustments_amount,
      COALESCE(s.negative_adjustments_amount, 0.00) AS negative_adjustments_amount,
      COALESCE(s.reversals_amount, 0.00) AS reversals_amount,
      COALESCE(s.net_amount, 0.00) AS net_amount,
      COALESCE(s.eligible_amount, 0.00) AS eligible_amount,
      COALESCE(s.blocked_amount, 0.00) AS blocked_amount,
      COALESCE(s.paid_amount, 0.00) AS paid_amount,
      GREATEST(0.00, COALESCE(s.eligible_amount, 0.00) - COALESCE(s.paid_amount, 0.00)) AS unpaid_eligible_amount,
      COALESCE((
        SELECT COUNT(DISTINCT si.tele_id)::int 
        FROM public.rider_weekly_settlement_items si 
        WHERE si.settlement_id = s.id AND si.source_type = 'rider_earning'
      ), 0) AS teles_count,
      COALESCE((
        SELECT COUNT(DISTINCT si.client_id)::int 
        FROM public.rider_weekly_settlement_items si 
        WHERE si.settlement_id = s.id AND si.funding_status = 'blocked_client_unpaid' AND si.client_id IS NOT NULL
      ), 0) AS blocked_clients_count,
      COALESCE(s.version, 0) AS version,
      s.created_at,
      s.updated_at
    FROM fleet_riders fr
    LEFT JOIN public.rider_weekly_settlements s 
      ON s.rider_id = fr.rider_id 
     AND s.period_start = v_period_start
    WHERE (p_status IS NULL OR COALESCE(s.status, 'not_calculated') = p_status)
  ),
  paged_settlements AS (
    SELECT * FROM filtered_settlements
    ORDER BY rider_name ASC
    OFFSET v_offset LIMIT v_limit
  )
  SELECT 
    (SELECT COUNT(*)::int FROM filtered_settlements),
    COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'settlement_id', ps.settlement_id,
        'rider_id', ps.rider_id,
        'rider_name', ps.rider_name,
        'rider_code', ps.rider_code,
        'period_start', ps.period_start,
        'period_end', ps.period_end,
        'status', ps.status,
        'status_label', ps.status_label,
        'base_rider_amount', ps.base_rider_amount,
        'consumables_amount', ps.consumables_amount,
        'credits_amount', ps.credits_amount,
        'positive_adjustments_amount', ps.positive_adjustments_amount,
        'negative_adjustments_amount', ps.negative_adjustments_amount,
        'reversals_amount', ps.reversals_amount,
        'net_amount', ps.net_amount,
        'eligible_amount', ps.eligible_amount,
        'blocked_amount', ps.blocked_amount,
        'paid_amount', ps.paid_amount,
        'unpaid_eligible_amount', ps.unpaid_eligible_amount,
        'teles_count', ps.teles_count,
        'blocked_clients_count', ps.blocked_clients_count,
        'version', ps.version,
        'created_at', ps.created_at,
        'updated_at', ps.updated_at
      ) ORDER BY ps.rider_name ASC
    ), '[]'::jsonb)
  INTO v_total_count, v_settlements
  FROM paged_settlements ps;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'total_count', v_total_count,
    'limit', v_limit,
    'offset', v_offset,
    'settlements', v_settlements
  );
END;
$$;

-- 3. PERMISSÕES CANÔNICAS
REVOKE ALL ON FUNCTION public.list_admin_rider_weekly_settlements(DATE, UUID, TEXT, UUID, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_admin_rider_weekly_settlements(DATE, UUID, TEXT, UUID, INTEGER, INTEGER, TEXT) TO authenticated;
