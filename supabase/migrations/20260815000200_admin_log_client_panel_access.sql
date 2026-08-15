-- Migration: 20260815000200_admin_log_client_panel_access.sql
-- Descrição: RPC de auditoria obrigatória para acesso administrativo à visualização de painel do cliente comercial.

CREATE OR REPLACE FUNCTION public.admin_log_client_panel_access(
  p_client_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_user_role TEXT;
  v_client_record RECORD;
  v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
  -- 1. Validar autenticação do usuário chamador via auth.uid()
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Usuário não autenticado.';
  END IF;

  -- 2. Validar perfil e permissão administrativa canônica (owner, admin, operador, gerente) no backend
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_profiles') THEN
    SELECT role INTO v_user_role
    FROM public.user_profiles
    WHERE user_id = v_user_id OR id = v_user_id;
  END IF;

  IF v_user_role IS NULL AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'perfis') THEN
    SELECT role INTO v_user_role
    FROM public.perfis
    WHERE id = v_user_id OR user_id = v_user_id;
  END IF;

  IF v_user_role IS NULL OR v_user_role NOT IN ('owner', 'admin', 'operador', 'gerente') THEN
    RAISE EXCEPTION 'Acesso negado: Somente administradores podem acessar a visualização de painel do cliente.';
  END IF;

  -- 3. Validar se o cliente comercial existe no PostgreSQL
  SELECT id, establishment_name, client_code INTO v_client_record
  FROM public.commercial_clients
  WHERE id = p_client_id;

  IF v_client_record.id IS NULL THEN
    RAISE EXCEPTION 'Cliente comercial não encontrado (ID: %).', p_client_id;
  END IF;

  -- 4. Gravar log de auditoria imutável em public.system_audit_logs (sem deduplicação por chave de idempotência)
  INSERT INTO public.system_audit_logs (
    actor_type,
    actor_id,
    action,
    target_resource,
    details,
    created_at
  )
  VALUES (
    'admin',
    v_user_id::text,
    'ADMIN_CLIENT_PANEL_OPENED',
    pg_catalog.format('commercial_clients:%s', p_client_id),
    pg_catalog.jsonb_build_object(
      'admin_user_id', v_user_id,
      'client_id', p_client_id,
      'client_code', v_client_record.client_code,
      'establishment_name', v_client_record.establishment_name,
      'timestamp', v_now
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'client_id', p_client_id,
    'establishment_name', v_client_record.establishment_name,
    'client_code', v_client_record.client_code,
    'logged_at', v_now
  );
END;
$$;

-- Restringir permissões de execução e garantir owner postgres para SECURITY DEFINER
ALTER FUNCTION public.admin_log_client_panel_access(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_log_client_panel_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_log_client_panel_access(UUID) TO authenticated;
