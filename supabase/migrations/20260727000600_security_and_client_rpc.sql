-- =====================================================================
-- Dahora Expresso — Baseline Migration 6: RPC do Cliente, Idempotência & Preço
-- Timestamp: 20260727000600
-- =====================================================================

-- 1. Colunas de Idempotência, Referência e Precificação em public.teles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'client_request_idempotency_key'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN client_request_idempotency_key TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_reference'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_reference TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'delivery_charge'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN delivery_charge NUMERIC(10,2) DEFAULT 15.00;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'pricing_rule_source'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN pricing_rule_source TEXT DEFAULT 'fallback_default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'pricing_rule_version'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN pricing_rule_version TEXT DEFAULT 'v1_fallback';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'tele_code'
  ) THEN
    ALTER TABLE public.teles ADD COLUMN tele_code TEXT UNIQUE;
  END IF;
END $$;

-- Sequence Transacional de Códigos de Tele (#TEL-XXXXXX)
CREATE SEQUENCE IF NOT EXISTS public.tele_code_seq START WITH 100001;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teles_client_idempotency_unique'
  ) THEN
    ALTER TABLE public.teles ADD CONSTRAINT teles_client_idempotency_unique UNIQUE (client_id, client_request_idempotency_key);
  END IF;
END $$;

-- 2. Função Centralizada de Resolução de Frete (resolve_delivery_charge)
CREATE OR REPLACE FUNCTION public.resolve_delivery_charge(
  p_client_id UUID,
  p_pickup_address TEXT,
  p_delivery_address TEXT,
  p_reference_data JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  delivery_charge NUMERIC(10,2),
  rule_source TEXT,
  rule_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Fallback temporário controlado de R$ 15,00.
  RETURN QUERY SELECT 15.00::NUMERIC(10,2), 'fallback_default'::TEXT, 'v1_fallback'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_delivery_charge(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_delivery_charge(UUID, TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_delivery_charge(UUID, TEXT, TEXT, JSONB) TO authenticated;

-- 3. RPC Centralizada do Cliente Comercial (create_client_tele)
CREATE OR REPLACE FUNCTION public.create_client_tele(
  p_pickup_address TEXT,
  p_delivery_address TEXT,
  p_recipient_name TEXT,
  p_recipient_phone TEXT,
  p_idempotency_key TEXT,
  p_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_order_value NUMERIC DEFAULT 0.00,
  p_operation_source TEXT DEFAULT 'client_portal'
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
  c_max_order_value CONSTANT NUMERIC(12,2) := 50000.00;
BEGIN
  -- 1. Validar Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Normalização e Validação do operation_source
  v_op_source_norm := pg_catalog.btrim(COALESCE(p_operation_source, 'client_portal'));
  IF v_op_source_norm = '' THEN
    v_op_source_norm := 'client_portal';
  END IF;
  IF v_op_source_norm <> 'client_portal' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION_SOURCE', 'message', 'Origem da operação inválida para a área do cliente. Apenas "client_portal" é permitido.');
  END IF;

  -- 3. Normalização e Validação da Idempotency Key
  v_idempotency_key_norm := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF v_idempotency_key_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED', 'message', 'A chave de idempotência é obrigatória para criar solicitação.');
  END IF;
  IF pg_catalog.length(v_idempotency_key_norm) < 5 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_TOO_SHORT', 'message', 'A chave de idempotência deve conter no mínimo 5 caracteres.');
  END IF;
  IF pg_catalog.length(v_idempotency_key_norm) > 100 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_TOO_LONG', 'message', 'A chave de idempotência excede o tamanho máximo de 100 caracteres.');
  END IF;

  -- 4. Resolver client_id pelo Usuário Autenticado em client_users
  SELECT * INTO v_client_user 
  FROM public.client_users 
  WHERE user_id = v_user_id AND status = 'ativo' 
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_ACCESS_DENIED', 'message', 'Usuário não possui vínculo ativo com cliente comercial.');
  END IF;

  -- 5. Validar Cliente Comercial Ativo
  SELECT * INTO v_client 
  FROM public.commercial_clients 
  WHERE id = v_client_user.client_id AND lifecycle_status = 'ativo';

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_INACTIVE_OR_BLOCKED', 'message', 'Cadastro do cliente comercial está inativo ou bloqueado.');
  END IF;

  -- 6. Normalização e Validação de Endereço de Coleta (pickup_address)
  v_pickup_norm := pg_catalog.btrim(COALESCE(p_pickup_address, ''));
  IF v_pickup_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PICKUP_ADDRESS_REQUIRED', 'message', 'Endereço de coleta é obrigatório.');
  END IF;
  IF pg_catalog.length(v_pickup_norm) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PICKUP_ADDRESS_TOO_LONG', 'message', 'Endereço de coleta excede o limite máximo de 500 caracteres.');
  END IF;

  -- 7. Normalização e Validação de Endereço de Entrega (delivery_address)
  v_delivery_norm := pg_catalog.btrim(COALESCE(p_delivery_address, ''));
  IF v_delivery_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_REQUIRED', 'message', 'Endereço de entrega é obrigatório.');
  END IF;
  IF pg_catalog.length(v_delivery_norm) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_TOO_LONG', 'message', 'Endereço de entrega excede o limite máximo de 500 caracteres.');
  END IF;

  -- 8. Validar Endereços Claramente Idênticos
  IF pg_catalog.lower(v_pickup_norm) = pg_catalog.lower(v_delivery_norm) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SAME_PICKUP_AND_DELIVERY_ADDRESS', 'message', 'Endereço de coleta e de entrega não podem ser idênticos.');
  END IF;

  -- 9. Normalização e Validação do Destinatário (recipient_name)
  v_recipient_name_norm := pg_catalog.btrim(COALESCE(p_recipient_name, ''));
  IF v_recipient_name_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_REQUIRED', 'message', 'Nome do destinatário é obrigatório.');
  END IF;
  IF pg_catalog.length(v_recipient_name_norm) > 150 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_TOO_LONG', 'message', 'Nome do destinatário excede o limite máximo de 150 caracteres.');
  END IF;

  -- 10. Normalização e Validação do Telefone do Destinatário (recipient_phone)
  v_recipient_phone_raw := pg_catalog.btrim(COALESCE(p_recipient_phone, ''));
  IF v_recipient_phone_raw = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é obrigatório.');
  END IF;
  IF v_recipient_phone_raw LIKE '+%' THEN
    v_recipient_phone_norm := '+' || pg_catalog.regexp_replace(pg_catalog.substr(v_recipient_phone_raw, 2), '[^0-9]', '', 'g');
  ELSE
    v_recipient_phone_norm := pg_catalog.regexp_replace(v_recipient_phone_raw, '[^0-9]', '', 'g');
  END IF;
  IF v_recipient_phone_norm = '' OR v_recipient_phone_norm = '+' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é inválido.');
  END IF;
  IF pg_catalog.length(v_recipient_phone_norm) > 30 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_TOO_LONG', 'message', 'Telefone do destinatário excede o limite máximo de 30 caracteres.');
  END IF;

  -- 11. Normalização e Validação da Referência (p_reference)
  v_reference_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_reference, '')), '');
  IF v_reference_norm IS NOT NULL AND pg_catalog.length(v_reference_norm) > 300 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_REFERENCE_TOO_LONG', 'message', 'A referência da entrega excede o limite máximo de 300 caracteres.');
  END IF;

  -- 12. Normalização e Validação das Observações (p_notes)
  v_notes_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_notes, '')), '');
  IF v_notes_norm IS NOT NULL AND pg_catalog.length(v_notes_norm) > 1000 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'NOTES_TOO_LONG', 'message', 'As observações da entrega excedem o limite máximo de 1000 caracteres.');
  END IF;

  -- 13. Validação Centralizada do Valor do Pedido (p_order_value)
  v_order_value := pg_catalog.round(COALESCE(p_order_value, 0.00)::NUMERIC, 2);
  IF v_order_value < 0.00 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_ORDER_VALUE', 'message', 'Valor do pedido não pode ser negativo.');
  END IF;
  IF v_order_value > c_max_order_value THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ORDER_VALUE_LIMIT_EXCEEDED', 'message', pg_catalog.format('Valor do pedido excede o limite máximo permitido de R$ %s.', c_max_order_value));
  END IF;

  -- 14. Resolver Frete da Tele no Backend
  SELECT delivery_charge, rule_source, rule_version INTO v_delivery_charge, v_pricing_source, v_pricing_version
  FROM public.resolve_delivery_charge(v_client_user.client_id, v_pickup_norm, v_delivery_norm);

  -- 15. Inserção Atômica Idempotente com ON CONFLICT DO NOTHING
  INSERT INTO public.teles (
    id, client_id, status, origin, address, dest_name, dest_phone, notes,
    total_order_amount, valor, delivery_charge, pricing_rule_source, pricing_rule_version,
    delivery_reference, version, client_request_idempotency_key, created_at, updated_at
  ) VALUES (
    v_tele_id, v_client_user.client_id, 'solicitada', v_pickup_norm, v_delivery_norm,
    v_recipient_name_norm, v_recipient_phone_norm, v_notes_norm, v_order_value,
    v_delivery_charge, v_delivery_charge, v_pricing_source, COALESCE(v_pricing_version, 'v1_fallback'),
    v_reference_norm, 1, v_idempotency_key_norm, v_now, v_now
  )
  ON CONFLICT (client_id, client_request_idempotency_key) DO NOTHING
  RETURNING id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at
  INTO v_inserted_tele;

  -- 16. Tratamento de Idempotência se o INSERT não inseriu nova linha
  IF v_inserted_tele.id IS NULL THEN
    SELECT id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at
    INTO v_existing_tele
    FROM public.teles
    WHERE client_id = v_client_user.client_id AND client_request_idempotency_key = v_idempotency_key_norm;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', v_existing_tele.id,
      'status', v_existing_tele.status,
      'client_id', v_existing_tele.client_id,
      'delivery_charge', v_existing_tele.delivery_charge,
      'delivery_reference', v_existing_tele.delivery_reference,
      'pricing_rule_source', v_existing_tele.pricing_rule_source,
      'pricing_rule_version', v_existing_tele.pricing_rule_version,
      'version', v_existing_tele.version,
      'created_at', v_existing_tele.created_at,
      'message', 'Solicitação já processada anteriormente.'
    );
  END IF;

  -- 17. Inserir Evento Imutável em tele_eventos (Apenas para nova Tele inserida)
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_inserted_tele.id, 'tele_requested',
    pg_catalog.jsonb_build_object('client_id', v_client_user.client_id, 'source', v_op_source_norm, 'actor_user_id', v_user_id, 'delivery_reference', v_reference_norm),
    pg_catalog.format('tele:%s:request:event:v1', v_inserted_tele.id),
    v_now
  );

  -- 18. Inserir Log de Auditoria do Sistema (Apenas para nova Tele inserida)
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'client_user', v_user_id::text, 'create_tele', pg_catalog.format('teles:%s', v_inserted_tele.id),
    pg_catalog.jsonb_build_object('client_id', v_client_user.client_id, 'source', v_op_source_norm, 'delivery_reference', v_reference_norm),
    pg_catalog.format('tele:%s:request:audit:v1', v_inserted_tele.id),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'is_idempotent', false,
    'tele_id', v_inserted_tele.id,
    'status', v_inserted_tele.status,
    'client_id', v_inserted_tele.client_id,
    'delivery_charge', v_inserted_tele.delivery_charge,
    'delivery_reference', v_inserted_tele.delivery_reference,
    'pricing_rule_source', v_inserted_tele.pricing_rule_source,
    'pricing_rule_version', v_inserted_tele.pricing_rule_version,
    'version', v_inserted_tele.version,
    'created_at', v_inserted_tele.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_client_tele(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated;

-- 3.b Função Centralizada de Autorização e Consulta de Papel
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role TEXT;
  v_is_active BOOLEAN := false;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN 'anon';
  END IF;

  -- 1. Consultar fonte oficial de perfis de usuários (user_profiles)
  SELECT role, is_active INTO v_role, v_is_active
  FROM public.user_profiles
  WHERE user_id = v_user_id;

  IF FOUND AND v_is_active IS TRUE THEN
    RETURN v_role;
  END IF;

  -- 2. Consultar se é usuário cliente comercial
  SELECT role INTO v_role
  FROM public.client_users
  WHERE user_id = v_user_id AND status = 'ativo';

  IF FOUND THEN
    RETURN 'client_user';
  END IF;

  RETURN 'authenticated_unprivileged';
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_has_permission(p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  v_role := public.get_current_user_role();

  IF v_role IN ('owner', 'admin') THEN
    RETURN true;
  ELSIF v_role = 'operador' THEN
    RETURN p_permission IN (
      'tele.create_admin',
      'tele.assign_rider',
      'tele.complete',
      'tele.cancel',
      'client.manage',
      'fleet.manage'
    );
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.get_current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO authenticated;

REVOKE ALL ON FUNCTION public.current_user_has_permission(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_has_permission(TEXT) TO authenticated;

-- 4. RPC Administrativa para Criação de Tele Manual pelo Operador/Admin (create_admin_tele)
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
  p_operation_source TEXT DEFAULT 'owner_panel'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_role TEXT;
  v_client RECORD;
  v_inserted_tele RECORD;
  v_existing_tele RECORD;
  v_tele_id UUID := pg_catalog.gen_random_uuid();
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
  c_max_order_value CONSTANT NUMERIC(12,2) := 50000.00;
BEGIN
  -- 1. Validar Autenticação Obrigatória
  IF v_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Usuário não autenticado.');
  END IF;

  -- 2. Validar Autorização Centralizada do Operador/Admin via Permission Check
  IF NOT public.current_user_has_permission('tele.create_admin') AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PERMISSION_DENIED', 'message', 'Usuário sem permissão operacional para criar Teles administrativamente.');
  END IF;

  -- 3. Validar Seleção de Cliente Comercial Obrigatório
  IF p_client_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'CLIENT_SELECTION_REQUIRED', 'message', 'Selecione um cliente comercial cadastrado.');
  END IF;

  -- 4. Validar Cliente Comercial e Lifecycle Status
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

  -- 6. Normalização e Validação da Idempotency Key
  v_idempotency_key_norm := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF v_idempotency_key_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED', 'message', 'A chave de idempotência é obrigatória para criar solicitação.');
  END IF;
  IF pg_catalog.length(v_idempotency_key_norm) < 5 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_TOO_SHORT', 'message', 'A chave de idempotência deve conter no mínimo 5 caracteres.');
  END IF;
  IF pg_catalog.length(v_idempotency_key_norm) > 100 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_TOO_LONG', 'message', 'A chave de idempotência excede o tamanho máximo de 100 caracteres.');
  END IF;

  -- 7. Normalização de Endereços
  v_pickup_norm := pg_catalog.btrim(COALESCE(p_pickup_address, ''));
  IF v_pickup_norm = '' THEN
    v_pickup_norm := v_client.address;
  END IF;
  IF pg_catalog.length(v_pickup_norm) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'PICKUP_ADDRESS_TOO_LONG', 'message', 'Endereço de coleta excede o limite máximo de 500 caracteres.');
  END IF;

  v_delivery_norm := pg_catalog.btrim(COALESCE(p_delivery_address, ''));
  IF v_delivery_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_REQUIRED', 'message', 'Endereço de entrega é obrigatório.');
  END IF;
  IF pg_catalog.length(v_delivery_norm) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_ADDRESS_TOO_LONG', 'message', 'Endereço de entrega excede o limite máximo de 500 caracteres.');
  END IF;

  IF pg_catalog.lower(v_pickup_norm) = pg_catalog.lower(v_delivery_norm) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'SAME_PICKUP_AND_DELIVERY_ADDRESS', 'message', 'Endereço de coleta e de entrega não podem ser idênticos.');
  END IF;

  -- 8. Normalização do Destinatário
  v_recipient_name_norm := pg_catalog.btrim(COALESCE(p_recipient_name, ''));
  IF v_recipient_name_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_REQUIRED', 'message', 'Nome do destinatário é obrigatório.');
  END IF;
  IF pg_catalog.length(v_recipient_name_norm) > 150 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_NAME_TOO_LONG', 'message', 'Nome do destinatário excede o limite máximo de 150 caracteres.');
  END IF;

  v_recipient_phone_raw := pg_catalog.btrim(COALESCE(p_recipient_phone, ''));
  IF v_recipient_phone_raw = '' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é obrigatório.');
  END IF;
  IF v_recipient_phone_raw LIKE '+%' THEN
    v_recipient_phone_norm := '+' || pg_catalog.regexp_replace(pg_catalog.substr(v_recipient_phone_raw, 2), '[^0-9]', '', 'g');
  ELSE
    v_recipient_phone_norm := pg_catalog.regexp_replace(v_recipient_phone_raw, '[^0-9]', '', 'g');
  END IF;
  IF v_recipient_phone_norm = '' OR v_recipient_phone_norm = '+' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_REQUIRED', 'message', 'Telefone do destinatário é inválido.');
  END IF;
  IF pg_catalog.length(v_recipient_phone_norm) > 30 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'RECIPIENT_PHONE_TOO_LONG', 'message', 'Telefone do destinatário excede o limite máximo de 30 caracteres.');
  END IF;

  -- 9. Normalização de Referência e Observações
  v_reference_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_reference, '')), '');
  IF v_reference_norm IS NOT NULL AND pg_catalog.length(v_reference_norm) > 300 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'DELIVERY_REFERENCE_TOO_LONG', 'message', 'A referência da entrega excede o limite máximo de 300 caracteres.');
  END IF;

  v_notes_norm := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_notes, '')), '');
  IF v_notes_norm IS NOT NULL AND pg_catalog.length(v_notes_norm) > 1000 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'NOTES_TOO_LONG', 'message', 'As observações da entrega excedem o limite máximo de 1000 caracteres.');
  END IF;

  -- 10. Validação do Valor do Pedido
  v_order_value := pg_catalog.round(COALESCE(p_order_value, 0.00)::NUMERIC, 2);
  IF v_order_value < 0.00 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'INVALID_ORDER_VALUE', 'message', 'Valor do pedido não pode ser negativo.');
  END IF;
  IF v_order_value > c_max_order_value THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error_code', 'ORDER_VALUE_LIMIT_EXCEEDED', 'message', pg_catalog.format('Valor do pedido excede o limite máximo permitido de R$ %s.', c_max_order_value));
  END IF;

  -- 11. Resolver Frete da Tele no Backend
  SELECT delivery_charge, rule_source, rule_version INTO v_delivery_charge, v_pricing_source, v_pricing_version
  FROM public.resolve_delivery_charge(p_client_id, v_pickup_norm, v_delivery_norm);

  -- 12. Inserção Atômica Idempotente com ON CONFLICT DO NOTHING
  INSERT INTO public.teles (
    id, client_id, status, origin, address, dest_name, dest_phone, notes,
    total_order_amount, valor, delivery_charge, pricing_rule_source, pricing_rule_version,
    delivery_reference, version, client_request_idempotency_key, created_at, updated_at
  ) VALUES (
    v_tele_id, p_client_id, 'solicitada', v_pickup_norm, v_delivery_norm,
    v_recipient_name_norm, v_recipient_phone_norm, v_notes_norm, v_order_value,
    v_delivery_charge, v_delivery_charge, v_pricing_source, COALESCE(v_pricing_version, 'v1_fallback'),
    v_reference_norm, 1, v_idempotency_key_norm, v_now, v_now
  )
  ON CONFLICT (client_id, client_request_idempotency_key) DO NOTHING
  RETURNING id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at
  INTO v_inserted_tele;

  -- 13. Idempotência se o INSERT não inseriu nova linha
  IF v_inserted_tele.id IS NULL THEN
    SELECT id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at
    INTO v_existing_tele
    FROM public.teles
    WHERE client_id = p_client_id AND client_request_idempotency_key = v_idempotency_key_norm;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'is_idempotent', true,
      'tele_id', v_existing_tele.id,
      'status', v_existing_tele.status,
      'client_id', v_existing_tele.client_id,
      'delivery_charge', v_existing_tele.delivery_charge,
      'delivery_reference', v_existing_tele.delivery_reference,
      'pricing_rule_source', v_existing_tele.pricing_rule_source,
      'pricing_rule_version', v_existing_tele.pricing_rule_version,
      'version', v_existing_tele.version,
      'created_at', v_existing_tele.created_at,
      'message', 'Solicitação já processada anteriormente.'
    );
  END IF;

  -- 14. Inserir Evento Imutável em tele_eventos
  INSERT INTO public.tele_eventos (tele_id, tipo, payload, idempotency_key, created_at)
  VALUES (
    v_inserted_tele.id, 'tele_requested',
    pg_catalog.jsonb_build_object('client_id', p_client_id, 'source', v_op_source_norm, 'actor_user_id', v_user_id, 'delivery_reference', v_reference_norm),
    pg_catalog.format('tele:%s:request:event:v1', v_inserted_tele.id),
    v_now
  );

  -- 15. Inserir Log de Auditoria
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details, idempotency_key, created_at)
  VALUES (
    'admin_user', v_user_id::text, 'create_admin_tele', pg_catalog.format('teles:%s', v_inserted_tele.id),
    pg_catalog.jsonb_build_object('client_id', p_client_id, 'source', v_op_source_norm, 'delivery_reference', v_reference_norm),
    pg_catalog.format('tele:%s:request:audit:v1', v_inserted_tele.id),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'is_idempotent', false,
    'tele_id', v_inserted_tele.id,
    'status', v_inserted_tele.status,
    'client_id', v_inserted_tele.client_id,
    'delivery_charge', v_inserted_tele.delivery_charge,
    'delivery_reference', v_inserted_tele.delivery_reference,
    'pricing_rule_source', v_inserted_tele.pricing_rule_source,
    'pricing_rule_version', v_inserted_tele.pricing_rule_version,
    'version', v_inserted_tele.version,
    'created_at', v_inserted_tele.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_admin_tele(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated;
