-- =====================================================================
-- Dahora Expresso — Baseline Migration 4: Despacho Seguro & Concorrência
-- Timestamp: 20260727000400
-- =====================================================================

CREATE INDEX IF NOT EXISTS teles_motoboy_status_idx ON public.teles (motoboy_id, status);
CREATE INDEX IF NOT EXISTS teles_status_updated_idx ON public.teles (status, updated_at);
CREATE INDEX IF NOT EXISTS fleet_id_status_idx ON public.fleet (id, status);

-- RPC assign_rider_to_tele com auth.uid() estrito, search_path='' e validação de papéis
CREATE OR REPLACE FUNCTION public.assign_rider_to_tele(
  p_tele_id TEXT,
  p_rider_id TEXT,
  p_expected_version INTEGER,
  p_reason TEXT DEFAULT NULL,
  p_operation_source TEXT DEFAULT 'owner_control_center'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_role TEXT;
  v_tele RECORD;
  v_rider RECORD;
  v_active_count INTEGER := 0;
  v_previous_rider_id TEXT := NULL;
  v_previous_status TEXT := NULL;
  v_new_status TEXT := 'motoboy_designado';
  v_event_type TEXT := 'rider_assigned';
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_new_version INTEGER;
  v_reason_norm TEXT;
BEGIN
  -- 1. Validar Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Validar Papel Autorizado (admin, gerente, operador em user_profiles ou client_users)
  SELECT role INTO v_user_role FROM public.user_profiles WHERE user_id = v_user_id AND is_active = true;
  IF v_user_role IS NULL THEN
    SELECT role INTO v_user_role FROM public.client_users WHERE user_id = v_user_id AND status = 'ativo';
  END IF;

  IF v_user_role IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Usuário sem permissão operacional para despachar.');
  END IF;

  -- 3. Lock transacional da Tele
  SELECT * INTO v_tele 
  FROM public.teles 
  WHERE id::text = p_tele_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  -- 4. Validar Estado Imutável ou Inválido
  v_previous_status := v_tele.status;
  IF v_previous_status IN ('concluido', 'concluida', 'entregue', 'cancelado', 'cancelada') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_STATUS_INVALID', 'message', 'Não é possível despachar uma Tele concluída ou cancelada.');
  END IF;

  -- 5. Validar Versão Otimista
  IF v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 
      'error_code', 'TELE_VERSION_CONFLICT', 
      'message', 'Esta Tele foi atualizada por outro operador. Os dados serão recarregados.',
      'current_version', v_tele.version
    );
  END IF;

  -- 6. Lock transacional do Motoboy
  SELECT * INTO v_rider 
  FROM public.fleet 
  WHERE id::text = p_rider_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_NOT_FOUND', 'message', 'Motoboy não encontrado na frota.');
  END IF;

  IF v_rider.status IN ('Indisponível', 'Bloqueado', 'Inativo') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_UNAVAILABLE', 'message', 'Motoboy indisponível para novos despachos.');
  END IF;

  -- 7. Validar Reatribuição (Troca com motivo obrigatório)
  v_previous_rider_id := v_tele.motoboy_id::text;
  v_reason_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_reason, '')), '');

  IF v_previous_rider_id IS NOT NULL AND v_previous_rider_id <> '' AND v_previous_rider_id <> p_rider_id THEN
    IF v_reason_norm IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'REASSIGN_REASON_REQUIRED', 'message', 'Motivo obrigatório para trocar de motoboy.');
    END IF;
    v_event_type := 'rider_reassigned';
    
    IF v_previous_status IN ('aguardando_coleta', 'coletada', 'em_entrega') THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'REASSIGN_BLOCKED_ADVANCED_STATUS', 'message', 'Troca de motoboy não permitida nesta fase da entrega.');
    END IF;
  END IF;

  -- 8. Validar Capacidade Simultânea
  SELECT pg_catalog.count(*) INTO v_active_count
  FROM public.teles
  WHERE motoboy_id::text = p_rider_id
    AND status IN ('novo', 'solicitada', 'aguardando_despacho', 'atribuido', 'motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_rota', 'em_entrega');

  IF v_active_count >= COALESCE(v_rider.simultaneous_limit, 3) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 
      'error_code', 'RIDER_CAPACITY_REACHED', 
      'message', pg_catalog.format('Capacidade limite atingida para %s (%s/%s).', v_rider.name, v_active_count, COALESCE(v_rider.simultaneous_limit, 3)),
      'rider_name', v_rider.name,
      'active_count', v_active_count,
      'limit', COALESCE(v_rider.simultaneous_limit, 3)
    );
  END IF;

  -- 9. Atualizar Tele
  v_new_version := COALESCE(v_tele.version, 1) + 1;

  UPDATE public.teles
  SET 
    motoboy_id = p_rider_id,
    status = v_new_status,
    version = v_new_version,
    updated_at = v_now
  WHERE id::text = p_tele_id;

  UPDATE public.fleet
  SET delivery = p_tele_id, last_seen = v_now
  WHERE id::text = p_rider_id;

  -- 10. Evento e Auditoria
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, created_at)
  VALUES (
    v_tele.id, v_event_type,
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'rider_id', p_rider_id, 'previous_rider_id', v_previous_rider_id, 'reason', v_reason_norm, 'actor_user_id', v_user_id, 'source', p_operation_source),
    v_now
  );

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, created_at)
  VALUES ('user', v_user_id::text, v_event_type, pg_catalog.format('teles:%s', p_tele_id), pg_catalog.jsonb_build_object('rider_id', p_rider_id, 'reason', v_reason_norm, 'version', v_new_version), v_now);

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'rider_id', p_rider_id,
    'rider_name', v_rider.name,
    'status', v_new_status,
    'version', v_new_version,
    'active_count', v_active_count + 1,
    'simultaneous_limit', COALESCE(v_rider.simultaneous_limit, 3),
    'updated_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_rider_to_tele(TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_rider_to_tele(TEXT, TEXT, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_rider_to_tele(TEXT, TEXT, INTEGER, TEXT, TEXT) TO authenticated;
