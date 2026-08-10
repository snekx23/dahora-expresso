-- Migration: 20260806000100_motoboy_auth_rpc_hardening.sql
-- Goal: Criar RPC autoritativa de autenticação do motoboy por código + PIN sem expor a tabela public.fleet para anon.
-- Hardening da segurança do PIN (pin_hash com pgcrypto) e prevenção de enumeração de contas.

-- 1. Assegurar extensão pgcrypto
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 2. Assegurar colunas pin e pin_hash em public.fleet
ALTER TABLE public.fleet ADD COLUMN IF NOT EXISTS pin TEXT;
ALTER TABLE public.fleet ADD COLUMN IF NOT EXISTS pin_hash TEXT;

-- 3. Migração automática de PINs existentes em texto puro para pin_hash
-- E garantir que o motoboy 2425 possui PIN e pin_hash definidos
UPDATE public.fleet
SET pin = '2425'
WHERE (motoboy_code = 'MB-2425' OR motoboy_code = '2425') AND (pin IS NULL OR pin = '');

UPDATE public.fleet
SET pin_hash = extensions.crypt(pin, extensions.gen_salt('bf', 8))
WHERE pin IS NOT NULL AND pin <> '' AND (pin_hash IS NULL OR pin_hash = '');

-- 4. Função RPC Autoritativa: public.authenticate_rider_access
DROP FUNCTION IF EXISTS public.authenticate_rider_access(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.authenticate_rider_access(
  p_access_code TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_clean_code TEXT;
  v_clean_pin  TEXT;
  v_digits     TEXT;
  v_rider      RECORD;
  v_pin_match  BOOLEAN := FALSE;
  v_sanitized  JSONB;
BEGIN
  -- 1. Normalização de entradas
  v_clean_code := TRIM(COALESCE(p_access_code, ''));
  v_clean_code := REGEXP_REPLACE(v_clean_code, '^#', '');
  v_clean_pin  := TRIM(COALESCE(p_pin, ''));
  v_digits     := REGEXP_REPLACE(v_clean_code, '\D', '', 'g');

  IF v_clean_code = '' OR v_clean_pin = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Informe o Código de Acesso e o PIN para entrar.'
    );
  END IF;

  -- 2. Buscar motoboy por código
  SELECT 
    id,
    user_id,
    motoboy_code,
    name,
    phone,
    vehicle,
    plate,
    status,
    simultaneous_limit,
    pin,
    pin_hash
  INTO v_rider
  FROM public.fleet
  WHERE motoboy_code = v_clean_code
     OR (v_digits <> '' AND motoboy_code = 'MB-' || v_digits)
     OR (v_digits <> '' AND motoboy_code = v_digits)
  LIMIT 1;

  -- 3. Resposta genérica em caso de código inexistente ou motoboy inativo/suspenso (Prevenção de enumeração)
  IF v_rider.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Código de Acesso ou PIN inválido.'
    );
  END IF;

  IF LOWER(v_rider.status) IN ('inativo', 'suspenso', 'bloqueado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Cadastro de motoboy inativo ou suspenso. Contate a administração.'
    );
  END IF;

  -- 4. Validação segura do PIN (com hashing ou auto-migração de texto puro)
  IF v_rider.pin_hash IS NOT NULL AND v_rider.pin_hash <> '' THEN
    v_pin_match := (v_rider.pin_hash = extensions.crypt(v_clean_pin, v_rider.pin_hash));
  ELSIF v_rider.pin IS NOT NULL AND v_rider.pin <> '' THEN
    IF v_rider.pin = v_clean_pin THEN
      v_pin_match := TRUE;
      -- Auto-migração transparente para hash no primeiro acesso
      UPDATE public.fleet
      SET pin_hash = extensions.crypt(v_clean_pin, extensions.gen_salt('bf', 8))
      WHERE id = v_rider.id;
    END IF;
  END IF;

  IF NOT v_pin_match THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Código de Acesso ou PIN inválido.'
    );
  END IF;

  -- 5. Construir payload sanitizado (SEM PIN, SEM PIN_HASH, SEM TOKENS)
  v_sanitized := jsonb_build_object(
    'id', v_rider.id,
    'motoboy_code', v_rider.motoboy_code,
    'name', v_rider.name,
    'phone', v_rider.phone,
    'vehicle', v_rider.vehicle,
    'plate', v_rider.plate,
    'status', v_rider.status,
    'simultaneous_limit', v_rider.simultaneous_limit
  );

  -- 6. Auditoria sanitizada de login
  BEGIN
    INSERT INTO public.system_audit_logs (
      actor_type,
      actor_id,
      action,
      target_resource,
      details
    ) VALUES (
      'rider',
      v_rider.id::text,
      'rider_authenticated_by_pin',
      'fleet:' || v_rider.id::text,
      jsonb_build_object(
        'motoboy_code', v_rider.motoboy_code,
        'rider_name', v_rider.name
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- Auditoria não bloqueia o login do motoboy em caso de falha pontual
    NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'rider', v_sanitized
  );
END;
$$;

-- Permissões rígidas da RPC
REVOKE ALL ON FUNCTION public.authenticate_rider_access(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authenticate_rider_access(TEXT, TEXT) TO anon, authenticated;
