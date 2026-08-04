-- =====================================================================
-- Dahora Expresso — Automated SQL Test Suite for Rider Support Module
-- File: supabase/tests/rider_support_module.sql
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_admin_id UUID := '14620da0-6e08-488f-95ff-26f751785870';
  v_rider_id UUID := '7668596b-0444-4435-9f0c-8d0ad7ce7fb8';
  v_other_user_id UUID := '4708f929-a6d6-4ed1-ab22-1acb1b676e9d';
  v_fleet_id UUID := 'f1111111-1111-4111-a111-111111111111';
  
  v_res JSONB;
  v_ticket_id UUID;
  v_ticket_2_id UUID;
  v_summary JSONB;
  v_details JSONB;
  v_audit_count INT;
  v_anon_blocked BOOLEAN := false;
BEGIN
  RAISE NOTICE '🚀 Executando Suíte de Testes SQL: Módulo de Suporte dos Motoboys...';

  -- -------------------------------------------------------------------
  -- 1. Testes de Validação e Bloqueios Iniciais
  -- -------------------------------------------------------------------
  
  -- 1.1 Autenticação ausente (anon / sem auth.uid)
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('role', 'anon', true);

  BEGIN
    v_res := public.create_my_rider_support_ticket('Problema na entrega', 'delivery_issue', 'normal', 'Mensagem anonima');
    IF (v_res->>'success')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'Anon não deveria conseguir criar chamado.';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    v_anon_blocked := true;
  END;

  IF NOT v_anon_blocked THEN
    RAISE EXCEPTION 'Teste 1.1 Falhou: Anon deve ser bloqueado por permissão REVOKE.';
  END IF;

  -- 1.2 Usuário autenticado mas sem registro em fleet
  PERFORM set_config('request.jwt.claim.sub', v_other_user_id::text, true);
  PERFORM set_config('role', 'authenticated', true);

  v_res := public.create_my_rider_support_ticket('Dúvida sobre repasse', 'payment_question', 'normal', 'Mensagem do parceiro comercial sem moto');
  IF (v_res->>'success')::boolean IS NOT FALSE OR (v_res->>'error_code') <> 'RIDER_PROFILE_NOT_FOUND' THEN
    RAISE EXCEPTION 'Teste 1.2 Falhou: Usuário sem perfil de motoboy deve ser bloqueado. Resposta: %', v_res;
  END IF;

  -- -------------------------------------------------------------------
  -- 2. Criação Atômica de Chamados pelo Motoboy Autenticado
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_rider_id::text, true);
  PERFORM set_config('role', 'authenticated', true);

  -- 2.1 Validação de Assunto Inválido (< 3 caracteres)
  v_res := public.create_my_rider_support_ticket('Oi', 'delivery_issue', 'normal', 'Mensagem válida');
  IF (v_res->>'error_code') <> 'INVALID_SUBJECT' THEN
    RAISE EXCEPTION 'Teste 2.1 Falhou: Assunto curto deve ser rejeitado. Resposta: %', v_res;
  END IF;

  -- 2.2 Validação de Categoria Inválida
  v_res := public.create_my_rider_support_ticket('Assunto Válido', 'categoria_inexistente', 'normal', 'Mensagem válida');
  IF (v_res->>'error_code') <> 'INVALID_CATEGORY' THEN
    RAISE EXCEPTION 'Teste 2.2 Falhou: Categoria inválida deve ser rejeitada. Resposta: %', v_res;
  END IF;

  -- 2.3 Validação de Mensagem Vazia
  v_res := public.create_my_rider_support_ticket('Assunto Válido', 'delivery_issue', 'normal', '   ');
  IF (v_res->>'error_code') <> 'INVALID_MESSAGE' THEN
    RAISE EXCEPTION 'Teste 2.3 Falhou: Mensagem em branco deve ser rejeitada. Resposta: %', v_res;
  END IF;

  -- 2.4 Criação com Sucesso do Chamado #1 (Motoboy)
  v_res := public.create_my_rider_support_ticket('Endereço do cliente não localizado na Tele #101', 'delivery_issue', 'high', 'Não estou conseguindo encontrar o número 450 da rua.');
  IF (v_res->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Teste 2.4 Falhou ao criar chamado válido. Resposta: %', v_res;
  END IF;
  v_ticket_id := (v_res->>'ticket_id')::uuid;

  -- Confirmar persistência no banco
  IF NOT EXISTS (SELECT 1 FROM public.rider_support_tickets WHERE id = v_ticket_id AND motoboy_id = v_fleet_id AND status = 'open') THEN
    RAISE EXCEPTION 'Teste 2.4 Falhou: Ticket não persistido corretamente no banco.';
  END IF;

  -- Confirmar criação atômica da primeira mensagem
  IF NOT EXISTS (SELECT 1 FROM public.rider_support_messages WHERE ticket_id = v_ticket_id AND sender_type = 'rider' AND is_internal IS FALSE) THEN
    RAISE EXCEPTION 'Teste 2.4 Falhou: Primeira mensagem do chamado não foi criada atomicamente.';
  END IF;

  -- 2.5 Criação do Chamado #2 (Motoboy)
  v_res := public.create_my_rider_support_ticket('Dúvida sobre valor de consumível', 'consumable_question', 'normal', 'Gostaria de confirmar a taxa de óleo.');
  v_ticket_2_id := (v_res->>'ticket_id')::uuid;

  -- -------------------------------------------------------------------
  -- 3. Isolamento por Motoboy & Leitura
  -- -------------------------------------------------------------------

  -- 3.1 Motoboy consulta seus próprios chamados
  v_res := public.get_my_rider_support_tickets(NULL, 10, 0);
  IF (v_res->>'total_count')::int < 2 THEN
    RAISE EXCEPTION 'Teste 3.1 Falhou: Motoboy deve ver seus 2 chamados. Resposta: %', v_res;
  END IF;

  -- 3.2 Motoboy consulta detalhes do seu chamado (marca lida)
  v_details := public.get_my_rider_support_ticket(v_ticket_id);
  IF (v_details->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Teste 3.2 Falhou ao consultar detalhes do chamado. Resposta: %', v_details;
  END IF;

  -- 3.3 Motoboy B tenta acessar chamado do Motoboy A (Bloqueio)
  PERFORM set_config('request.jwt.claim.sub', '99999999-9999-4999-a999-999999999999', true);
  v_details := public.get_my_rider_support_ticket(v_ticket_id);
  IF (v_details->>'error_code') <> 'TICKET_NOT_FOUND' THEN
    RAISE EXCEPTION 'Teste 3.3 Falhou: Motoboy B não pode ver ticket do Motoboy A. Resposta: %', v_details;
  END IF;

  -- -------------------------------------------------------------------
  -- 4. Testes de RPCs Administrativas
  -- -------------------------------------------------------------------

  -- 4.1 Motoboy tenta executar RPC administrativa -> Bloqueio ADMIN_ROLE_REQUIRED
  PERFORM set_config('request.jwt.claim.sub', v_rider_id::text, true);
  v_res := public.admin_get_rider_support_tickets(NULL, NULL, NULL, NULL, 10, 0);
  IF (v_res->>'error_code') <> 'ADMIN_ROLE_REQUIRED' THEN
    RAISE EXCEPTION 'Teste 4.1 Falhou: Motoboy não pode executar RPC administrativa. Resposta: %', v_res;
  END IF;

  -- 4.2 Administrador autenticado consulta lista e métricas
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_res := public.admin_get_rider_support_tickets(NULL, NULL, NULL, NULL, 10, 0);
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'total_count')::int < 2 THEN
    RAISE EXCEPTION 'Teste 4.2 Falhou: Admin deve listar todos os chamados. Resposta: %', v_res;
  END IF;

  -- Confirmar que o nome do motoboy aparece no formato "Guilherme Motoboy — MB-0001"
  IF (v_res->'items'->0->>'rider_display_name') <> 'Guilherme Motoboy — MB-0001' THEN
    RAISE EXCEPTION 'Teste 4.2 Falhou: Formato do nome do motoboy inválido: %', v_res->'items'->0->>'rider_display_name';
  END IF;

  -- 4.3 Métricas Globais (admin_get_rider_support_summary)
  v_summary := public.admin_get_rider_support_summary();
  IF (v_summary->>'success')::boolean IS NOT TRUE OR (v_summary->>'new_count')::int < 2 THEN
    RAISE EXCEPTION 'Teste 4.3 Falhou: Resumo de suporte deve retornar contagens reais. Resposta: %', v_summary;
  END IF;

  -- -------------------------------------------------------------------
  -- 5. Respostas Públicas vs. Notas Internas
  -- -------------------------------------------------------------------

  -- 5.1 Admin envia Nota Interna (is_internal = true)
  v_res := public.admin_reply_rider_support_ticket(v_ticket_id, 'Nota interna: Verificando cadastro no sistema.', true);
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'is_internal')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Teste 5.1 Falhou: Admin deve conseguir criar nota interna. Resposta: %', v_res;
  END IF;

  -- Status do chamado NÃO deve mudar com nota interna
  IF (SELECT status FROM public.rider_support_tickets WHERE id = v_ticket_id) <> 'open' THEN
    RAISE EXCEPTION 'Teste 5.1 Falhou: Nota interna não pode alterar status do chamado.';
  END IF;

  -- 5.2 Motoboy consulta chamado e NÃO VÊ a nota interna
  PERFORM set_config('request.jwt.claim.sub', v_rider_id::text, true);
  v_details := public.get_my_rider_support_ticket(v_ticket_id);
  IF pg_catalog.jsonb_array_length(v_details->'messages') <> 1 THEN
    RAISE EXCEPTION 'Teste 5.2 Falhou: Nota interna não pode aparecer para o motoboy. Mensagens retornadas: %', v_details->'messages';
  END IF;

  -- 5.3 Admin envia Resposta Pública ao Motoboy
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_res := public.admin_reply_rider_support_ticket(v_ticket_id, 'Olá Guilherme, o número 450 fica próximo ao posto de gasolina.', false);
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'status') <> 'waiting_rider' THEN
    RAISE EXCEPTION 'Teste 5.3 Falhou: Resposta pública do admin deve mudar status para waiting_rider. Resposta: %', v_res;
  END IF;

  -- 5.4 Motoboy consulta e VÊ a resposta pública do suporte
  PERFORM set_config('request.jwt.claim.sub', v_rider_id::text, true);
  v_details := public.get_my_rider_support_ticket(v_ticket_id);
  IF pg_catalog.jsonb_array_length(v_details->'messages') <> 2 THEN
    RAISE EXCEPTION 'Teste 5.4 Falhou: Motoboy deve visualizar a resposta pública. Mensagens: %', v_details->'messages';
  END IF;

  -- -------------------------------------------------------------------
  -- 6. Resposta do Motoboy & Mudança de Status
  -- -------------------------------------------------------------------
  v_res := public.reply_my_rider_support_ticket(v_ticket_id, 'Obrigado, encontrei o local!');
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'status') <> 'waiting_admin' THEN
    RAISE EXCEPTION 'Teste 6 Falhou: Resposta do motoboy deve alterar status para waiting_admin. Resposta: %', v_res;
  END IF;

  -- -------------------------------------------------------------------
  -- 7. Transições de Status & Encerramento
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);

  -- 7.1 Transição Válida: waiting_admin -> resolved
  v_res := public.admin_update_rider_support_ticket_status(v_ticket_id, 'resolved', 'Atendimento concluído com sucesso');
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'new_status') <> 'resolved' THEN
    RAISE EXCEPTION 'Teste 7.1 Falhou ao alterar para resolved. Resposta: %', v_res;
  END IF;

  -- 7.2 Motoboy responde em ticket resolved -> Reabre para waiting_admin
  PERFORM set_config('request.jwt.claim.sub', v_rider_id::text, true);
  v_res := public.reply_my_rider_support_ticket(v_ticket_id, 'Ainda fiquei com uma dúvida complementar.');
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'status') <> 'waiting_admin' THEN
    RAISE EXCEPTION 'Teste 7.2 Falhou: Resposta em ticket resolved deve reabrir para waiting_admin. Resposta: %', v_res;
  END IF;

  -- 7.3 Admin encerra o chamado (closed)
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_res := public.admin_update_rider_support_ticket_status(v_ticket_id, 'closed', 'Finalizado');
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'new_status') <> 'closed' THEN
    RAISE EXCEPTION 'Teste 7.3 Falhou ao encerrar chamado. Resposta: %', v_res;
  END IF;

  -- Confirmar que closed_at foi preenchido
  IF (SELECT closed_at FROM public.rider_support_tickets WHERE id = v_ticket_id) IS NULL THEN
    RAISE EXCEPTION 'Teste 7.3 Falhou: closed_at deve ser preenchido ao fechar.';
  END IF;

  -- 7.4 Motoboy tenta responder em ticket closed -> Bloqueio TICKET_CLOSED
  PERFORM set_config('request.jwt.claim.sub', v_rider_id::text, true);
  v_res := public.reply_my_rider_support_ticket(v_ticket_id, 'Tentativa em ticket fechado');
  IF (v_res->>'error_code') <> 'TICKET_CLOSED' THEN
    RAISE EXCEPTION 'Teste 7.4 Falhou: Resposta em ticket fechado deve ser bloqueada. Resposta: %', v_res;
  END IF;

  -- 7.5 Admin reabre ticket closed sem motivo -> Bloqueio REOPEN_REASON_REQUIRED
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_res := public.admin_update_rider_support_ticket_status(v_ticket_id, 'in_progress', '');
  IF (v_res->>'error_code') <> 'REOPEN_REASON_REQUIRED' THEN
    RAISE EXCEPTION 'Teste 7.5 Falhou: Reabrir ticket closed exige motivo. Resposta: %', v_res;
  END IF;

  -- 7.6 Admin reabre ticket closed com motivo válido
  v_res := public.admin_update_rider_support_ticket_status(v_ticket_id, 'in_progress', 'Reaberto para análise de auditoria');
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'new_status') <> 'in_progress' THEN
    RAISE EXCEPTION 'Teste 7.6 Falhou ao reabrir ticket closed com motivo. Resposta: %', v_res;
  END IF;

  -- Confirmar que closed_at foi limpo
  IF (SELECT closed_at FROM public.rider_support_tickets WHERE id = v_ticket_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Teste 7.6 Falhou: closed_at deve ser nulo ao reabrir.';
  END IF;

  -- -------------------------------------------------------------------
  -- 8. Atribuição de Responsável
  -- -------------------------------------------------------------------
  v_res := public.admin_assign_rider_support_ticket(v_ticket_id, v_admin_id);
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'assigned_admin_id')::uuid <> v_admin_id THEN
    RAISE EXCEPTION 'Teste 8 Falhou ao atribuir chamado ao admin. Resposta: %', v_res;
  END IF;

  -- -------------------------------------------------------------------
  -- 9. Validação de Auditoria (com permissão de admin)
  -- -------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT COUNT(*) INTO v_audit_count
  FROM public.system_audit_logs
  WHERE action LIKE 'rider_support_%' OR action LIKE 'admin_support_%';

  IF v_audit_count < 5 THEN
    RAISE EXCEPTION 'Teste 9 Falhou: Logs de auditoria devem ser gerados. Quantidade encontrada: %', v_audit_count;
  END IF;

  RAISE NOTICE '🎉 Suíte de Testes SQL para Módulo de Suporte dos Motoboys concluída com 100%% de SUCESSO! (35 asserções validadas)';
END;
$$;

ROLLBACK;
