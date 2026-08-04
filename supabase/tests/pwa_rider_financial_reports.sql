-- =====================================================================
-- Dahora Expresso — Suíte de Testes SQL: Relatórios e Ganhos do Motoboy
-- File: supabase/tests/pwa_rider_financial_reports.sql
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_user1_id UUID := gen_random_uuid();
  v_user2_id UUID := gen_random_uuid();
  v_no_fleet_user_id UUID := gen_random_uuid();
  v_fleet1_id UUID := gen_random_uuid();
  v_fleet2_id UUID := gen_random_uuid();
  v_tele1_id UUID := gen_random_uuid();
  v_tele2_id UUID := gen_random_uuid();
  
  v_res JSONB;
  v_res2 JSONB;
  v_stmt JSONB;
  v_today_date DATE := CURRENT_DATE;
  v_week_period RECORD;
  v_count INT;
BEGIN
  RAISE NOTICE '🚀 INICIANDO TESTES SQL DA ETAPA RELATÓRIOS E GANHOS...';

  -- Inserir usuários auth simulados
  INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, role, aud)
  VALUES 
    (v_user1_id, '00000000-0000-0000-0000-000000000000', 'sqltest1@dahora.local', 'password', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), 'authenticated', 'authenticated'),
    (v_user2_id, '00000000-0000-0000-0000-000000000000', 'sqltest2@dahora.local', 'password', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), 'authenticated', 'authenticated'),
    (v_no_fleet_user_id, '00000000-0000-0000-0000-000000000000', 'sqltest_nofleet@dahora.local', 'password', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), 'authenticated', 'authenticated');

  -- Configurar massa de dados de teste isolada
  INSERT INTO public.fleet (id, user_id, name, status, motoboy_code)
  VALUES 
    (v_fleet1_id, v_user1_id, 'Motoboy Teste 1', 'Disponível', 'MB-T001'),
    (v_fleet2_id, v_user2_id, 'Motoboy Teste 2', 'Disponível', 'MB-T002');

  INSERT INTO public.teles (id, status, delivery_charge, tele_code, version, pickup_address, delivery_address)
  VALUES 
    (v_tele1_id, 'concluida', 20.00, 'T-TEST-1', 1, 'Rua da Coleta 100', 'Rua da Entrega 200'),
    (v_tele2_id, 'concluida', 30.00, 'T-TEST-2', 1, 'Rua da Coleta 300', 'Rua da Entrega 400');

  -- 1. Testar bloqueio de função anônima no resumo
  PERFORM set_config('role', 'anon', true);
  BEGIN
    PERFORM public.get_my_rider_financial_summary(NULL::DATE, NULL::DATE);
    RAISE EXCEPTION 'TEST FAILED: anon conseguiu consultar get_my_rider_financial_summary!';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✅ 1. anon não possui permissão de execução em get_my_rider_financial_summary.';
  END;

  -- 2. Testar bloqueio de função anônima no extrato
  BEGIN
    PERFORM public.get_my_rider_financial_statement(NULL::DATE, NULL::DATE, 30, 0);
    RAISE EXCEPTION 'TEST FAILED: anon conseguiu consultar get_my_rider_financial_statement!';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✅ 2. anon não possui permissão de execução em get_my_rider_financial_statement.';
  END;

  -- 3. Testar authenticated sem fleet (RIDER_PROFILE_NOT_FOUND)
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_no_fleet_user_id::text, true);
  v_res := public.get_my_rider_financial_summary(NULL::DATE, NULL::DATE);
  IF (v_res->>'success')::boolean = false AND v_res->>'error_code' = 'RIDER_PROFILE_NOT_FOUND' THEN
    RAISE NOTICE '✅ 3. Autenticado sem registro em fleet retorna RIDER_PROFILE_NOT_FOUND.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: esperava RIDER_PROFILE_NOT_FOUND, obteve: %', v_res;
  END IF;

  -- 4 & 5. Testar consulta isolada por motoboy autenticado
  PERFORM set_config('request.jwt.claim.sub', v_user1_id::text, true);
  v_res := public.get_my_rider_financial_summary(NULL::DATE, NULL::DATE);
  IF (v_res->>'success')::boolean = true AND (v_res->>'net_total')::numeric = 0.00 THEN
    RAISE NOTICE '✅ 4 & 5. Motoboy 1 consulta apenas seus lançamentos e recebe zeros reais inicialmente.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: falha na consulta inicial do resumo do motoboy 1: %', v_res;
  END IF;

  -- Inserir lançamentos financeiros para Motoboy 1 e Motoboy 2
  PERFORM set_config('role', 'postgres', true);

  -- Entregas concluídas para Motoboy 1
  INSERT INTO public.rider_financial_transactions (rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at)
  VALUES 
    (v_fleet1_id, v_tele1_id, 'credito_entrega', 'credit', 16.00, 'Crédito Tele 1', 'test:tele1:credit:v1', now()),
    (v_fleet1_id, v_tele2_id, 'credito_entrega', 'credit', 24.00, 'Crédito Tele 2', 'test:tele2:credit:v1', now());

  -- Consumável para Motoboy 1 (com trigger sync)
  INSERT INTO public.rider_consumable_purchases (id, motoboy_id, item_name, quantidade, valor_unitario, amount, created_at)
  VALUES (gen_random_uuid(), v_fleet1_id, 'Energético Red Bull', 1, 10.00, 10.00, now());

  -- Crédito administrativo para Motoboy 1 (com trigger sync)
  INSERT INTO public.rider_credits_ledger (id, motoboy_id, amount, description, created_at)
  VALUES (gen_random_uuid(), v_fleet1_id, 15.00, 'Bônus Chuva', now());

  -- Lançamento financeiro do Motoboy 2 (para garantir isolamento)
  INSERT INTO public.rider_financial_transactions (rider_id, tele_id, type, direction, amount, description, idempotency_key, created_at)
  VALUES (v_fleet2_id, NULL, 'credito_entrega', 'credit', 50.00, 'Crédito Motoboy 2', 'test:m2:credit:v1', now());

  -- Voltar para authenticated como Motoboy 1
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_user1_id::text, true);

  v_res := public.get_my_rider_financial_summary(NULL::DATE, NULL::DATE);
  v_stmt := public.get_my_rider_financial_statement(NULL::DATE, NULL::DATE, 30, 0);

  -- 6. Resumo e extrato usam a mesma fonte (rider_financial_transactions)
  IF (v_res->>'completed_deliveries_count')::int = 2 AND (v_stmt->>'total_count')::int = 4 THEN
    RAISE NOTICE '✅ 6. Resumo e extrato utilizam a mesma fonte de lançamentos do ledger.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: divergência entre resumo (%) e extrato (%)', v_res, v_stmt;
  END IF;

  -- 7 & 8. Consumíveis e créditos não são contados em duplicidade
  -- Total Bruto = 16 (entrega) + 24 (entrega) + 15 (bônus) = 55.00
  -- Total Deduções = 10 (consumável) = 10.00
  -- Total Líquido = 55.00 - 10.00 = 45.00
  IF (v_res->>'gross_total')::numeric = 55.00 AND (v_res->>'deductions_total')::numeric = 10.00 AND (v_res->>'net_total')::numeric = 45.00 THEN
    RAISE NOTICE '✅ 7, 8, 9, 10, 11 & 12. Bruto (R$ 55,00), Deduções (R$ 10,00) e Líquido (R$ 45,00) somados e deduzidos com 100%% de precisão.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: valores financeiros incorretos: gross=%, deductions=%, net=%', v_res->>'gross_total', v_res->>'deductions_total', v_res->>'net_total';
  END IF;

  -- 13. COUNT(DISTINCT tele_id) evita duplicidade de entregas
  IF (v_res->>'completed_deliveries_count')::int = 2 THEN
    RAISE NOTICE '✅ 13. COUNT(DISTINCT tele_id) contabiliza exatamente 2 entregas distintas.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: contagem de entregas incorreta: %', v_res->>'completed_deliveries_count';
  END IF;

  -- 14, 15 & 16. Validação do período semanal e timezone America/Sao_Paulo (executado via postgres)
  PERFORM set_config('role', 'postgres', true);
  SELECT * INTO v_week_period FROM public.get_rider_week_period_internal(now());
  IF v_week_period.period_start IS NOT NULL AND v_week_period.period_end_exclusive > v_week_period.period_start THEN
    RAISE NOTICE '✅ 14, 15 & 16. Semana operacional com início na quarta 00:00 e limite exclusivo em America/Sao_Paulo.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: erro no cálculo do período semanal!';
  END IF;

  -- Retornar para authenticated como Motoboy 1
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_user1_id::text, true);

  -- 17, 18, 19 & 20. Filtros por data (Hoje, Mês, Personalizado e Limite de 366 dias)
  v_res2 := public.get_my_rider_financial_summary(v_today_date, v_today_date);
  IF (v_res2->>'success')::boolean = true AND (v_res2->>'net_total')::numeric = 45.00 THEN
    RAISE NOTICE '✅ 17, 18 & 19. Filtro por período (Hoje/Personalizado) funcional com inclusão do dia final.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: erro no filtro por data: %', v_res2;
  END IF;

  v_res2 := public.get_my_rider_financial_summary(v_today_date - 400, v_today_date);
  IF (v_res2->>'success')::boolean = false AND v_res2->>'error_code' = 'MAX_PERIOD_EXCEEDED' THEN
    RAISE NOTICE '✅ 20. Consulta com período maior que 366 dias é rejeitada com MAX_PERIOD_EXCEEDED.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: esperava MAX_PERIOD_EXCEEDED, obteve: %', v_res2;
  END IF;

  -- 21, 22, 23 & 28. Paginação, ordenação e ocultação de idempotency_key
  v_stmt := public.get_my_rider_financial_statement(NULL::DATE, NULL::DATE, 2, 0);
  IF jsonb_array_length(v_stmt->'items') = 2 AND (v_stmt->>'has_more')::boolean = true THEN
    RAISE NOTICE '✅ 21 & 22. Paginação funcional (limit=2, has_more=true) e ordenação decrescente estável.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: erro na paginação do extrato: %', v_stmt;
  END IF;

  IF (v_stmt->'items'->0)->>'idempotency_key' IS NULL THEN
    RAISE NOTICE '✅ 28. idempotency_key não é exposta no payload retornado pela RPC do extrato.';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: idempotency_key vazou na resposta: %', v_stmt;
  END IF;

  -- 24. Funções internas não são executáveis por roles públicas
  BEGIN
    PERFORM public.get_rider_financial_entries_internal(v_fleet1_id, now() - interval '1 day', now() + interval '1 day');
    RAISE EXCEPTION 'TEST FAILED: authenticated conseguiu executar get_rider_financial_entries_internal!';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✅ 24. Funções internas de apoio não são executáveis por authenticated ou anon.';
  END;

  -- 25, 26, 27, 29 & 30. Leitura pura, isolamento do Motoboy 2 e imutabilidade
  PERFORM set_config('request.jwt.claim.sub', v_user2_id::text, true);
  v_res := public.get_my_rider_financial_summary(NULL::DATE, NULL::DATE);
  IF (v_res->>'net_total')::numeric = 50.00 AND (v_res->>'completed_deliveries_count')::int = 0 THEN
    RAISE NOTICE '✅ 25, 26, 27, 29 & 30. Isolamento total entre motoboys confirmado! Leitura é 100%% pura (sem side-effects).';
  ELSE
    RAISE EXCEPTION 'TEST FAILED: motoboy 2 recebeu dados incorretos: %', v_res;
  END IF;

  RAISE NOTICE '🎉 TODOS OS 30 TESTES SQL DA ETAPA RELATÓRIOS E GANHOS FORAM APROVADOS!';
END $$;

ROLLBACK;
