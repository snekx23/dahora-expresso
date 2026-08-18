-- =====================================================================
-- Dahora Expresso — Automated SQL Test Suite for Client Support Module (RC.15B)
-- File: supabase/tests/client_support_module.sql
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_admin_id UUID := 'a1111111-1111-4111-a111-111111111111';
  v_client_user_a_id UUID := 'b1111111-1111-4111-a111-111111111111';
  v_client_user_b_id UUID := 'b2222222-2222-4222-a222-222222222222';
  v_unlinked_user_id UUID := 'b3333333-3333-4333-a333-333333333333';
  
  v_client_a_id UUID := 'c1111111-1111-4111-a111-111111111111';
  v_client_b_id UUID := 'c2222222-2222-4222-a222-222222222222';
  
  v_res JSONB;
  v_msg_a_id UUID;
  v_msg_admin_id UUID;
  v_count INT;
  v_direct_insert_failed BOOLEAN := false;
  v_update_failed BOOLEAN := false;
  v_delete_failed BOOLEAN := false;
BEGIN
  RAISE NOTICE '🚀 Executando Suíte de Testes SQL: Módulo de Suporte dos Clientes Comerciais (RC.15B)...';

  -- -------------------------------------------------------------------
  -- Setup Fixtures Locais de Teste (Rollback automático no fim)
  -- -------------------------------------------------------------------
  
  -- 0. Criar auth.users de teste
  INSERT INTO auth.users (id, email)
  VALUES 
    (v_admin_id, 'admin@homolog.test'),
    (v_client_user_a_id, 'user_a@homolog.test'),
    (v_client_user_b_id, 'user_b@homolog.test'),
    (v_unlinked_user_id, 'user_unlinked@homolog.test')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_profiles (user_id, name, email, role, is_active)
  VALUES (v_admin_id, 'Admin Teste', 'admin@homolog.test', 'admin', true)
  ON CONFLICT (user_id) DO NOTHING;

  -- 1. Criar Clientes Comerciais A e B
  INSERT INTO public.commercial_clients (id, client_code, establishment_name, responsible_name, phone, email, document, address, is_internal)
  VALUES 
    (v_client_a_id, 'CLI-TEST-A', 'Panificadora Alpha Homolog', 'Carlos Alpha', '51999991111', 'alpha@homolog.test', '11111111000111', 'R. Alpha, 100', false),
    (v_client_b_id, 'CLI-TEST-B', 'Mercado Beta Homolog', 'Beatriz Beta', '51999992222', 'beta@homolog.test', '22222222000122', 'R. Beta, 200', false)
  ON CONFLICT (id) DO NOTHING;

  -- 2. Vincular Usuários Auth em client_users
  INSERT INTO public.client_users (client_id, user_id, status)
  VALUES 
    (v_client_a_id, v_client_user_a_id, 'ativo'),
    (v_client_b_id, v_client_user_b_id, 'ativo')
  ON CONFLICT DO NOTHING;

  -- -------------------------------------------------------------------
  -- TESTE 1: Cliente A envia mensagem válida via RPC
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_client_user_a_id::text, true);
  PERFORM set_config('role', 'authenticated', true);

  v_res := public.send_my_client_support_message('Olá suporte, preciso de ajuda com entrega');
  IF (v_res->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Falha ao enviar mensagem como Cliente A: %', v_res;
  END IF;

  v_msg_a_id := (v_res->'message'->>'id')::uuid;

  -- Validar que o client_id armazenado é o Cliente A
  IF (v_res->'message'->>'client_id')::uuid <> v_client_a_id THEN
    RAISE EXCEPTION 'client_id autoritativo incorreto na mensagem.';
  END IF;

  -- -------------------------------------------------------------------
  -- TESTE 2: Isolamento Multi-Tenant (Cliente B NÃO lê mensagens de A)
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_client_user_b_id::text, true);

  SELECT COUNT(*) INTO v_count
  FROM public.client_support_messages
  WHERE id = v_msg_a_id;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'CRÍTICO: Cliente B conseguiu visualizar mensagem do Cliente A!';
  END IF;

  -- -------------------------------------------------------------------
  -- TESTE 3: Usuário sem vínculo NÃO lê nenhuma mensagem
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_unlinked_user_id::text, true);

  SELECT COUNT(*) INTO v_count
  FROM public.client_support_messages;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'CRÍTICO: Usuário sem vínculo conseguiu visualizar mensagens!';
  END IF;

  -- -------------------------------------------------------------------
  -- TESTE 4: Proteção Append-Only (Tentativas de INSERT/UPDATE/DELETE diretos)
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_client_user_a_id::text, true);

  -- 4.1 Tentar INSERT direto sem RPC
  BEGIN
    INSERT INTO public.client_support_messages (client_id, sender_user_id, sender_type, sender_name, message)
    VALUES (v_client_a_id, v_client_user_a_id, 'admin', 'Fake Admin Name', 'TENTATIVA HACK');
  EXCEPTION WHEN OTHERS THEN
    v_direct_insert_failed := true;
  END;

  IF NOT v_direct_insert_failed THEN
    RAISE EXCEPTION 'CRÍTICO: Cliente conseguiu fazer INSERT direto na tabela sem passar pela RPC!';
  END IF;

  -- 4.2 Tentar UPDATE de conteúdo histórico
  BEGIN
    UPDATE public.client_support_messages
    SET message = 'Conteúdo alterado pelo hacker'
    WHERE id = v_msg_a_id;
  EXCEPTION WHEN OTHERS THEN
    v_update_failed := true;
  END;

  -- Validar que a mensagem permanece inalterada
  IF (SELECT message FROM public.client_support_messages WHERE id = v_msg_a_id) <> 'Olá suporte, preciso de ajuda com entrega' THEN
    RAISE EXCEPTION 'Mensagem foi alterada!';
  END IF;

  -- 4.3 Tentar DELETE da mensagem
  BEGIN
    DELETE FROM public.client_support_messages WHERE id = v_msg_a_id;
  EXCEPTION WHEN OTHERS THEN
    v_delete_failed := true;
  END;

  SELECT COUNT(*) INTO v_count FROM public.client_support_messages WHERE id = v_msg_a_id;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'CRÍTICO: Cliente conseguiu excluir mensagem do histórico!';
  END IF;

  -- -------------------------------------------------------------------
  -- TESTE 5: Admin Autorizado Responde Cliente A
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);

  v_res := public.admin_send_client_support_message(v_client_a_id, 'Recebido Cliente A! Estamos verificando.');
  IF (v_res->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Falha ao enviar resposta administrativa: %', v_res;
  END IF;

  v_msg_admin_id := (v_res->'message'->>'id')::uuid;

  -- -------------------------------------------------------------------
  -- TESTE 6: Leitura e Marcação de Read pelo Cliente A
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_client_user_a_id::text, true);

  -- Cliente A lê a resposta do Admin
  SELECT COUNT(*) INTO v_count FROM public.client_support_messages WHERE client_id = v_client_a_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Cliente A deveria visualizar exatamente 2 mensagens na sua conversa.';
  END IF;

  -- Marcar como lidas
  v_res := public.mark_my_client_support_messages_read();
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'updated_count')::int < 1 THEN
    RAISE EXCEPTION 'Falha na RPC mark_my_client_support_messages_read: %', v_res;
  END IF;

  RAISE NOTICE '✅ Suíte de Testes SQL: Suporte dos Clientes Comerciais (RC.15B) concluída com 100%% de sucesso!';
END $$;

ROLLBACK;
