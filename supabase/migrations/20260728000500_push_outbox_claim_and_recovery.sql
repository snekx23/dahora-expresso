-- =====================================================================
-- Dahora Expresso — Migration: Outbox Claim Atômico com Worker Token & Stale Recovery
-- Timestamp: 20260728000500
-- =====================================================================

-- 1. Adicionar colunas de controle de claim no public.rider_notification_outbox
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rider_notification_outbox' AND column_name = 'processing_started_at'
  ) THEN
    ALTER TABLE public.rider_notification_outbox ADD COLUMN processing_started_at TIMESTAMPTZ NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rider_notification_outbox' AND column_name = 'worker_token'
  ) THEN
    ALTER TABLE public.rider_notification_outbox ADD COLUMN worker_token UUID NULL;
  END IF;
END $$;

-- Índice para acelerar a recuperação de itens abandonados
CREATE INDEX IF NOT EXISTS idx_outbox_stale ON public.rider_notification_outbox(status, processing_started_at) WHERE status = 'processing';

-- 2. RPC Backend-Only: Reivindicação Atômica com Worker Token (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_rider_notification_outbox(
  p_limit INTEGER DEFAULT 20,
  p_worker_token UUID DEFAULT gen_random_uuid()
)
RETURNS SETOF public.rider_notification_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit INTEGER;
BEGIN
  v_limit := p_limit;
  IF v_limit < 1 OR v_limit > 100 THEN
    v_limit := 20;
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT id
    FROM public.rider_notification_outbox
    WHERE status = 'pending'
      AND next_attempt_at <= now()
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  )
  UPDATE public.rider_notification_outbox o
  SET status = 'processing',
      processing_started_at = now(),
      worker_token = p_worker_token
  FROM claimed c
  WHERE o.id = c.id
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_rider_notification_outbox(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_rider_notification_outbox(integer, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_rider_notification_outbox(integer, uuid) FROM authenticated;

-- 3. RPC Backend-Only: Recuperação de Itens Abandonados (Stale Workers)
CREATE OR REPLACE FUNCTION public.recover_stale_notification_outbox(
  p_stale_after INTERVAL DEFAULT interval '2 minutes'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recovered_count INTEGER := 0;
BEGIN
  WITH stale_items AS (
    SELECT id, attempt_count
    FROM public.rider_notification_outbox
    WHERE status = 'processing'
      AND processing_started_at < (now() - p_stale_after)
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE public.rider_notification_outbox o
    SET status = CASE
                   WHEN s.attempt_count + 1 >= 5 THEN 'failed'
                   ELSE 'pending'
                 END,
        attempt_count = s.attempt_count + 1,
        next_attempt_at = now(),
        processed_at = CASE
                         WHEN s.attempt_count + 1 >= 5 THEN now()
                         ELSE NULL
                       END,
        last_error = CASE
                       WHEN s.attempt_count + 1 >= 5 THEN 'worker_timeout'
                       ELSE 'worker_timeout_recovered'
                     END,
        worker_token = NULL,
        processing_started_at = NULL
    FROM stale_items s
    WHERE o.id = s.id
    RETURNING o.id
  )
  SELECT count(*) INTO v_recovered_count FROM updated;

  RETURN v_recovered_count;
END;
$$;

-- Funções de claim e recovery são estritamente backend-only (sem GRANT TO authenticated; acesso via service_role)
REVOKE ALL ON FUNCTION public.recover_stale_notification_outbox(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recover_stale_notification_outbox(interval) FROM anon;
REVOKE ALL ON FUNCTION public.recover_stale_notification_outbox(interval) FROM authenticated;

