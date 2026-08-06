-- Migration 20260806000301_drop_legacy_overloaded_rpcs.sql
-- Remoção estrita das funções sobrecarregadas legadas (parâmetro BIGINT) para eliminar ambiguidade PGRST203 no PostgREST

DROP FUNCTION IF EXISTS public.mark_my_tele_collected(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.start_my_tele_delivery(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.complete_my_tele(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.complete_tele(UUID, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.assign_rider_to_tele(UUID, UUID, BIGINT, TEXT, TEXT);
