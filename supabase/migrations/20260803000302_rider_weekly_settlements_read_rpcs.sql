-- =====================================================================
-- Dahora Expresso — Migration 20260803000302
-- Fase 3B.1: RPCs Autorizadas de Leitura Pura (Timezone America/Sao_Paulo & Integridade de Lotes)
-- Preserva 100% das migrations da Fase 1, Fase 2 e Fase 3A.
-- Zero mutações no banco de dados. Zero alteração em tabelas ou RLS existentes.
-- =====================================================================

-- 1. RPC DE LISTAGEM ADMINISTRATIVA DOS FECHAMENTOS SEMANAIS
CREATE OR REPLACE FUNCTION public.list_admin_rider_weekly_settlements(
  p_period_start TIMESTAMPTZ DEFAULT NULL,
  p_workspace_id UUID DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_rider_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
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

  -- Delimitação operacional por America/Sao_Paulo convertida autoritativamente para UTC timestamptz
  IF p_period_start IS NOT NULL THEN
    -- Truncar no início da semana em America/Sao_Paulo e converter para TIMESTAMPTZ
    v_period_start := (date_trunc('week', p_period_start AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo');
    v_period_end := v_period_start + INTERVAL '7 days';
  END IF;

  -- Executar consulta com LEFT JOIN para incluir motoboys ativos do fleet que ainda não possuem settlement
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
        SELECT COUNT(*)::int 
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
     AND (v_period_start IS NULL OR s.period_start = v_period_start)
    WHERE (p_workspace_id IS NULL OR s.workspace_id = p_workspace_id OR s.id IS NULL)
      AND (p_status IS NULL OR btrim(p_status) = '' OR COALESCE(s.status, 'not_calculated') = p_status)
  ),
  counted AS (
    SELECT COUNT(*)::int AS total FROM filtered_settlements
  ),
  paginated AS (
    SELECT * FROM filtered_settlements
    ORDER BY period_start DESC NULLS LAST, rider_name ASC, settlement_id ASC NULLS LAST
    LIMIT v_limit OFFSET v_offset
  )
  SELECT 
    (SELECT total FROM counted),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'settlement_id', p.settlement_id,
          'rider_id', p.rider_id,
          'rider_name', p.rider_name,
          'rider_code', p.rider_code,
          'period_start', p.period_start,
          'period_end', p.period_end,
          'status', p.status,
          'status_label', p.status_label,
          'base_rider_amount', p.base_rider_amount,
          'consumables_amount', p.consumables_amount,
          'credits_amount', p.credits_amount,
          'positive_adjustments_amount', p.positive_adjustments_amount,
          'negative_adjustments_amount', p.negative_adjustments_amount,
          'reversals_amount', p.reversals_amount,
          'net_amount', p.net_amount,
          'eligible_amount', p.eligible_amount,
          'blocked_amount', p.blocked_amount,
          'paid_amount', p.paid_amount,
          'unpaid_eligible_amount', p.unpaid_eligible_amount,
          'teles_count', p.teles_count,
          'blocked_clients_count', p.blocked_clients_count,
          'version', p.version,
          'created_at', p.created_at,
          'updated_at', p.updated_at
        )
      ), '[]'::jsonb
    )
  INTO v_total_count, v_settlements
  FROM paginated p;

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

-- 2. RPC CONSOLIDADA DE DETALHAMENTO DO FECHAMENTO SEMANAL (INTEGRIDADE RIGOROSA DE LOTES)
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

  -- 1. Verificar existência do settlement
  SELECT EXISTS (SELECT 1 FROM public.rider_weekly_settlements WHERE id = p_settlement_id) INTO v_exists;

  IF NOT v_exists THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SETTLEMENT_NOT_FOUND', 'message', 'Fechamento não encontrado.');
  END IF;

  -- 2. Header do Settlement
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
  LEFT JOIN public.fleet f ON f.id = s.rider_id
  WHERE s.id = p_settlement_id;

  -- 3. Summary Contábil Autoritativo
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

  -- 4. Items com Invariante em Centavos e Rótulo de Funding Status Coerente
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'source_type', i.source_type,
        'source_id', i.source_id,
        'tele_id', i.tele_id,
        'tele_code', t.tele_code,
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

  -- 5. Batches com Invariantes de Integridade (paid_at, reversed_at, reversal_reason, integrity_status)
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

  -- 6. Latest Payment EXIGE status = 'paid' AND paid_at IS NOT NULL
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

-- 3. PERMISSÕES E GRANTS RÍGIDOS
REVOKE ALL ON FUNCTION public.list_admin_rider_weekly_settlements(TIMESTAMPTZ, UUID, TEXT, UUID, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_admin_rider_weekly_settlements(TIMESTAMPTZ, UUID, TEXT, UUID, INTEGER, INTEGER) TO authenticated;

REVOKE ALL ON FUNCTION public.get_admin_rider_weekly_settlement_detail(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_rider_weekly_settlement_detail(UUID) TO authenticated;
