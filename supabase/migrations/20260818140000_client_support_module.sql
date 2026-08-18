-- =====================================================================
-- Dahora Expresso — Módulo de Suporte dos Clientes Comerciais
-- Migration: 20260818140000_client_support_module.sql
-- =====================================================================

-- 1. Tabela de Mensagens de Suporte dos Clientes Comerciais (Append-Only Multi-Tenant)
CREATE TABLE IF NOT EXISTS public.client_support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.commercial_clients(id) ON DELETE CASCADE,
  sender_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('client', 'admin', 'system')),
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL CHECK (char_length(trim(message)) >= 1 AND char_length(message) <= 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS client_support_messages_client_created_idx ON public.client_support_messages(client_id, created_at);
CREATE INDEX IF NOT EXISTS client_support_messages_client_read_idx ON public.client_support_messages(client_id, read_at);

-- 2. Habilitar RLS e Permissões Controladas
ALTER TABLE public.client_support_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.client_support_messages FROM PUBLIC, anon;
GRANT SELECT ON public.client_support_messages TO authenticated;

-- 3. Políticas RLS (Somente SELECT — INSERT/UPDATE/DELETE Diretos Bloqueados)
DROP POLICY IF EXISTS client_support_messages_client_select ON public.client_support_messages;
CREATE POLICY client_support_messages_client_select ON public.client_support_messages
  FOR SELECT TO authenticated
  USING (
    client_id IN (SELECT public.my_client_ids())
  );

DROP POLICY IF EXISTS client_support_messages_admin_select ON public.client_support_messages;
CREATE POLICY client_support_messages_admin_select ON public.client_support_messages
  FOR SELECT TO authenticated
  USING (public.is_admin_user());

-- =====================================================================
-- 4. RPCs DO CLIENTE COMERCIAL
-- =====================================================================

-- 4.1 Enviar Mensagem do Cliente Comercial
CREATE OR REPLACE FUNCTION public.send_my_client_support_message(
  p_message TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_client_id UUID;
  v_sender_name TEXT;
  v_message_trimmed TEXT;
  v_msg_record RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  -- Resolver o client_id do usuário autenticado
  SELECT client_id INTO v_client_id
  FROM public.client_users
  WHERE user_id = v_user_id
    AND status = 'ativo'
  LIMIT 1;

  IF v_client_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'CLIENT_NOT_FOUND', 'message', 'Estabelecimento comercial não localizado ou inativo.');
  END IF;

  v_message_trimmed := trim(p_message);
  IF v_message_trimmed IS NULL OR char_length(v_message_trimmed) < 1 OR char_length(v_message_trimmed) > 4000 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_MESSAGE', 'message', 'A mensagem deve conter entre 1 e 4000 caracteres.');
  END IF;

  -- Derivar o nome do remetente autoritativamente
  SELECT COALESCE(establishment_name, responsible_name, 'Cliente Comercial') INTO v_sender_name
  FROM public.commercial_clients
  WHERE id = v_client_id;

  IF v_sender_name IS NULL THEN
    v_sender_name := 'Cliente Comercial';
  END IF;

  -- Inserir registro append-only
  INSERT INTO public.client_support_messages (
    client_id, sender_user_id, sender_type, sender_name, message, created_at, read_at
  ) VALUES (
    v_client_id, v_user_id, 'client', v_sender_name, v_message_trimmed, clock_timestamp(), NULL
  ) RETURNING * INTO v_msg_record;

  RETURN jsonb_build_object(
    'success', true,
    'message', jsonb_build_object(
      'id', v_msg_record.id,
      'client_id', v_msg_record.client_id,
      'sender_user_id', v_msg_record.sender_user_id,
      'sender_type', v_msg_record.sender_type,
      'sender_name', v_msg_record.sender_name,
      'message', v_msg_record.message,
      'created_at', v_msg_record.created_at,
      'read_at', v_msg_record.read_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.send_my_client_support_message(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_my_client_support_message(TEXT) TO authenticated;


-- 4.2 Marcar Mensagens do Suporte como Lidas pelo Cliente
CREATE OR REPLACE FUNCTION public.mark_my_client_support_messages_read()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_client_id UUID;
  v_updated_count INT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT client_id INTO v_client_id
  FROM public.client_users
  WHERE user_id = v_user_id
    AND status = 'ativo'
  LIMIT 1;

  IF v_client_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'CLIENT_NOT_FOUND', 'message', 'Estabelecimento comercial não localizado.');
  END IF;

  UPDATE public.client_support_messages
  SET read_at = clock_timestamp()
  WHERE client_id = v_client_id
    AND sender_type IN ('admin', 'system')
    AND read_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated_count', v_updated_count);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_my_client_support_messages_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_my_client_support_messages_read() TO authenticated;


-- =====================================================================
-- 5. RPCs DO ADMINISTRADOR
-- =====================================================================

-- 5.1 Enviar Resposta do Administrador para Cliente Comercial
CREATE OR REPLACE FUNCTION public.admin_send_client_support_message(
  p_client_id UUID,
  p_message TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_client_exists BOOLEAN;
  v_sender_name TEXT;
  v_message_trimmed TEXT;
  v_msg_record RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FORBIDDEN', 'message', 'Acesso negado. Requer perfil administrativo.');
  END IF;

  IF p_client_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_CLIENT_ID', 'message', 'ID do cliente comercial é obrigatório.');
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.commercial_clients WHERE id = p_client_id) INTO v_client_exists;
  IF NOT v_client_exists THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'CLIENT_NOT_FOUND', 'message', 'Cliente comercial não localizado.');
  END IF;

  v_message_trimmed := trim(p_message);
  IF v_message_trimmed IS NULL OR char_length(v_message_trimmed) < 1 OR char_length(v_message_trimmed) > 4000 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_MESSAGE', 'message', 'A mensagem deve conter entre 1 e 4000 caracteres.');
  END IF;

  v_sender_name := 'Suporte Dahora Expresso';

  INSERT INTO public.client_support_messages (
    client_id, sender_user_id, sender_type, sender_name, message, created_at, read_at
  ) VALUES (
    p_client_id, v_user_id, 'admin', v_sender_name, v_message_trimmed, clock_timestamp(), NULL
  ) RETURNING * INTO v_msg_record;

  RETURN jsonb_build_object(
    'success', true,
    'message', jsonb_build_object(
      'id', v_msg_record.id,
      'client_id', v_msg_record.client_id,
      'sender_user_id', v_msg_record.sender_user_id,
      'sender_type', v_msg_record.sender_type,
      'sender_name', v_msg_record.sender_name,
      'message', v_msg_record.message,
      'created_at', v_msg_record.created_at,
      'read_at', v_msg_record.read_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_send_client_support_message(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_send_client_support_message(UUID, TEXT) TO authenticated;


-- 5.2 Marcar Mensagens do Cliente como Lidas pelo Administrador
CREATE OR REPLACE FUNCTION public.admin_mark_client_support_messages_read(
  p_client_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_updated_count INT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FORBIDDEN', 'message', 'Acesso negado. Requer perfil administrativo.');
  END IF;

  IF p_client_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_CLIENT_ID', 'message', 'ID do cliente é obrigatório.');
  END IF;

  UPDATE public.client_support_messages
  SET read_at = clock_timestamp()
  WHERE client_id = p_client_id
    AND sender_type = 'client'
    AND read_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated_count', v_updated_count);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_mark_client_support_messages_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_client_support_messages_read(UUID) TO authenticated;


-- 5.3 Listar Canais de Conversa do Cliente para o Painel Administrativo
CREATE OR REPLACE FUNCTION public.get_admin_client_support_channels()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_channels JSONB;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FORBIDDEN', 'message', 'Acesso negado. Requer perfil administrativo.');
  END IF;

  SELECT jsonb_agg(c_info) INTO v_channels
  FROM (
    SELECT 
      c.id AS client_id,
      c.establishment_name,
      c.responsible_name,
      c.email,
      COALESCE(
        (SELECT jsonb_build_object(
          'id', m.id,
          'message', m.message,
          'sender_type', m.sender_type,
          'created_at', m.created_at
        )
        FROM public.client_support_messages m
        WHERE m.client_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1),
        NULL
      ) AS last_message,
      (SELECT COUNT(*)::INT
       FROM public.client_support_messages m
       WHERE m.client_id = c.id
         AND m.sender_type = 'client'
         AND m.read_at IS NULL) AS unread_count
    FROM public.commercial_clients c
    ORDER BY (
      SELECT COALESCE(MAX(m.created_at), c.created_at)
      FROM public.client_support_messages m
      WHERE m.client_id = c.id
    ) DESC
  ) c_info;

  RETURN jsonb_build_object('success', true, 'channels', COALESCE(v_channels, '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_client_support_channels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_client_support_channels() TO authenticated;


-- =====================================================================
-- 6. HABILITAR REALTIME (IDEMPOTENTE)
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'client_support_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.client_support_messages;
  END IF;
END $$;
