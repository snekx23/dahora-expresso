-- =====================================================================
-- Dahora Expresso — Local Seed Data (Public Schema Only)
-- Timestamp: 20260728000100
-- =====================================================================

-- 1. Cliente Interno Dahora Expresso
INSERT INTO public.commercial_clients (
  id, client_code, establishment_name, responsible_name, phone, email, address, neighborhood, city, postal_code, document, lifecycle_status, financial_status, is_internal
) VALUES (
  'a0000000-0000-4000-a000-000000000001'::uuid,
  'SYS-DAHORA', 'Dahora Expresso', 'Operação Interna', '(51) 99999-0000', 'operacao@dahoraexpresso.local',
  'Av. Presidente Vargas, 1000', 'Centro', 'Sapucaia do Sul', '93260-006', '00.000.000/0001-00', 'ativo', 'em_dia', true
) ON CONFLICT (client_code) DO UPDATE SET
  establishment_name = 'Dahora Expresso',
  responsible_name = 'Operação Interna',
  is_internal = true,
  lifecycle_status = 'ativo';

-- 2. Cliente Comercial Fictício (Mercado Central)
INSERT INTO public.commercial_clients (
  id, client_code, establishment_name, responsible_name, phone, email, address, neighborhood, city, postal_code, document, lifecycle_status, financial_status, is_internal
) VALUES (
  'c1111111-1111-4111-a111-111111111111'::uuid,
  'CLI-000101', 'Mercado Central', 'Carlos Silva', '(51) 98888-1111', 'contato@mercadocentral.local',
  'Rua São João, 125', 'Centro', 'Sapucaia do Sul', '93260-000', '11.222.333/0001-44', 'ativo', 'em_dia', false
) ON CONFLICT (client_code) DO UPDATE SET
  establishment_name = 'Mercado Central',
  responsible_name = 'Carlos Silva',
  lifecycle_status = 'ativo';

-- 3. Motoboy Fictício na Frota (MOTO-001)
INSERT INTO public.fleet (
  id, motoboy_code, name, phone, vehicle, plate, status, simultaneous_limit
) VALUES (
  'f2222222-2222-4222-a222-222222222222'::uuid,
  'MOTO-001', 'João Entregador', '(51) 97777-2222', 'Honda CG 160', 'ABC-1234', 'Ativo', 3
) ON CONFLICT (motoboy_code) DO UPDATE SET
  name = 'João Entregador',
  status = 'Ativo';
