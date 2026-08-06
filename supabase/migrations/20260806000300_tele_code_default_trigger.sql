-- Migration 20260806000300_tele_code_default_trigger.sql
-- 1. Limpeza de funções sobrecarregadas legadas (BIGINT vs INTEGER) que causam ambiguidade no PostgREST (PGRST203)
DROP FUNCTION IF EXISTS public.mark_my_tele_collected(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.start_my_tele_delivery(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.complete_my_tele(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.complete_tele(UUID, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.assign_rider_to_tele(UUID, UUID, BIGINT, TEXT, TEXT);

-- 2. Garantia server-side autoritativa de tele_code para 100% dos inserts na tabela public.teles
CREATE SEQUENCE IF NOT EXISTS public.tele_code_seq START WITH 100001;

-- Preencher registros legados que eventualmente possuam tele_code NULO
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.teles WHERE tele_code IS NULL ORDER BY created_at ASC LOOP
    UPDATE public.teles
    SET tele_code = 'TEL-' || pg_catalog.lpad(nextval('public.tele_code_seq')::text, 6, '0')
    WHERE id = r.id AND tele_code IS NULL;
  END LOOP;
END;
$$;

-- Definir função de trigger para autogerar tele_code caso omitido ou NULL
CREATE OR REPLACE FUNCTION public.ensure_tele_code_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.tele_code IS NULL OR TRIM(NEW.tele_code) = '' THEN
    NEW.tele_code := 'TEL-' || pg_catalog.lpad(nextval('public.tele_code_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ensure_tele_code_before_insert_trg ON public.teles;

CREATE TRIGGER ensure_tele_code_before_insert_trg
BEFORE INSERT ON public.teles
FOR EACH ROW
EXECUTE FUNCTION public.ensure_tele_code_before_insert();

-- Garantir índice ÚNICO na coluna tele_code
CREATE UNIQUE INDEX IF NOT EXISTS teles_tele_code_unique_idx ON public.teles(tele_code) WHERE tele_code IS NOT NULL;
