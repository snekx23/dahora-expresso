-- =====================================================================
-- Dahora Expresso — Migration: Fix & Hardening of Admin Financial Operations
-- File: supabase/migrations/20260730000200_admin_rider_financial_operations_fix.sql
-- =====================================================================

-- 1. Remover triggers antigos para evitar duplicação no ledger financeiro.
-- As RPCs administrativas doravante gerenciam atomicamente os registros operacionais
-- e as transações imutáveis em public.rider_financial_transactions.
DROP TRIGGER IF EXISTS trg_sync_consumable_to_financial_tx ON public.rider_consumable_purchases;
DROP TRIGGER IF EXISTS trg_sync_credits_to_financial_tx ON public.rider_credits_ledger;
DROP FUNCTION IF EXISTS public.trg_sync_consumable_to_rider_financial_tx();
DROP FUNCTION IF EXISTS public.trg_sync_credits_to_rider_financial_tx();

-- 2. Adicionar colunas operacionais em public.rider_consumable_purchases
ALTER TABLE public.rider_consumable_purchases
  ADD COLUMN IF NOT EXISTS competency_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversal_transaction_id UUID;

ALTER TABLE public.rider_consumable_purchases
  DROP CONSTRAINT IF EXISTS rider_consumable_purchases_status_check;

ALTER TABLE public.rider_consumable_purchases
  ADD CONSTRAINT rider_consumable_purchases_status_check CHECK (status IN ('active', 'reversed'));

-- Backfill para rider_consumable_purchases existentes
UPDATE public.rider_consumable_purchases
SET competency_date = COALESCE(competency_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date),
    status = COALESCE(status, 'active')
WHERE competency_date IS NULL OR status IS NULL;


-- 3. Adicionar colunas operacionais em public.rider_credits_ledger
ALTER TABLE public.rider_credits_ledger
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'credit',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversal_transaction_id UUID;

ALTER TABLE public.rider_credits_ledger
  DROP CONSTRAINT IF EXISTS rider_credits_ledger_direction_check;
ALTER TABLE public.rider_credits_ledger
  ADD CONSTRAINT rider_credits_ledger_direction_check CHECK (direction IN ('credit', 'debit'));

ALTER TABLE public.rider_credits_ledger
  DROP CONSTRAINT IF EXISTS rider_credits_ledger_status_check;
ALTER TABLE public.rider_credits_ledger
  ADD CONSTRAINT rider_credits_ledger_status_check CHECK (status IN ('active', 'reversed'));

-- Backfill para rider_credits_ledger existentes
UPDATE public.rider_credits_ledger
SET direction = COALESCE(direction, 'credit'),
    status = COALESCE(status, 'active')
WHERE direction IS NULL OR status IS NULL;


-- 4. Adicionar coluna de competência em public.rider_financial_transactions
ALTER TABLE public.rider_financial_transactions
  ADD COLUMN IF NOT EXISTS competency_date DATE NOT NULL DEFAULT CURRENT_DATE;

-- Backfill seguro para rider_financial_transactions
UPDATE public.rider_financial_transactions tx
SET competency_date = (
  CASE
    WHEN tx.idempotency_key LIKE 'credit:%' OR tx.idempotency_key LIKE 'adjustment:%' THEN (
      SELECT l.target_date FROM public.rider_credits_ledger l WHERE tx.idempotency_key LIKE ('%' || l.id::text || '%') LIMIT 1
    )
    WHEN tx.idempotency_key LIKE 'consumable:%' THEN (
      SELECT c.competency_date FROM public.rider_consumable_purchases c WHERE tx.idempotency_key LIKE ('%' || c.id::text || '%') LIMIT 1
    )
    WHEN tx.tele_id IS NOT NULL THEN (
      SELECT COALESCE((t.completed_at AT TIME ZONE 'America/Sao_Paulo')::date, (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
      FROM public.teles t WHERE t.id = tx.tele_id LIMIT 1
    )
    ELSE (tx.created_at AT TIME ZONE 'America/Sao_Paulo')::date
  END
)
WHERE tx.competency_date IS NULL;

-- Garantir NOT NULL em competency_date
ALTER TABLE public.rider_financial_transactions
  ALTER COLUMN competency_date SET DEFAULT CURRENT_DATE;


-- 5. RPC Administrativa: public.admin_create_rider_consumable
CREATE OR REPLACE FUNCTION public.admin_create_rider_consumable(
  p_motoboy_id UUID,
  p_category TEXT,
  p_item_name TEXT,
  p_quantity NUMERIC,
  p_unit_amount NUMERIC,
  p_notes TEXT DEFAULT NULL,
  p_competency_date DATE DEFAULT CURRENT_DATE,
  p_request_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_motoboy RECORD;
  v_category_norm TEXT;
  v_total_amount NUMERIC(10,2);
  v_purchase_id UUID;
  v_op_key TEXT;
  v_tx_key TEXT;
  v_purchase RECORD;
  v_tx RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem registrar consumíveis.');
  END IF;

  SELECT f.id, f.name INTO v_motoboy FROM public.fleet f WHERE f.id = p_motoboy_id;
  IF v_motoboy.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_NOT_FOUND', 'message', 'Motoboy não encontrado.');
  END IF;

  IF p_item_name IS NULL OR pg_catalog.btrim(p_item_name) = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ITEM_NAME_REQUIRED', 'message', 'O nome do item é obrigatório.');
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_QUANTITY', 'message', 'A quantidade deve ser maior que zero.');
  END IF;

  IF p_unit_amount IS NULL OR p_unit_amount < 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_UNIT_AMOUNT', 'message', 'O valor unitário não pode ser negativo.');
  END IF;

  v_category_norm := LOWER(pg_catalog.btrim(COALESCE(p_category, 'consumivel')));
  IF v_category_norm NOT IN ('vale', 'consumivel', 'consumível') THEN
    v_category_norm := 'consumivel';
  END IF;
  IF v_category_norm = 'consumável' THEN
    v_category_norm := 'consumivel';
  END IF;

  v_total_amount := pg_catalog.round(p_quantity * p_unit_amount, 2);

  IF p_request_idempotency_key IS NOT NULL AND pg_catalog.btrim(p_request_idempotency_key) <> '' THEN
    v_op_key := pg_catalog.btrim(p_request_idempotency_key);
    SELECT * INTO v_purchase FROM public.rider_consumable_purchases WHERE idempotency_key = v_op_key;
    IF v_purchase.id IS NOT NULL THEN
      SELECT * INTO v_tx FROM public.rider_financial_transactions WHERE idempotency_key = pg_catalog.format('consumable:%s:rider_debit:v1', v_purchase.id);
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'idempotent', true,
        'purchase', pg_catalog.to_jsonb(v_purchase),
        'transaction', pg_catalog.to_jsonb(v_tx)
      );
    END IF;
  ELSE
    v_op_key := pg_catalog.format('admin-consumable:%s', gen_random_uuid());
  END IF;

  INSERT INTO public.rider_consumable_purchases (
    motoboy_id, motoboy_name, categoria, item_name, quantidade, valor_unitario, amount, observacao, competency_date, status, idempotency_key
  ) VALUES (
    v_motoboy.id, v_motoboy.name, v_category_norm, pg_catalog.btrim(p_item_name), p_quantity::integer, p_unit_amount, v_total_amount, p_notes, COALESCE(p_competency_date, CURRENT_DATE), 'active', v_op_key
  )
  RETURNING * INTO v_purchase;

  v_tx_key := pg_catalog.format('consumable:%s:rider_debit:v1', v_purchase.id);

  INSERT INTO public.rider_financial_transactions (
    rider_id, tele_id, type, direction, amount, description, competency_date, idempotency_key
  ) VALUES (
    v_motoboy.id, NULL, 'ajuste_debito', 'debit', v_total_amount, pg_catalog.format('Consumível: %s', v_purchase.item_name), COALESCE(p_competency_date, CURRENT_DATE), v_tx_key
  )
  RETURNING * INTO v_tx;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES ('user', COALESCE(v_user_id::text, 'system'), 'admin_create_rider_consumable', pg_catalog.format('rider_consumable_purchases:%s', v_purchase.id), pg_catalog.jsonb_build_object(
    'motoboy_id', v_motoboy.id, 'amount', v_total_amount, 'item_name', v_purchase.item_name
  ));

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'idempotent', false,
    'purchase', pg_catalog.to_jsonb(v_purchase),
    'transaction', pg_catalog.to_jsonb(v_tx)
  );
END;
$$;


-- 6. RPC Administrativa: public.admin_create_rider_adjustment
CREATE OR REPLACE FUNCTION public.admin_create_rider_adjustment(
  p_motoboy_id UUID,
  p_direction TEXT,
  p_amount NUMERIC,
  p_description TEXT,
  p_target_date DATE DEFAULT CURRENT_DATE,
  p_request_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_motoboy RECORD;
  v_dir_norm TEXT;
  v_amount NUMERIC(10,2);
  v_tx_type TEXT;
  v_op_key TEXT;
  v_tx_key TEXT;
  v_adj RECORD;
  v_tx RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem registrar ajustes.');
  END IF;

  SELECT f.id, f.name INTO v_motoboy FROM public.fleet f WHERE f.id = p_motoboy_id;
  IF v_motoboy.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_NOT_FOUND', 'message', 'Motoboy não encontrado.');
  END IF;

  v_dir_norm := LOWER(pg_catalog.btrim(COALESCE(p_direction, '')));
  IF v_dir_norm NOT IN ('credit', 'debit') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DIRECTION', 'message', 'A direção do ajuste deve ser credit ou debit.');
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_AMOUNT', 'message', 'O valor deve ser maior que zero.');
  END IF;

  IF p_description IS NULL OR pg_catalog.btrim(p_description) = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DESCRIPTION_REQUIRED', 'message', 'A descrição é obrigatória.');
  END IF;

  v_amount := pg_catalog.round(p_amount, 2);
  v_tx_type := CASE WHEN v_dir_norm = 'credit' THEN 'ajuste_credito' ELSE 'ajuste_debito' END;

  IF p_request_idempotency_key IS NOT NULL AND pg_catalog.btrim(p_request_idempotency_key) <> '' THEN
    v_op_key := pg_catalog.btrim(p_request_idempotency_key);
    SELECT * INTO v_adj FROM public.rider_credits_ledger WHERE idempotency_key = v_op_key;
    IF v_adj.id IS NOT NULL THEN
      SELECT * INTO v_tx FROM public.rider_financial_transactions WHERE idempotency_key = pg_catalog.format('adjustment:%s:%s:v1', v_adj.id, v_dir_norm);
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'idempotent', true,
        'adjustment', pg_catalog.to_jsonb(v_adj),
        'transaction', pg_catalog.to_jsonb(v_tx)
      );
    END IF;
  ELSE
    v_op_key := pg_catalog.format('admin-adjustment:%s', gen_random_uuid());
  END IF;

  INSERT INTO public.rider_credits_ledger (
    motoboy_id, amount, description, target_date, direction, status, idempotency_key
  ) VALUES (
    v_motoboy.id, v_amount, pg_catalog.btrim(p_description), COALESCE(p_target_date, CURRENT_DATE), v_dir_norm, 'active', v_op_key
  )
  RETURNING * INTO v_adj;

  v_tx_key := pg_catalog.format('adjustment:%s:%s:v1', v_adj.id, v_dir_norm);

  INSERT INTO public.rider_financial_transactions (
    rider_id, tele_id, type, direction, amount, description, competency_date, idempotency_key
  ) VALUES (
    v_motoboy.id, NULL, v_tx_type, v_dir_norm, v_amount, pg_catalog.btrim(p_description), COALESCE(p_target_date, CURRENT_DATE), v_tx_key
  )
  RETURNING * INTO v_tx;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES ('user', COALESCE(v_user_id::text, 'system'), 'admin_create_rider_adjustment', pg_catalog.format('rider_credits_ledger:%s', v_adj.id), pg_catalog.jsonb_build_object(
    'motoboy_id', v_motoboy.id, 'amount', v_amount, 'direction', v_dir_norm, 'description', p_description
  ));

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'idempotent', false,
    'adjustment', pg_catalog.to_jsonb(v_adj),
    'transaction', pg_catalog.to_jsonb(v_tx)
  );
END;
$$;


-- 7. RPC Administrativa: public.admin_reverse_rider_consumable
CREATE OR REPLACE FUNCTION public.admin_reverse_rider_consumable(
  p_purchase_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_purchase RECORD;
  v_rev_tx_key TEXT;
  v_rev_tx RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem estornar consumíveis.');
  END IF;

  IF p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'REASON_REQUIRED', 'message', 'O motivo do estorno é obrigatório.');
  END IF;

  SELECT * INTO v_purchase FROM public.rider_consumable_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF v_purchase.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PURCHASE_NOT_FOUND', 'message', 'Consumível não encontrado.');
  END IF;

  v_rev_tx_key := pg_catalog.format('consumable:%s:reversal:v1', v_purchase.id);

  IF v_purchase.status = 'reversed' THEN
    SELECT * INTO v_rev_tx FROM public.rider_financial_transactions WHERE idempotency_key = v_rev_tx_key;
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'already_reversed', true,
      'purchase', pg_catalog.to_jsonb(v_purchase),
      'reversal_transaction', pg_catalog.to_jsonb(v_rev_tx)
    );
  END IF;

  -- Criar transação de estorno inverso (direção 'credit' compensa o débito original)
  INSERT INTO public.rider_financial_transactions (
    rider_id, tele_id, type, direction, amount, description, competency_date, idempotency_key
  ) VALUES (
    v_purchase.motoboy_id, NULL, 'estorno', 'credit', v_purchase.amount,
    pg_catalog.format('Estorno de Consumível: %s (Motivo: %s)', v_purchase.item_name, pg_catalog.btrim(p_reason)),
    v_purchase.competency_date, v_rev_tx_key
  )
  RETURNING * INTO v_rev_tx;

  -- Atualizar status do registro operacional
  UPDATE public.rider_consumable_purchases
  SET status = 'reversed',
      reversed_at = pg_catalog.clock_timestamp(),
      reversed_by = v_user_id,
      reversal_reason = pg_catalog.btrim(p_reason),
      reversal_transaction_id = v_rev_tx.id
  WHERE id = v_purchase.id
  RETURNING * INTO v_purchase;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES ('user', COALESCE(v_user_id::text, 'system'), 'admin_reverse_rider_consumable', pg_catalog.format('rider_consumable_purchases:%s', v_purchase.id), pg_catalog.jsonb_build_object(
    'purchase_id', v_purchase.id, 'amount', v_purchase.amount, 'reason', p_reason, 'reversal_transaction_id', v_rev_tx.id
  ));

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'already_reversed', false,
    'purchase', pg_catalog.to_jsonb(v_purchase),
    'reversal_transaction', pg_catalog.to_jsonb(v_rev_tx)
  );
END;
$$;


-- 8. RPC Administrativa: public.admin_reverse_rider_adjustment
CREATE OR REPLACE FUNCTION public.admin_reverse_rider_adjustment(
  p_adjustment_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_adj RECORD;
  v_inv_direction TEXT;
  v_rev_tx_key TEXT;
  v_rev_tx RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem estornar lançamentos.');
  END IF;

  IF p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'REASON_REQUIRED', 'message', 'O motivo do estorno é obrigatório.');
  END IF;

  SELECT * INTO v_adj FROM public.rider_credits_ledger WHERE id = p_adjustment_id FOR UPDATE;
  IF v_adj.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADJUSTMENT_NOT_FOUND', 'message', 'Lançamento não encontrado.');
  END IF;

  v_rev_tx_key := pg_catalog.format('adjustment:%s:reversal:v1', v_adj.id);

  IF v_adj.status = 'reversed' THEN
    SELECT * INTO v_rev_tx FROM public.rider_financial_transactions WHERE idempotency_key = v_rev_tx_key;
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'already_reversed', true,
      'adjustment', pg_catalog.to_jsonb(v_adj),
      'reversal_transaction', pg_catalog.to_jsonb(v_rev_tx)
    );
  END IF;

  -- Inverter a direção do lançamento original
  v_inv_direction := CASE WHEN COALESCE(v_adj.direction, 'credit') = 'credit' THEN 'debit' ELSE 'credit' END;

  INSERT INTO public.rider_financial_transactions (
    rider_id, tele_id, type, direction, amount, description, competency_date, idempotency_key
  ) VALUES (
    v_adj.motoboy_id, NULL, 'estorno', v_inv_direction, v_adj.amount,
    pg_catalog.format('Estorno: %s (Motivo: %s)', v_adj.description, pg_catalog.btrim(p_reason)),
    v_adj.target_date, v_rev_tx_key
  )
  RETURNING * INTO v_rev_tx;

  UPDATE public.rider_credits_ledger
  SET status = 'reversed',
      reversed_at = pg_catalog.clock_timestamp(),
      reversed_by = v_user_id,
      reversal_reason = pg_catalog.btrim(p_reason),
      reversal_transaction_id = v_rev_tx.id
  WHERE id = v_adj.id
  RETURNING * INTO v_adj;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES ('user', COALESCE(v_user_id::text, 'system'), 'admin_reverse_rider_adjustment', pg_catalog.format('rider_credits_ledger:%s', v_adj.id), pg_catalog.jsonb_build_object(
    'adjustment_id', v_adj.id, 'amount', v_adj.amount, 'reason', p_reason, 'reversal_transaction_id', v_rev_tx.id
  ));

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'already_reversed', false,
    'adjustment', pg_catalog.to_jsonb(v_adj),
    'reversal_transaction', pg_catalog.to_jsonb(v_rev_tx)
  );
END;
$$;


-- 9. RPC Administrativa: public.admin_get_rider_financial_summary
CREATE OR REPLACE FUNCTION public.admin_get_rider_financial_summary(
  p_motoboy_id UUID,
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
  v_is_admin BOOLEAN;
  v_motoboy RECORD;
  v_week RECORD;
  v_start_date DATE;
  v_end_date DATE;
  v_period_label TEXT;
  
  v_completed_deliveries_count INT := 0;
  v_delivery_earnings NUMERIC(12,2) := 0.00;
  v_consumables_total NUMERIC(12,2) := 0.00;
  v_credits_total NUMERIC(12,2) := 0.00;
  v_positive_adjustments_total NUMERIC(12,2) := 0.00;
  v_negative_adjustments_total NUMERIC(12,2) := 0.00;
  v_reversals_credit_total NUMERIC(12,2) := 0.00;
  v_reversals_debit_total NUMERIC(12,2) := 0.00;
  v_gross_total NUMERIC(12,2) := 0.00;
  v_deductions_total NUMERIC(12,2) := 0.00;
  v_net_total NUMERIC(12,2) := 0.00;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem consultar o resumo do motoboy.');
  END IF;

  SELECT f.id, f.name, f.motoboy_code INTO v_motoboy FROM public.fleet f WHERE f.id = p_motoboy_id;
  IF v_motoboy.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_NOT_FOUND', 'message', 'Motoboy não encontrado.');
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    SELECT * INTO v_week FROM public.get_rider_week_period_internal(pg_catalog.clock_timestamp());
    v_start_date := (v_week.period_start AT TIME ZONE 'America/Sao_Paulo')::date;
    v_end_date := (v_week.period_end_exclusive AT TIME ZONE 'America/Sao_Paulo')::date - 1;
    v_period_label := 'Semana Operacional';
  ELSE
    IF p_start_date > p_end_date THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DATE_RANGE', 'message', 'Data inicial maior que data final.');
    END IF;
    IF (p_end_date - p_start_date) > 366 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'MAX_PERIOD_EXCEEDED', 'message', 'Período máximo de 366 dias.');
    END IF;
    v_start_date := p_start_date;
    v_end_date := p_end_date;
    v_period_label := 'Período Personalizado';
  END IF;

  SELECT
    COALESCE(COUNT(DISTINCT tele_id) FILTER (WHERE type = 'credito_entrega' AND tele_id IS NOT NULL), 0)::INT,
    COALESCE(SUM(amount) FILTER (WHERE type = 'credito_entrega'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'ajuste_debito' AND idempotency_key LIKE 'consumable:%' AND direction = 'debit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'ajuste_credito' AND idempotency_key LIKE 'credit:%' AND direction = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'ajuste_credito' AND idempotency_key LIKE 'adjustment:%' AND direction = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'ajuste_debito' AND idempotency_key LIKE 'adjustment:%' AND direction = 'debit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'estorno' AND direction = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'estorno' AND direction = 'debit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0.00)
  INTO
    v_completed_deliveries_count,
    v_delivery_earnings,
    v_consumables_total,
    v_credits_total,
    v_positive_adjustments_total,
    v_negative_adjustments_total,
    v_reversals_credit_total,
    v_reversals_debit_total,
    v_gross_total,
    v_deductions_total
  FROM public.rider_financial_transactions
  WHERE rider_id = p_motoboy_id
    AND competency_date >= v_start_date
    AND competency_date <= v_end_date;

  v_net_total := v_gross_total - v_deductions_total;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'motoboy_id', v_motoboy.id,
    'motoboy_name', v_motoboy.name,
    'motoboy_code', v_motoboy.motoboy_code,
    'period_label', v_period_label,
    'period_start', v_start_date,
    'period_end', v_end_date,
    'completed_deliveries_count', v_completed_deliveries_count,
    'delivery_earnings', v_delivery_earnings,
    'consumables_total', v_consumables_total,
    'credits_total', v_credits_total,
    'positive_adjustments_total', v_positive_adjustments_total,
    'negative_adjustments_total', v_negative_adjustments_total,
    'reversals_credit_total', v_reversals_credit_total,
    'reversals_debit_total', v_reversals_debit_total,
    'gross_total', v_gross_total,
    'deductions_total', v_deductions_total,
    'net_total', v_net_total
  );
END;
$$;


-- 10. RPC Administrativa: public.admin_get_rider_financial_statement
CREATE OR REPLACE FUNCTION public.admin_get_rider_financial_statement(
  p_motoboy_id UUID,
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
  v_motoboy RECORD;
  v_week RECORD;
  v_start_date DATE;
  v_end_date DATE;
  v_limit INT;
  v_offset INT;
  v_total_count INT := 0;
  v_items JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT public.is_admin_user() INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, false) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Apenas administradores podem consultar o extrato.');
  END IF;

  SELECT f.id, f.name, f.motoboy_code INTO v_motoboy FROM public.fleet f WHERE f.id = p_motoboy_id;
  IF v_motoboy.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_NOT_FOUND', 'message', 'Motoboy não encontrado.');
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    SELECT * INTO v_week FROM public.get_rider_week_period_internal(pg_catalog.clock_timestamp());
    v_start_date := (v_week.period_start AT TIME ZONE 'America/Sao_Paulo')::date;
    v_end_date := (v_week.period_end_exclusive AT TIME ZONE 'America/Sao_Paulo')::date - 1;
  ELSE
    v_start_date := p_start_date;
    v_end_date := p_end_date;
  END IF;

  v_limit := COALESCE(p_limit, 50);
  IF v_limit < 1 THEN v_limit := 50; END IF;
  IF v_limit > 200 THEN v_limit := 200; END IF;

  v_offset := COALESCE(p_offset, 0);
  IF v_offset < 0 THEN v_offset := 0; END IF;

  SELECT COUNT(*) INTO v_total_count
  FROM public.rider_financial_transactions
  WHERE rider_id = p_motoboy_id
    AND competency_date >= v_start_date
    AND competency_date <= v_end_date;

  SELECT COALESCE(pg_catalog.jsonb_agg(stmt.item_row), '[]'::jsonb) INTO v_items
  FROM (
    SELECT pg_catalog.jsonb_build_object(
      'transaction_id', r.id,
      'rider_id', r.rider_id,
      'tele_id', r.tele_id,
      'tele_code', t.tele_code,
      'type', r.type,
      'direction', r.direction,
      'amount', pg_catalog.round(r.amount, 2),
      'description', r.description,
      'competency_date', r.competency_date,
      'created_at', r.created_at
    ) AS item_row
    FROM public.rider_financial_transactions r
    LEFT JOIN public.teles t ON t.id = r.tele_id
    WHERE r.rider_id = p_motoboy_id
      AND r.competency_date >= v_start_date
      AND r.competency_date <= v_end_date
    ORDER BY r.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) stmt;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'motoboy_id', v_motoboy.id,
    'motoboy_name', v_motoboy.name,
    'motoboy_code', v_motoboy.motoboy_code,
    'total_count', v_total_count,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
END;
$$;


-- 11. Atualizar RPC do PWA (public.get_my_rider_financial_summary) para utilizar competency_date
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
    COALESCE(COUNT(DISTINCT tele_id) FILTER (WHERE type = 'credito_entrega' AND tele_id IS NOT NULL), 0)::INT,
    COALESCE(SUM(amount) FILTER (WHERE type = 'credito_entrega'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'ajuste_credito' AND idempotency_key LIKE 'credit:%'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE (type = 'ajuste_credito' AND idempotency_key LIKE 'adjustment:%') OR (type = 'estorno' AND direction = 'credit')), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE type = 'ajuste_debito' AND idempotency_key LIKE 'consumable:%'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE (type = 'ajuste_debito' AND idempotency_key LIKE 'adjustment:%') OR (type = 'estorno' AND direction = 'debit')), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0.00),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0.00),
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
    'credits_total', v_credits_total,
    'adjustments_positive_total', v_adjustments_positive_total,
    'consumables_total', v_consumables_total,
    'adjustments_negative_total', v_adjustments_negative_total,
    'refunds_total', 0.00,
    'other_discounts_total', 0.00,
    'gross_total', v_gross_total,
    'deductions_total', v_deductions_total,
    'net_total', v_net_total,
    'last_transaction_at', v_last_transaction_at
  );
END;
$$;


-- 12. Atualizar RPC do PWA (public.get_my_rider_financial_statement) para utilizar competency_date
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
      'transaction_id', r.id,
      'tele_id', r.tele_id,
      'tele_code', t.tele_code,
      'type', r.type,
      'direction', r.direction,
      'amount', pg_catalog.round(r.amount, 2),
      'description', r.description,
      'competency_date', r.competency_date,
      'created_at', r.created_at,
      'transaction_category', CASE
        WHEN r.type = 'credito_entrega' THEN 'delivery_earning'
        WHEN r.type = 'ajuste_credito' AND r.idempotency_key LIKE 'credit:%' THEN 'credit'
        WHEN r.type = 'ajuste_credito' THEN 'positive_adjustment'
        WHEN r.type = 'ajuste_debito' AND r.idempotency_key LIKE 'consumable:%' THEN 'consumable'
        WHEN r.type = 'ajuste_debito' THEN 'negative_adjustment'
        WHEN r.type = 'estorno' AND r.direction = 'credit' THEN 'positive_adjustment'
        WHEN r.type = 'estorno' AND r.direction = 'debit' THEN 'negative_adjustment'
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


-- 13. Permissões
REVOKE ALL ON FUNCTION public.admin_create_rider_consumable(UUID, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_rider_consumable(UUID, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, DATE, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_create_rider_consumable(UUID, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, DATE, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_create_rider_adjustment(UUID, TEXT, NUMERIC, TEXT, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_rider_adjustment(UUID, TEXT, NUMERIC, TEXT, DATE, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_create_rider_adjustment(UUID, TEXT, NUMERIC, TEXT, DATE, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_reverse_rider_consumable(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reverse_rider_consumable(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reverse_rider_consumable(UUID, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_reverse_rider_adjustment(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reverse_rider_adjustment(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reverse_rider_adjustment(UUID, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_rider_financial_summary(UUID, DATE, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_get_rider_financial_summary(UUID, DATE, DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_get_rider_financial_summary(UUID, DATE, DATE) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_rider_financial_statement(UUID, DATE, DATE, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_get_rider_financial_statement(UUID, DATE, DATE, INT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_get_rider_financial_statement(UUID, DATE, DATE, INT, INT) TO authenticated;

REVOKE ALL ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_financial_summary(DATE, DATE) TO authenticated;

REVOKE ALL ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_financial_statement(DATE, DATE, INT, INT) TO authenticated;

-- Notificar PostgREST para recarregar o schema cache
NOTIFY pgrst, 'reload schema';
