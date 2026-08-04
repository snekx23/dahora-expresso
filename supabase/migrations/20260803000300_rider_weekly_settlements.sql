-- =====================================================================
-- Dahora Expresso — Migration 20260803000300
-- Fase 3A: Fundação Financeira Canônica e Fechamento Semanal (DDL, RLS & Menor Privilégio)
-- Preserva 100% das migrations da Fase 1 e Fase 2.
-- =====================================================================

-- 1. Coluna ocorreu_em em public.rider_consumable_purchases
ALTER TABLE public.rider_consumable_purchases 
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 2. Tabela public.client_payment_allocations (Alocação de Pagamento do Cliente Comercial às Teles)
CREATE TABLE IF NOT EXISTS public.client_payment_allocations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                   UUID NOT NULL REFERENCES public.commercial_clients(id) ON DELETE RESTRICT,
  client_transaction_id       UUID NOT NULL REFERENCES public.client_financial_transactions(id) ON DELETE RESTRICT,
  tele_id                     UUID NOT NULL REFERENCES public.teles(id) ON DELETE RESTRICT,
  allocated_amount            NUMERIC(10,2) NOT NULL CHECK (allocated_amount > 0),
  is_fully_covered            BOOLEAN NOT NULL DEFAULT false,
  allocated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  allocated_by                UUID REFERENCES auth.users(id),
  CONSTRAINT unique_client_tele_allocation UNIQUE (client_transaction_id, tele_id)
);

CREATE INDEX IF NOT EXISTS client_alloc_client_idx ON public.client_payment_allocations (client_id);
CREATE INDEX IF NOT EXISTS client_alloc_tele_idx ON public.client_payment_allocations (tele_id);

-- 3. Tabela public.rider_weekly_settlements (Cabeçalho do Fechamento Semanal Imutável)
CREATE TABLE IF NOT EXISTS public.rider_weekly_settlements (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id                    UUID NOT NULL REFERENCES public.fleet(id) ON DELETE RESTRICT,
  workspace_id                UUID DEFAULT NULL,
  period_start                TIMESTAMPTZ NOT NULL,
  period_end                  TIMESTAMPTZ NOT NULL,
  gross_delivery_amount       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  base_rider_amount           NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  platform_amount             NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  consumables_amount          NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  credits_amount              NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  positive_adjustments_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  negative_adjustments_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  reversals_amount            NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  net_amount                  NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  eligible_amount             NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  blocked_amount              NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  paid_amount                 NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  status                      TEXT NOT NULL DEFAULT 'open' 
                              CHECK (status IN ('open', 'calculated', 'pending', 'partially_blocked', 'paid', 'reopened', 'reversed', 'cancelled')),
  calculated_at               TIMESTAMPTZ DEFAULT NULL,
  closed_at                   TIMESTAMPTZ DEFAULT NULL,
  version                     INTEGER NOT NULL DEFAULT 1,
  idempotency_key             TEXT UNIQUE DEFAULT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rider_settlement_period_unique UNIQUE (rider_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS rider_settlement_rider_idx ON public.rider_weekly_settlements (rider_id);
CREATE INDEX IF NOT EXISTS rider_settlement_period_idx ON public.rider_weekly_settlements (period_start, period_end);

-- 4. Tabela public.rider_weekly_settlement_items (Linhas do Fechamento Semanal)
CREATE TABLE IF NOT EXISTS public.rider_weekly_settlement_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id       UUID NOT NULL REFERENCES public.rider_weekly_settlements(id) ON DELETE CASCADE,
  source_type         TEXT NOT NULL CHECK (source_type IN ('rider_earning', 'consumable', 'credit', 'positive_adjustment', 'negative_adjustment', 'reversal', 'payment_release')),
  source_id           UUID NOT NULL,
  tele_id             UUID REFERENCES public.teles(id) ON DELETE RESTRICT DEFAULT NULL,
  client_id           UUID REFERENCES public.commercial_clients(id) ON DELETE RESTRICT DEFAULT NULL,
  original_amount     NUMERIC(12,2) NOT NULL CHECK (original_amount >= 0),
  eligible_amount     NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (eligible_amount >= 0),
  blocked_amount      NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (blocked_amount >= 0),
  paid_amount         NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (paid_amount >= 0),
  direction           TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  funding_status      TEXT NOT NULL DEFAULT 'eligible' CHECK (funding_status IN ('eligible', 'blocked_client_unpaid', 'paid', 'reversed')),
  occurred_at         TIMESTAMPTZ NOT NULL,
  description         TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_settlement_source UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS settlement_items_settlement_idx ON public.rider_weekly_settlement_items (settlement_id);
CREATE INDEX IF NOT EXISTS settlement_items_source_idx ON public.rider_weekly_settlement_items (source_type, source_id);

-- 5. Tabela public.rider_payment_batches (Lotes de Pagamento Efetivos)
CREATE TABLE IF NOT EXISTS public.rider_payment_batches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id            UUID NOT NULL REFERENCES public.fleet(id) ON DELETE RESTRICT,
  settlement_id       UUID REFERENCES public.rider_weekly_settlements(id) ON DELETE RESTRICT,
  batch_type          TEXT NOT NULL DEFAULT 'regular_weekly' CHECK (batch_type IN ('regular_weekly', 'complementary_release')),
  total_paid_amount   NUMERIC(12,2) NOT NULL CHECK (total_paid_amount > 0),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft', 'pending', 'paid', 'reversed')),
  payment_method      TEXT NOT NULL DEFAULT 'PIX',
  payment_reference   TEXT DEFAULT NULL,
  notes               TEXT DEFAULT NULL,
  paid_at             TIMESTAMPTZ DEFAULT NULL,
  paid_by             UUID REFERENCES auth.users(id) DEFAULT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  idempotency_key     TEXT UNIQUE DEFAULT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_batches_rider_idx ON public.rider_payment_batches (rider_id);

-- 6. Tabela public.rider_payment_batch_items (Itens Liquidados por Lote)
CREATE TABLE IF NOT EXISTS public.rider_payment_batch_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            UUID NOT NULL REFERENCES public.rider_payment_batches(id) ON DELETE CASCADE,
  settlement_item_id  UUID NOT NULL REFERENCES public.rider_weekly_settlement_items(id) ON DELETE RESTRICT,
  amount_paid         NUMERIC(12,2) NOT NULL CHECK (amount_paid > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_batch_item UNIQUE (batch_id, settlement_item_id)
);

CREATE INDEX IF NOT EXISTS batch_items_batch_idx ON public.rider_payment_batch_items (batch_id);

-- Trigger Autoritativa com LOCK TRANSACIONAL (FOR UPDATE) Contra Duplo Pagamento e Respeito ao Teto Liberado
CREATE OR REPLACE FUNCTION public.check_rider_item_double_payment()
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
  -- 1. BLOQUEIO TRANSACIONAL DA LINHA (ROW LOCK FOR UPDATE)
  -- Garante que duas transações simultâneas leiam o mesmo saldo em série estrita
  SELECT eligible_amount, original_amount INTO v_current_eligible, v_original_amount
  FROM public.rider_weekly_settlement_items
  WHERE id = NEW.settlement_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NOT_FOUND: Item de fechamento % não encontrado.', NEW.settlement_item_id;
  END IF;

  -- 2. CALCULAR TOTAL JÁ PAGO EM LOTES ATIVOS (NÃO REVERSED)
  SELECT COALESCE(SUM(pbi.amount_paid), 0.00) INTO v_already_paid
  FROM public.rider_payment_batch_items pbi
  JOIN public.rider_payment_batches pb ON pb.id = pbi.batch_id
  WHERE pbi.settlement_item_id = NEW.settlement_item_id
    AND pb.status <> 'reversed'
    AND pbi.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  -- 3. REGRA ABSOLUTA DE TETO POR ELEGÍVEL LIBERADO ACUMULADO
  IF (v_already_paid + NEW.amount_paid) > v_current_eligible THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT_DENIED: Tentativa de pagar R$ % para um item com R$ % elegíveis liberados (já pago: R$ %).',
      NEW.amount_paid, v_current_eligible, v_already_paid;
  END IF;

  -- 4. REGRA ABSOLUTA DE TETO POR VALOR ORIGINAL DO ITEM
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
  EXECUTE FUNCTION public.check_rider_item_double_payment();

-- Habilitar RLS em todas as tabelas criadas
ALTER TABLE public.client_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_weekly_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_weekly_settlement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_payment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_payment_batch_items ENABLE ROW LEVEL SECURITY;

-- Políticas de RLS para Leitura Restrita
DROP POLICY IF EXISTS admin_all_client_payment_allocations ON public.client_payment_allocations;
CREATE POLICY admin_all_client_payment_allocations ON public.client_payment_allocations
  FOR SELECT TO authenticated USING (public.is_admin_user());

DROP POLICY IF EXISTS admin_all_rider_weekly_settlements ON public.rider_weekly_settlements;
CREATE POLICY admin_all_rider_weekly_settlements ON public.rider_weekly_settlements
  FOR SELECT TO authenticated USING (public.is_admin_user());

DROP POLICY IF EXISTS rider_select_rider_weekly_settlements ON public.rider_weekly_settlements;
CREATE POLICY rider_select_rider_weekly_settlements ON public.rider_weekly_settlements
  FOR SELECT TO authenticated USING (
    rider_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS admin_all_rider_weekly_settlement_items ON public.rider_weekly_settlement_items;
CREATE POLICY admin_all_rider_weekly_settlement_items ON public.rider_weekly_settlement_items
  FOR SELECT TO authenticated USING (public.is_admin_user());

DROP POLICY IF EXISTS rider_select_rider_weekly_settlement_items ON public.rider_weekly_settlement_items;
CREATE POLICY rider_select_rider_weekly_settlement_items ON public.rider_weekly_settlement_items
  FOR SELECT TO authenticated USING (
    settlement_id IN (
      SELECT id FROM public.rider_weekly_settlements 
      WHERE rider_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS admin_all_rider_payment_batches ON public.rider_payment_batches;
CREATE POLICY admin_all_rider_payment_batches ON public.rider_payment_batches
  FOR SELECT TO authenticated USING (public.is_admin_user());

DROP POLICY IF EXISTS rider_select_rider_payment_batches ON public.rider_payment_batches;
CREATE POLICY rider_select_rider_payment_batches ON public.rider_payment_batches
  FOR SELECT TO authenticated USING (
    rider_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS admin_all_rider_payment_batch_items ON public.rider_payment_batch_items;
CREATE POLICY admin_all_rider_payment_batch_items ON public.rider_payment_batch_items
  FOR SELECT TO authenticated USING (public.is_admin_user());

DROP POLICY IF EXISTS rider_select_rider_payment_batch_items ON public.rider_payment_batch_items;
CREATE POLICY rider_select_rider_payment_batch_items ON public.rider_payment_batch_items
  FOR SELECT TO authenticated USING (
    batch_id IN (
      SELECT id FROM public.rider_payment_batches 
      WHERE rider_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())
    )
  );

-- APLICAÇÃO RÍGIDA DO PRINCÍPIO DO MENOR PRIVILÉGIO
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.client_payment_allocations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.rider_weekly_settlements FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.rider_weekly_settlement_items FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.rider_payment_batches FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.rider_payment_batch_items FROM authenticated;

GRANT SELECT ON TABLE public.client_payment_allocations TO authenticated;
GRANT SELECT ON TABLE public.rider_weekly_settlements TO authenticated;
GRANT SELECT ON TABLE public.rider_weekly_settlement_items TO authenticated;
GRANT SELECT ON TABLE public.rider_payment_batches TO authenticated;
GRANT SELECT ON TABLE public.rider_payment_batch_items TO authenticated;

GRANT ALL ON TABLE public.client_payment_allocations TO service_role;
GRANT ALL ON TABLE public.rider_weekly_settlements TO service_role;
GRANT ALL ON TABLE public.rider_weekly_settlement_items TO service_role;
GRANT ALL ON TABLE public.rider_payment_batches TO service_role;
GRANT ALL ON TABLE public.rider_payment_batch_items TO service_role;
