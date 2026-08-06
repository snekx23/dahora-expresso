-- Migration: 20260806000200_motoboy_official_auth_flow.sql
-- Dahora Expresso — Fluxo Autoritativo Oficial de Cadastro e Autenticação do Motoboy no Supabase Auth

-- 1. Assegurar colunas necessárias na tabela public.fleet
ALTER TABLE public.fleet ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.fleet ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.fleet ADD COLUMN IF NOT EXISTS motoboy_code TEXT;
ALTER TABLE public.fleet ADD COLUMN IF NOT EXISTS pin TEXT;
ALTER TABLE public.fleet ADD COLUMN IF NOT EXISTS pin_hash TEXT;

-- 2. Migração e higienização transparente de PINs legados para pin_hash
DO $$
BEGIN
  -- Criptografar PINs em texto puro existentes
  UPDATE public.fleet
  SET pin_hash = extensions.crypt(pin, extensions.gen_salt('bf', 8))
  WHERE pin IS NOT NULL AND pin <> '' AND (pin_hash IS NULL OR pin_hash = '');

  -- Limpar a coluna em texto puro após a gravação do hash
  UPDATE public.fleet
  SET pin = NULL
  WHERE pin_hash IS NOT NULL AND pin_hash <> '';
END $$;

-- 3. Normalização canônica do formato do motoboy_code (MB-XXXX)
UPDATE public.fleet
SET motoboy_code = 'MB-' || RIGHT(REGEXP_REPLACE(motoboy_code, '\D', '', 'g'), 4)
WHERE motoboy_code IS NOT NULL 
  AND motoboy_code !~ '^MB-[0-9]{4}$' 
  AND LENGTH(REGEXP_REPLACE(motoboy_code, '\D', '', 'g')) >= 4;

-- 4. Garantia de Integridade e Duplicidade no Banco de Dados
-- 4.1 Índice único para user_id (um usuário Auth representa no máximo um motoboy)
DROP INDEX IF EXISTS public.fleet_user_id_unique_idx;
CREATE UNIQUE INDEX fleet_user_id_unique_idx ON public.fleet (user_id) WHERE user_id IS NOT NULL;

-- 4.2 Índice único parcial para código canônico de 4 dígitos em motoboys ativos/operacionais
DROP INDEX IF EXISTS public.fleet_active_code_unique_idx;
CREATE UNIQUE INDEX fleet_active_code_unique_idx ON public.fleet (
  RIGHT(REGEXP_REPLACE(motoboy_code, '\D', '', 'g'), 4)
) WHERE LOWER(status) NOT IN ('inativo', 'suspenso', 'bloqueado');

-- 5. Função SQL Autoritativa: Definir ou substituir PIN do Motoboy
CREATE OR REPLACE FUNCTION public.set_rider_pin_hash(
  p_rider_id UUID,
  p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_clean_pin TEXT;
BEGIN
  v_clean_pin := TRIM(COALESCE(p_pin, ''));
  
  IF v_clean_pin !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'PIN deve conter exatamente 4 números.';
  END IF;

  UPDATE public.fleet
  SET 
    pin_hash = extensions.crypt(v_clean_pin, extensions.gen_salt('bf', 8)),
    pin = NULL,
    updated_at = NOW()
  WHERE id = p_rider_id;

  RETURN TRUE;
END;
$$;

-- Permissões estritas da função set_rider_pin_hash (Service Role apenas)
REVOKE ALL ON FUNCTION public.set_rider_pin_hash(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_rider_pin_hash(UUID, TEXT) TO service_role;

-- 6. Função SQL Autoritativa: Validação de Código e PIN
CREATE OR REPLACE FUNCTION public.validate_rider_pin_and_get_auth(
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
  v_rider      RECORD;
  v_pin_match  BOOLEAN := FALSE;
BEGIN
  v_clean_code := REGEXP_REPLACE(TRIM(COALESCE(p_access_code, '')), '\D', '', 'g');
  v_clean_pin  := TRIM(COALESCE(p_pin, ''));

  IF LENGTH(v_clean_code) < 4 OR v_clean_pin !~ '^[0-9]{4}$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Código ou PIN inválido, ou acesso indisponível.'
    );
  END IF;

  -- Pegar os últimos 4 dígitos se o código fornecido for mais longo
  v_clean_code := RIGHT(v_clean_code, 4);

  -- Localizar motoboy por código canônico de 4 dígitos
  SELECT 
    id,
    user_id,
    motoboy_code,
    name,
    status,
    pin_hash
  INTO v_rider
  FROM public.fleet
  WHERE RIGHT(REGEXP_REPLACE(motoboy_code, '\D', '', 'g'), 4) = v_clean_code
  LIMIT 1;

  IF v_rider.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Código ou PIN inválido, ou acesso indisponível.'
    );
  END IF;

  -- Bloquear contas inativas, suspensas ou sem vínculo Auth
  IF LOWER(v_rider.status) IN ('inativo', 'suspenso', 'bloqueado') OR v_rider.user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Código ou PIN inválido, ou acesso indisponível.'
    );
  END IF;

  -- Validar PIN pelo pin_hash
  IF v_rider.pin_hash IS NOT NULL AND v_rider.pin_hash <> '' THEN
    v_pin_match := (v_rider.pin_hash = extensions.crypt(v_clean_pin, v_rider.pin_hash));
  END IF;

  IF NOT v_pin_match THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Código ou PIN inválido, ou acesso indisponível.'
    );
  END IF;

  -- Retornar SOMENTE dados mínimos (SEM e-mail, SEM hash, SEM PIN, SEM segredos)
  RETURN jsonb_build_object(
    'success', true,
    'fleet_id', v_rider.id,
    'user_id', v_rider.user_id,
    'status', v_rider.status
  );
END;
$$;

-- Permissões estritas da função validate_rider_pin_and_get_auth (Service Role apenas, SEM acesso anônimo)
REVOKE ALL ON FUNCTION public.validate_rider_pin_and_get_auth(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_rider_pin_and_get_auth(TEXT, TEXT) TO service_role;

-- 7. Desativar / Revogar acesso anônimo da RPC antiga authenticate_rider_access
REVOKE ALL ON FUNCTION public.authenticate_rider_access(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authenticate_rider_access(TEXT, TEXT) TO service_role;

-- 8. Atualização das Políticas RLS de public.fleet
DROP POLICY IF EXISTS fleet_select ON public.fleet;
DROP POLICY IF EXISTS fleet_update_self ON public.fleet;
DROP POLICY IF EXISTS fleet_all_admin ON public.fleet;

CREATE POLICY fleet_select ON public.fleet
  FOR SELECT TO authenticated
  USING (public.is_admin_user() OR user_id = auth.uid());

CREATE POLICY fleet_update_self ON public.fleet
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY fleet_all_admin ON public.fleet
  FOR ALL TO authenticated
  USING (public.is_admin_user());
