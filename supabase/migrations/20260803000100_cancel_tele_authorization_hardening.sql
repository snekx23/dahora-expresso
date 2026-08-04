-- =====================================================================
-- Dahora Expresso — Migration 20260803000100
-- Endurecimento de Autorização e Idempotência da RPC public.cancel_tele
-- Preserva 100% da assinatura, tabelas, ledgers, auditoria e eventos existentes.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.cancel_tele(
  p_tele_id UUID,
  p_expected_version INTEGER,
  p_reason TEXT,
  p_charge_policy TEXT DEFAULT 'sem_cobranca'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_tele RECORD;
  v_is_client_owner BOOLEAN := false;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_new_version INTEGER;
  v_key_event TEXT := pg_catalog.format('tele:%s:cancellation:event:v1', p_tele_id);
  v_key_audit TEXT := pg_catalog.format('tele:%s:cancellation:audit:v1', p_tele_id);
  v_reason_norm TEXT;
  v_policy_norm TEXT;
BEGIN
  -- 1. Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Validação da Versão Esperada
  IF p_expected_version IS NULL OR p_expected_version <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_VERSION_PARAM', 'message', 'Versão esperada deve ser um número inteiro positivo.');
  END IF;

  -- 3. Validação da Política de Cobrança Canônica
  v_policy_norm := LOWER(btrim(COALESCE(p_charge_policy, 'sem_cobranca')));
  IF v_policy_norm NOT IN ('sem_cobranca', 'taxa_parcial', 'cobranca_integral') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_CHARGE_POLICY', 'message', 'Política de cobrança inválida.');
  END IF;

  -- 4. Validação do Motivo
  v_reason_norm := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason_norm IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CANCELLATION_REASON_REQUIRED', 'message', 'Motivo do cancelamento é obrigatório.');
  END IF;

  -- 5. Leitura e Lock da Tele
  SELECT * INTO v_tele FROM public.teles WHERE id = p_tele_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  -- 6. Autorização Definitiva: Utiliza a função canônica public.is_admin_user() ou valida vínculo comercial
  IF NOT public.is_admin_user() THEN
    SELECT EXISTS(
      SELECT 1 FROM public.client_users 
      WHERE user_id = v_user_id AND client_id = v_tele.client_id AND status = 'ativo'
    ) INTO v_is_client_owner;

    IF NOT v_is_client_owner THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Usuário não possui autorização administrativa ou de proprietário para cancelar esta Tele.');
    END IF;

    -- Restrição de status para cliente parceiro: apenas solicitações iniciais antes do despacho/coleta
    IF v_tele.status NOT IN ('solicitada', 'solicitado', 'criada', 'novo', 'aguardando_despacho') THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_CANCELLATION_BLOCKED', 'message', 'Cancelamento pelo cliente não permitido após início do atendimento. Contate o suporte.');
    END IF;
  END IF;

  -- 7. Idempotência: Se já estiver cancelada, não re-executa mutações nem altera a versão
  IF v_tele.status IN ('cancelada', 'cancelado') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 
      'tele_id', p_tele_id, 
      'status', 'cancelada', 
      'version', v_tele.version, 
      'is_already_cancelled', true,
      'message', 'Tele já se encontra cancelada.'
    );
  END IF;

  -- 8. Restrição de Status Concluído
  IF v_tele.status IN ('concluido', 'concluida', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_ALREADY_COMPLETED', 'message', 'Não é possível cancelar uma Tele que já foi concluída.');
  END IF;

  -- 9. Concorrência Otimista de Versão
  IF v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_VERSION_CONFLICT', 'message', 'Esta Tele foi atualizada por outro operador. Os dados serão recarregados.');
  END IF;

  v_new_version := COALESCE(v_tele.version, 1) + 1;

  -- 10. Atualização do Registro na Tabela public.teles
  UPDATE public.teles
  SET 
    status = 'cancelada',
    cancelled_at = v_now,
    cancellation_reason = v_reason_norm,
    version = v_new_version,
    updated_at = v_now
  WHERE id = p_tele_id;

  -- 11. Auditoria e Eventos (Idempotentes via ON CONFLICT)
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_tele.id, 'tele_cancelled',
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'reason', v_reason_norm, 'policy', v_policy_norm, 'actor_user_id', v_user_id, 'cancelled_at', v_now),
    v_key_event, v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES ('user', v_user_id::text, 'tele_cancelled', pg_catalog.format('teles:%s', p_tele_id), pg_catalog.jsonb_build_object('reason', v_reason_norm, 'policy', v_policy_norm), v_key_audit, v_now)
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object('success', true, 'tele_id', p_tele_id, 'status', 'cancelada', 'version', v_new_version);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_tele(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_tele(UUID, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_tele(UUID, INTEGER, TEXT, TEXT) TO authenticated;
