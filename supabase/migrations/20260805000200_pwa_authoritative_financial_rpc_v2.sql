-- =====================================================================
-- Dahora Expresso — Additive Migration: Sanitized Rider Financial RPC v2
-- Timestamp: 20260805000200
-- File: supabase/migrations/20260805000200_pwa_authoritative_financial_rpc_v2.sql
-- Finalidade: Fornecer fonte autoritativa e 100% sanitizada para o extrato financeiro do PWA
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_my_rider_financial_statement_v2(
  p_period_start TIMESTAMPTZ DEFAULT NULL,
  p_history_limit INTEGER DEFAULT 12
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_rider_id UUID;
  v_limit INT;
  v_settlement RECORD;
  v_status_label TEXT;
  v_items JSONB := '[]'::jsonb;
  v_batches JSONB := '[]'::jsonb;
  v_latest_payment JSONB := NULL;
  v_available_periods JSONB := '[]'::jsonb;
  v_unpaid_eligible NUMERIC(12,2) := 0.00;
BEGIN
  -- 1. Exigir autenticação
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 
      'error_code', 'AUTHENTICATION_REQUIRED', 
      'message', 'Usuário não autenticado.'
    );
  END IF;

  -- 2. Resolver rider_id exclusivamente por auth.uid()
  SELECT id INTO v_rider_id 
  FROM public.fleet 
  WHERE user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 
      'error_code', 'RIDER_PROFILE_NOT_FOUND', 
      'message', 'Perfil de motoboy não encontrado.'
    );
  END IF;

  -- 3. Sanitizar e limitar histórico entre 1 e 52
  v_limit := COALESCE(p_history_limit, 12);
  IF v_limit < 1 THEN v_limit := 1; END IF;
  IF v_limit > 52 THEN v_limit := 52; END IF;

  -- 4. Coletar histórico de períodos disponíveis (sem dados financeiros confidenciais)
  -- Períodos mantêm timestamps canônicos reais persistidos (ex: Segunda 03:00Z até Segunda 03:00Z)
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'period_start', s.period_start,
        'period_end', s.period_end,
        'status', s.status
      ) ORDER BY s.period_start DESC
    ),
    '[]'::jsonb
  ) INTO v_available_periods
  FROM (
    SELECT period_start, period_end, status
    FROM public.rider_weekly_settlements
    WHERE rider_id = v_rider_id
    ORDER BY period_start DESC
    LIMIT v_limit
  ) s;

  -- 5. Selecionar o fechamento específico do período solicitado ou o mais recente
  SELECT * INTO v_settlement 
  FROM public.rider_weekly_settlements 
  WHERE rider_id = v_rider_id 
    AND (p_period_start IS NULL OR period_start = p_period_start)
  ORDER BY period_start DESC 
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 
      'has_settlement', false, 
      'available_periods', v_available_periods,
      'settlement', NULL, 
      'items', '[]'::jsonb,
      'batches', '[]'::jsonb,
      'latest_payment', NULL
    );
  END IF;

  -- Mapeamento estrito de rótulo de status em português autoritativo do Postgres
  CASE v_settlement.status
    WHEN 'open' THEN v_status_label := 'Ciclo em Andamento';
    WHEN 'calculated' THEN v_status_label := 'Apurado';
    WHEN 'pending' THEN v_status_label := 'Pendente de Pagamento';
    WHEN 'partially_blocked' THEN v_status_label := 'Parcialmente Bloqueado';
    WHEN 'paid' THEN v_status_label := 'Pago (Concluído)';
    WHEN 'reopened' THEN v_status_label := 'Reaberto para Revisão';
    WHEN 'reversed' THEN v_status_label := 'Estornado';
    WHEN 'cancelled' THEN v_status_label := 'Cancelado';
    ELSE v_status_label := 'Status Indisponível';
  END CASE;

  -- Cálculo 100% no Postgres de unpaid_eligible_amount
  v_unpaid_eligible := GREATEST(0.00, COALESCE(v_settlement.eligible_amount, 0.00) - COALESCE(v_settlement.paid_amount, 0.00));

  -- 6. Linhas do Fechamento Sanitizadas
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
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
    ),
    '[]'::jsonb
  ) INTO v_items
  FROM public.rider_weekly_settlement_items item
  WHERE item.settlement_id = v_settlement.id;

  -- 7. Lotes de Pagamento Sanitizados (sem actor_id / paid_by / chaves / notas)
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'batch_type', b.batch_type,
        'total_paid_amount', b.total_paid_amount,
        'status', b.status,
        'paid_at', b.paid_at,
        'created_at', b.created_at
      ) ORDER BY b.created_at DESC
    ),
    '[]'::jsonb
  ) INTO v_batches
  FROM public.rider_payment_batches b
  WHERE b.settlement_id = v_settlement.id;

  -- 8. Último pagamento concluído sanitizado (Exclusivamente status = 'paid' e paid_at IS NOT NULL)
  SELECT pg_catalog.jsonb_build_object(
    'total_paid_amount', b.total_paid_amount,
    'status', b.status,
    'paid_at', b.paid_at
  ) INTO v_latest_payment
  FROM public.rider_payment_batches b
  WHERE b.settlement_id = v_settlement.id 
    AND b.status = 'paid' 
    AND b.paid_at IS NOT NULL
  ORDER BY b.paid_at DESC
  LIMIT 1;

  -- 9. Retornar Payload Sanitizado Completo
  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'has_settlement', true,
    'available_periods', v_available_periods,
    'settlement', pg_catalog.jsonb_build_object(
      'period_start', v_settlement.period_start,
      'period_end', v_settlement.period_end,
      'status', v_settlement.status,
      'status_label', v_status_label,
      'base_rider_amount', v_settlement.base_rider_amount,
      'consumables_amount', v_settlement.consumables_amount,
      'credits_amount', v_settlement.credits_amount,
      'positive_adjustments_amount', v_settlement.positive_adjustments_amount,
      'negative_adjustments_amount', v_settlement.negative_adjustments_amount,
      'net_amount', v_settlement.net_amount,
      'eligible_amount', v_settlement.eligible_amount,
      'blocked_amount', v_settlement.blocked_amount,
      'paid_amount', v_settlement.paid_amount,
      'unpaid_eligible_amount', v_unpaid_eligible
    ),
    'items', COALESCE(v_items, '[]'::jsonb),
    'batches', COALESCE(v_batches, '[]'::jsonb),
    'latest_payment', v_latest_payment
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_rider_financial_statement_v2(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_financial_statement_v2(TIMESTAMPTZ, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_financial_statement_v2(TIMESTAMPTZ, INTEGER) TO authenticated;
