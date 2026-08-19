-- =====================================================================
-- Dahora Expresso — Módulo de Perfil do Cliente Comercial (RPCs Autoritativas)
-- Migration: 20260819140000_client_profile_rpcs.sql
-- =====================================================================

-- 1. RPC de Leitura de Perfil pelo Próprio Cliente Comercial
CREATE OR REPLACE FUNCTION public.get_my_commercial_client_profile()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_client_id UUID;
  v_profile RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'UNAUTHORIZED',
      'message', 'Usuário não autenticado.'
    );
  END IF;

  SELECT client_id INTO v_client_id
  FROM public.client_users
  WHERE user_id = v_user_id AND status = 'ativo'
  LIMIT 1;

  IF v_client_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'CLIENT_NOT_FOUND',
      'message', 'Nenhum estabelecimento comercial associado ao usuário.'
    );
  END IF;

  SELECT
    id,
    client_code,
    establishment_name,
    responsible_name,
    phone,
    email,
    document,
    address,
    street_number,
    neighborhood,
    city,
    state,
    postal_code,
    pickup_latitude,
    pickup_longitude,
    pickup_place_id,
    lifecycle_status,
    financial_status,
    created_at,
    updated_at
  INTO v_profile
  FROM public.commercial_clients
  WHERE id = v_client_id;

  IF v_profile.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'CLIENT_NOT_FOUND',
      'message', 'Dados do cliente não encontrados.'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'client_id', v_profile.id,
    'client_code', v_profile.client_code,
    'establishment_name', v_profile.establishment_name,
    'responsible_name', v_profile.responsible_name,
    'phone', v_profile.phone,
    'email', v_profile.email,
    'document', v_profile.document,
    'address', COALESCE(v_profile.address, ''),
    'street_number', COALESCE(v_profile.street_number, ''),
    'neighborhood', COALESCE(v_profile.neighborhood, ''),
    'city', COALESCE(v_profile.city, 'Sapucaia do Sul'),
    'state', COALESCE(v_profile.state, 'RS'),
    'postal_code', COALESCE(v_profile.postal_code, ''),
    'pickup_latitude', v_profile.pickup_latitude,
    'pickup_longitude', v_profile.pickup_longitude,
    'pickup_place_id', COALESCE(v_profile.pickup_place_id, ''),
    'lifecycle_status', v_profile.lifecycle_status,
    'financial_status', v_profile.financial_status,
    'created_at', v_profile.created_at,
    'updated_at', v_profile.updated_at
  );
END;
$$;

-- 2. RPC de Leitura de Perfil pelo Admin (Impersonation)
CREATE OR REPLACE FUNCTION public.admin_get_commercial_client_profile(
  p_client_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_profile RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'FORBIDDEN',
      'message', 'Acesso permitido apenas para administradores.'
    );
  END IF;

  IF p_client_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_PARAM',
      'message', 'ID do cliente não informado.'
    );
  END IF;

  SELECT
    id,
    client_code,
    establishment_name,
    responsible_name,
    phone,
    email,
    document,
    address,
    street_number,
    neighborhood,
    city,
    state,
    postal_code,
    pickup_latitude,
    pickup_longitude,
    pickup_place_id,
    lifecycle_status,
    financial_status,
    created_at,
    updated_at
  INTO v_profile
  FROM public.commercial_clients
  WHERE id = p_client_id;

  IF v_profile.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'CLIENT_NOT_FOUND',
      'message', 'Dados do cliente não encontrados.'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'client_id', v_profile.id,
    'client_code', v_profile.client_code,
    'establishment_name', v_profile.establishment_name,
    'responsible_name', v_profile.responsible_name,
    'phone', v_profile.phone,
    'email', v_profile.email,
    'document', v_profile.document,
    'address', COALESCE(v_profile.address, ''),
    'street_number', COALESCE(v_profile.street_number, ''),
    'neighborhood', COALESCE(v_profile.neighborhood, ''),
    'city', COALESCE(v_profile.city, 'Sapucaia do Sul'),
    'state', COALESCE(v_profile.state, 'RS'),
    'postal_code', COALESCE(v_profile.postal_code, ''),
    'pickup_latitude', v_profile.pickup_latitude,
    'pickup_longitude', v_profile.pickup_longitude,
    'pickup_place_id', COALESCE(v_profile.pickup_place_id, ''),
    'lifecycle_status', v_profile.lifecycle_status,
    'financial_status', v_profile.financial_status,
    'created_at', v_profile.created_at,
    'updated_at', v_profile.updated_at
  );
END;
$$;

-- 3. RPC de Atualização do Perfil pelo Cliente Comercial
CREATE OR REPLACE FUNCTION public.update_my_commercial_client_profile(
  p_responsible_name TEXT,
  p_phone TEXT,
  p_address TEXT,
  p_street_number TEXT DEFAULT NULL,
  p_neighborhood TEXT DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_state TEXT DEFAULT 'RS',
  p_postal_code TEXT DEFAULT NULL,
  p_pickup_latitude DOUBLE PRECISION DEFAULT NULL,
  p_pickup_longitude DOUBLE PRECISION DEFAULT NULL,
  p_pickup_place_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_client_id UUID;
  v_clean_resp TEXT;
  v_clean_phone TEXT;
  v_clean_addr TEXT;
  v_clean_state TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'UNAUTHORIZED',
      'message', 'Usuário não autenticado.'
    );
  END IF;

  SELECT client_id INTO v_client_id
  FROM public.client_users
  WHERE user_id = v_user_id AND status = 'ativo'
  LIMIT 1;

  IF v_client_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'CLIENT_NOT_FOUND',
      'message', 'Nenhum estabelecimento comercial associado ao usuário.'
    );
  END IF;

  v_clean_resp := pg_catalog.btrim(COALESCE(p_responsible_name, ''));
  v_clean_phone := pg_catalog.btrim(COALESCE(p_phone, ''));
  v_clean_addr := pg_catalog.btrim(COALESCE(p_address, ''));
  v_clean_state := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_state, 'RS')));

  IF pg_catalog.length(v_clean_resp) < 2 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_PARAM',
      'message', 'O nome do responsável deve ter ao menos 2 caracteres.'
    );
  END IF;

  IF pg_catalog.length(v_clean_phone) < 8 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_PARAM',
      'message', 'Telefone inválido.'
    );
  END IF;

  IF pg_catalog.length(v_clean_addr) < 5 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_PARAM',
      'message', 'O endereço de coleta deve ser preenchido.'
    );
  END IF;

  IF v_clean_state <> 'RS' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'STATE_NOT_ALLOWED',
      'message', 'A operação é restrita ao estado do Rio Grande do Sul (RS).'
    );
  END IF;

  IF p_pickup_latitude IS NOT NULL AND (p_pickup_latitude < -90 OR p_pickup_latitude > 90) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_COORDINATES',
      'message', 'Latitude fora dos limites válidos (-90 a 90).'
    );
  END IF;

  IF p_pickup_longitude IS NOT NULL AND (p_pickup_longitude < -180 OR p_pickup_longitude > 180) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_COORDINATES',
      'message', 'Longitude fora dos limites válidos (-180 a 180).'
    );
  END IF;

  UPDATE public.commercial_clients
  SET
    responsible_name = v_clean_resp,
    phone = v_clean_phone,
    address = v_clean_addr,
    street_number = NULLIF(pg_catalog.btrim(COALESCE(p_street_number, '')), ''),
    neighborhood = NULLIF(pg_catalog.btrim(COALESCE(p_neighborhood, '')), ''),
    city = COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_city, '')), ''), 'Sapucaia do Sul'),
    state = v_clean_state,
    postal_code = NULLIF(pg_catalog.btrim(COALESCE(p_postal_code, '')), ''),
    pickup_latitude = p_pickup_latitude,
    pickup_longitude = p_pickup_longitude,
    pickup_place_id = NULLIF(pg_catalog.btrim(COALESCE(p_pickup_place_id, '')), ''),
    updated_at = clock_timestamp()
  WHERE id = v_client_id;

  INSERT INTO public.system_audit_logs (
    actor_type, actor_id, action, target_resource, details, created_at
  ) VALUES (
    'client_user',
    v_user_id::text,
    'UPDATE_COMMERCIAL_CLIENT_PROFILE',
    pg_catalog.format('commercial_clients:%s', v_client_id),
    pg_catalog.jsonb_build_object(
      'responsible_name', v_clean_resp,
      'phone', v_clean_phone,
      'address', v_clean_addr
    ),
    clock_timestamp()
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'client_id', v_client_id,
    'message', 'Perfil atualizado com sucesso.'
  );
END;
$$;

-- 4. RPC de Atualização do Perfil pelo Admin (Impersonation / Admin Actions)
CREATE OR REPLACE FUNCTION public.admin_update_commercial_client_profile(
  p_client_id UUID,
  p_responsible_name TEXT,
  p_phone TEXT,
  p_address TEXT,
  p_street_number TEXT DEFAULT NULL,
  p_neighborhood TEXT DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_state TEXT DEFAULT 'RS',
  p_postal_code TEXT DEFAULT NULL,
  p_pickup_latitude DOUBLE PRECISION DEFAULT NULL,
  p_pickup_longitude DOUBLE PRECISION DEFAULT NULL,
  p_pickup_place_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_clean_resp TEXT;
  v_clean_phone TEXT;
  v_clean_addr TEXT;
  v_clean_state TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin_user() THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'FORBIDDEN',
      'message', 'Acesso permitido apenas para administradores.'
    );
  END IF;

  IF p_client_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_PARAM',
      'message', 'ID do cliente não informado.'
    );
  END IF;

  v_clean_resp := pg_catalog.btrim(COALESCE(p_responsible_name, ''));
  v_clean_phone := pg_catalog.btrim(COALESCE(p_phone, ''));
  v_clean_addr := pg_catalog.btrim(COALESCE(p_address, ''));
  v_clean_state := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_state, 'RS')));

  IF pg_catalog.length(v_clean_resp) < 2 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_PARAM',
      'message', 'O nome do responsável deve ter ao menos 2 caracteres.'
    );
  END IF;

  IF pg_catalog.length(v_clean_phone) < 8 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_PARAM',
      'message', 'Telefone inválido.'
    );
  END IF;

  IF pg_catalog.length(v_clean_addr) < 5 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_PARAM',
      'message', 'O endereço de coleta deve ser preenchido.'
    );
  END IF;

  IF v_clean_state <> 'RS' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'STATE_NOT_ALLOWED',
      'message', 'A operação é restrita ao estado do Rio Grande do Sul (RS).'
    );
  END IF;

  IF p_pickup_latitude IS NOT NULL AND (p_pickup_latitude < -90 OR p_pickup_latitude > 90) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_COORDINATES',
      'message', 'Latitude fora dos limites válidos (-90 a 90).'
    );
  END IF;

  IF p_pickup_longitude IS NOT NULL AND (p_pickup_longitude < -180 OR p_pickup_longitude > 180) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'INVALID_COORDINATES',
      'message', 'Longitude fora dos limites válidos (-180 a 180).'
    );
  END IF;

  UPDATE public.commercial_clients
  SET
    responsible_name = v_clean_resp,
    phone = v_clean_phone,
    address = v_clean_addr,
    street_number = NULLIF(pg_catalog.btrim(COALESCE(p_street_number, '')), ''),
    neighborhood = NULLIF(pg_catalog.btrim(COALESCE(p_neighborhood, '')), ''),
    city = COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_city, '')), ''), 'Sapucaia do Sul'),
    state = v_clean_state,
    postal_code = NULLIF(pg_catalog.btrim(COALESCE(p_postal_code, '')), ''),
    pickup_latitude = p_pickup_latitude,
    pickup_longitude = p_pickup_longitude,
    pickup_place_id = NULLIF(pg_catalog.btrim(COALESCE(p_pickup_place_id, '')), ''),
    updated_at = clock_timestamp()
  WHERE id = p_client_id;

  INSERT INTO public.system_audit_logs (
    actor_type, actor_id, action, target_resource, details, created_at
  ) VALUES (
    'admin',
    v_user_id::text,
    'ADMIN_UPDATE_COMMERCIAL_CLIENT_PROFILE',
    pg_catalog.format('commercial_clients:%s', p_client_id),
    pg_catalog.jsonb_build_object(
      'responsible_name', v_clean_resp,
      'phone', v_clean_phone,
      'address', v_clean_addr
    ),
    clock_timestamp()
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'client_id', p_client_id,
    'message', 'Perfil atualizado pelo administrador com sucesso.'
  );
END;
$$;

-- 5. Permissões das RPCs
REVOKE ALL ON FUNCTION public.get_my_commercial_client_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_commercial_client_profile() TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_commercial_client_profile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_commercial_client_profile(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.update_my_commercial_client_profile(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_commercial_client_profile(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_update_commercial_client_profile(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_commercial_client_profile(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO authenticated;
