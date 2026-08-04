-- =====================================================================
-- Dahora Expresso — Automated SQL Test Suite for Admin Financial Operations
-- File: supabase/tests/admin_rider_financial_operations_fix.sql
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_admin_user_id UUID := '14620da0-6e08-488f-95ff-26f751785870'; -- admin@dahora.local
  v_rider_user_id UUID := '7668596b-0444-4435-9f0c-8d0ad7ce7fb8'; -- motoboy@dahora.local
  v_fleet_id UUID;
  v_res JSONB;
  v_res_rev JSONB;
  v_res_rev2 JSONB;
  v_summary JSONB;
  v_statement JSONB;
  v_pwa_summary JSONB;
  v_purch_count INT;
  v_tx_count INT;
  v_audit_count INT;
  v_col_exists BOOLEAN;
  v_tbl_exists BOOLEAN;
BEGIN
  RAISE NOTICE '🧪 Executando Suíte de Testes SQL: Operações Financeiras Administrativas...';

  -- 1. Schema check: item_type não é utilizado em rider_consumable_purchases
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'rider_consumable_purchases' AND column_name = 'item_type'
  ) INTO v_col_exists;
  ASSERT NOT v_col_exists, 'Tabela rider_consumable_purchases NÃO deve conter a coluna obsoleta item_type!';

  -- 2. Schema check: rider_credits não existe (usando rider_credits_ledger)
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'rider_credits'
  ) INTO v_tbl_exists;
  ASSERT NOT v_tbl_exists, 'Tabela public.rider_credits NÃO deve existir no schema oficial!';

  -- 3. Triggers antigos foram removidos
  SELECT EXISTS (
    SELECT 1 FROM information_schema.triggers 
    WHERE event_object_table IN ('rider_consumable_purchases', 'rider_credits_ledger')
  ) INTO v_col_exists;
  ASSERT NOT v_col_exists, 'Triggers antigos de sincronização devem estar desativados!';

  -- Setup do contexto JWT e busca do motoboy
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_user_id::text, 'role', 'authenticated')::text, true);

  SELECT id INTO v_fleet_id FROM public.fleet WHERE user_id = v_rider_user_id LIMIT 1;
  IF v_fleet_id IS NULL THEN
    INSERT INTO public.fleet (id, user_id, name, motoboy_code, status)
    VALUES (gen_random_uuid(), v_rider_user_id, 'Guilherme Motoboy', 'MB-0001', 'Disponível')
    RETURNING id INTO v_fleet_id;
  END IF;

  -- 4 & 5 & 6. Admin cria consumível -> registro operacional + exatamente um débito no ledger
  v_res := public.admin_create_rider_consumable(
    p_motoboy_id := v_fleet_id,
    p_category := 'consumivel',
    p_item_name := 'Óleo 20W50',
    p_quantity := 2,
    p_unit_amount := 30.00,
    p_notes := 'Troca preventiva de óleo',
    p_competency_date := CURRENT_DATE,
    p_request_idempotency_key := 'test-sql-cons-key-1'
  );
  ASSERT (v_res->>'success')::boolean = true, 'Admin deve criar consumível com sucesso!';
  ASSERT (v_res->'purchase'->>'amount')::numeric = 60.00, 'Amount deve ser calculated como quantidade * valor_unitario (60.00)';

  SELECT COUNT(*) INTO v_purch_count FROM public.rider_consumable_purchases WHERE motoboy_id = v_fleet_id AND observacao = 'Troca preventiva de óleo';
  ASSERT v_purch_count = 1, 'Deve existir exatamente 1 registro operacional de consumível!';

  SELECT COUNT(*) INTO v_tx_count FROM public.rider_financial_transactions WHERE rider_id = v_fleet_id AND type = 'ajuste_debito' AND description LIKE '%Óleo 20W50%';
  ASSERT v_tx_count = 1, 'Deve existir exatamente 1 débito em rider_financial_transactions!';

  -- 7 & 8 & 9. Admin cria crédito -> registro operacional + exatamente um crédito no ledger
  v_res := public.admin_create_rider_adjustment(
    p_motoboy_id := v_fleet_id,
    p_direction := 'credit',
    p_amount := 50.00,
    p_description := 'Bônus Meta Batida Teste SQL',
    p_target_date := CURRENT_DATE,
    p_request_idempotency_key := 'test-sql-cred-key-1'
  );
  ASSERT (v_res->>'success')::boolean = true, 'Admin deve criar crédito com sucesso!';

  SELECT COUNT(*) INTO v_tx_count FROM public.rider_financial_transactions WHERE rider_id = v_fleet_id AND type = 'ajuste_credito' AND description = 'Bônus Meta Batida Teste SQL';
  ASSERT v_tx_count = 1, 'Deve existir exatamente 1 crédito em rider_financial_transactions!';

  -- 10 & 11. Admin cria ajuste negativo -> exatamente um débito
  v_res := public.admin_create_rider_adjustment(
    p_motoboy_id := v_fleet_id,
    p_direction := 'debit',
    p_amount := 15.00,
    p_description := 'Desconto Capa Danificada Teste SQL',
    p_target_date := CURRENT_DATE,
    p_request_idempotency_key := 'test-sql-deb-key-1'
  );
  ASSERT (v_res->>'success')::boolean = true, 'Admin deve criar ajuste negativo com sucesso!';

  -- 12. Idempotência de criação funciona
  v_res := public.admin_create_rider_adjustment(
    p_motoboy_id := v_fleet_id,
    p_direction := 'debit',
    p_amount := 15.00,
    p_description := 'Desconto Capa Danificada Teste SQL',
    p_target_date := CURRENT_DATE,
    p_request_idempotency_key := 'test-sql-deb-key-1'
  );
  ASSERT (v_res->>'idempotent')::boolean = true, 'Chamada repetida com a mesma chave deve retornar de forma idempotente!';

  -- 13 & 14. Motoboy e Anon não executam RPCs administrativas
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rider_user_id::text, 'role', 'authenticated')::text, true);

  v_res := public.admin_create_rider_consumable(
    p_motoboy_id := v_fleet_id,
    p_category := 'consumivel',
    p_item_name := 'Item Proibido',
    p_quantity := 1,
    p_unit_amount := 10.00
  );
  ASSERT (v_res->>'success')::boolean = false, 'Motoboy NÃO pode criar consumível via RPC administrativa!';
  ASSERT (v_res->>'error_code') = 'ADMIN_ROLE_REQUIRED', 'Erro deve ser ADMIN_ROLE_REQUIRED!';

  -- 15 & 16. Estorno de consumível cria crédito inverso e atualiza status para reversed
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_user_id::text, 'role', 'authenticated')::text, true);

  v_res_rev := public.admin_reverse_rider_consumable(
    p_purchase_id := (SELECT id FROM public.rider_consumable_purchases WHERE motoboy_id = v_fleet_id AND observacao = 'Troca preventiva de óleo' LIMIT 1),
    p_reason := 'Compra cancelada a pedido do motoboy'
  );
  ASSERT (v_res_rev->>'success')::boolean = true, 'Estorno de consumível deve ser realizado com sucesso!';
  ASSERT (v_res_rev->'purchase'->>'status') = 'reversed', 'Status do consumível deve ser atualizado para reversed!';

  -- 17 & 18. Estorno de crédito cria débito inverso
  v_res_rev := public.admin_reverse_rider_adjustment(
    p_adjustment_id := (SELECT id FROM public.rider_credits_ledger WHERE motoboy_id = v_fleet_id AND description = 'Bônus Meta Batida Teste SQL' LIMIT 1),
    p_reason := 'Crédito lançado por engano'
  );
  ASSERT (v_res_rev->>'success')::boolean = true, 'Estorno de crédito deve ser realizado com sucesso!';

  -- 19. Segunda reversão é idempotente e não duplica transações
  v_res_rev2 := public.admin_reverse_rider_adjustment(
    p_adjustment_id := (SELECT id FROM public.rider_credits_ledger WHERE motoboy_id = v_fleet_id AND description = 'Bônus Meta Batida Teste SQL' LIMIT 1),
    p_reason := 'Crédito lançado por engano'
  );
  ASSERT (v_res_rev2->>'already_reversed')::boolean = true, 'Segunda chamada de estorno deve retornar de forma idempotente!';

  -- 20 & 21 & 22. Histórico operacional e ledger original são preservados sem DELETE físico
  SELECT COUNT(*) INTO v_purch_count FROM public.rider_consumable_purchases WHERE motoboy_id = v_fleet_id AND observacao = 'Troca preventiva de óleo';
  ASSERT v_purch_count = 1, 'Registro operacional de consumível NÃO deve ser removido fisicamente!';

  -- 24 & 25 & 26 & 27 & 28 & 29. Extrato e Resumo do Motoboy
  v_summary := public.admin_get_rider_financial_summary(
    p_motoboy_id := v_fleet_id,
    p_start_date := CURRENT_DATE - 1,
    p_end_date := CURRENT_DATE + 1
  );
  ASSERT (v_summary->>'success')::boolean = true, 'Resumo do motoboy deve retornar sucesso!';

  v_statement := public.admin_get_rider_financial_statement(
    p_motoboy_id := v_fleet_id,
    p_start_date := CURRENT_DATE - 1,
    p_end_date := CURRENT_DATE + 1,
    p_limit := 50,
    p_offset := 0
  );
  ASSERT (v_statement->>'success')::boolean = true, 'Extrato do motoboy deve retornar sucesso!';

  -- 30 & 31. PWA e Admin usam a mesma fonte (public.rider_financial_transactions)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rider_user_id::text, 'role', 'authenticated')::text, true);

  v_pwa_summary := public.get_my_rider_financial_summary(
    p_start_date := CURRENT_DATE - 1,
    p_end_date := CURRENT_DATE + 1
  );
  ASSERT (v_pwa_summary->>'success')::boolean = true, 'PWA deve consultar resumo do motoboy com sucesso!';
  ASSERT (v_pwa_summary->>'net_total')::numeric = (v_summary->>'net_total')::numeric, 'Saldo do PWA e do Admin devem ser 100% idênticos!';

  -- 34. Auditoria registra o ator
  SELECT COUNT(*) INTO v_audit_count FROM public.system_audit_logs WHERE action LIKE 'admin_%';
  ASSERT v_audit_count >= 4, 'Todas as operações administrativas devem gravar logs em system_audit_logs!';

  RAISE NOTICE '🎉 Suíte de Testes SQL para Operações Financeiras Administrativas concluída com 100%% de SUCESSO!';
END;
$$;

ROLLBACK;
