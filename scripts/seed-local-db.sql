-- =====================================================================
-- Dahora Expresso — Local Seed SQL Script (Root-Cause Fixed for GoTrue Auth)
-- File: scripts/seed-local-db.sql
-- =====================================================================

-- Garantir que colunas de token em auth.users possuem DEFAULT ''::character varying para evitar Scan Error no GoTrue Go driver
ALTER TABLE auth.users ALTER COLUMN confirmation_token SET DEFAULT '';
ALTER TABLE auth.users ALTER COLUMN recovery_token SET DEFAULT '';
ALTER TABLE auth.users ALTER COLUMN email_change_token_new SET DEFAULT '';
ALTER TABLE auth.users ALTER COLUMN email_change SET DEFAULT '';

-- Inserir usuários no auth.users com hash bcrypt nativo (pgcrypto) e colunas de token inicializadas com ''
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change, phone_change_token, email_change_token_current, reauthentication_token
)
VALUES 
  (
    '14620da0-6e08-488f-95ff-26f751785870', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@dahora.local',
    crypt('senha123456', gen_salt('bf')), NOW(), '{"provider":"email","providers":["email"]}', '{"full_name":"Administrador Dahora"}', NOW(), NOW(),
    '', '', '', '', '', '', '', ''
  ),
  (
    '4708f929-a6d6-4ed1-ab22-1acb1b676e9d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'parceiro@mercadocentral.local',
    crypt('senha123456', gen_salt('bf')), NOW(), '{"provider":"email","providers":["email"]}', '{"full_name":"Carlos Mercado"}', NOW(), NOW(),
    '', '', '', '', '', '', '', ''
  ),
  (
    '7668596b-0444-4435-9f0c-8d0ad7ce7fb8', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'motoboy@dahora.local',
    crypt('senha123456', gen_salt('bf')), NOW(), '{"provider":"email","providers":["email"]}', '{"full_name":"Guilherme Motoboy"}', NOW(), NOW(),
    '', '', '', '', '', '', '', ''
  )
ON CONFLICT (id) DO UPDATE SET
  encrypted_password = EXCLUDED.encrypted_password,
  confirmation_token = '',
  recovery_token = '',
  email_change_token_new = '',
  email_change = '';

INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
VALUES 
  ('14620da0-6e08-488f-95ff-26f751785870', '14620da0-6e08-488f-95ff-26f751785870', 'admin@dahora.local', 'email', '{"sub":"14620da0-6e08-488f-95ff-26f751785870","email":"admin@dahora.local"}', NOW(), NOW()),
  ('4708f929-a6d6-4ed1-ab22-1acb1b676e9d', '4708f929-a6d6-4ed1-ab22-1acb1b676e9d', 'parceiro@mercadocentral.local', 'email', '{"sub":"4708f929-a6d6-4ed1-ab22-1acb1b676e9d","email":"parceiro@mercadocentral.local"}', NOW(), NOW()),
  ('7668596b-0444-4435-9f0c-8d0ad7ce7fb8', '7668596b-0444-4435-9f0c-8d0ad7ce7fb8', 'motoboy@dahora.local', 'email', '{"sub":"7668596b-0444-4435-9f0c-8d0ad7ce7fb8","email":"motoboy@dahora.local"}', NOW(), NOW())
ON CONFLICT (provider_id, provider) DO NOTHING;

INSERT INTO public.user_profiles (user_id, role, name, email)
VALUES 
  ('14620da0-6e08-488f-95ff-26f751785870', 'admin', 'Administrador Dahora', 'admin@dahora.local'),
  ('4708f929-a6d6-4ed1-ab22-1acb1b676e9d', 'client_user', 'Carlos Mercado', 'parceiro@mercadocentral.local'),
  ('7668596b-0444-4435-9f0c-8d0ad7ce7fb8', 'motoboy', 'Guilherme Motoboy', 'motoboy@dahora.local')
ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, name = EXCLUDED.name, email = EXCLUDED.email;

INSERT INTO public.fleet (id, user_id, name, motoboy_code, status)
VALUES 
  ('f1111111-1111-4111-a111-111111111111', '7668596b-0444-4435-9f0c-8d0ad7ce7fb8', 'Guilherme Motoboy', 'MB-0001', 'Disponível')
ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, motoboy_code = EXCLUDED.motoboy_code;
