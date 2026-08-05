-- =====================================================================
-- Dahora Expresso — Additive Migration: Fix Default Rider Percentage to 85%
-- Timestamp: 20260805000300
-- File: supabase/migrations/20260805000300_fix_default_rider_percentage_85.sql
-- Finalidade: Atualizar o percentual padrão de repasse do motoboy para 85.00% (Empresa = 15.00%)
-- =====================================================================

-- 1. Alterar o valor padrão da coluna rider_percentage em public.commercial_clients para 85.00 (novos clientes)
ALTER TABLE public.commercial_clients 
  ALTER COLUMN rider_percentage SET DEFAULT 85.00;

-- 2. Atualizar exclusivamente o cliente interno oficial Dahora Expresso por chave canônica estrita
UPDATE public.commercial_clients
SET rider_percentage = 85.00,
    updated_at = now()
WHERE client_code = 'SYS-DAHORA' OR is_internal = true;
