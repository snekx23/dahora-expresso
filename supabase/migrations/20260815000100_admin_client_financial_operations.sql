-- =====================================================================
-- MIGRATION: 20260815000100_admin_client_financial_operations.sql
-- DESCRIPTION: RPCs administrativas para extrato, recebimento e alocação atômica de cliente
-- =====================================================================

-- 1. Constraint de Idempotência por Cliente
DO $$ 
BEGIN 
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_financial_transactions_idempotency_key_key'
  ) THEN
    ALTER TABLE public.client_financial_transactions DROP CONSTRAINT client_financial_transactions_idempotency_key_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_fin_tx_client_idempotency_uniq'
  ) THEN
    ALTER TABLE public.client_financial_transactions ADD CONSTRAINT client_fin_tx_client_idempotency_uniq UNIQUE (client_id, idempotency_key);
  END IF;
END $$;

-- 2. RPC: public.admin_register_client_payment (Atômica com Alocação FIFO Automatizada)
CREATE OR REPLACE FUNCTION public.admin_register_client_payment(
  p_client_id UUID,
  p_amount NUMERIC,
  p_payment_method TEXT,
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
  v_is_admin BOOLEAN;
  v_client RECORD;
  v_tx RECORD;
  v_idempotency_key TEXT;
  v_clean_amount NUMERIC(10,2);
  v_description TEXT;
  v_current_open_balance NUMERIC(10,2) := 0.00;
  v_unallocated_credit NUMERIC(10,2);
  v_tele RECORD;
  v_existing_alloc NUMERIC(10,2);
  v_tele_charge NUMERIC(10,2);
  v_needed NUMERIC(10,2);
  v_alloc_amount NUMERIC(10,2);
  v_total_alloc NUMERIC(10,2);
  v_allocated_count INT := 0;
  v_fully_covered_count INT := 0;
BEGIN
  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem registrar recebimento.');
  END IF;

  -- Verify FK reference to auth.users for v_user_id
  IF v_user_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
      v_user_id := NULL;
    END IF;
  END IF;

  -- Lock row on commercial_clients to prevent concurrent overpayments & race conditions
  SELECT c.id, c.establishment_name INTO v_client 
  FROM public.commercial_clients c 
  WHERE c.id = p_client_id
  FOR UPDATE;

  IF v_client.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_NOT_FOUND', 'message', 'Cliente não encontrado.');
  END IF;

  v_clean_amount := pg_catalog.round(p_amount, 2);
  IF v_clean_amount <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_AMOUNT', 'message', 'O valor do recebimento deve ser maior que zero.');
  END IF;

  -- Idempotency Key Normalization
  IF p_idempotency_key IS NOT NULL AND TRIM(p_idempotency_key) <> '' THEN
    v_idempotency_key := TRIM(p_idempotency_key);
  ELSE
    v_idempotency_key := pg_catalog.format('receipt:%s:%s', p_client_id, pg_catalog.clock_timestamp());
  END IF;

  -- Check for Replay
  SELECT * INTO v_tx 
  FROM public.client_financial_transactions 
  WHERE client_id = p_client_id AND idempotency_key = v_idempotency_key;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'transaction_id', v_tx.id,
      'client_id', v_tx.client_id,
      'amount', v_tx.amount,
      'message', 'Recebimento já processado (replay idempotente).'
    );
  END IF;

  -- Authoritative Open Balance Calculation (Debits - Credits)
  SELECT COALESCE(SUM(
    CASE WHEN direction = 'debit' THEN amount ELSE -amount END
  ), 0.00) INTO v_current_open_balance
  FROM public.client_financial_transactions
  WHERE client_id = p_client_id;

  -- Overpayment Check
  IF v_clean_amount > v_current_open_balance THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'AMOUNT_EXCEEDS_BALANCE',
      'current_open_balance', v_current_open_balance,
      'message', 'O valor recebido não pode ser maior que o saldo atual em aberto do cliente.'
    );
  END IF;

  v_description := pg_catalog.format('Recebimento de Pagamento (%s)', COALESCE(p_payment_method, 'Outro'));
  IF p_notes IS NOT NULL AND TRIM(p_notes) <> '' THEN
    v_description := v_description || ' - ' || TRIM(p_notes);
  END IF;

  -- Insert credit transaction with unique_violation exception handler
  BEGIN
    INSERT INTO public.client_financial_transactions (
      client_id,
      type,
      direction,
      amount,
      description,
      idempotency_key,
      created_at,
      created_by
    ) VALUES (
      p_client_id,
      'pagamento_recebido',
      'credit',
      v_clean_amount,
      v_description,
      v_idempotency_key,
      pg_catalog.clock_timestamp(),
      v_user_id
    ) RETURNING * INTO v_tx;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_tx 
    FROM public.client_financial_transactions 
    WHERE client_id = p_client_id AND idempotency_key = v_idempotency_key;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'transaction_id', v_tx.id,
      'client_id', v_tx.client_id,
      'amount', v_tx.amount,
      'message', 'Recebimento já processado por requisição concorrente.'
    );
  END;

  -- -------------------------------------------------------------------
  -- AUTOMATIC FIFO ALLOCATION OF THE RECEIVED PAYMENT TO OPEN TELES
  -- -------------------------------------------------------------------
  v_unallocated_credit := v_clean_amount;

  FOR v_tele IN
    SELECT t.id, t.delivery_charge, t.created_at
    FROM public.teles t
    WHERE t.client_id = p_client_id
      AND t.status IN ('concluida', 'concluido', 'entregue', 'Entregue')
    ORDER BY t.created_at ASC
  LOOP
    EXIT WHEN v_unallocated_credit <= 0;

    v_tele_charge := pg_catalog.round(COALESCE(v_tele.delivery_charge, 0.00), 2);

    -- Calculate existing allocations for this tele from all payment transactions
    SELECT COALESCE(SUM(allocated_amount), 0.00) INTO v_existing_alloc
    FROM public.client_payment_allocations
    WHERE tele_id = v_tele.id;

    v_needed := v_tele_charge - v_existing_alloc;

    IF v_needed > 0 THEN
      v_alloc_amount := LEAST(v_unallocated_credit, v_needed);
      v_total_alloc := v_existing_alloc + v_alloc_amount;

      INSERT INTO public.client_payment_allocations (
        client_id, client_transaction_id, tele_id, allocated_amount, is_fully_covered, allocated_by
      ) VALUES (
        p_client_id, v_tx.id, v_tele.id, v_alloc_amount, (v_total_alloc >= v_tele_charge), v_user_id
      ) ON CONFLICT (client_transaction_id, tele_id) DO UPDATE 
        SET allocated_amount = EXCLUDED.allocated_amount, is_fully_covered = (v_total_alloc >= v_tele_charge);

      v_unallocated_credit := v_unallocated_credit - v_alloc_amount;
      v_allocated_count := v_allocated_count + 1;

      -- If tele is 100% covered, update rider settlement items from blocked_client_unpaid to eligible
      IF v_total_alloc >= v_tele_charge THEN
        v_fully_covered_count := v_fully_covered_count + 1;

        UPDATE public.rider_weekly_settlement_items
        SET funding_status = 'eligible', eligible_amount = original_amount, blocked_amount = 0.00
        WHERE tele_id = v_tele.id AND funding_status = 'blocked_client_unpaid';
      END IF;
    END IF;
  END LOOP;

  -- Audit log
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key)
  VALUES (
    'admin',
    COALESCE(v_user_id::text, 'system_admin'),
    'admin_register_client_payment',
    pg_catalog.format('client_financial_transactions:%s', v_tx.id),
    pg_catalog.jsonb_build_object(
      'client_id', p_client_id,
      'amount', v_clean_amount,
      'payment_method', p_payment_method,
      'transaction_id', v_tx.id,
      'allocated_count', v_allocated_count,
      'fully_covered_count', v_fully_covered_count
    ),
    pg_catalog.format('audit:receipt:%s', v_tx.id)
  ) ON CONFLICT DO NOTHING;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'is_idempotent', false,
    'transaction_id', v_tx.id,
    'client_id', v_tx.client_id,
    'amount', v_tx.amount,
    'allocated_count', v_allocated_count,
    'fully_covered_count', v_fully_covered_count,
    'message', 'Recebimento registrado e alocado com sucesso.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_register_client_payment(UUID, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_register_client_payment(UUID, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;

-- 3. RPC: public.admin_get_client_financial_statement
CREATE OR REPLACE FUNCTION public.admin_get_client_financial_statement(
  p_client_id UUID,
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL,
  p_limit INT DEFAULT 50,
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
  v_is_admin BOOLEAN;
  v_client RECORD;
  v_start_tz TIMESTAMPTZ;
  v_end_tz TIMESTAMPTZ;
  v_limit INT;
  v_offset INT;
  v_opening_balance NUMERIC(10,2) := 0.00;
  v_total_open_balance NUMERIC(10,2) := 0.00;
  v_billed_period NUMERIC(10,2) := 0.00;
  v_paid_period NUMERIC(10,2) := 0.00;
  v_teles_count_period INT := 0;
  v_total_count INT := 0;
  v_items JSONB := '[]'::jsonb;
BEGIN
  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem consultar o extrato.');
  END IF;

  SELECT c.id, c.establishment_name, c.client_code INTO v_client FROM public.commercial_clients c WHERE c.id = p_client_id;
  IF v_client.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_NOT_FOUND', 'message', 'Cliente não encontrado.');
  END IF;

  IF p_start_date IS NOT NULL THEN
    v_start_tz := (p_start_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo';
  ELSE
    v_start_tz := '2000-01-01 00:00:00+00'::timestamptz;
  END IF;

  IF p_end_date IS NOT NULL THEN
    v_end_tz := ((p_end_date + INTERVAL '1 day')::date::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo';
  ELSE
    v_end_tz := '2099-12-31 23:59:59+00'::timestamptz;
  END IF;

  v_limit := COALESCE(p_limit, 50);
  IF v_limit < 1 THEN v_limit := 50; END IF;
  IF v_limit > 200 THEN v_limit := 200; END IF;

  v_offset := COALESCE(p_offset, 0);
  IF v_offset < 0 THEN v_offset := 0; END IF;

  SELECT COALESCE(SUM(
    CASE WHEN direction = 'debit' THEN amount ELSE -amount END
  ), 0.00) INTO v_total_open_balance
  FROM public.client_financial_transactions
  WHERE client_id = p_client_id;

  SELECT COALESCE(SUM(
    CASE WHEN direction = 'debit' THEN amount ELSE -amount END
  ), 0.00) INTO v_opening_balance
  FROM public.client_financial_transactions
  WHERE client_id = p_client_id
    AND created_at < v_start_tz;

  SELECT
    COALESCE(COUNT(DISTINCT tele_id) FILTER (WHERE type = 'cobranca_entrega' AND tele_id IS NOT NULL), 0)::INT,
    COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0.00)
  INTO
    v_teles_count_period,
    v_billed_period,
    v_paid_period
  FROM public.client_financial_transactions
  WHERE client_id = p_client_id
    AND created_at >= v_start_tz
    AND created_at < v_end_tz;

  SELECT COUNT(*) INTO v_total_count
  FROM public.client_financial_transactions
  WHERE client_id = p_client_id
    AND created_at >= v_start_tz
    AND created_at < v_end_tz;

  SELECT COALESCE(pg_catalog.jsonb_agg(stmt.item_row), '[]'::jsonb) INTO v_items
  FROM (
    SELECT pg_catalog.jsonb_build_object(
      'transaction_id', r.id,
      'client_id', r.client_id,
      'tele_id', r.tele_id,
      'tele_code', CASE WHEN t.tele_code IS NOT NULL THEN 'TEL-' || t.tele_code::text ELSE NULL END,
      'type', r.type,
      'direction', r.direction,
      'amount', pg_catalog.round(r.amount, 2),
      'description', r.description,
      'created_at', r.created_at,
      'running_balance', pg_catalog.round(
        v_opening_balance + SUM(CASE WHEN r_sub.direction = 'debit' THEN r_sub.amount ELSE -r_sub.amount END), 2
      )
    ) AS item_row
    FROM public.client_financial_transactions r
    LEFT JOIN public.teles t ON t.id = r.tele_id
    LEFT JOIN public.client_financial_transactions r_sub 
      ON r_sub.client_id = r.client_id 
     AND r_sub.created_at >= v_start_tz 
     AND r_sub.created_at <= r.created_at
    WHERE r.client_id = p_client_id
      AND r.created_at >= v_start_tz
      AND r.created_at < v_end_tz
    GROUP BY r.id, r.client_id, r.tele_id, t.tele_code, r.type, r.direction, r.amount, r.description, r.created_at
    ORDER BY r.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) stmt;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'client_id', v_client.id,
    'establishment_name', v_client.establishment_name,
    'client_code', v_client.client_code,
    'period_start', v_start_tz,
    'period_end', v_end_tz,
    'opening_balance', v_opening_balance,
    'total_open_balance', v_total_open_balance,
    'completed_teles_count', v_teles_count_period,
    'billed_total', v_billed_period,
    'paid_total', v_paid_period,
    'total_count', v_total_count,
    'items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_client_financial_statement(UUID, DATE, DATE, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_client_financial_statement(UUID, DATE, DATE, INT, INT) TO authenticated;
