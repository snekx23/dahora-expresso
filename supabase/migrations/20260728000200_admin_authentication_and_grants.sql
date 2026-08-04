-- =====================================================================
-- Dahora Expresso — Migration 20260728000200: Admin Authentication & Table Grants
-- Timestamp: 20260728000200
-- =====================================================================

-- 1. Conceder permissões de tabela para a role authenticated
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cidades TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fleet TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tele_eventos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commercial_clients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_financial_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rider_credits_ledger TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.consumables_catalog TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rider_consumable_purchases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rider_financial_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_financial_transactions TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- 2. Função auxiliar de segurança para verificar se o usuário autenticado é admin/owner/operador
CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE (up.user_id = auth.uid() OR up.id = auth.uid())
      AND up.is_active = true
      AND up.role IN ('owner', 'admin', 'operador', 'gerente')
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_user() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin_user() TO authenticated;

-- 3. Atualizar/Reforçar RLS Policies para Administradores

-- user_profiles: Admin visualiza todos os perfis; Usuário comum visualiza seu próprio perfil
DROP POLICY IF EXISTS user_profiles_select ON public.user_profiles;
CREATE POLICY user_profiles_select ON public.user_profiles
FOR SELECT TO authenticated
USING (
  (user_id = auth.uid() OR id = auth.uid())
  OR public.is_admin_user()
);

DROP POLICY IF EXISTS user_profiles_insert ON public.user_profiles;
CREATE POLICY user_profiles_insert ON public.user_profiles
FOR INSERT TO authenticated
WITH CHECK (public.is_admin_user());

DROP POLICY IF EXISTS user_profiles_update ON public.user_profiles;
CREATE POLICY user_profiles_update ON public.user_profiles
FOR UPDATE TO authenticated
USING (
  (user_id = auth.uid() OR id = auth.uid())
  OR public.is_admin_user()
);

-- cidades: Leitura por usuários autenticados, modificação por admin
DROP POLICY IF EXISTS cidades_select ON public.cidades;
CREATE POLICY cidades_select ON public.cidades
FOR SELECT TO authenticated
USING (true);

DROP POLICY IF EXISTS cidades_all_admin ON public.cidades;
CREATE POLICY cidades_all_admin ON public.cidades
FOR ALL TO authenticated
USING (public.is_admin_user());

-- fleet: Leitura por usuários autenticados (admin/operador/motoboy), modificação por admin
DROP POLICY IF EXISTS fleet_select ON public.fleet;
CREATE POLICY fleet_select ON public.fleet
FOR SELECT TO authenticated
USING (
  public.is_admin_user()
  OR user_id = auth.uid()
);

DROP POLICY IF EXISTS fleet_all_admin ON public.fleet;
CREATE POLICY fleet_all_admin ON public.fleet
FOR ALL TO authenticated
USING (public.is_admin_user());

-- teles: Admin gerencia todas as teles; Cliente vê/cria suas teles
DROP POLICY IF EXISTS teles_select ON public.teles;
CREATE POLICY teles_select ON public.teles
FOR SELECT TO authenticated
USING (
  public.is_admin_user()
  OR client_id IN (
    SELECT cu.client_id
    FROM public.client_users cu
    WHERE cu.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS teles_all_admin ON public.teles;
CREATE POLICY teles_all_admin ON public.teles
FOR ALL TO authenticated
USING (public.is_admin_user());

-- rider_consumable_purchases: Admin gerencia todas; motoboy vê/cria suas compras
DROP POLICY IF EXISTS rider_consumable_purchases_select ON public.rider_consumable_purchases;
CREATE POLICY rider_consumable_purchases_select ON public.rider_consumable_purchases
FOR SELECT TO authenticated
USING (
  public.is_admin_user()
  OR motoboy_id IN (
    SELECT f.id FROM public.fleet f WHERE f.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS rider_consumable_purchases_all_admin ON public.rider_consumable_purchases;
CREATE POLICY rider_consumable_purchases_all_admin ON public.rider_consumable_purchases
FOR ALL TO authenticated
USING (public.is_admin_user());
