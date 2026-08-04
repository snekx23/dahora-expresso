-- =====================================================================
-- Migration: 20260801000100_rider_support_direct_chat_rpc.sql
-- Descrição: RPC idempotente e segura para busca/criação concorrente do
--            atendimento operacional direto do Motoboy no PWA.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_or_create_my_active_rider_chat()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user_id UUID;
  v_fleet_id UUID;
  v_ticket_id UUID;
  v_status TEXT;
  v_created_at TIMESTAMPTZ;
  v_last_message_at TIMESTAMPTZ;
BEGIN
  -- 1. Exigir autenticação válida
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATION_REQUIRED', 'message', 'Autenticação necessária.');
  END IF;

  -- 2. Lock transacional na linha da frota do motoboy para evitar concorrência dupla
  SELECT id INTO v_fleet_id
  FROM public.fleet
  WHERE user_id = v_user_id
  FOR UPDATE;

  IF v_fleet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RIDER_PROFILE_NOT_FOUND', 'message', 'Perfil de motoboy não localizado em fleet.');
  END IF;

  -- 3. Buscar atendimento operacional ativo (categoria canônica 'other', assunto fixo 'Atendimento Operacional PWA')
  SELECT id, status, created_at, last_message_at
  INTO v_ticket_id, v_status, v_created_at, v_last_message_at
  FROM public.rider_support_tickets
  WHERE motoboy_id = v_fleet_id
    AND subject = 'Atendimento Operacional PWA'
    AND category = 'other'
    AND status IN ('open', 'in_progress', 'waiting_rider', 'waiting_admin')
  ORDER BY created_at DESC
  LIMIT 1;

  -- 4. Se não existir chamado ativo, criar um novo automaticamente
  IF v_ticket_id IS NULL THEN
    INSERT INTO public.rider_support_tickets (
      motoboy_id,
      created_by,
      category,
      priority,
      subject,
      status,
      created_at,
      updated_at,
      last_message_at
    ) VALUES (
      v_fleet_id,
      v_user_id,
      'other',
      'normal',
      'Atendimento Operacional PWA',
      'open',
      clock_timestamp(),
      clock_timestamp(),
      clock_timestamp()
    )
    RETURNING id, status, created_at, last_message_at
    INTO v_ticket_id, v_status, v_created_at, v_last_message_at;

    -- Registrar log de auditoria do sistema
    INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
    VALUES (
      'rider',
      v_fleet_id::text,
      'rider_auto_chat_created',
      'rider_support_tickets/' || v_ticket_id::text,
      jsonb_build_object(
        'ticket_id', v_ticket_id,
        'motoboy_id', v_fleet_id,
        'subject', 'Atendimento Operacional PWA'
      )
    );
  END IF;

  -- 5. Retornar dados do ticket operacional
  RETURN jsonb_build_object(
    'success', true,
    'ticket_id', v_ticket_id,
    'status', v_status,
    'created_at', v_created_at,
    'last_message_at', v_last_message_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_my_active_rider_chat() TO authenticated;
