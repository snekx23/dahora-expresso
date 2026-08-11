-- Migration: Adicionar admin_code em public.user_profiles
ALTER TABLE public.user_profiles 
ADD COLUMN IF NOT EXISTS admin_code TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_admin_code_uidx 
ON public.user_profiles (admin_code) 
WHERE admin_code IS NOT NULL;

UPDATE public.user_profiles
SET admin_code = 'ADM-001'
WHERE email = 'admin1@dahoraexpresso.com.br';

UPDATE public.user_profiles
SET admin_code = 'ADM-002'
WHERE email = 'admin2@dahoraexpresso.com.br';
