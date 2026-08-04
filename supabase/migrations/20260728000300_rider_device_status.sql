-- =====================================================================
-- Dahora Expresso — Migration: Tabela de Status do Dispositivo do Entregador
-- Timestamp: 20260728000300
-- =====================================================================

-- 1. Criar Tabela public.rider_device_status
CREATE TABLE IF NOT EXISTS public.rider_device_status (
  rider_id UUID PRIMARY KEY REFERENCES public.fleet(id) ON DELETE CASCADE,
  battery_level SMALLINT NULL CHECK (battery_level IS NULL OR (battery_level >= 0 AND battery_level <= 100)),
  is_charging BOOLEAN NULL,
  battery_supported BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Privilégios e Grants Estritos
REVOKE ALL ON public.rider_device_status FROM PUBLIC;
REVOKE ALL ON public.rider_device_status FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.rider_device_status TO authenticated;


-- 3. Habilitar RLS
ALTER TABLE public.rider_device_status ENABLE ROW LEVEL SECURITY;

-- Policy SELECT: Administrador/operador pode visualizar todos; Motoboy visualiza apenas o próprio
DROP POLICY IF EXISTS rider_device_status_select_policy ON public.rider_device_status;
CREATE POLICY rider_device_status_select_policy ON public.rider_device_status
  FOR SELECT TO authenticated
  USING (
    public.is_admin_user()
    OR rider_id IN (SELECT f.id FROM public.fleet f WHERE f.user_id = auth.uid())
  );

-- Policy INSERT: Motoboy insere apenas para o próprio rider_id
DROP POLICY IF EXISTS rider_device_status_insert_policy ON public.rider_device_status;
CREATE POLICY rider_device_status_insert_policy ON public.rider_device_status
  FOR INSERT TO authenticated
  WITH CHECK (
    rider_id IN (SELECT f.id FROM public.fleet f WHERE f.user_id = auth.uid())
  );

-- Policy UPDATE: Motoboy atualiza apenas o próprio rider_id
DROP POLICY IF EXISTS rider_device_status_update_policy ON public.rider_device_status;
CREATE POLICY rider_device_status_update_policy ON public.rider_device_status
  FOR UPDATE TO authenticated
  USING (
    rider_id IN (SELECT f.id FROM public.fleet f WHERE f.user_id = auth.uid())
  )
  WITH CHECK (
    rider_id IN (SELECT f.id FROM public.fleet f WHERE f.user_id = auth.uid())
  );

-- 4. RPC Backend-Authoritative para Atualização do Dispositivo
CREATE OR REPLACE FUNCTION public.update_my_device_status(
  p_battery_level SMALLINT DEFAULT NULL,
  p_is_charging BOOLEAN DEFAULT NULL,
  p_battery_supported BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_rider_id UUID;
  v_effective_battery SMALLINT;
  v_effective_charging BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Usuário não autenticado.');
  END IF;

  SELECT id INTO v_rider_id
  FROM public.fleet
  WHERE user_id = v_user_id;

  IF v_rider_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Motoboy não vinculado ao perfil do usuário.');
  END IF;

  -- Quando p_battery_supported = false: forçar battery_level = null e is_charging = null
  IF p_battery_supported IS FALSE OR p_battery_supported IS NULL THEN
    v_effective_battery := NULL;
    v_effective_charging := NULL;
  ELSE
    v_effective_battery := p_battery_level;
    v_effective_charging := p_is_charging;
  END IF;

  -- Validar battery_level entre 0 e 100 se não for nulo
  IF v_effective_battery IS NOT NULL AND (v_effective_battery < 0 OR v_effective_battery > 100) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Nível da bateria deve estar entre 0 e 100.');
  END IF;

  INSERT INTO public.rider_device_status (
    rider_id,
    battery_level,
    is_charging,
    battery_supported,
    last_seen_at,
    updated_at
  ) VALUES (
    v_rider_id,
    v_effective_battery,
    v_effective_charging,
    COALESCE(p_battery_supported, false),
    now(),
    now()
  )
  ON CONFLICT (rider_id) DO UPDATE SET
    battery_level = EXCLUDED.battery_level,
    is_charging = EXCLUDED.is_charging,
    battery_supported = EXCLUDED.battery_supported,
    last_seen_at = now(),
    updated_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'rider_id', v_rider_id,
    'battery_level', v_effective_battery,
    'is_charging', v_effective_charging,
    'battery_supported', COALESCE(p_battery_supported, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_my_device_status(SMALLINT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_device_status(SMALLINT, BOOLEAN, BOOLEAN) TO authenticated;

-- 5. Adicionar à Publicação Supabase Realtime
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rider_device_status;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
