-- =====================================================================
-- Dahora Expresso — Migration: Web Push Subscriptions, RPCs & Outbox
-- Timestamp: 20260728000400
-- =====================================================================

-- 1. Criar Tabela public.rider_push_subscriptions
CREATE TABLE IF NOT EXISTS public.rider_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id UUID NOT NULL REFERENCES public.fleet(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NULL
);

-- Índices em rider_id e is_active
CREATE INDEX IF NOT EXISTS idx_rider_push_subscriptions_rider ON public.rider_push_subscriptions(rider_id);
CREATE INDEX IF NOT EXISTS idx_rider_push_subscriptions_active ON public.rider_push_subscriptions(is_active);

-- Privilégios Estritos
REVOKE ALL ON public.rider_push_subscriptions FROM PUBLIC;
REVOKE ALL ON public.rider_push_subscriptions FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rider_push_subscriptions TO authenticated;

-- Habilitar RLS
ALTER TABLE public.rider_push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rider_push_subscriptions_select_policy ON public.rider_push_subscriptions;
CREATE POLICY rider_push_subscriptions_select_policy ON public.rider_push_subscriptions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.fleet f
      WHERE f.id = rider_push_subscriptions.rider_id
        AND f.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS rider_push_subscriptions_insert_policy ON public.rider_push_subscriptions;
CREATE POLICY rider_push_subscriptions_insert_policy ON public.rider_push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.fleet f
      WHERE f.id = rider_push_subscriptions.rider_id
        AND f.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS rider_push_subscriptions_update_policy ON public.rider_push_subscriptions;
CREATE POLICY rider_push_subscriptions_update_policy ON public.rider_push_subscriptions
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.fleet f
      WHERE f.id = rider_push_subscriptions.rider_id
        AND f.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.fleet f
      WHERE f.id = rider_push_subscriptions.rider_id
        AND f.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS rider_push_subscriptions_delete_policy ON public.rider_push_subscriptions;
CREATE POLICY rider_push_subscriptions_delete_policy ON public.rider_push_subscriptions
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.fleet f
      WHERE f.id = rider_push_subscriptions.rider_id
        AND f.user_id = (SELECT auth.uid())
    )
  );

-- 2. RPC: Registrar Subscription Segura do Motoboy
CREATE OR REPLACE FUNCTION public.register_my_push_subscription(
  p_endpoint TEXT,
  p_p256dh TEXT,
  p_auth TEXT,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_rider_id UUID;
  v_sub_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado. Usuário não autenticado.';
  END IF;

  IF coalesce(trim(p_endpoint), '') = '' OR coalesce(trim(p_p256dh), '') = '' OR coalesce(trim(p_auth), '') = '' THEN
    RAISE EXCEPTION 'Parâmetros de subscription inválidos (endpoint, p256dh e auth são obrigatórios).';
  END IF;

  SELECT f.id INTO v_rider_id
  FROM public.fleet f
  WHERE f.user_id = v_user_id
  LIMIT 1;

  IF v_rider_id IS NULL THEN
    RAISE EXCEPTION 'Entregador não encontrado para o usuário autenticado.';
  END IF;

  INSERT INTO public.rider_push_subscriptions (
    rider_id,
    endpoint,
    p256dh,
    auth,
    user_agent,
    is_active,
    failure_count,
    last_error,
    updated_at
  ) VALUES (
    v_rider_id,
    p_endpoint,
    p_p256dh,
    p_auth,
    p_user_agent,
    true,
    0,
    NULL,
    now()
  )
  ON CONFLICT (endpoint) DO UPDATE SET
    rider_id = v_rider_id,
    p256dh = EXCLUDED.p256dh,
    auth = EXCLUDED.auth,
    user_agent = EXCLUDED.user_agent,
    is_active = true,
    failure_count = 0,
    last_error = NULL,
    updated_at = now()
  RETURNING id INTO v_sub_id;

  RETURN jsonb_build_object(
    'success', true,
    'subscription_id', v_sub_id,
    'rider_id', v_rider_id,
    'message', 'Subscription registrada com sucesso.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_my_push_subscription FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_my_push_subscription FROM anon;
GRANT EXECUTE ON FUNCTION public.register_my_push_subscription TO authenticated;

-- 3. RPC: Desativar Subscription do Motoboy
CREATE OR REPLACE FUNCTION public.deactivate_my_push_subscription(
  p_endpoint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_rider_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado. Usuário não autenticado.';
  END IF;

  SELECT f.id INTO v_rider_id
  FROM public.fleet f
  WHERE f.user_id = v_user_id
  LIMIT 1;

  IF v_rider_id IS NULL THEN
    RAISE EXCEPTION 'Entregador não encontrado.';
  END IF;

  UPDATE public.rider_push_subscriptions
  SET is_active = false, updated_at = now()
  WHERE endpoint = p_endpoint
    AND rider_id = v_rider_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Subscription desativada com sucesso.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_my_push_subscription FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deactivate_my_push_subscription FROM anon;
GRANT EXECUTE ON FUNCTION public.deactivate_my_push_subscription TO authenticated;

-- 4. Tabela public.rider_notification_outbox
CREATE TABLE IF NOT EXISTS public.rider_notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id UUID NOT NULL REFERENCES public.fleet(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  tele_id UUID NULL REFERENCES public.teles(id) ON DELETE CASCADE,
  conversation_id UUID NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON public.rider_notification_outbox(status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_rider ON public.rider_notification_outbox(rider_id);

REVOKE ALL ON public.rider_notification_outbox FROM PUBLIC;
REVOKE ALL ON public.rider_notification_outbox FROM anon;
REVOKE ALL ON public.rider_notification_outbox FROM authenticated;

-- 5. RPC Backend-Only: Reivindicação Atômica do Outbox (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_rider_notification_outbox(
  p_limit INTEGER DEFAULT 20
)
RETURNS SETOF public.rider_notification_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id
    FROM public.rider_notification_outbox
    WHERE status = 'pending'
      AND next_attempt_at <= now()
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.rider_notification_outbox o
  SET status = 'processing'
  FROM claimed c
  WHERE o.id = c.id
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_rider_notification_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_rider_notification_outbox FROM anon;
REVOKE ALL ON FUNCTION public.claim_rider_notification_outbox FROM authenticated;

-- 6. Atualizar assign_rider_to_tele RPC para registrar item no outbox após commit da atribuição
CREATE OR REPLACE FUNCTION public.assign_rider_to_tele(
  p_tele_id UUID,
  p_motoboy_id UUID,
  p_expected_version INTEGER,
  p_reason TEXT DEFAULT NULL,
  p_reassignment_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tele_record RECORD;
  v_rider_record RECORD;
  v_actor_role TEXT;
  v_current_active INTEGER;
  v_idempotency_key TEXT;
BEGIN
  IF NOT (public.get_current_user_role() IN ('admin', 'operator') OR public.current_user_has_permission('tele:dispatch')) THEN
    RAISE EXCEPTION 'Acesso negado: privilégio insuficiente para despachar tele.';
  END IF;

  SELECT * INTO v_tele_record
  FROM public.teles
  WHERE id = p_tele_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TELE_NOT_FOUND', 'message', 'Tele não encontrada.');
  END IF;

  IF v_tele_record.version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT', 'message', 'A tele foi alterada por outro usuário.');
  END IF;

  IF v_tele_record.status IN ('concluida', 'cancelada', 'Entregue') THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_STATUS', 'message', 'Tele concluída ou cancelada não pode ser reatribuída.');
  END IF;

  IF v_tele_record.motoboy_id IS NOT NULL AND v_tele_record.motoboy_id <> p_motoboy_id THEN
    IF coalesce(trim(p_reassignment_reason), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'REASSIGNMENT_REASON_REQUIRED', 'message', 'Motivo da reatribuição é obrigatório.');
    END IF;
  END IF;

  SELECT * INTO v_rider_record
  FROM public.fleet
  WHERE id = p_motoboy_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'RIDER_NOT_FOUND', 'message', 'Entregador não encontrado.');
  END IF;

  SELECT count(*) INTO v_current_active
  FROM public.teles
  WHERE motoboy_id = p_motoboy_id
    AND status IN ('a_caminho_coleta', 'em_rota_entrega', 'A caminho da coleta', 'Em rota de entrega');

  IF v_current_active >= coalesce(v_rider_record.simultaneous_limit, 2) THEN
    RETURN jsonb_build_object('success', false, 'error', 'RIDER_LIMIT_REACHED', 'message', 'Entregador atingiu o limite de teles simultâneas.');
  END IF;

  UPDATE public.teles
  SET motoboy_id = p_motoboy_id,
      status = 'motoboy_designado',
      version = v_tele_record.version + 1,
      updated_at = now()
  WHERE id = p_tele_id;

  UPDATE public.fleet
  SET status = 'Em entrega'
  WHERE id = p_motoboy_id;

  INSERT INTO public.system_audit_logs (
    actor_type,
    actor_id,
    action,
    target_resource,
    details
  ) VALUES (
    public.get_current_user_role(),
    auth.uid()::text,
    'ASSIGN_RIDER',
    pg_catalog.format('teles:%s', p_tele_id),
    jsonb_build_object(
      'tele_id', p_tele_id,
      'previous_motoboy_id', v_tele_record.motoboy_id,
      'new_motoboy_id', p_motoboy_id,
      'reassignment_reason', p_reassignment_reason
    )
  );

  v_idempotency_key := 'NEW_TELE:' || p_tele_id::text || ':' || p_motoboy_id::text;
  INSERT INTO public.rider_notification_outbox (
    rider_id,
    event_type,
    tele_id,
    payload,
    idempotency_key
  ) VALUES (
    p_motoboy_id,
    'NEW_TELE',
    p_tele_id,
    jsonb_build_object(
      'type', 'NEW_TELE',
      'tele_id', p_tele_id,
      'title', 'Nova Tele atribuída',
      'body', 'Nova entrega disponível. Toque para visualizar.',
      'url', '/motoboy.html?view=tele&tele_id=' || p_tele_id::text
    ),
    v_idempotency_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'tele_id', p_tele_id,
    'motoboy_id', p_motoboy_id,
    'new_version', v_tele_record.version + 1,
    'status', 'a_caminho_coleta'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_rider_to_tele(uuid, uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_rider_to_tele(uuid, uuid, integer, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_rider_to_tele(uuid, uuid, integer, text, text) TO authenticated;
