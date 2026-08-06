-- =====================================================================
-- Dahora Expresso — RPC Autoritativa Transacional de Reset (Somente AMBIENTE DEMO)
-- Migration EXCLUSIVA de DEMO: supabase/migrations-demo/20260805009900_demo_environment_reset_rpc.sql
-- NUNCA aplicar ao banco de Produção.
-- =====================================================================

-- 1. Tabela de Configuração Endurecida Singleton do Ambiente no Postgres
CREATE TABLE IF NOT EXISTS public.environment_settings (
    id TEXT PRIMARY KEY DEFAULT 'current',
    environment_uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    environment_kind TEXT NOT NULL DEFAULT 'production',
    environment_version INTEGER NOT NULL DEFAULT 1,
    reset_enabled BOOLEAN NOT NULL DEFAULT false,
    demo_admin_user_id UUID,
    demo_client_user_id UUID,
    demo_rider_user_id UUID,
    demo_client_id UUID,
    demo_rider_id UUID,
    internal_client_id UUID,
    demo_client_code TEXT DEFAULT 'CLI-DEMO-001',
    demo_rider_code TEXT DEFAULT 'MB-DEMO-001',
    internal_client_code TEXT DEFAULT 'SYS-DAHORA',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_environment_settings_singleton CHECK (id = 'current'),
    CONSTRAINT chk_env_kind CHECK (environment_kind IN ('production', 'staging', 'demo', 'qa', 'local')),
    CONSTRAINT chk_env_version CHECK (environment_version >= 1),
    CONSTRAINT chk_reset_enabled CHECK (reset_enabled = false OR environment_kind = 'demo'),
    CONSTRAINT chk_demo_base_user_ids CHECK (
        (demo_admin_user_id IS NULL AND demo_client_user_id IS NULL AND demo_rider_user_id IS NULL)
        OR
        (demo_admin_user_id IS NOT NULL AND demo_client_user_id IS NOT NULL AND demo_rider_user_id IS NOT NULL
         AND demo_admin_user_id <> demo_client_user_id
         AND demo_admin_user_id <> demo_rider_user_id
         AND demo_client_user_id <> demo_rider_user_id)
    ),
    CONSTRAINT chk_demo_base_entity_ids CHECK (
        (demo_client_id IS NULL AND demo_rider_id IS NULL AND internal_client_id IS NULL)
        OR
        (demo_client_id IS NOT NULL AND demo_rider_id IS NOT NULL AND internal_client_id IS NOT NULL
         AND demo_client_id <> demo_rider_id
         AND demo_client_id <> internal_client_id
         AND demo_rider_id <> internal_client_id)
    )
);

ALTER TABLE public.environment_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.environment_settings FROM PUBLIC;
REVOKE ALL ON TABLE public.environment_settings FROM anon;
REVOKE ALL ON TABLE public.environment_settings FROM authenticated;

-- No Banco DEMO, a configuração é 'demo' / reset_enabled = true
INSERT INTO public.environment_settings (
    id, environment_kind, environment_version, reset_enabled,
    demo_client_code, demo_rider_code, internal_client_code
)
VALUES ('current', 'demo', 1, true, 'CLI-DEMO-001', 'MB-DEMO-001', 'SYS-DAHORA')
ON CONFLICT (id) DO UPDATE
SET environment_kind = EXCLUDED.environment_kind,
    reset_enabled = EXCLUDED.reset_enabled,
    updated_at = NOW();

-- 2. Tabela Endurecida da Fila de Reconciliação de Auth Users Extras
CREATE TABLE IF NOT EXISTS public.demo_auth_cleanup_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id TEXT NOT NULL,
    auth_user_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    processing_started_at TIMESTAMPTZ,
    claim_token UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_demo_auth_cleanup_execution_user UNIQUE (execution_id, auth_user_id),
    CONSTRAINT chk_demo_auth_cleanup_attempt_count CHECK (attempt_count >= 0),
    CONSTRAINT chk_cleanup_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

ALTER TABLE public.demo_auth_cleanup_queue ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE public.demo_auth_cleanup_queue ADD COLUMN IF NOT EXISTS claim_token UUID;

CREATE INDEX IF NOT EXISTS idx_demo_auth_cleanup_status ON public.demo_auth_cleanup_queue(status);
CREATE INDEX IF NOT EXISTS idx_demo_auth_cleanup_created ON public.demo_auth_cleanup_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_demo_auth_cleanup_user ON public.demo_auth_cleanup_queue(auth_user_id);

ALTER TABLE public.demo_auth_cleanup_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.demo_auth_cleanup_queue FROM PUBLIC;
REVOKE ALL ON TABLE public.demo_auth_cleanup_queue FROM anon;
REVOKE ALL ON TABLE public.demo_auth_cleanup_queue FROM authenticated;

-- 3. RPC Autoritativa Transacional de Reset
CREATE OR REPLACE FUNCTION public.reset_demo_environment(p_confirmation TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_uid UUID := auth.uid();
    v_env RECORD;
    v_settings_count INT := 0;
    v_start_time TIMESTAMPTZ := NOW();
    v_execution_id TEXT;
    v_deleted_teles INT := 0;
    v_deleted_txs INT := 0;
    v_deleted_clients INT := 0;
    v_deleted_riders INT := 0;
    v_extra_auth_users UUID[];
    v_uid UUID;
BEGIN
    -- 1. Validar Autenticação
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Authentication required.';
    END IF;

    -- 2. Carregar e Validar Configuração Singleton de Ambiente no Postgres
    SELECT COUNT(*) INTO v_settings_count FROM public.environment_settings;
    IF v_settings_count = 0 THEN
        RAISE EXCEPTION 'DEMO_ENVIRONMENT_SETTINGS_MISSING: Environment settings row not found.';
    ELSIF v_settings_count > 1 THEN
        RAISE EXCEPTION 'DEMO_ENVIRONMENT_SETTINGS_INVALID: Multiple environment settings rows found.';
    END IF;

    SELECT * INTO v_env FROM public.environment_settings WHERE id = 'current';

    IF v_env IS NULL THEN
        RAISE EXCEPTION 'DEMO_ENVIRONMENT_SETTINGS_MISSING: Environment settings row missing.';
    END IF;

    IF v_env.environment_kind <> 'demo' OR v_env.reset_enabled <> true OR v_env.environment_uuid IS NULL THEN
        RAISE EXCEPTION 'RESET_NOT_ALLOWED: Target database environment is not configured as DEMO.';
    END IF;

    IF v_env.environment_version <> 1 THEN
        RAISE EXCEPTION 'DEMO_ENVIRONMENT_VERSION_UNSUPPORTED: Unsupported environment settings version.';
    END IF;

    -- 3. Validar Identidades Canônicas da Demonstração
    IF v_env.demo_admin_user_id IS NULL OR v_env.demo_client_user_id IS NULL OR v_env.demo_rider_user_id IS NULL THEN
        RAISE EXCEPTION 'DEMO_BASE_IDENTITIES_INVALID: Canonical base user UUIDs are missing in environment_settings.';
    END IF;

    -- Autorização Estrita: Apenas o UUID canônico do Admin Demo pode disparar o reset!
    IF v_caller_uid <> v_env.demo_admin_user_id THEN
        RAISE EXCEPTION 'FORBIDDEN: Only the canonical Demo Admin user can execute demo reset.';
    END IF;

    -- 4. Exigir Confirmação Textual Exata
    IF p_confirmation IS NULL OR p_confirmation <> 'RESTAURAR DEMO' THEN
        RAISE EXCEPTION 'INVALID_CONFIRMATION: Exact string RESTAURAR DEMO is required.';
    END IF;

    -- 5. Advisory Lock Transacional
    IF NOT pg_try_advisory_xact_lock(88998899) THEN
        RAISE EXCEPTION 'RESET_ALREADY_RUNNING: A demo reset operation is currently in progress.';
    END IF;

    v_execution_id := 'RESET-' || TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS') || '-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');

    -- 6. Coleta Explicita por Exclusão dos Auth User IDs Extras (Sem usar role ou e-mail!)
    SELECT ARRAY_AGG(user_id) INTO v_extra_auth_users
    FROM public.user_profiles
    WHERE user_id NOT IN (v_env.demo_admin_user_id, v_env.demo_client_user_id, v_env.demo_rider_user_id);

    -- 7. Execução Transacional de Exclusão em Ordem de FKs
    DELETE FROM public.rider_payment_batch_items;
    DELETE FROM public.rider_payment_batches;
    DELETE FROM public.rider_weekly_settlement_items;
    DELETE FROM public.rider_weekly_settlements;
    DELETE FROM public.client_payment_allocations;

    WITH del_r AS (
        DELETE FROM public.rider_financial_transactions RETURNING id
    ), del_c AS (
        DELETE FROM public.company_financial_transactions RETURNING id
    ), del_cl AS (
        DELETE FROM public.client_financial_transactions RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM del_r) + (SELECT COUNT(*) FROM del_c) + (SELECT COUNT(*) FROM del_cl) INTO v_deleted_txs;

    DELETE FROM public.rider_credits_ledger;
    DELETE FROM public.rider_consumable_purchases;
    DELETE FROM public.tele_eventos;

    WITH del_t AS (
        DELETE FROM public.teles RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted_teles FROM del_t;

    DELETE FROM public.rider_support_message_reads;
    DELETE FROM public.rider_support_messages;
    DELETE FROM public.rider_support_tickets;
    DELETE FROM public.rider_device_status;
    DELETE FROM public.rider_push_subscriptions;
    DELETE FROM public.rider_notification_outbox;

    WITH del_fl AS (
        DELETE FROM public.fleet
        WHERE (v_env.demo_rider_id IS NOT NULL AND id <> v_env.demo_rider_id)
           OR (v_env.demo_rider_id IS NULL AND motoboy_code <> v_env.demo_rider_code)
        RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted_riders FROM del_fl;

    WITH del_cli AS (
        DELETE FROM public.commercial_clients
        WHERE (v_env.demo_client_id IS NOT NULL AND id NOT IN (v_env.demo_client_id, v_env.internal_client_id))
           OR (v_env.demo_client_id IS NULL AND client_code NOT IN (v_env.demo_client_code, v_env.internal_client_code))
        RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted_clients FROM del_cli;

    -- Purga de perfis e vínculos extras
    IF v_extra_auth_users IS NOT NULL AND ARRAY_LENGTH(v_extra_auth_users, 1) > 0 THEN
        DELETE FROM public.client_users WHERE user_id = ANY(v_extra_auth_users);
        DELETE FROM public.user_profiles WHERE user_id = ANY(v_extra_auth_users);

        -- Inserir IDs na fila de reconciliação de Auth Users (Idempotente com ON CONFLICT)
        FOREACH v_uid IN ARRAY v_extra_auth_users LOOP
            INSERT INTO public.demo_auth_cleanup_queue (execution_id, auth_user_id, status)
            VALUES (v_execution_id, v_uid, 'pending')
            ON CONFLICT (execution_id, auth_user_id) DO NOTHING;
        END LOOP;
    END IF;

    -- 8. Normalizar Entidades Base Preservadas usando colunas auditadas do schema
    IF v_env.demo_rider_id IS NOT NULL THEN
        UPDATE public.fleet
        SET status = 'Ativo', lat = NULL, lng = NULL, last_seen = NULL, battery_level = NULL, updated_at = NOW()
        WHERE id = v_env.demo_rider_id;
    END IF;

    IF v_env.demo_client_id IS NOT NULL THEN
        UPDATE public.commercial_clients
        SET financial_status = 'em_dia', lifecycle_status = 'ativo', updated_at = NOW()
        WHERE id = v_env.demo_client_id;
    END IF;

    -- 9. Retornar Resumo Transacional
    RETURN jsonb_build_object(
        'success', true,
        'execution_id', v_execution_id,
        'duration_ms', ROUND(EXTRACT(EPOCH FROM (NOW() - v_start_time)) * 1000),
        'summary', jsonb_build_object(
            'removed_teles', v_deleted_teles,
            'removed_transactions', v_deleted_txs,
            'removed_clients', v_deleted_clients,
            'removed_riders', v_deleted_riders
        ),
        'extra_auth_user_ids', COALESCE(v_extra_auth_users, '{}'::UUID[])
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reset_demo_environment(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_demo_environment(TEXT) TO authenticated;

-- 4. RPC Autoritativa para Claim Atômico com claim_token UUID (FOR UPDATE SKIP LOCKED)
DROP FUNCTION IF EXISTS public.claim_demo_auth_cleanup_item();

CREATE OR REPLACE FUNCTION public.claim_demo_auth_cleanup_item()
RETURNS TABLE (
    queue_id UUID,
    execution_id TEXT,
    auth_user_id UUID,
    attempt_count INT,
    claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_item RECORD;
    v_new_token UUID := gen_random_uuid();
BEGIN
    -- Seleciona e trava atomicamente um único item disponível
    SELECT q.id, q.execution_id, q.auth_user_id, q.attempt_count
    INTO v_item
    FROM public.demo_auth_cleanup_queue q
    WHERE (
            q.status IN ('pending', 'failed')
            OR (q.status = 'processing' AND q.processing_started_at < NOW() - INTERVAL '5 minutes')
          )
      AND q.attempt_count < 5
    ORDER BY q.created_at ASC, q.id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_item.id IS NOT NULL THEN
        UPDATE public.demo_auth_cleanup_queue
        SET status = 'processing',
            attempt_count = v_item.attempt_count + 1,
            processing_started_at = NOW(),
            claim_token = v_new_token,
            updated_at = NOW()
        WHERE id = v_item.id;

        RETURN QUERY
        SELECT v_item.id, v_item.execution_id, v_item.auth_user_id, (v_item.attempt_count + 1), v_new_token;
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_demo_auth_cleanup_item() FROM PUBLIC, anon, authenticated;

-- 5. RPC para Finalização com Sucesso Exigindo claim_token UUID
DROP FUNCTION IF EXISTS public.complete_demo_auth_cleanup_item(UUID);
DROP FUNCTION IF EXISTS public.complete_demo_auth_cleanup_item(UUID, UUID);

CREATE OR REPLACE FUNCTION public.complete_demo_auth_cleanup_item(p_queue_id UUID, p_claim_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_rows INT := 0;
BEGIN
    UPDATE public.demo_auth_cleanup_queue
    SET status = 'completed',
        processing_started_at = NULL,
        claim_token = NULL,
        updated_at = NOW()
    WHERE id = p_queue_id
      AND claim_token = p_claim_token
      AND status = 'processing';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_demo_auth_cleanup_item(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- 6. RPC para Finalização com Falha Exigindo claim_token UUID
DROP FUNCTION IF EXISTS public.fail_demo_auth_cleanup_item(UUID, TEXT);
DROP FUNCTION IF EXISTS public.fail_demo_auth_cleanup_item(UUID, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.fail_demo_auth_cleanup_item(p_queue_id UUID, p_claim_token UUID, p_error_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_rows INT := 0;
BEGIN
    UPDATE public.demo_auth_cleanup_queue
    SET status = 'failed',
        last_error_code = SUBSTRING(COALESCE(p_error_code, 'UNKNOWN') FROM 1 FOR 100),
        processing_started_at = NULL,
        claim_token = NULL,
        updated_at = NOW()
    WHERE id = p_queue_id
      AND claim_token = p_claim_token
      AND status = 'processing';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fail_demo_auth_cleanup_item(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
