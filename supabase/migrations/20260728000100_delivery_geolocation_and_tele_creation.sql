-- =====================================================================
-- Dahora Expresso — Migration: Delivery Geolocation & Tele Creation RPCs
-- Timestamp: 20260728000100
-- =====================================================================

-- 1. Atualizar Tabela public.commercial_clients com is_internal e colunas de endereço
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'is_internal'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN is_internal BOOLEAN NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'neighborhood'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN neighborhood TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'city'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN city TEXT DEFAULT 'Sapucaia do Sul';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'postal_code'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN postal_code TEXT;
  END IF;
END $$;

-- Seed Idempotente do Cliente Interno Dahora Expresso
INSERT INTO public.commercial_clients (
  client_code, establishment_name, responsible_name, phone, email, address, neighborhood, city, postal_code, document, lifecycle_status, financial_status, is_internal
) VALUES (
  'SYS-DAHORA', 'Dahora Expresso', 'Operação Interna', '(51) 99999-0000', 'operacao@dahoraexpresso.local', 'Av. Presidente Vargas, 1000', 'Centro', 'Sapucaia do Sul', '93260-006', '00.000.000/0001-00', 'ativo', 'em_dia', true
) ON CONFLICT (client_code) DO UPDATE SET
  establishment_name = 'Dahora Expresso',
  responsible_name = 'Operação Interna',
  is_internal = true,
  lifecycle_status = 'ativo';

-- 2. Atualizar RLS de commercial_clients (Restringir anon e restringir parceiros ao seu próprio ID)
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.commercial_clients TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.client_users TO authenticated;

DROP POLICY IF EXISTS commercial_clients_select ON public.commercial_clients;
CREATE POLICY commercial_clients_select ON public.commercial_clients FOR SELECT TO authenticated USING (
  public.get_current_user_role() IN ('owner', 'admin', 'operador', 'gerente')
  OR id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid() AND status = 'ativo')
);

-- 3. Atualizar Tabela public.teles com Geocodificação, Place ID e Detalhes de Endereço
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'place_id'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN place_id TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'pickup_latitude'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN pickup_latitude DOUBLE PRECISION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'pickup_longitude'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN pickup_longitude DOUBLE PRECISION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_number'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_number TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_complement'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_complement TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_neighborhood'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_neighborhood TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_city'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_city TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_state'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_state TEXT DEFAULT 'RS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_postal_code'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_postal_code TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_latitude'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_latitude DOUBLE PRECISION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_longitude'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_longitude DOUBLE PRECISION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'geocoding_precision'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN geocoding_precision TEXT DEFAULT 'unconfirmed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'location_adjusted_manually'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN location_adjusted_manually BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

ALTER TABLE public.teles DROP CONSTRAINT IF EXISTS check_geocoding_precision;
ALTER TABLE public.teles ADD CONSTRAINT check_geocoding_precision 
  CHECK (geocoding_precision IN ('exact', 'rooftop', 'parcel', 'interpolated', 'street', 'approximate', 'manual', 'unconfirmed'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teles_admin_idempotency_unique'
  ) THEN
    ALTER TABLE public.teles ADD CONSTRAINT teles_admin_idempotency_unique UNIQUE (client_id, admin_request_idempotency_key);
  END IF;
END $$;

-- 4. Atualizar RPC Administrativa (create_admin_tele)
DROP FUNCTION IF EXISTS public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION);

CREATE OR REPLACE FUNCTION public.create_admin_tele(
  p_client_id UUID,
  p_pickup_address TEXT,
  p_delivery_address TEXT,
  p_recipient_name TEXT,
  p_recipient_phone TEXT,
  p_idempotency_key TEXT,
  p_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_order_value NUMERIC DEFAULT 0.00,
  p_operation_source TEXT DEFAULT 'owner_panel',
  p_delivery_number TEXT DEFAULT NULL,
  p_delivery_complement TEXT DEFAULT NULL,
  p_delivery_neighborhood TEXT DEFAULT NULL,
  p_delivery_city TEXT DEFAULT NULL,
  p_delivery_postal_code TEXT DEFAULT NULL,
  p_delivery_latitude DOUBLE PRECISION DEFAULT NULL,
  p_delivery_longitude DOUBLE PRECISION DEFAULT NULL,
  p_geocoding_precision TEXT DEFAULT 'unconfirmed',
  p_location_adjusted_manually BOOLEAN DEFAULT false,
  p_pickup_latitude DOUBLE PRECISION DEFAULT NULL,
  p_pickup_longitude DOUBLE PRECISION DEFAULT NULL,
  p_place_id TEXT DEFAULT NULL,
  p_delivery_state TEXT DEFAULT 'RS'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_client RECORD;
  v_inserted_tele RECORD;
  v_existing_tele RECORD;
  v_tele_id UUID := pg_catalog.gen_random_uuid();
  v_tele_code TEXT;
  v_delivery_charge NUMERIC(10,2);
  v_pricing_source TEXT;
  v_pricing_version TEXT;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_pickup_norm TEXT;
  v_delivery_norm TEXT;
  v_recipient_name_norm TEXT;
  v_recipient_phone_raw TEXT;
  v_recipient_phone_norm TEXT;
  v_idempotency_key_norm TEXT;
  v_reference_norm TEXT;
  v_notes_norm TEXT;
  v_op_source_norm TEXT;
  v_order_value NUMERIC(12,2);
  v_geocoding_precision TEXT;
  c_max_order_value CONSTANT NUMERIC(12,2) := 50000.00;
BEGIN
  -- 1. Validar Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Validar Autorização Operacional
  IF NOT public.current_user_has_permission('tele.create_admin') AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Usuário sem permissão operacional para criar Teles administrativamente.');
  END IF;

  -- 3. Validar Seleção de Cliente
  IF p_client_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_SELECTION_REQUIRED', 'message', 'Selecione um cliente comercial cadastrado.');
  END IF;

  -- 4. Validar Cliente Comercial Ativo ou Interno
  SELECT * INTO v_client 
  FROM public.commercial_clients 
  WHERE id = p_client_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_NOT_FOUND', 'message', 'O cliente comercial selecionado não foi encontrado.');
  END IF;

  IF v_client.lifecycle_status IN ('suspenso', 'cancelado', 'inativo') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_INACTIVE_OR_BLOCKED', 'message', 'O cliente comercial selecionado está inativo, suspenso ou bloqueado.');
  END IF;

  -- 5. Normalização do operation_source
  v_op_source_norm := pg_catalog.btrim(COALESCE(p_operation_source, 'owner_panel'));
  IF v_op_source_norm = '' THEN
    v_op_source_norm := 'owner_panel';
  END IF;

  -- 6. Idempotência
  v_idempotency_key_norm := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF v_idempotency_key_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED', 'message', 'A chave de idempotência é obrigatória.');
  END IF;

  -- 7. Normalização do Endereço de Coleta
  v_pickup_norm := pg_catalog.btrim(COALESCE(p_pickup_address, ''));
  IF v_pickup_norm = '' THEN
    v_pickup_norm := v_client.address;
  END IF;
  IF v_pickup_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PICKUP_ADDRESS_REQUIRED', 'message', 'Endereço de coleta é obrigatório.');
  END IF;

  -- 8. Normalização do Endereço de Entrega
  v_delivery_norm := pg_catalog.btrim(COALESCE(p_delivery_address, ''));
  IF v_delivery_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_REQUIRED', 'message', 'Endereço de entrega é obrigatório.');
  END IF;

  -- 9. Normalização do Destinatário
  v_recipient_name_norm := pg_catalog.btrim(COALESCE(p_recipient_name, ''));
  IF v_recipient_name_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_REQUIRED', 'message', 'Nome do destinatário é obrigatório.');
  END IF;

  v_recipient_phone_raw := pg_catalog.btrim(COALESCE(p_recipient_phone, ''));
  IF v_recipient_phone_raw = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é obrigatório.');
  END IF;
  v_recipient_phone_norm := pg_catalog.regexp_replace(v_recipient_phone_raw, '[^0-9+]', '', 'g');

  -- 10. Validação de Coordenadas
  IF p_delivery_latitude IS NOT NULL AND (p_delivery_latitude < -90 OR p_delivery_latitude > 90) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_LATITUDE', 'message', 'Latitude de entrega inválida.');
  END IF;
  IF p_delivery_longitude IS NOT NULL AND (p_delivery_longitude < -180 OR p_delivery_longitude > 180) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_LONGITUDE', 'message', 'Longitude de entrega inválida.');
  END IF;

  v_geocoding_precision := COALESCE(p_geocoding_precision, 'unconfirmed');

  -- 11. Resolver Frete
  SELECT delivery_charge, rule_source, rule_version INTO v_delivery_charge, v_pricing_source, v_pricing_version
  FROM public.resolve_delivery_charge(p_client_id, v_pickup_norm, v_delivery_norm);

  v_tele_code := 'TEL-' || pg_catalog.lpad(nextval('public.tele_code_seq')::text, 6, '0');
  v_reference_norm := NULLIF(pg_catalog.btrim(COALESCE(p_reference, '')), '');
  v_notes_norm := NULLIF(pg_catalog.btrim(COALESCE(p_notes, '')), '');
  v_order_value := pg_catalog.round(COALESCE(p_order_value, 0.00)::NUMERIC, 2);

  -- 12. Inserção Atômica com ON CONFLICT DO NOTHING
  INSERT INTO public.teles (
    id, tele_code, client_id, status, origin, pickup_address, delivery_address, recipient_name, recipient_phone, notes,
    total_order_amount, delivery_charge, pricing_rule_source, pricing_rule_version,
    delivery_reference, version, admin_request_idempotency_key, created_at, updated_at,
    delivery_number, delivery_complement, delivery_neighborhood, delivery_city, delivery_postal_code,
    delivery_latitude, delivery_longitude, geocoding_precision, location_adjusted_manually,
    pickup_latitude, pickup_longitude, place_id, delivery_state
  ) VALUES (
    v_tele_id, v_tele_code, p_client_id, 'aguardando_despacho', v_op_source_norm, v_pickup_norm, v_delivery_norm, v_recipient_name_norm, v_recipient_phone_norm, v_notes_norm,
    v_order_value, v_delivery_charge, v_pricing_source, COALESCE(v_pricing_version, 'v1_fallback'),
    v_reference_norm, 1, v_idempotency_key_norm, v_now, v_now,
    p_delivery_number, p_delivery_complement, p_delivery_neighborhood, p_delivery_city, p_delivery_postal_code,
    p_delivery_latitude, p_delivery_longitude, v_geocoding_precision, COALESCE(p_location_adjusted_manually, false),
    p_pickup_latitude, p_pickup_longitude, p_place_id, COALESCE(p_delivery_state, 'RS')
  )
  ON CONFLICT (client_id, admin_request_idempotency_key) DO NOTHING
  RETURNING id, status, client_id, tele_code, delivery_charge, delivery_reference, version, created_at
  INTO v_inserted_tele;

  IF v_inserted_tele.id IS NULL THEN
    SELECT id, status, client_id, tele_code, delivery_charge, delivery_reference, version, created_at
    INTO v_existing_tele
    FROM public.teles
    WHERE client_id = p_client_id AND admin_request_idempotency_key = v_idempotency_key_norm;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', v_existing_tele.id,
      'tele_code', v_existing_tele.tele_code,
      'status', v_existing_tele.status,
      'client_id', v_existing_tele.client_id,
      'delivery_charge', v_existing_tele.delivery_charge,
      'version', v_existing_tele.version,
      'created_at', v_existing_tele.created_at,
      'message', 'Tele manual já processada anteriormente.'
    );
  END IF;

  -- Registros de evento e auditoria
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_inserted_tele.id, 'tele_requested',
    pg_catalog.jsonb_build_object('client_id', p_client_id, 'source', v_op_source_norm, 'actor_user_id', v_user_id),
    pg_catalog.format('tele:%s:admin:request:event:v1', v_inserted_tele.id),
    v_now
  );

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'user_profile', v_user_id::text, 'create_admin_tele', pg_catalog.format('teles:%s', v_inserted_tele.id),
    pg_catalog.jsonb_build_object('client_id', p_client_id, 'source', v_op_source_norm),
    pg_catalog.format('tele:%s:admin:request:audit:v1', v_inserted_tele.id),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'is_idempotent', false,
    'tele_id', v_inserted_tele.id,
    'tele_code', v_inserted_tele.tele_code,
    'status', v_inserted_tele.status,
    'client_id', v_inserted_tele.client_id,
    'delivery_charge', v_inserted_tele.delivery_charge,
    'version', v_inserted_tele.version,
    'created_at', v_inserted_tele.created_at
  );
END;
$$;

-- 5. Atualizar RPC do Cliente Comercial (create_client_tele)
DROP FUNCTION IF EXISTS public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION);

CREATE OR REPLACE FUNCTION public.create_client_tele(
  p_pickup_address TEXT,
  p_delivery_address TEXT,
  p_recipient_name TEXT,
  p_recipient_phone TEXT,
  p_idempotency_key TEXT,
  p_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_order_value NUMERIC DEFAULT 0.00,
  p_operation_source TEXT DEFAULT 'client_portal',
  p_delivery_number TEXT DEFAULT NULL,
  p_delivery_complement TEXT DEFAULT NULL,
  p_delivery_neighborhood TEXT DEFAULT NULL,
  p_delivery_city TEXT DEFAULT NULL,
  p_delivery_postal_code TEXT DEFAULT NULL,
  p_delivery_latitude DOUBLE PRECISION DEFAULT NULL,
  p_delivery_longitude DOUBLE PRECISION DEFAULT NULL,
  p_geocoding_precision TEXT DEFAULT 'unconfirmed',
  p_location_adjusted_manually BOOLEAN DEFAULT false,
  p_pickup_latitude DOUBLE PRECISION DEFAULT NULL,
  p_pickup_longitude DOUBLE PRECISION DEFAULT NULL,
  p_place_id TEXT DEFAULT NULL,
  p_delivery_state TEXT DEFAULT 'RS'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_client RECORD;
  v_client_user RECORD;
  v_inserted_tele RECORD;
  v_existing_tele RECORD;
  v_tele_id UUID := pg_catalog.gen_random_uuid();
  v_tele_code TEXT;
  v_delivery_charge NUMERIC(10,2);
  v_pricing_source TEXT;
  v_pricing_version TEXT;
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_pickup_norm TEXT;
  v_delivery_norm TEXT;
  v_recipient_name_norm TEXT;
  v_recipient_phone_raw TEXT;
  v_recipient_phone_norm TEXT;
  v_idempotency_key_norm TEXT;
  v_reference_norm TEXT;
  v_notes_norm TEXT;
  v_op_source_norm TEXT;
  v_order_value NUMERIC(12,2);
  v_geocoding_precision TEXT;
  c_max_order_value CONSTANT NUMERIC(12,2) := 50000.00;
BEGIN
  -- 1. Validar Autenticação
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Resolver client_id EXCLUSIVAMENTE pelo Usuário Autenticado em client_users
  SELECT * INTO v_client_user 
  FROM public.client_users 
  WHERE user_id = v_user_id AND status = 'ativo' 
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_ACCESS_DENIED', 'message', 'Usuário não possui vínculo ativo com cliente comercial.');
  END IF;

  -- 3. Validar Cliente Comercial Ativo ou em Teste
  SELECT * INTO v_client 
  FROM public.commercial_clients 
  WHERE id = v_client_user.client_id AND lifecycle_status IN ('ativo', 'teste');

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_INACTIVE_OR_BLOCKED', 'message', 'Cadastro do cliente comercial está inativo ou bloqueado.');
  END IF;

  -- 4. Idempotência
  v_idempotency_key_norm := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF v_idempotency_key_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED', 'message', 'A chave de idempotência é obrigatória.');
  END IF;

  -- 5. Endereço de Coleta Automático do Cadastro do Cliente Comercial
  v_pickup_norm := pg_catalog.btrim(COALESCE(v_client.address, ''));
  IF v_pickup_norm = '' THEN
    v_pickup_norm := pg_catalog.btrim(COALESCE(p_pickup_address, ''));
  END IF;
  IF v_pickup_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PICKUP_ADDRESS_REQUIRED', 'message', 'Endereço de coleta do cliente não está cadastrado.');
  END IF;

  -- 6. Endereço de Entrega
  v_delivery_norm := pg_catalog.btrim(COALESCE(p_delivery_address, ''));
  IF v_delivery_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_REQUIRED', 'message', 'Endereço de entrega é obrigatório.');
  END IF;

  -- 7. Destinatário
  v_recipient_name_norm := pg_catalog.btrim(COALESCE(p_recipient_name, ''));
  IF v_recipient_name_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_REQUIRED', 'message', 'Nome do destinatário é obrigatório.');
  END IF;

  v_recipient_phone_raw := pg_catalog.btrim(COALESCE(p_recipient_phone, ''));
  IF v_recipient_phone_raw = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é obrigatório.');
  END IF;
  v_recipient_phone_norm := pg_catalog.regexp_replace(v_recipient_phone_raw, '[^0-9+]', '', 'g');

  -- 8. Validar Coordenadas
  IF p_delivery_latitude IS NOT NULL AND (p_delivery_latitude < -90 OR p_delivery_latitude > 90) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_LATITUDE', 'message', 'Latitude de entrega inválida.');
  END IF;
  IF p_delivery_longitude IS NOT NULL AND (p_delivery_longitude < -180 OR p_delivery_longitude > 180) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_LONGITUDE', 'message', 'Longitude de entrega inválida.');
  END IF;

  v_geocoding_precision := COALESCE(p_geocoding_precision, 'unconfirmed');

  -- 9. Resolver Frete no Server
  SELECT delivery_charge, rule_source, rule_version INTO v_delivery_charge, v_pricing_source, v_pricing_version
  FROM public.resolve_delivery_charge(v_client_user.client_id, v_pickup_norm, v_delivery_norm);

  v_tele_code := 'TEL-' || pg_catalog.lpad(nextval('public.tele_code_seq')::text, 6, '0');
  v_reference_norm := NULLIF(pg_catalog.btrim(COALESCE(p_reference, '')), '');
  v_notes_norm := NULLIF(pg_catalog.btrim(COALESCE(p_notes, '')), '');
  v_order_value := pg_catalog.round(COALESCE(p_order_value, 0.00)::NUMERIC, 2);

  -- 10. Inserir Tele em aguardando_despacho
  INSERT INTO public.teles (
    id, tele_code, client_id, status, origin, pickup_address, delivery_address, recipient_name, recipient_phone, notes,
    total_order_amount, delivery_charge, pricing_rule_source, pricing_rule_version,
    delivery_reference, version, client_request_idempotency_key, created_at, updated_at,
    delivery_number, delivery_complement, delivery_neighborhood, delivery_city, delivery_postal_code,
    delivery_latitude, delivery_longitude, geocoding_precision, location_adjusted_manually,
    pickup_latitude, pickup_longitude, place_id, delivery_state
  ) VALUES (
    v_tele_id, v_tele_code, v_client_user.client_id, 'aguardando_despacho', 'client_portal', v_pickup_norm, v_delivery_norm, v_recipient_name_norm, v_recipient_phone_norm, v_notes_norm,
    v_order_value, v_delivery_charge, v_pricing_source, COALESCE(v_pricing_version, 'v1_fallback'),
    v_reference_norm, 1, v_idempotency_key_norm, v_now, v_now,
    p_delivery_number, p_delivery_complement, p_delivery_neighborhood, p_delivery_city, p_delivery_postal_code,
    p_delivery_latitude, p_delivery_longitude, v_geocoding_precision, COALESCE(p_location_adjusted_manually, false),
    p_pickup_latitude, p_pickup_longitude, p_place_id, COALESCE(p_delivery_state, 'RS')
  )
  ON CONFLICT (client_id, client_request_idempotency_key) DO NOTHING
  RETURNING id, status, client_id, tele_code, delivery_charge, delivery_reference, version, created_at
  INTO v_inserted_tele;

  IF v_inserted_tele.id IS NULL THEN
    SELECT id, status, client_id, tele_code, delivery_charge, delivery_reference, version, created_at
    INTO v_existing_tele
    FROM public.teles
    WHERE client_id = v_client_user.client_id AND client_request_idempotency_key = v_idempotency_key_norm;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', v_existing_tele.id,
      'tele_code', v_existing_tele.tele_code,
      'status', v_existing_tele.status,
      'client_id', v_existing_tele.client_id,
      'delivery_charge', v_existing_tele.delivery_charge,
      'version', v_existing_tele.version,
      'created_at', v_existing_tele.created_at,
      'message', 'Solicitação já processada anteriormente.'
    );
  END IF;

  -- Evento & Auditoria
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_inserted_tele.id, 'tele_requested',
    pg_catalog.jsonb_build_object('client_id', v_client_user.client_id, 'source', 'client_portal', 'actor_user_id', v_user_id),
    pg_catalog.format('tele:%s:client:request:event:v1', v_inserted_tele.id),
    v_now
  );

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'client_user', v_user_id::text, 'create_client_tele', pg_catalog.format('teles:%s', v_inserted_tele.id),
    pg_catalog.jsonb_build_object('client_id', v_client_user.client_id, 'source', 'client_portal'),
    pg_catalog.format('tele:%s:client:request:audit:v1', v_inserted_tele.id),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'is_idempotent', false,
    'tele_id', v_inserted_tele.id,
    'tele_code', v_inserted_tele.tele_code,
    'status', v_inserted_tele.status,
    'client_id', v_inserted_tele.client_id,
    'delivery_charge', v_inserted_tele.delivery_charge,
    'version', v_inserted_tele.version,
    'created_at', v_inserted_tele.created_at
  );
END;
$$;

-- 6. REVOKE/GRANT de permissões
REVOKE ALL ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) TO authenticated;
