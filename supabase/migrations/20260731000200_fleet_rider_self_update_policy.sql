-- Migration: 20260731000200_fleet_rider_self_update_policy.sql
-- 1. Permite que o motoboy autenticado atualize seu próprio registro na tabela public.fleet (ex: status de disponibilidade, localização GPS e nível de bateria) restrito a user_id = auth.uid()
-- 2. Adiciona as tabelas public.fleet e public.teles à publicação supabase_realtime para atualização em tempo real sem F5.

DROP POLICY IF EXISTS fleet_update_self ON public.fleet;
CREATE POLICY fleet_update_self ON public.fleet
FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fleet, public.teles;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;
