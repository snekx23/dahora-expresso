-- Migration: 20260809000100_distance_bypass_and_realtime_hardening.sql
-- 1. Assegurar coluna bypass_distance_limit em public.fleet
ALTER TABLE public.fleet ADD COLUMN IF NOT EXISTS bypass_distance_limit BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Garantir REPLICA IDENTITY FULL em public.teles para Realtime enviar payload.old completo
ALTER TABLE public.teles REPLICA IDENTITY FULL;

-- 3. Assegurar public.fleet e public.teles na publicação supabase_realtime
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fleet, public.teles;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

-- 4. Atualizar RPC mark_my_tele_collected com validação dos 3km autoritativa e suporte a bypass_distance_limit
CREATE OR REPLACE FUNCTION public.mark_my_tele_collected(
  p_tele_id UUID,
  p_expected_version INTEGER DEFAULT NULL,
  p_rider_lat DOUBLE PRECISION DEFAULT NULL,
  p_rider_lng DOUBLE PRECISION DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_fleet_id UUID;
  v_bypass BOOLEAN := FALSE;
  v_fleet_lat DOUBLE PRECISION;
  v_fleet_lng DOUBLE PRECISION;
  v_rider_lat DOUBLE PRECISION;
  v_rider_lng DOUBLE PRECISION;
  v_tele RECORD;
  v_client_pct NUMERIC(5,2);
  v_new_version INTEGER;
  v_key_event TEXT;
  v_key_audit TEXT;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_dlat DOUBLE PRECISION;
  v_dlon DOUBLE PRECISION;
  v_a DOUBLE PRECISION;
  v_dist_km DOUBLE PRECISION;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  SELECT f.id, COALESCE(f.bypass_distance_limit, false), f.lat, f.lng
  INTO v_fleet_id, v_bypass, v_fleet_lat, v_fleet_lng
  FROM public.fleet f
  WHERE f.user_id = v_user_id;

  IF v_fleet_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não encontrado.');
  END IF;

  SELECT t.id, t.status, t.version, t.motoboy_id, t.client_id, t.rider_percentage, t.pickup_latitude, t.pickup_longitude
  INTO v_tele
  FROM public.teles t
  WHERE t.id = p_tele_id
  FOR UPDATE;

  IF v_tele.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele.motoboy_id IS NULL OR v_tele.motoboy_id <> v_fleet_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'FORBIDDEN_NOT_YOUR_TELE', 'message', 'Esta entrega não pertence a você.');
  END IF;

  IF v_tele.status IN ('cancelada', 'cancelado') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_CANCELLED', 'message', 'Esta entrega foi cancelada.');
  END IF;

  IF v_tele.status IN ('concluida', 'concluido', 'entregue') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_COMPLETED', 'message', 'Esta entrega já foi concluída.');
  END IF;

  IF v_tele.status NOT IN ('motoboy_designado', 'indo_coletar', 'aguardando_coleta') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_TRANSITION', 'message', 'Transição para coletada inválida a partir do status atual.');
  END IF;

  IF p_expected_version IS NOT NULL AND v_tele.version IS NOT NULL AND v_tele.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'TELE_VERSION_CONFLICT', 'message', 'A tele foi alterada por outro usuário.', 'current_version', v_tele.version);
  END IF;

  -- Validação dos 3km (Regra Padrão autoritativa no Backend)
  IF NOT v_bypass THEN
    v_rider_lat := COALESCE(p_rider_lat, v_fleet_lat);
    v_rider_lng := COALESCE(p_rider_lng, v_fleet_lng);

    IF v_tele.pickup_latitude IS NOT NULL AND v_tele.pickup_longitude IS NOT NULL AND v_rider_lat IS NOT NULL AND v_rider_lng IS NOT NULL THEN
      v_dlat := radians(v_tele.pickup_latitude - v_rider_lat);
      v_dlon := radians(v_tele.pickup_longitude - v_rider_lng);
      v_a := (sin(v_dlat / 2.0)^2) + (cos(radians(v_rider_lat)) * cos(radians(v_tele.pickup_latitude)) * (sin(v_dlon / 2.0)^2));
      v_dist_km := 6371.0 * 2.0 * atan2(sqrt(v_a), sqrt(GREATEST(0.0, 1.0 - v_a)));

      IF v_dist_km > 3.0 THEN
        RETURN pg_catalog.jsonb_build_object(
          'success', false,
          'error_code', 'DISTANCE_TOO_FAR',
          'message', 'Você está muito longe do ponto de coleta. Aproxime-se para marcar esta Tele como coletada.'
        );
      END IF;
    END IF;
  END IF;

  v_new_version := COALESCE(v_tele.version, 1) + 1;

  IF v_tele.rider_percentage IS NULL THEN
    IF v_tele.client_id IS NOT NULL THEN
      SELECT c.rider_percentage INTO v_client_pct FROM public.commercial_clients c WHERE c.id = v_tele.client_id;
    END IF;
    IF v_client_pct IS NULL THEN
      SELECT c.rider_percentage INTO v_client_pct FROM public.commercial_clients c WHERE c.establishment_name = 'Dahora Expresso' LIMIT 1;
    END IF;
  END IF;

  UPDATE public.teles
  SET status = 'coletada',
      version = v_new_version,
      updated_at = v_now,
      rider_percentage = COALESCE(v_tele.rider_percentage, v_client_pct)
  WHERE id = p_tele_id;

  v_key_event := pg_catalog.format('tele:%s:collected:event:v1', p_tele_id);
  v_key_audit := pg_catalog.format('tele:%s:collected:audit:v1', p_tele_id);

  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    p_tele_id,
    'tele_collected',
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'previous_status', v_tele.status, 'new_status', 'coletada', 'actor_user_id', v_user_id),
    v_key_event,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'rider', v_user_id::text, 'tele_collected', pg_catalog.format('teles:%s', p_tele_id),
    pg_catalog.jsonb_build_object('tele_id', p_tele_id, 'version', v_new_version),
    v_key_audit,
    v_now
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object('success', true, 'tele_id', p_tele_id, 'status', 'coletada', 'version', v_new_version, 'updated_at', v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_my_tele_collected(UUID, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_my_tele_collected(UUID, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_my_tele_collected(UUID, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
