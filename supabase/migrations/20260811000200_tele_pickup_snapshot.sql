-- =====================================================================
-- Dahora Expresso — Migration: Snapshot Autoritativo da Coleta na Tele
-- Timestamp: 20260811000200
-- Descrição: Adiciona pickup_place_id em public.teles e atualiza RPCs (create_admin_tele e create_client_tele)
--            com seleção autoritativa por CONJUNTO INTEIRO de coleta (Zero Coleta Híbrida).
-- =====================================================================

-- 1. Adicionar coluna pickup_place_id em public.teles se ainda não existir
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'pickup_place_id'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN pickup_place_id TEXT;
  END IF;
END $$;

-- 2. Atualizar RPC public.create_admin_tele
DROP FUNCTION IF EXISTS public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, NUMERIC, TEXT);

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
  p_delivery_state TEXT DEFAULT 'RS',
  p_delivery_charge NUMERIC DEFAULT NULL,
  p_pickup_place_id TEXT DEFAULT NULL
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
  v_delivery_charge NUMERIC(12,2);
  v_pricing_source TEXT := 'manual_entry';
  v_pricing_version TEXT := 'v1_manual';
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_pickup_address_final TEXT;
  v_pickup_lat_final DOUBLE PRECISION;
  v_pickup_lng_final DOUBLE PRECISION;
  v_pickup_place_id_final TEXT;
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

  -- 5. Validar Valor da Tele OBRIGATÓRIO E MAIOR QUE ZERO
  IF p_delivery_charge IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DELIVERY_CHARGE', 'message', 'Informe um valor válido para a Tele (maior que R$ 0,00).');
  END IF;

  v_delivery_charge := pg_catalog.round(p_delivery_charge::NUMERIC, 2);
  IF v_delivery_charge <= 0.00 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DELIVERY_CHARGE', 'message', 'Informe um valor válido para a Tele (maior que R$ 0,00).');
  END IF;

  -- 6. Normalização do operation_source
  v_op_source_norm := pg_catalog.btrim(COALESCE(p_operation_source, 'owner_panel'));
  IF v_op_source_norm = '' THEN
    v_op_source_norm := 'owner_panel';
  END IF;

  -- 7. Idempotência
  v_idempotency_key_norm := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF v_idempotency_key_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED', 'message', 'A chave de idempotência é obrigatória.');
  END IF;

  -- 8. Resolução por CONJUNTO INTEIRO de Coleta (REGRA CRÍTICA — Zero Coleta Híbrida)
  IF p_pickup_address IS NOT NULL AND pg_catalog.btrim(p_pickup_address) <> ''
     AND p_pickup_latitude IS NOT NULL AND p_pickup_latitude BETWEEN -90 AND 90
     AND p_pickup_longitude IS NOT NULL AND p_pickup_longitude BETWEEN -180 AND 180 THEN
    -- Usar CONJUNTO ESPECÍFICO integralmente
    v_pickup_address_final  := pg_catalog.btrim(p_pickup_address);
    v_pickup_lat_final      := p_pickup_latitude;
    v_pickup_lng_final      := p_pickup_longitude;
    v_pickup_place_id_final := NULLIF(pg_catalog.btrim(COALESCE(p_pickup_place_id, '')), '');
  ELSE
    -- Usar CONJUNTO PADRÃO do cliente integralmente
    v_pickup_address_final  := v_client.address;
    v_pickup_lat_final      := v_client.pickup_latitude;
    v_pickup_lng_final      := v_client.pickup_longitude;
    v_pickup_place_id_final := v_client.pickup_place_id;
  END IF;

  -- Validação Estrita do Conjunto Escolhido
  IF v_pickup_address_final IS NULL OR pg_catalog.btrim(v_pickup_address_final) = ''
     OR v_pickup_lat_final IS NULL OR v_pickup_lng_final IS NULL
     OR v_pickup_lat_final < -90 OR v_pickup_lat_final > 90
     OR v_pickup_lng_final < -180 OR v_pickup_lng_final > 180 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'MISSING_PICKUP_LOCATION',
      'message', 'Este cliente ainda não possui um ponto de coleta configurado.'
    );
  END IF;

  -- 9. Normalização do Endereço de Entrega
  v_delivery_norm := pg_catalog.btrim(COALESCE(p_delivery_address, ''));
  IF v_delivery_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_REQUIRED', 'message', 'Endereço de entrega é obrigatório.');
  END IF;

  -- 10. Normalização do Destinatário
  v_recipient_name_norm := pg_catalog.btrim(COALESCE(p_recipient_name, ''));
  IF v_recipient_name_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_REQUIRED', 'message', 'Nome do destinatário é obrigatório.');
  END IF;

  v_recipient_phone_raw := pg_catalog.btrim(COALESCE(p_recipient_phone, ''));
  IF v_recipient_phone_raw = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é obrigatório.');
  END IF;
  v_recipient_phone_norm := pg_catalog.regexp_replace(v_recipient_phone_raw, '[^0-9+]', '', 'g');

  -- 11. Validação de Coordenadas de Entrega
  IF p_delivery_latitude IS NOT NULL AND (p_delivery_latitude < -90 OR p_delivery_latitude > 90) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_LATITUDE', 'message', 'Latitude de entrega inválida.');
  END IF;
  IF p_delivery_longitude IS NOT NULL AND (p_delivery_longitude < -180 OR p_delivery_longitude > 180) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_LONGITUDE', 'message', 'Longitude de entrega inválida.');
  END IF;

  v_geocoding_precision := COALESCE(p_geocoding_precision, 'unconfirmed');
  v_tele_code := 'TEL-' || pg_catalog.lpad(nextval('public.tele_code_seq')::text, 6, '0');
  v_reference_norm := NULLIF(pg_catalog.btrim(COALESCE(p_reference, '')), '');
  v_notes_norm := NULLIF(pg_catalog.btrim(COALESCE(p_notes, '')), '');
  v_order_value := pg_catalog.round(COALESCE(p_order_value, 0.00)::NUMERIC, 2);

  -- 12. Inserção Atômica Persistindo o Snapshot Imutável de Coleta
  INSERT INTO public.teles (
    id, tele_code, client_id, status, origin, pickup_address, delivery_address, recipient_name, recipient_phone, notes,
    total_order_amount, delivery_charge, pricing_rule_source, pricing_rule_version,
    delivery_reference, version, admin_request_idempotency_key, created_at, updated_at,
    delivery_number, delivery_complement, delivery_neighborhood, delivery_city, delivery_postal_code,
    delivery_latitude, delivery_longitude, geocoding_precision, location_adjusted_manually,
    pickup_latitude, pickup_longitude, place_id, delivery_state, pickup_place_id
  ) VALUES (
    v_tele_id, v_tele_code, p_client_id, 'aguardando_despacho', v_op_source_norm, v_pickup_address_final, v_delivery_norm, v_recipient_name_norm, v_recipient_phone_norm, v_notes_norm,
    v_order_value, v_delivery_charge, v_pricing_source, v_pricing_version,
    v_reference_norm, 1, v_idempotency_key_norm, v_now, v_now,
    p_delivery_number, p_delivery_complement, p_delivery_neighborhood, p_delivery_city, p_delivery_postal_code,
    p_delivery_latitude, p_delivery_longitude, v_geocoding_precision, COALESCE(p_location_adjusted_manually, false),
    v_pickup_lat_final, v_pickup_lng_final, p_place_id, COALESCE(p_delivery_state, 'RS'), v_pickup_place_id_final
  )
  ON CONFLICT (client_id, admin_request_idempotency_key) DO NOTHING
  RETURNING id, status, client_id, tele_code, delivery_charge, total_order_amount, delivery_reference, version, created_at
  INTO v_inserted_tele;

  IF v_inserted_tele.id IS NULL THEN
    SELECT id, status, client_id, tele_code, delivery_charge, total_order_amount, delivery_reference, version, created_at
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
      'total_order_amount', v_existing_tele.total_order_amount,
      'version', v_existing_tele.version,
      'created_at', v_existing_tele.created_at,
      'message', 'Tele manual já processada anteriormente.'
    );
  END IF;

  -- Registros de evento e auditoria
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_inserted_tele.id, 'tele_requested',
    pg_catalog.jsonb_build_object('client_id', p_client_id, 'source', v_op_source_norm, 'actor_user_id', v_user_id, 'delivery_charge', v_delivery_charge, 'total_order_amount', v_order_value),
    pg_catalog.format('tele:%s:admin:request:event:v1', v_inserted_tele.id),
    v_now
  );

  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'user_profile', v_user_id::text, 'create_admin_tele', pg_catalog.format('teles:%s', v_inserted_tele.id),
    pg_catalog.jsonb_build_object('client_id', p_client_id, 'source', v_op_source_norm, 'delivery_charge', v_delivery_charge, 'total_order_amount', v_order_value),
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
    'total_order_amount', v_inserted_tele.total_order_amount,
    'version', v_inserted_tele.version,
    'created_at', v_inserted_tele.created_at,
    'message', 'Tele manual criada com sucesso.'
  );
END;
$$;


-- 3. Atualizar RPC public.create_client_tele
DROP FUNCTION IF EXISTS public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, BOOLEAN, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, NUMERIC, TEXT);

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
  p_delivery_state TEXT DEFAULT 'RS',
  p_delivery_charge NUMERIC DEFAULT NULL,
  p_pickup_place_id TEXT DEFAULT NULL
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
  v_delivery_charge NUMERIC(12,2);
  v_pricing_source TEXT := 'manual_entry';
  v_pricing_version TEXT := 'v1_manual';
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_pickup_address_final TEXT;
  v_pickup_lat_final DOUBLE PRECISION;
  v_pickup_lng_final DOUBLE PRECISION;
  v_pickup_place_id_final TEXT;
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

  -- 2. Resolver client_id pelo Usuário Autenticado em client_users
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

  -- 4. Validar Valor da Tele OBRIGATÓRIO E MAIOR QUE ZERO
  IF p_delivery_charge IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DELIVERY_CHARGE', 'message', 'Informe um valor válido para a Tele (maior que R$ 0,00).');
  END IF;

  v_delivery_charge := pg_catalog.round(p_delivery_charge::NUMERIC, 2);
  IF v_delivery_charge <= 0.00 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_DELIVERY_CHARGE', 'message', 'Informe um valor válido para a Tele (maior que R$ 0,00).');
  END IF;

  -- 5. Idempotência
  v_idempotency_key_norm := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF v_idempotency_key_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED', 'message', 'A chave de idempotência é obrigatória.');
  END IF;

  -- 6. Resolução por CONJUNTO INTEIRO de Coleta (REGRA CRÍTICA — Zero Coleta Híbrida)
  IF p_pickup_address IS NOT NULL AND pg_catalog.btrim(p_pickup_address) <> ''
     AND p_pickup_latitude IS NOT NULL AND p_pickup_latitude BETWEEN -90 AND 90
     AND p_pickup_longitude IS NOT NULL AND p_pickup_longitude BETWEEN -180 AND 180 THEN
    -- Usar CONJUNTO ESPECÍFICO integralmente
    v_pickup_address_final  := pg_catalog.btrim(p_pickup_address);
    v_pickup_lat_final      := p_pickup_latitude;
    v_pickup_lng_final      := p_pickup_longitude;
    v_pickup_place_id_final := NULLIF(pg_catalog.btrim(COALESCE(p_pickup_place_id, '')), '');
  ELSE
    -- Usar CONJUNTO PADRÃO do cliente integralmente
    v_pickup_address_final  := v_client.address;
    v_pickup_lat_final      := v_client.pickup_latitude;
    v_pickup_lng_final      := v_client.pickup_longitude;
    v_pickup_place_id_final := v_client.pickup_place_id;
  END IF;

  -- Validação Estrita do Conjunto Escolhido
  IF v_pickup_address_final IS NULL OR pg_catalog.btrim(v_pickup_address_final) = ''
     OR v_pickup_lat_final IS NULL OR v_pickup_lng_final IS NULL
     OR v_pickup_lat_final < -90 OR v_pickup_lat_final > 90
     OR v_pickup_lng_final < -180 OR v_pickup_lng_final > 180 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error_code', 'MISSING_PICKUP_LOCATION',
      'message', 'Este cliente ainda não possui um ponto de coleta configurado.'
    );
  END IF;

  -- 7. Endereço de Entrega
  v_delivery_norm := pg_catalog.btrim(COALESCE(p_delivery_address, ''));
  IF v_delivery_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_REQUIRED', 'message', 'Endereço de entrega é obrigatório.');
  END IF;

  -- 8. Destinatário
  v_recipient_name_norm := pg_catalog.btrim(COALESCE(p_recipient_name, ''));
  IF v_recipient_name_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_REQUIRED', 'message', 'Nome do destinatário é obrigatório.');
  END IF;

  v_recipient_phone_raw := pg_catalog.btrim(COALESCE(p_recipient_phone, ''));
  IF v_recipient_phone_raw = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é obrigatório.');
  END IF;
  v_recipient_phone_norm := pg_catalog.regexp_replace(v_recipient_phone_raw, '[^0-9+]', '', 'g');

  -- 9. Validar Coordenadas de Entrega
  IF p_delivery_latitude IS NOT NULL AND (p_delivery_latitude < -90 OR p_delivery_latitude > 90) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_LATITUDE', 'message', 'Latitude de entrega inválida.');
  END IF;
  IF p_delivery_longitude IS NOT NULL AND (p_delivery_longitude < -180 OR p_delivery_longitude > 180) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_LONGITUDE', 'message', 'Longitude de entrega inválida.');
  END IF;

  v_geocoding_precision := COALESCE(p_geocoding_precision, 'unconfirmed');
  v_tele_code := 'TEL-' || pg_catalog.lpad(nextval('public.tele_code_seq')::text, 6, '0');
  v_reference_norm := NULLIF(pg_catalog.btrim(COALESCE(p_reference, '')), '');
  v_notes_norm := NULLIF(pg_catalog.btrim(COALESCE(p_notes, '')), '');
  v_order_value := pg_catalog.round(COALESCE(p_order_value, 0.00)::NUMERIC, 2);

  -- 10. Inserir Tele em aguardando_despacho Persistindo o Snapshot Imutável de Coleta
  INSERT INTO public.teles (
    id, tele_code, client_id, status, origin, pickup_address, delivery_address, recipient_name, recipient_phone, notes,
    total_order_amount, delivery_charge, pricing_rule_source, pricing_rule_version,
    delivery_reference, version, client_request_idempotency_key, created_at, updated_at,
    delivery_number, delivery_complement, delivery_neighborhood, delivery_city, delivery_postal_code,
    delivery_latitude, delivery_longitude, geocoding_precision, location_adjusted_manually,
    pickup_latitude, pickup_longitude, place_id, delivery_state, pickup_place_id
  ) VALUES (
    v_tele_id, v_tele_code, v_client_user.client_id, 'aguardando_despacho', 'client_portal', v_pickup_address_final, v_delivery_norm, v_recipient_name_norm, v_recipient_phone_norm, v_notes_norm,
    v_order_value, v_delivery_charge, v_pricing_source, v_pricing_version,
    v_reference_norm, 1, v_idempotency_key_norm, v_now, v_now,
    p_delivery_number, p_delivery_complement, p_delivery_neighborhood, p_delivery_city, p_delivery_postal_code,
    p_delivery_latitude, p_delivery_longitude, v_geocoding_precision, COALESCE(p_location_adjusted_manually, false),
    v_pickup_lat_final, v_pickup_lng_final, p_place_id, COALESCE(p_delivery_state, 'RS'), v_pickup_place_id_final
  )
  ON CONFLICT (client_id, client_request_idempotency_key) DO NOTHING
  RETURNING id, status, client_id, tele_code, delivery_charge, total_order_amount, delivery_reference, version, created_at
  INTO v_inserted_tele;

  IF v_inserted_tele.id IS NULL THEN
    SELECT id, status, client_id, tele_code, delivery_charge, total_order_amount, delivery_reference, version, created_at
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
      'total_order_amount', v_existing_tele.total_order_amount,
      'version', v_existing_tele.version,
      'created_at', v_existing_tele.created_at,
      'message', 'Entrega do cliente já processada anteriormente.'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'is_idempotent', false,
    'tele_id', v_inserted_tele.id,
    'tele_code', v_inserted_tele.tele_code,
    'status', v_inserted_tele.status,
    'client_id', v_inserted_tele.client_id,
    'delivery_charge', v_inserted_tele.delivery_charge,
    'total_order_amount', v_inserted_tele.total_order_amount,
    'version', v_inserted_tele.version,
    'created_at', v_inserted_tele.created_at,
    'message', 'Entrega criada com sucesso.'
  );
END;
$$;

-- Permissões
GRANT EXECUTE ON FUNCTION public.create_admin_tele TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_client_tele TO authenticated;
