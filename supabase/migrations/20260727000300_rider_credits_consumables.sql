-- =====================================================================
-- Dahora Expresso — Baseline Migration 3: Consumíveis e Créditos dos Motoboys
-- Timestamp: 20260727000300
-- =====================================================================

-- 1. Tabela 'rider_credits_ledger'
CREATE TABLE public.rider_credits_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  motoboy_id UUID NOT NULL REFERENCES public.fleet(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT NOT NULL,
  target_date DATE NOT NULL DEFAULT CURRENT_DATE,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rider_credits_ledger_motoboy_idx ON public.rider_credits_ledger (motoboy_id);

-- 2. Tabela 'consumables_catalog' (Catálogo Oficial de Consumíveis)
CREATE TABLE public.consumables_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Consumível',
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Tabela 'rider_consumable_purchases' (Lançamentos de Consumo do Motoboy)
CREATE TABLE public.rider_consumable_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  motoboy_id UUID NOT NULL REFERENCES public.fleet(id) ON DELETE CASCADE,
  motoboy_name TEXT,
  categoria TEXT DEFAULT 'Consumível',
  item_name TEXT NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  amount NUMERIC(10,2) NOT NULL,
  observacao TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rider_consumables_motoboy_idx ON public.rider_consumable_purchases (motoboy_id);

-- RLS
ALTER TABLE public.rider_credits_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumables_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_consumable_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY rider_credits_ledger_select ON public.rider_credits_ledger FOR SELECT TO authenticated USING (true);
CREATE POLICY consumables_catalog_select ON public.consumables_catalog FOR SELECT TO authenticated USING (true);
CREATE POLICY rider_consumable_purchases_select ON public.rider_consumable_purchases FOR SELECT TO authenticated USING (true);
