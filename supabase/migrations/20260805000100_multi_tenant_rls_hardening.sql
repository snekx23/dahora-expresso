-- =====================================================================
-- Dahora Expresso — Additive Migration: Hardening H1 (Multi-Tenant RLS & Grants)
-- Timestamp: 20260805000100
-- Finalidade: Eliminar todas as políticas USING (true) permissivas,
--             bloquear escrita direta não-administrativa em user_profiles,
--             bloquear leitura direta de fleet por clientes comerciais,
--             fornecer RPC sanitizada para rastreamento de entregas pelo cliente,
--             e aplicar double-locking via REVOKE de escrita.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Helper Function: public.my_client_ids()
--    Evita recursão infinita em RLS policies de client_users/commercial_clients
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_client_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT client_id
  FROM public.client_users
  WHERE user_id = auth.uid()
    AND status = 'ativo';
$$;

REVOKE ALL ON FUNCTION public.my_client_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_client_ids() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_client_ids() TO authenticated;

-- ---------------------------------------------------------------------
-- 2. Hardening: public.user_profiles
--    Bloqueio total de escrita direta para não-administradores (Sem subquery recursiva em UPDATE)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS user_profiles_select ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_insert ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_update ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_delete ON public.user_profiles;

CREATE POLICY user_profiles_select ON public.user_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR id = auth.uid() OR public.is_admin_user());

CREATE POLICY user_profiles_insert ON public.user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_user());

CREATE POLICY user_profiles_update ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (public.is_admin_user());

CREATE POLICY user_profiles_delete ON public.user_profiles
  FOR DELETE TO authenticated
  USING (public.is_admin_user());

-- ---------------------------------------------------------------------
-- 3. Hardening: public.commercial_clients
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS commercial_clients_select ON public.commercial_clients;

CREATE POLICY commercial_clients_select ON public.commercial_clients
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR id IN (SELECT public.my_client_ids()));

-- ---------------------------------------------------------------------
-- 4. Hardening: public.client_users
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS client_users_select ON public.client_users;

CREATE POLICY client_users_select ON public.client_users
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR user_id = auth.uid() OR client_id IN (SELECT public.my_client_ids()));

-- ---------------------------------------------------------------------
-- 5. Hardening: public.fleet
--    Leitura direta restrita EXCLUSIVAMENTE a Administradores e ao próprio Motoboy
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS fleet_select ON public.fleet;
DROP POLICY IF EXISTS fleet_all_admin ON public.fleet;
DROP POLICY IF EXISTS fleet_update_self ON public.fleet;

CREATE POLICY fleet_select ON public.fleet
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR user_id = auth.uid());

CREATE POLICY fleet_update_self ON public.fleet
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY fleet_all_admin ON public.fleet
  FOR ALL TO authenticated
  USING (public.is_admin_user());

-- ---------------------------------------------------------------------
-- 6. RPC Sanitizada Read-Only para Rastreamento pelo Cliente Comercial
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_assigned_motoboy_for_client_tele(p_tele_id UUID)
RETURNS TABLE (
  id UUID,
  nome TEXT,
  motoboy_code TEXT,
  placa TEXT,
  modelo_veiculo TEXT,
  status TEXT,
  latitude NUMERIC,
  longitude NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM public.teles t
    WHERE t.id = p_tele_id
      AND (
        public.is_admin_user()
        OR t.client_id IN (
          SELECT cu.client_id 
          FROM public.client_users cu 
          WHERE cu.user_id = auth.uid() AND cu.status = 'ativo'
        )
      )
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 
    f.id,
    f.nome,
    f.motoboy_code,
    f.placa,
    f.modelo_veiculo,
    f.status,
    f.latitude,
    f.longitude
  FROM public.teles t
  JOIN public.fleet f ON f.id = t.motoboy_id
  WHERE t.id = p_tele_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_assigned_motoboy_for_client_tele(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_assigned_motoboy_for_client_tele(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_assigned_motoboy_for_client_tele(UUID) TO authenticated;

-- ---------------------------------------------------------------------
-- 7. Hardening: public.teles
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS teles_select ON public.teles;
DROP POLICY IF EXISTS teles_all_admin ON public.teles;

CREATE POLICY teles_select ON public.teles
  FOR SELECT TO authenticated
  USING (
    public.is_admin_user()
    OR client_id IN (SELECT public.my_client_ids())
    OR motoboy_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())
  );

CREATE POLICY teles_all_admin ON public.teles
  FOR ALL TO authenticated
  USING (public.is_admin_user());

-- ---------------------------------------------------------------------
-- 8. Hardening: public.tele_eventos
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tele_eventos_select ON public.tele_eventos;

CREATE POLICY tele_eventos_select ON public.tele_eventos
  FOR SELECT TO authenticated
  USING (
    public.is_admin_user()
    OR EXISTS (
      SELECT 1 FROM public.teles t
      WHERE t.id = tele_eventos.tele_id
        AND (
          t.client_id IN (SELECT public.my_client_ids())
          OR t.motoboy_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())
        )
    )
  );

-- ---------------------------------------------------------------------
-- 9. Hardening: public.client_financial_transactions
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS client_financial_transactions_select ON public.client_financial_transactions;

CREATE POLICY client_financial_transactions_select ON public.client_financial_transactions
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR client_id IN (SELECT public.my_client_ids()));

-- ---------------------------------------------------------------------
-- 10. Hardening: public.system_audit_logs
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_logs_select ON public.system_audit_logs;
DROP POLICY IF EXISTS system_audit_logs_select ON public.system_audit_logs;

CREATE POLICY system_audit_logs_select ON public.system_audit_logs
  FOR SELECT TO authenticated
  USING (public.is_admin_user());

-- ---------------------------------------------------------------------
-- 11. Hardening: Tabelas Financeiras do Motoboy
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS rider_credits_ledger_select ON public.rider_credits_ledger;
CREATE POLICY rider_credits_ledger_select ON public.rider_credits_ledger
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR motoboy_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS rider_consumable_purchases_select ON public.rider_consumable_purchases;
DROP POLICY IF EXISTS rider_consumable_purchases_all_admin ON public.rider_consumable_purchases;
CREATE POLICY rider_consumable_purchases_select ON public.rider_consumable_purchases
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR motoboy_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid()));

CREATE POLICY rider_consumable_purchases_all_admin ON public.rider_consumable_purchases
  FOR ALL TO authenticated
  USING (public.is_admin_user());

DROP POLICY IF EXISTS rider_fin_tx_select ON public.rider_financial_transactions;
DROP POLICY IF EXISTS rider_financial_transactions_select ON public.rider_financial_transactions;
CREATE POLICY rider_financial_transactions_select ON public.rider_financial_transactions
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR rider_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid()));

-- ---------------------------------------------------------------------
-- 12. Hardening: public.company_financial_transactions
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS company_fin_tx_select ON public.company_financial_transactions;
CREATE POLICY company_financial_transactions_admin ON public.company_financial_transactions
  FOR ALL TO authenticated
  USING (public.is_admin_user());

-- ---------------------------------------------------------------------
-- 13. Hardening: Catálogos Globais
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS cidades_select ON public.cidades;
DROP POLICY IF EXISTS cidades_all_admin ON public.cidades;
CREATE POLICY cidades_select ON public.cidades FOR SELECT TO authenticated USING (true);
CREATE POLICY cidades_all_admin ON public.cidades FOR ALL TO authenticated USING (public.is_admin_user());

DROP POLICY IF EXISTS consumables_catalog_select ON public.consumables_catalog;
CREATE POLICY consumables_catalog_select ON public.consumables_catalog FOR SELECT TO authenticated USING (true);
CREATE POLICY consumables_catalog_admin ON public.consumables_catalog FOR ALL TO authenticated USING (public.is_admin_user());

-- ---------------------------------------------------------------------
-- 14. Hardening: public.client_payment_allocations
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS admin_all_client_payment_allocations ON public.client_payment_allocations;
CREATE POLICY client_payment_allocations_select ON public.client_payment_allocations
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR client_id IN (SELECT public.my_client_ids()));

CREATE POLICY client_payment_allocations_admin_all ON public.client_payment_allocations
  FOR ALL TO authenticated
  USING (public.is_admin_user());

-- ---------------------------------------------------------------------
-- 15. Double-Locking Grants: Revogar Escrita Direta de Usuários Comuns
-- ---------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.user_profiles FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.system_audit_logs FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.company_financial_transactions FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.client_financial_transactions FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.rider_financial_transactions FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.rider_credits_ledger FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.rider_weekly_settlements FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.rider_weekly_settlement_items FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.rider_payment_batches FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.rider_payment_batch_items FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.client_payment_allocations FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.tele_eventos FROM authenticated, anon;
REVOKE INSERT, DELETE ON public.commercial_clients FROM authenticated, anon;
REVOKE INSERT, DELETE ON public.client_users FROM authenticated, anon;
