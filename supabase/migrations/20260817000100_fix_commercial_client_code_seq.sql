-- Migration: 20260817000100_fix_commercial_client_code_seq.sql
-- Goal: Synchronize commercial_client_code_seq with maximum existing client_code number in commercial_clients.

DO $$
DECLARE
    v_max_val INTEGER;
    v_seq_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'commercial_client_code_seq'
    ) INTO v_seq_exists;

    IF NOT v_seq_exists THEN
        CREATE SEQUENCE public.commercial_client_code_seq START WITH 1 INCREMENT BY 1;
    END IF;

    SELECT COALESCE(MAX(CAST(SUBSTRING(client_code FROM 'CLI-([0-9]+)') AS INTEGER)), 0)
    INTO v_max_val
    FROM public.commercial_clients
    WHERE client_code ~* '^CLI-[0-9]+$';

    IF v_max_val > 0 THEN
        PERFORM setval('public.commercial_client_code_seq', v_max_val, true);
    ELSE
        PERFORM setval('public.commercial_client_code_seq', 1, false);
    END IF;
END $$;
