-- =====================================================================
-- Dahora Expresso — Módulo de Suporte dos Motoboys
-- Migration: 20260731000100_rider_support_module.sql
-- =====================================================================

-- 1. Tabela de Chamados de Suporte dos Motoboys
CREATE TABLE IF NOT EXISTS public.rider_support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  motoboy_id UUID NOT NULL REFERENCES public.fleet(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_admin_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ NULL,

  CONSTRAINT rider_support_tickets_subject_length CHECK (char_length(trim(subject)) >= 3 AND char_length(subject) <= 120),
  CONSTRAINT rider_support_tickets_category_check CHECK (category IN ('delivery_issue', 'payment_question', 'consumable_question', 'app_problem', 'account_problem', 'other')),
  CONSTRAINT rider_support_tickets_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT rider_support_tickets_status_check CHECK (status IN ('open', 'in_progress', 'waiting_rider', 'waiting_admin', 'resolved', 'closed'))
);

CREATE INDEX IF NOT EXISTS rider_support_tickets_motoboy_id_idx ON public.rider_support_tickets(motoboy_id);
CREATE INDEX IF NOT EXISTS rider_support_tickets_status_idx ON public.rider_support_tickets(status);
CREATE INDEX IF NOT EXISTS rider_support_tickets_priority_idx ON public.rider_support_tickets(priority);
CREATE INDEX IF NOT EXISTS rider_support_tickets_last_message_at_idx ON public.rider_support_tickets(last_message_at DESC);
CREATE INDEX IF NOT EXISTS rider_support_tickets_assigned_admin_id_idx ON public.rider_support_tickets(assigned_admin_id);


-- 2. Tabela de Mensagens do Chamado
CREATE TABLE IF NOT EXISTS public.rider_support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.rider_support_tickets(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL,
  sender_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  is_internal BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT rider_support_messages_sender_type_check CHECK (sender_type IN ('rider', 'admin', 'system')),
  CONSTRAINT rider_support_messages_message_length CHECK (char_length(trim(message)) >= 1 AND char_length(message) <= 4000)
);

CREATE INDEX IF NOT EXISTS rider_support_messages_ticket_id_idx ON public.rider_support_messages(ticket_id);
CREATE INDEX IF NOT EXISTS rider_support_messages_created_at_idx ON public.rider_support_messages(created_at);
CREATE INDEX IF NOT EXISTS rider_support_messages_ticket_created_idx ON public.rider_support_messages(ticket_id, created_at);


-- 3. Tabela Unificada de Recibos de Leitura (Única Fonte de Leitura por Usuário)
CREATE TABLE IF NOT EXISTS public.rider_support_message_reads (
  message_id UUID NOT NULL REFERENCES public.rider_support_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS rider_support_message_reads_user_idx ON public.rider_support_message_reads(user_id, message_id);


-- 4. Habilitar RLS em todas as tabelas e conceder permissoes controladas
ALTER TABLE public.rider_support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rider_support_message_reads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rider_support_tickets FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.rider_support_messages FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.rider_support_message_reads FROM PUBLIC, anon;

GRANT SELECT ON public.rider_support_tickets TO authenticated;
GRANT SELECT ON public.rider_support_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.rider_support_message_reads TO authenticated;

GRANT SELECT ON public.system_audit_logs TO authenticated;

-- Politicas RLS para rider_support_tickets
DROP POLICY IF EXISTS rider_support_tickets_rider_select ON public.rider_support_tickets;
CREATE POLICY rider_support_tickets_rider_select ON public.rider_support_tickets
  FOR SELECT TO authenticated
  USING (
    motoboy_id IN (
      SELECT f.id FROM public.fleet f WHERE f.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rider_support_tickets_admin_all ON public.rider_support_tickets;
CREATE POLICY rider_support_tickets_admin_all ON public.rider_support_tickets
  FOR ALL TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- Politicas RLS para rider_support_messages
DROP POLICY IF EXISTS rider_support_messages_rider_select ON public.rider_support_messages;
CREATE POLICY rider_support_messages_rider_select ON public.rider_support_messages
  FOR SELECT TO authenticated
  USING (
    is_internal IS FALSE AND ticket_id IN (
      SELECT t.id FROM public.rider_support_tickets t
      JOIN public.fleet f ON f.id = t.motoboy_id
      WHERE f.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rider_support_messages_admin_all ON public.rider_support_messages;
CREATE POLICY rider_support_messages_admin_all ON public.rider_support_messages
  FOR ALL TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- Politicas RLS para rider_support_message_reads
DROP POLICY IF EXISTS rider_support_message_reads_select ON public.rider_support_message_reads;
CREATE POLICY rider_support_message_reads_select ON public.rider_support_message_reads
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_user());

DROP POLICY IF EXISTS rider_support_message_reads_insert ON public.rider_support_message_reads;
CREATE POLICY rider_support_message_reads_insert ON public.rider_support_message_reads
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.is_admin_user());


-- =====================================================================
-- 5. RPCs DO MOTOBOY
-- =====================================================================

-- 5.1 Criar Chamado pelo Motoboy
CREATE OR REPLACE FUNCTION public.create_my_rider_support_ticket(
  p_subject TEXT,
  p_category TEXT,
  p_priority TEXT DEFAULT 'normal',
  p_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user_id UUID;
  v_fleet_id UUID;
  v_ticket_id UUID;
  v_message_id UUID;
  v_subject_trimmed TEXT;
  v_message_trimmed TEXT;
  v_category TEXT;
  v_priority TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT id INTO v_fleet_id
  FROM public.fleet
  WHERE user_id = v_user_id
  LIMIT 1;

  IF v_fleet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não localizado em fleet.');
  END IF;

  v_subject_trimmed := trim(p_subject);
  IF v_subject_trimmed IS NULL OR char_length(v_subject_trimmed) < 3 OR char_length(v_subject_trimmed) > 120 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_SUBJECT', 'message', 'O assunto deve ter entre 3 e 120 caracteres.');
  END IF;

  v_category := trim(p_category);
  IF v_category NOT IN ('delivery_issue', 'payment_question', 'consumable_question', 'app_problem', 'account_problem', 'other') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_CATEGORY', 'message', 'Categoria inválida.');
  END IF;

  v_priority := trim(COALESCE(p_priority, 'normal'));
  IF v_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_PRIORITY', 'message', 'Prioridade inválida.');
  END IF;

  v_message_trimmed := trim(p_message);
  IF v_message_trimmed IS NULL OR char_length(v_message_trimmed) < 1 OR char_length(v_message_trimmed) > 4000 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_MESSAGE', 'message', 'A mensagem deve conter entre 1 e 4000 caracteres.');
  END IF;

  -- Insert Ticket
  INSERT INTO public.rider_support_tickets (
    motoboy_id, subject, category, priority, status, created_by, created_at, updated_at, last_message_at
  ) VALUES (
    v_fleet_id, v_subject_trimmed, v_category, v_priority, 'open', v_user_id, clock_timestamp(), clock_timestamp(), clock_timestamp()
  ) RETURNING id INTO v_ticket_id;

  -- Insert First Message
  INSERT INTO public.rider_support_messages (
    ticket_id, sender_user_id, sender_type, message, created_at, is_internal
  ) VALUES (
    v_ticket_id, v_user_id, 'rider', v_message_trimmed, clock_timestamp(), false
  ) RETURNING id INTO v_message_id;

  -- Recibo de leitura para o próprio criador
  INSERT INTO public.rider_support_message_reads (message_id, user_id, read_at)
  VALUES (v_message_id, v_user_id, clock_timestamp())
  ON CONFLICT DO NOTHING;

  -- Registrar Auditoria
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES (
    'rider',
    v_user_id::text,
    'rider_support_ticket_created',
    'rider_support_tickets/' || v_ticket_id::text,
    jsonb_build_object(
      'ticket_id', v_ticket_id,
      'motoboy_id', v_fleet_id,
      'category', v_category,
      'priority', v_priority,
      'subject', v_subject_trimmed
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'ticket_id', v_ticket_id,
    'subject', v_subject_trimmed,
    'category', v_category,
    'priority', v_priority,
    'status', 'open',
    'created_at', clock_timestamp()
  );
END;
$$;


-- 5.2 Listar Chamados do Motoboy
CREATE OR REPLACE FUNCTION public.get_my_rider_support_tickets(
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user_id UUID;
  v_fleet_id UUID;
  v_limit INT;
  v_offset INT;
  v_total_count INT;
  v_items JSONB;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT id INTO v_fleet_id
  FROM public.fleet
  WHERE user_id = v_user_id
  LIMIT 1;

  IF v_fleet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não localizado.');
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  SELECT COUNT(*) INTO v_total_count
  FROM public.rider_support_tickets t
  WHERE t.motoboy_id = v_fleet_id
    AND (p_status IS NULL OR p_status = '' OR t.status = p_status);

  SELECT COALESCE(jsonb_agg(stmt.ticket_row), '[]'::jsonb) INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'ticket_id', t.id,
      'subject', t.subject,
      'category', t.category,
      'priority', t.priority,
      'status', t.status,
      'created_at', t.created_at,
      'updated_at', t.updated_at,
      'last_message_at', t.last_message_at,
      'unread_messages_count', (
        SELECT COUNT(*)
        FROM public.rider_support_messages m
        WHERE m.ticket_id = t.id
          AND m.is_internal IS FALSE
          AND m.sender_user_id <> v_user_id
          AND NOT EXISTS (
            SELECT 1 FROM public.rider_support_message_reads r
            WHERE r.message_id = m.id AND r.user_id = v_user_id
          )
      ),
      'last_message_preview', (
        SELECT substr(m.message, 1, 100)
        FROM public.rider_support_messages m
        WHERE m.ticket_id = t.id AND m.is_internal IS FALSE
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      )
    ) AS ticket_row
    FROM public.rider_support_tickets t
    WHERE t.motoboy_id = v_fleet_id
      AND (p_status IS NULL OR p_status = '' OR t.status = p_status)
    ORDER BY t.last_message_at DESC, t.id DESC
    LIMIT v_limit OFFSET v_offset
  ) stmt;

  RETURN jsonb_build_object(
    'success', true,
    'total_count', v_total_count,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
END;
$$;


-- 5.3 Detalhes do Chamado para o Motoboy
CREATE OR REPLACE FUNCTION public.get_my_rider_support_ticket(
  p_ticket_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user_id UUID;
  v_fleet_id UUID;
  v_ticket RECORD;
  v_messages JSONB;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT id INTO v_fleet_id
  FROM public.fleet
  WHERE user_id = v_user_id
  LIMIT 1;

  SELECT * INTO v_ticket
  FROM public.rider_support_tickets
  WHERE id = p_ticket_id AND motoboy_id = v_fleet_id;

  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TICKET_NOT_FOUND', 'message', 'Chamado não localizado ou sem acesso.');
  END IF;

  -- Marcar mensagens visíveis do suporte como lidas para este motoboy
  INSERT INTO public.rider_support_message_reads (message_id, user_id, read_at)
  SELECT m.id, v_user_id, clock_timestamp()
  FROM public.rider_support_messages m
  WHERE m.ticket_id = p_ticket_id
    AND m.is_internal IS FALSE
    AND m.sender_user_id <> v_user_id
  ON CONFLICT (message_id, user_id) DO NOTHING;

  -- Buscar histórico de mensagens visíveis ao motoboy
  SELECT COALESCE(jsonb_agg(stmt.msg_row), '[]'::jsonb) INTO v_messages
  FROM (
    SELECT jsonb_build_object(
      'id', m.id,
      'sender_type', m.sender_type,
      'sender_user_id', m.sender_user_id,
      'message', m.message,
      'created_at', m.created_at
    ) AS msg_row
    FROM public.rider_support_messages m
    WHERE m.ticket_id = p_ticket_id AND m.is_internal IS FALSE
    ORDER BY m.created_at ASC, m.id ASC
  ) stmt;

  RETURN jsonb_build_object(
    'success', true,
    'ticket', jsonb_build_object(
      'ticket_id', v_ticket.id,
      'subject', v_ticket.subject,
      'category', v_ticket.category,
      'priority', v_ticket.priority,
      'status', v_ticket.status,
      'created_at', v_ticket.created_at,
      'updated_at', v_ticket.updated_at,
      'last_message_at', v_ticket.last_message_at,
      'closed_at', v_ticket.closed_at
    ),
    'messages', v_messages
  );
END;
$$;


-- 5.4 Resposta do Motoboy no Chamado
CREATE OR REPLACE FUNCTION public.reply_my_rider_support_ticket(
  p_ticket_id UUID,
  p_message TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user_id UUID;
  v_fleet_id UUID;
  v_ticket RECORD;
  v_message_trimmed TEXT;
  v_message_id UUID;
  v_new_status TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  SELECT id INTO v_fleet_id
  FROM public.fleet
  WHERE user_id = v_user_id
  LIMIT 1;

  SELECT * INTO v_ticket
  FROM public.rider_support_tickets
  WHERE id = p_ticket_id AND motoboy_id = v_fleet_id
  FOR UPDATE;

  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TICKET_NOT_FOUND', 'message', 'Chamado não localizado.');
  END IF;

  IF v_ticket.status = 'closed' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TICKET_CLOSED', 'message', 'Chamado encerrado. Não é possível enviar novas mensagens.');
  END IF;

  v_message_trimmed := trim(p_message);
  IF v_message_trimmed IS NULL OR char_length(v_message_trimmed) < 1 OR char_length(v_message_trimmed) > 4000 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_MESSAGE', 'message', 'Mensagem inválida (deve conter entre 1 e 4000 caracteres).');
  END IF;

  v_new_status := 'waiting_admin';

  INSERT INTO public.rider_support_messages (
    ticket_id, sender_user_id, sender_type, message, created_at, is_internal
  ) VALUES (
    p_ticket_id, v_user_id, 'rider', v_message_trimmed, clock_timestamp(), false
  ) RETURNING id INTO v_message_id;

  INSERT INTO public.rider_support_message_reads (message_id, user_id, read_at)
  VALUES (v_message_id, v_user_id, clock_timestamp())
  ON CONFLICT DO NOTHING;

  UPDATE public.rider_support_tickets
  SET status = v_new_status,
      updated_at = clock_timestamp(),
      last_message_at = clock_timestamp(),
      closed_at = NULL
  WHERE id = p_ticket_id;

  -- Auditoria
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES (
    'rider',
    v_user_id::text,
    'rider_support_ticket_replied',
    'rider_support_tickets/' || p_ticket_id::text,
    jsonb_build_object('ticket_id', p_ticket_id, 'status', v_new_status)
  );

  RETURN jsonb_build_object(
    'success', true,
    'ticket_id', p_ticket_id,
    'status', v_new_status,
    'last_message_at', clock_timestamp()
  );
END;
$$;


-- =====================================================================
-- 6. RPCs ADMINISTRATIVAS
-- =====================================================================

-- 6.1 Listar Chamados (Visão Administrativa)
CREATE OR REPLACE FUNCTION public.admin_get_rider_support_tickets(
  p_status TEXT DEFAULT NULL,
  p_priority TEXT DEFAULT NULL,
  p_motoboy_id UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_admin_id UUID;
  v_limit INT;
  v_offset INT;
  v_total_count INT;
  v_items JSONB;
  v_search_term TEXT;
BEGIN
  v_admin_id := auth.uid();
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Acesso restrito a administradores.');
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);
  v_search_term := trim(p_search);

  SELECT COUNT(*) INTO v_total_count
  FROM public.rider_support_tickets t
  JOIN public.fleet f ON f.id = t.motoboy_id
  WHERE (p_status IS NULL OR p_status = '' OR t.status = p_status)
    AND (p_priority IS NULL OR p_priority = '' OR t.priority = p_priority)
    AND (p_motoboy_id IS NULL OR t.motoboy_id = p_motoboy_id)
    AND (
      v_search_term IS NULL OR v_search_term = '' OR
      t.subject ILIKE '%' || v_search_term || '%' OR
      f.name ILIKE '%' || v_search_term || '%' OR
      f.motoboy_code ILIKE '%' || v_search_term || '%' OR
      t.category ILIKE '%' || v_search_term || '%'
    );

  SELECT COALESCE(jsonb_agg(stmt.ticket_row), '[]'::jsonb) INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'ticket_id', t.id,
      'motoboy_id', t.motoboy_id,
      'rider_name', f.name,
      'rider_code', COALESCE(f.motoboy_code, 'MB-0000'),
      'rider_display_name', f.name || ' — ' || COALESCE(f.motoboy_code, 'MB-0000'),
      'subject', t.subject,
      'category', t.category,
      'priority', t.priority,
      'status', t.status,
      'assigned_admin_id', t.assigned_admin_id,
      'assigned_admin_name', (SELECT name FROM public.user_profiles WHERE user_id = t.assigned_admin_id LIMIT 1),
      'created_at', t.created_at,
      'updated_at', t.updated_at,
      'last_message_at', t.last_message_at,
      'unread_messages_count', (
        SELECT COUNT(*)
        FROM public.rider_support_messages m
        WHERE m.ticket_id = t.id
          AND m.sender_type = 'rider'
          AND NOT EXISTS (
            SELECT 1 FROM public.rider_support_message_reads r
            WHERE r.message_id = m.id AND r.user_id = v_admin_id
          )
      ),
      'last_message_preview', (
        SELECT substr(m.message, 1, 100)
        FROM public.rider_support_messages m
        WHERE m.ticket_id = t.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      )
    ) AS ticket_row
    FROM public.rider_support_tickets t
    JOIN public.fleet f ON f.id = t.motoboy_id
    WHERE (p_status IS NULL OR p_status = '' OR t.status = p_status)
      AND (p_priority IS NULL OR p_priority = '' OR t.priority = p_priority)
      AND (p_motoboy_id IS NULL OR t.motoboy_id = p_motoboy_id)
      AND (
        v_search_term IS NULL OR v_search_term = '' OR
        t.subject ILIKE '%' || v_search_term || '%' OR
        f.name ILIKE '%' || v_search_term || '%' OR
        f.motoboy_code ILIKE '%' || v_search_term || '%' OR
        t.category ILIKE '%' || v_search_term || '%'
      )
    ORDER BY t.last_message_at DESC, t.id DESC
    LIMIT v_limit OFFSET v_offset
  ) stmt;

  RETURN jsonb_build_object(
    'success', true,
    'total_count', v_total_count,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
END;
$$;


-- 6.2 Resumo Global de Métricas de Suporte
CREATE OR REPLACE FUNCTION public.admin_get_rider_support_summary()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_admin_id UUID;
  v_new_count INT;
  v_in_progress_count INT;
  v_waiting_rider_count INT;
  v_waiting_admin_count INT;
  v_resolved_count INT;
  v_closed_count INT;
  v_urgent_count INT;
  v_unread_count INT;
BEGIN
  v_admin_id := auth.uid();
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Acesso restrito a administradores.');
  END IF;

  SELECT COUNT(*) FILTER (WHERE status = 'open') INTO v_new_count FROM public.rider_support_tickets;
  SELECT COUNT(*) FILTER (WHERE status = 'in_progress') INTO v_in_progress_count FROM public.rider_support_tickets;
  SELECT COUNT(*) FILTER (WHERE status = 'waiting_rider') INTO v_waiting_rider_count FROM public.rider_support_tickets;
  SELECT COUNT(*) FILTER (WHERE status = 'waiting_admin') INTO v_waiting_admin_count FROM public.rider_support_tickets;
  SELECT COUNT(*) FILTER (WHERE status = 'resolved') INTO v_resolved_count FROM public.rider_support_tickets;
  SELECT COUNT(*) FILTER (WHERE status = 'closed') INTO v_closed_count FROM public.rider_support_tickets;
  SELECT COUNT(*) FILTER (WHERE priority = 'urgent' AND status NOT IN ('resolved', 'closed')) INTO v_urgent_count FROM public.rider_support_tickets;

  SELECT COUNT(*) INTO v_unread_count
  FROM public.rider_support_messages m
  WHERE m.sender_type = 'rider'
    AND NOT EXISTS (
      SELECT 1 FROM public.rider_support_message_reads r
      WHERE r.message_id = m.id AND r.user_id = v_admin_id
    );

  RETURN jsonb_build_object(
    'success', true,
    'new_count', COALESCE(v_new_count, 0),
    'in_progress_count', COALESCE(v_in_progress_count, 0),
    'waiting_rider_count', COALESCE(v_waiting_rider_count, 0),
    'waiting_admin_count', COALESCE(v_waiting_admin_count, 0),
    'resolved_count', COALESCE(v_resolved_count, 0),
    'closed_count', COALESCE(v_closed_count, 0),
    'urgent_count', COALESCE(v_urgent_count, 0),
    'unread_count', COALESCE(v_unread_count, 0)
  );
END;
$$;


-- 6.3 Detalhes Administrativos do Chamado
CREATE OR REPLACE FUNCTION public.admin_get_rider_support_ticket(
  p_ticket_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_admin_id UUID;
  v_ticket RECORD;
  v_rider RECORD;
  v_messages JSONB;
BEGIN
  v_admin_id := auth.uid();
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Acesso restrito a administradores.');
  END IF;

  SELECT * INTO v_ticket
  FROM public.rider_support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TICKET_NOT_FOUND', 'message', 'Chamado não localizado.');
  END IF;

  SELECT f.id, f.name, COALESCE(f.motoboy_code, 'MB-0000') as motoboy_code, f.phone, f.status as rider_status
  INTO v_rider
  FROM public.fleet f
  WHERE f.id = v_ticket.motoboy_id;

  -- Criar recibos de leitura do admin para mensagens recebidas do motoboy neste chamado
  INSERT INTO public.rider_support_message_reads (message_id, user_id, read_at)
  SELECT m.id, v_admin_id, clock_timestamp()
  FROM public.rider_support_messages m
  WHERE m.ticket_id = p_ticket_id
    AND m.sender_type = 'rider'
  ON CONFLICT (message_id, user_id) DO NOTHING;

  -- Selecionar todas as mensagens (públicas e notas internas)
  SELECT COALESCE(jsonb_agg(stmt.msg_row), '[]'::jsonb) INTO v_messages
  FROM (
    SELECT jsonb_build_object(
      'id', m.id,
      'sender_type', m.sender_type,
      'sender_user_id', m.sender_user_id,
      'sender_name', CASE 
        WHEN m.sender_type = 'rider' THEN v_rider.name 
        WHEN m.sender_type = 'admin' THEN COALESCE((SELECT name FROM public.user_profiles WHERE user_id = m.sender_user_id LIMIT 1), 'Administrador')
        ELSE 'Sistema'
      END,
      'message', m.message,
      'is_internal', m.is_internal,
      'created_at', m.created_at
    ) AS msg_row
    FROM public.rider_support_messages m
    WHERE m.ticket_id = p_ticket_id
    ORDER BY m.created_at ASC, m.id ASC
  ) stmt;

  RETURN jsonb_build_object(
    'success', true,
    'ticket', jsonb_build_object(
      'ticket_id', v_ticket.id,
      'motoboy_id', v_ticket.motoboy_id,
      'subject', v_ticket.subject,
      'category', v_ticket.category,
      'priority', v_ticket.priority,
      'status', v_ticket.status,
      'assigned_admin_id', v_ticket.assigned_admin_id,
      'assigned_admin_name', (SELECT name FROM public.user_profiles WHERE user_id = v_ticket.assigned_admin_id LIMIT 1),
      'created_at', v_ticket.created_at,
      'updated_at', v_ticket.updated_at,
      'last_message_at', v_ticket.last_message_at,
      'closed_at', v_ticket.closed_at
    ),
    'rider', jsonb_build_object(
      'id', v_rider.id,
      'name', v_rider.name,
      'code', v_rider.motoboy_code,
      'display_name', v_rider.name || ' — ' || v_rider.motoboy_code,
      'phone', v_rider.phone,
      'status', v_rider.rider_status
    ),
    'messages', v_messages
  );
END;
$$;


-- 6.4 Resposta do Administrador e Criação de Nota Interna
CREATE OR REPLACE FUNCTION public.admin_reply_rider_support_ticket(
  p_ticket_id UUID,
  p_message TEXT,
  p_is_internal BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_admin_id UUID;
  v_ticket RECORD;
  v_message_trimmed TEXT;
  v_message_id UUID;
  v_new_status TEXT;
  v_is_internal_flag BOOLEAN;
BEGIN
  v_admin_id := auth.uid();
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Acesso restrito a administradores.');
  END IF;

  SELECT * INTO v_ticket
  FROM public.rider_support_tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TICKET_NOT_FOUND', 'message', 'Chamado não localizado.');
  END IF;

  v_message_trimmed := trim(p_message);
  IF v_message_trimmed IS NULL OR char_length(v_message_trimmed) < 1 OR char_length(v_message_trimmed) > 4000 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_MESSAGE', 'message', 'Mensagem inválida (deve conter entre 1 e 4000 caracteres).');
  END IF;

  v_is_internal_flag := COALESCE(p_is_internal, false);

  IF v_is_internal_flag THEN
    v_new_status := v_ticket.status; -- Nota interna não altera status
  ELSE
    v_new_status := 'waiting_rider'; -- Resposta pública altera para aguardando motoboy
  END IF;

  INSERT INTO public.rider_support_messages (
    ticket_id, sender_user_id, sender_type, message, created_at, is_internal
  ) VALUES (
    p_ticket_id, v_admin_id, 'admin', v_message_trimmed, clock_timestamp(), v_is_internal_flag
  ) RETURNING id INTO v_message_id;

  INSERT INTO public.rider_support_message_reads (message_id, user_id, read_at)
  VALUES (v_message_id, v_admin_id, clock_timestamp())
  ON CONFLICT DO NOTHING;

  UPDATE public.rider_support_tickets
  SET status = v_new_status,
      updated_at = clock_timestamp(),
      last_message_at = clock_timestamp(),
      assigned_admin_id = COALESCE(assigned_admin_id, v_admin_id)
  WHERE id = p_ticket_id;

  -- Auditoria
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES (
    'admin',
    v_admin_id::text,
    CASE WHEN v_is_internal_flag THEN 'admin_support_note_created' ELSE 'admin_support_reply_created' END,
    'rider_support_tickets/' || p_ticket_id::text,
    jsonb_build_object(
      'ticket_id', p_ticket_id,
      'is_internal', v_is_internal_flag,
      'status', v_new_status
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'ticket_id', p_ticket_id,
    'is_internal', v_is_internal_flag,
    'status', v_new_status,
    'last_message_at', clock_timestamp()
  );
END;
$$;


-- 6.5 Transições Controladas de Status
CREATE OR REPLACE FUNCTION public.admin_update_rider_support_ticket_status(
  p_ticket_id UUID,
  p_status TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_admin_id UUID;
  v_ticket RECORD;
  v_old_status TEXT;
  v_new_status TEXT;
  v_reason_trimmed TEXT;
  v_is_valid_transition BOOLEAN := false;
BEGIN
  v_admin_id := auth.uid();
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Acesso restrito a administradores.');
  END IF;

  SELECT * INTO v_ticket
  FROM public.rider_support_tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TICKET_NOT_FOUND', 'message', 'Chamado não localizado.');
  END IF;

  v_old_status := v_ticket.status;
  v_new_status := trim(p_status);
  v_reason_trimmed := trim(p_reason);

  IF v_old_status = v_new_status THEN
    RETURN jsonb_build_object('success', true, 'ticket_id', p_ticket_id, 'status', v_new_status, 'message', 'Status inalterado.');
  END IF;

  -- Matriz de Transições Válidas
  IF v_old_status = 'open' AND v_new_status IN ('in_progress', 'closed') THEN v_is_valid_transition := true;
  ELSIF v_old_status = 'in_progress' AND v_new_status IN ('waiting_rider', 'waiting_admin', 'resolved', 'closed') THEN v_is_valid_transition := true;
  ELSIF v_old_status = 'waiting_rider' AND v_new_status IN ('in_progress', 'resolved', 'closed') THEN v_is_valid_transition := true;
  ELSIF v_old_status = 'waiting_admin' AND v_new_status IN ('in_progress', 'waiting_rider', 'resolved', 'closed') THEN v_is_valid_transition := true;
  ELSIF v_old_status = 'resolved' AND v_new_status IN ('in_progress', 'closed') THEN v_is_valid_transition := true;
  ELSIF v_old_status = 'closed' AND v_new_status IN ('in_progress') THEN
    IF v_reason_trimmed IS NULL OR char_length(v_reason_trimmed) < 3 THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'REOPEN_REASON_REQUIRED', 'message', 'Motivo obrigatório para reabrir chamado encerrado.');
    END IF;
    v_is_valid_transition := true;
  END IF;

  IF NOT v_is_valid_transition THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_STATUS_TRANSITION', 'message', 'Transição de status não permitida: ' || v_old_status || ' -> ' || v_new_status);
  END IF;

  UPDATE public.rider_support_tickets
  SET status = v_new_status,
      updated_at = clock_timestamp(),
      closed_at = CASE WHEN v_new_status = 'closed' THEN clock_timestamp() ELSE NULL END
  WHERE id = p_ticket_id;

  INSERT INTO public.rider_support_messages (
    ticket_id, sender_user_id, sender_type, message, created_at, is_internal
  ) VALUES (
    p_ticket_id,
    v_admin_id,
    'system',
    'Status alterado de ' || v_old_status || ' para ' || v_new_status || CASE WHEN v_reason_trimmed IS NOT NULL THEN ' (' || v_reason_trimmed || ')' ELSE '' END,
    clock_timestamp(),
    false
  );

  -- Auditoria
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES (
    'admin',
    v_admin_id::text,
    'admin_support_status_updated',
    'rider_support_tickets/' || p_ticket_id::text,
    jsonb_build_object(
      'ticket_id', p_ticket_id,
      'old_status', v_old_status,
      'new_status', v_new_status,
      'reason', v_reason_trimmed
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'ticket_id', p_ticket_id,
    'old_status', v_old_status,
    'new_status', v_new_status,
    'closed_at', CASE WHEN v_new_status = 'closed' THEN clock_timestamp() ELSE NULL END
  );
END;
$$;


-- 6.6 Atribuição de Administrador Responsável
CREATE OR REPLACE FUNCTION public.admin_assign_rider_support_ticket(
  p_ticket_id UUID,
  p_admin_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_admin_id UUID;
  v_ticket RECORD;
  v_target_admin_name TEXT;
BEGIN
  v_admin_id := auth.uid();
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ADMIN_ROLE_REQUIRED', 'message', 'Acesso restrito a administradores.');
  END IF;

  SELECT * INTO v_ticket
  FROM public.rider_support_tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TICKET_NOT_FOUND', 'message', 'Chamado não localizado.');
  END IF;

  IF p_admin_user_id IS NOT NULL THEN
    SELECT name INTO v_target_admin_name
    FROM public.user_profiles
    WHERE user_id = p_admin_user_id
      AND is_active = true
      AND role IN ('owner', 'admin', 'operador', 'gerente')
    LIMIT 1;

    IF v_target_admin_name IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_TARGET_ADMIN', 'message', 'Administrador de destino inválido ou inativo.');
    END IF;
  END IF;

  UPDATE public.rider_support_tickets
  SET assigned_admin_id = p_admin_user_id,
      updated_at = clock_timestamp()
  WHERE id = p_ticket_id;

  -- Auditoria
  INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
  VALUES (
    'admin',
    v_admin_id::text,
    'admin_support_ticket_assigned',
    'rider_support_tickets/' || p_ticket_id::text,
    jsonb_build_object(
      'ticket_id', p_ticket_id,
      'assigned_admin_id', p_admin_user_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'ticket_id', p_ticket_id,
    'assigned_admin_id', p_admin_user_id,
    'assigned_admin_name', v_target_admin_name
  );
END;
$$;


-- =====================================================================
-- 7. PERMISSÕES E PUBLICAÇÃO REALTIME
-- =====================================================================

REVOKE ALL ON FUNCTION public.create_my_rider_support_ticket(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_my_rider_support_ticket(TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_my_rider_support_ticket(TEXT, TEXT, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.get_my_rider_support_tickets(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_support_tickets(TEXT, INTEGER, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_support_tickets(TEXT, INTEGER, INTEGER) TO authenticated;

REVOKE ALL ON FUNCTION public.get_my_rider_support_ticket(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_rider_support_ticket(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_rider_support_ticket(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.reply_my_rider_support_ticket(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_my_rider_support_ticket(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.reply_my_rider_support_ticket(UUID, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_rider_support_tickets(TEXT, TEXT, UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_get_rider_support_tickets(TEXT, TEXT, UUID, TEXT, INTEGER, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_get_rider_support_tickets(TEXT, TEXT, UUID, TEXT, INTEGER, INTEGER) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_rider_support_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_get_rider_support_summary() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_get_rider_support_summary() TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_rider_support_ticket(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_get_rider_support_ticket(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_get_rider_support_ticket(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_reply_rider_support_ticket(UUID, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reply_rider_support_ticket(UUID, TEXT, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reply_rider_support_ticket(UUID, TEXT, BOOLEAN) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_update_rider_support_ticket_status(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_rider_support_ticket_status(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_update_rider_support_ticket_status(UUID, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_assign_rider_support_ticket(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_assign_rider_support_ticket(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_rider_support_ticket(UUID, UUID) TO authenticated;

-- Adicionar tabelas de suporte ao Realtime
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rider_support_tickets;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rider_support_messages;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

NOTIFY pgrst, 'reload schema';
