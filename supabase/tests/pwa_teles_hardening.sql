-- =====================================================================
-- Dahora Expresso — Script de Homologação SQL: PWA Minhas Teles Hardening
-- Arquivo: supabase/tests/pwa_teles_hardening.sql
-- =====================================================================

BEGIN;

-- 1. Validar que tipo de public.teles.version é INTEGER
DO $$
DECLARE
  v_type TEXT;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'teles' AND column_name = 'version';

  IF v_type <> 'integer' THEN
    RAISE EXCEPTION 'TEST FAILED: teles.version esperava integer, encontrou %', v_type;
  END IF;
END $$;

-- 2. Validar que rider_percentage rejeita valores fora da faixa [0, 100]
DO $$
BEGIN
  BEGIN
    INSERT INTO public.teles (pickup_address, delivery_address, delivery_charge, rider_percentage)
    VALUES ('Rua A', 'Rua B', 10.00, 150.00);
    RAISE EXCEPTION 'TEST FAILED: rider_percentage > 100 deveria ser rejeitado.';
  EXCEPTION WHEN check_violation THEN
    -- Sucesso
  END;
END $$;

-- 3, 4, 5. Validar que a leitura (get_tele_rider_earning) NÃO altera a Tele (sem UPDATE, version ou updated_at change)
DO $$
DECLARE
  v_tele_id UUID := gen_random_uuid();
  v_v1 INTEGER;
  v_u1 TIMESTAMPTZ;
  v_pct1 NUMERIC(5,2);
  v_v2 INTEGER;
  v_u2 TIMESTAMPTZ;
  v_pct2 NUMERIC(5,2);
  v_earning NUMERIC(12,2);
BEGIN
  INSERT INTO public.teles (id, pickup_address, delivery_address, delivery_charge, status, version, updated_at)
  VALUES (v_tele_id, 'Coleta', 'Entrega', 20.00, 'motoboy_designado', 1, clock_timestamp());

  SELECT version, updated_at, rider_percentage INTO v_v1, v_u1, v_pct1 FROM public.teles WHERE id = v_tele_id;

  -- Leitura
  v_earning := public.get_tele_rider_earning(v_tele_id);

  SELECT version, updated_at, rider_percentage INTO v_v2, v_u2, v_pct2 FROM public.teles WHERE id = v_tele_id;

  IF v_v1 <> v_v2 OR v_u1 <> v_u2 THEN
    RAISE EXCEPTION 'TEST FAILED: get_tele_rider_earning alterou a versão ou timestamp da Tele!';
  END IF;

  IF v_pct2 IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: get_tele_rider_earning não deve congelar rider_percentage durante leitura!';
  END IF;
END $$;

-- 6, 7, 8, 9. Congelamento da regra e fechamento de valores monetários com arredondamento exato
DO $$
DECLARE
  v_client_id UUID := gen_random_uuid();
  v_tele_id UUID := gen_random_uuid();
  v_split RECORD;
  v_earning NUMERIC(12,2);
BEGIN
  -- Criar cliente comercial com 85% de repasse
  INSERT INTO public.commercial_clients (id, establishment_name, responsible_name, phone, email, document, address, rider_percentage)
  VALUES (v_client_id, 'Restaurante Teste', 'Resp', '51999998888', 'rest@teste.local', '99988877700', 'Rua Teste 10', 85.00);

  -- Criar Tele vinculada ao cliente com percentual congelado a 85%
  INSERT INTO public.teles (id, client_id, pickup_address, delivery_address, delivery_charge, status, version, rider_percentage)
  VALUES (v_tele_id, v_client_id, 'Coleta 1', 'Entrega 1', 15.00, 'em_entrega', 1, 85.00);

  -- Alterar percentual do cliente no cadastro para 50%
  UPDATE public.commercial_clients SET rider_percentage = 50.00 WHERE id = v_client_id;

  -- Obter split financeiro
  SELECT * INTO v_split FROM public.calculate_tele_financial_split_internal(v_tele_id);

  -- Validar soma exata
  IF (v_split.rider_earning_amount + v_split.company_earning_amount) <> v_split.delivery_charge THEN
    RAISE EXCEPTION 'TEST FAILED: Soma do repasse e empresa (% + %) não fecha a taxa (%)',
      v_split.rider_earning_amount, v_split.company_earning_amount, v_split.delivery_charge;
  END IF;

  -- Validar repasse de 85% (15 * 0.85 = 12.75)
  IF v_split.rider_earning_amount <> 12.75 OR v_split.company_earning_amount <> 2.25 THEN
    RAISE EXCEPTION 'TEST FAILED: Split financeiro incorreto. Esperado (12.75, 2.25), obtido (%, %)',
      v_split.rider_earning_amount, v_split.company_earning_amount;
  END IF;
END $$;

-- 10, 11. Validar revogação de funções internas
DO $$
DECLARE
  v_has_exec BOOLEAN;
BEGIN
  SELECT has_function_privilege('authenticated', 'public.calculate_tele_financial_split_internal(uuid)', 'EXECUTE')
  INTO v_has_exec;

  IF v_has_exec THEN
    RAISE EXCEPTION 'TEST FAILED: authenticated não deveria ter EXECUTE em calculate_tele_financial_split_internal.';
  END IF;
END $$;

-- 12 a 22. Fluxo Atômico, Idempotência e Rollback em Transação
DO $$
DECLARE
  v_client_id UUID := gen_random_uuid();
  v_rider_user_id UUID := gen_random_uuid();
  v_rider_fleet_id UUID := gen_random_uuid();
  v_tele_id UUID := gen_random_uuid();
  v_res JSONB;
  v_client_cnt INT;
  v_rider_cnt INT;
  v_company_cnt INT;
BEGIN
  -- Criar usuário auth fake
  INSERT INTO auth.users (id, email, role, aud)
  VALUES (v_rider_user_id, 'rider_sql_test@local.internal', 'authenticated', 'authenticated');

  -- 1. Criar fleet do motoboy
  INSERT INTO public.fleet (id, user_id, name, phone, status, motoboy_code)
  VALUES (v_rider_fleet_id, v_rider_user_id, 'Motoboy Teste SQL', '51999997777', 'Disponível', 'MB-TEST');

  -- 2. Criar cliente comercial (75%)
  INSERT INTO public.commercial_clients (id, establishment_name, responsible_name, phone, email, document, address, rider_percentage)
  VALUES (v_client_id, 'Mercado SQL Teste', 'Resp SQL', '51988887777', 'sql@teste.local', '88877766600', 'Rua SQL 100', 75.00);

  -- 3. Criar Tele atribuída
  INSERT INTO public.teles (id, client_id, motoboy_id, pickup_address, delivery_address, delivery_charge, status, version)
  VALUES (v_tele_id, v_client_id, v_rider_fleet_id, 'Coleta SQL', 'Entrega SQL', 20.00, 'motoboy_designado', 1);

  -- 4. Coleta
  UPDATE public.teles SET status = 'coletada', version = 2, rider_percentage = 75.00 WHERE id = v_tele_id;

  -- 5. Início de Entrega
  UPDATE public.teles SET status = 'em_entrega', version = 3 WHERE id = v_tele_id;

  -- 6. Primeira Conclusão
  v_res := public.complete_tele_internal(v_tele_id, 3, v_rider_user_id, 'rider', 'rider_pwa');

  IF (v_res->>'success')::boolean <> true THEN
    RAISE EXCEPTION 'TEST FAILED: Primeira conclusão falhou: %', v_res;
  END IF;

  SELECT count(*) INTO v_client_cnt FROM public.client_financial_transactions WHERE tele_id = v_tele_id;
  SELECT count(*) INTO v_rider_cnt FROM public.rider_financial_transactions WHERE tele_id = v_tele_id;
  SELECT count(*) INTO v_company_cnt FROM public.company_financial_transactions WHERE tele_id = v_tele_id;

  IF v_client_cnt <> 1 OR v_rider_cnt <> 1 OR v_company_cnt <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: Conclusão esperava exatamente (1, 1, 1) ledgers, obteve (%, %, %)',
      v_client_cnt, v_rider_cnt, v_company_cnt;
  END IF;

  -- 7. Segunda Conclusão (Testar Idempotência)
  v_res := public.complete_tele_internal(v_tele_id, 4, v_rider_user_id, 'rider', 'rider_pwa');

  IF (v_res->>'success')::boolean <> true OR (v_res->>'is_idempotent')::boolean <> true THEN
    RAISE EXCEPTION 'TEST FAILED: Segunda conclusão deveria retornar resposta idempotente: %', v_res;
  END IF;

  -- Re-verificar ledgers após repetição
  SELECT count(*) INTO v_client_cnt FROM public.client_financial_transactions WHERE tele_id = v_tele_id;
  SELECT count(*) INTO v_rider_cnt FROM public.rider_financial_transactions WHERE tele_id = v_tele_id;
  SELECT count(*) INTO v_company_cnt FROM public.company_financial_transactions WHERE tele_id = v_tele_id;

  IF v_client_cnt <> 1 OR v_rider_cnt <> 1 OR v_company_cnt <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: Segunda conclusão duplicou lançamentos no ledger! (%, %, %)',
      v_client_cnt, v_rider_cnt, v_company_cnt;
  END IF;
END $$;

-- 23, 24, 25. Validação de Preservação Histórica do Ledger Concluído
DO $$
DECLARE
  v_client_id UUID := gen_random_uuid();
  v_rider_user_id UUID := gen_random_uuid();
  v_rider_fleet_id UUID := gen_random_uuid();
  v_tele_id UUID := gen_random_uuid();
  v_earning_before NUMERIC(12,2);
  v_earning_after NUMERIC(12,2);
BEGIN
  INSERT INTO auth.users (id, email, role, aud)
  VALUES (v_rider_user_id, 'rider_hist_test@local.internal', 'authenticated', 'authenticated');

  INSERT INTO public.fleet (id, user_id, name, phone, status, motoboy_code)
  VALUES (v_rider_fleet_id, v_rider_user_id, 'MB Histórico', '51999990000', 'Disponível', 'MB-HIST');

  INSERT INTO public.commercial_clients (id, establishment_name, responsible_name, phone, email, document, address, rider_percentage)
  VALUES (v_client_id, 'Cliente Histórico', 'Resp Hist', '51988880000', 'hist@teste.local', '77766655500', 'Rua Hist 50', 80.00);

  INSERT INTO public.teles (id, client_id, motoboy_id, pickup_address, delivery_address, delivery_charge, status, version)
  VALUES (v_tele_id, v_client_id, v_rider_fleet_id, 'Coleta', 'Entrega', 100.00, 'em_entrega', 1);

  -- Concluir (Repasse = 80.00)
  PERFORM public.complete_tele_internal(v_tele_id, 1, v_rider_user_id, 'rider', 'rider_pwa');

  v_earning_before := public.get_tele_rider_earning(v_tele_id);

  -- Alterar percentual do cliente de 80% para 20% no cadastro
  UPDATE public.commercial_clients SET rider_percentage = 20.00 WHERE id = v_client_id;
  UPDATE public.teles SET rider_percentage = 20.00 WHERE id = v_tele_id;

  v_earning_after := public.get_tele_rider_earning(v_tele_id);

  IF v_earning_before <> 80.00 OR v_earning_after <> 80.00 THEN
    RAISE EXCEPTION 'TEST FAILED: Leitura de Tele concluída alterou valor histórico! (antes: %, depois: %)',
      v_earning_before, v_earning_after;
  END IF;
END $$;

ROLLBACK;
