-- =====================================================================
-- Dahora Expresso — Baseline Migration 1: Core Schema
-- Timestamp: 20260727000100
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabela 'user_profiles' (Perfis e Permissões de Usuários)
CREATE TABLE public.user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operador', 'gerente', 'motoboy', 'client_user')),
  access_level TEXT DEFAULT 'operador',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Tabela 'cidades' (Municípios Atendidos)
CREATE TABLE public.cidades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL UNIQUE,
  uf VARCHAR(2) NOT NULL DEFAULT 'RS',
  ativa BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Tabela 'fleet' (Frota de Motoboys)
CREATE TABLE public.fleet (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  motoboy_code TEXT UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  vehicle TEXT,
  plate TEXT,
  status TEXT NOT NULL DEFAULT 'Ativo',
  simultaneous_limit INTEGER NOT NULL DEFAULT 3,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  last_seen TIMESTAMPTZ,
  battery_level INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fleet_status_idx ON public.fleet (status);
CREATE INDEX fleet_user_id_idx ON public.fleet (user_id);

-- 4. Tabela 'teles' (Solicitações de Entregas)
CREATE TABLE public.teles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tele_code TEXT UNIQUE,
  client_id UUID,
  motoboy_id UUID REFERENCES public.fleet(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'solicitada' CHECK (status IN ('solicitada', 'aguardando_despacho', 'motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_rota', 'em_entrega', 'concluido', 'concluida', 'entregue', 'cancelado', 'cancelada')),
  version INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'manual_admin',
  pickup_address TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_reference TEXT,
  recipient_name TEXT,
  recipient_phone TEXT,
  notes TEXT,
  total_order_amount NUMERIC(12,2) DEFAULT 0.00,
  delivery_charge NUMERIC(12,2) NOT NULL DEFAULT 15.00,
  pricing_rule_source TEXT DEFAULT 'fallback_default',
  pricing_rule_version TEXT DEFAULT 'v1_fallback',
  client_request_idempotency_key TEXT,
  admin_request_idempotency_key TEXT,
  payment_method TEXT DEFAULT 'Faturado',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  CONSTRAINT teles_client_idempotency_unique UNIQUE (client_id, client_request_idempotency_key)
);

CREATE INDEX teles_status_idx ON public.teles (status);
CREATE INDEX teles_motoboy_id_idx ON public.teles (motoboy_id);
CREATE INDEX teles_created_at_idx ON public.teles (created_at);

-- 5. Tabela 'tele_eventos' (Timeline Imutável de Eventos da Tele)
CREATE TABLE public.tele_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tele_id UUID NOT NULL REFERENCES public.teles(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  payload JSONB DEFAULT '{}'::jsonb,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tele_eventos_tele_id_idx ON public.tele_eventos (tele_id, created_at);

-- RLS Inicial nas Tabelas Core
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tele_eventos ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_profiles_select ON public.user_profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY cidades_select ON public.cidades FOR SELECT TO authenticated USING (true);
CREATE POLICY fleet_select ON public.fleet FOR SELECT TO authenticated USING (true);
CREATE POLICY teles_select ON public.teles FOR SELECT TO authenticated USING (true);
CREATE POLICY tele_eventos_select ON public.tele_eventos FOR SELECT TO authenticated USING (true);
