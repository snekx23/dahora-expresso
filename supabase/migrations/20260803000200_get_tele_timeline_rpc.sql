-- =====================================================================
-- Dahora Expresso — Migration 20260803000200
-- RPC Sanitizada de Leitura da Timeline Administrativa (public.get_tele_timeline)
-- Estritamente restrita a Administradores (is_admin_user()). Ordenação cronológica.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_tele_timeline(p_tele_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_timeline JSONB;
BEGIN
  -- 1. Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Autorização Estritamente Administrativa
  IF NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Acesso negado. Apenas administradores podem visualizar a timeline operacional.');
  END IF;

  -- 3. Validação de Existência da Tele
  IF NOT EXISTS (SELECT 1 FROM public.teles WHERE id = p_tele_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  -- 4. Consulta Deduplicada no Backend e Ordenada Cronologicamente (Mais antigo -> Mais recente)
  WITH raw_events AS (
    SELECT DISTINCT ON (e.id)
      e.id AS event_id,
      e.tipo AS event_type,
      e.created_at,
      COALESCE(up.name, 'Sistema / Operação') AS actor_name,
      e.payload->>'previous_status' AS previous_status,
      e.payload->>'status' AS new_status,
      e.payload->>'reason' AS reason,
      (e.payload->>'rider_id')::uuid AS rider_id,
      f.name AS rider_name
    FROM public.tele_eventos e
    LEFT JOIN public.user_profiles up ON up.user_id = (e.payload->>'actor_user_id')::uuid
    LEFT JOIN public.fleet f ON f.id = (e.payload->>'rider_id')::uuid
    WHERE e.tele_id = p_tele_id
  )
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'event_id', re.event_id,
      'event_type', re.event_type,
      'created_at', re.created_at,
      'actor_name', re.actor_name,
      'previous_status', re.previous_status,
      'new_status', re.new_status,
      'reason', re.reason,
      'rider_id', re.rider_id,
      'rider_name', re.rider_name
    ) ORDER BY re.created_at ASC
  )
  INTO v_timeline
  FROM raw_events re;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'timeline', COALESCE(v_timeline, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_tele_timeline(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_tele_timeline(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_tele_timeline(UUID) TO authenticated;
