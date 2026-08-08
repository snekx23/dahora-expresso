import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.bootstrap.remote' });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const adminEmail = process.env.OWNER_1_EMAIL;
const adminPassword = process.env.OWNER_1_PASSWORD;

if (!supabaseUrl || !supabaseSecretKey) {
  console.error('Configuração de ambiente não encontrada em .env.bootstrap.remote');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

describe('Manual Tele Delivery Charge & Financial Protection Tests', () => {
  let adminClient;
  let activeClientId;
  let testMotoboyId;
  let createdAdminTeleId;
  let createdClientTeleId;

  test('0. Autenticação e Configuração de Ambiente para Testes', async () => {
    // 0.1 Autenticar Admin1
    const { data: adminAuth, error: adminErr } = await supabaseAdmin.auth.signInWithPassword({
      email: adminEmail,
      password: adminPassword
    });
    assert.ifError(adminErr, 'Falha ao autenticar Admin1');
    assert.ok(adminAuth.session?.access_token, 'Admin session token ausente');

    const adminUserId = adminAuth.user.id;

    adminClient = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${adminAuth.session.access_token}` } }
    });

    // 0.2 Selecionar Cliente Comercial Ativo
    const { data: clients } = await supabaseAdmin
      .from('commercial_clients')
      .select('id, establishment_name')
      .eq('lifecycle_status', 'ativo')
      .limit(1);

    assert.ok(clients && clients.length > 0, 'Nenhum cliente comercial ativo encontrado');
    activeClientId = clients[0].id;

    // 0.3 Garantir Vínculo de client_users para o Usuário Autenticado
    const { data: existingCu } = await supabaseAdmin
      .from('client_users')
      .select('id')
      .eq('client_id', activeClientId)
      .eq('user_id', adminUserId);

    if (!existingCu || existingCu.length === 0) {
      await supabaseAdmin
        .from('client_users')
        .insert({
          client_id: activeClientId,
          user_id: adminUserId,
          role: 'admin',
          status: 'ativo'
        });
    }

    // 0.4 Selecionar Motoboy da Frota
    const { data: riders } = await supabaseAdmin
      .from('fleet')
      .select('id')
      .limit(1);

    assert.ok(riders && riders.length > 0, 'Nenhum motoboy na frota para teste financeiro');
    testMotoboyId = riders[0].id;
  });

  test('1. ADMIN: Criar Tele com Valor do Pedido (R$ 120,00) e Valor da Tele (R$ 20,00)', async () => {
    const idempotencyKey = `idemp-test-admin-${Date.now()}`;
    const { data, error } = await adminClient.rpc('create_admin_tele', {
      p_client_id: activeClientId,
      p_pickup_address: 'Av. Presidente Vargas, 1000 - Centro, Sapucaia do Sul - RS',
      p_delivery_address: 'Rua Portão, 271 - Vargas, Sapucaia do Sul - RS',
      p_recipient_name: 'Cliente Teste Admin',
      p_recipient_phone: '(51) 98888-1111',
      p_idempotency_key: idempotencyKey,
      p_order_value: 120.00,
      p_delivery_charge: 20.00,
      p_operation_source: 'owner_panel'
    });

    assert.ifError(error, 'Erro na chamada da RPC create_admin_tele');
    assert.equal(data.success, true, `RPC retornou erro: ${data?.message}`);
    createdAdminTeleId = data.tele_id;

    // Verificar no banco de dados public.teles
    const { data: teleRow } = await supabaseAdmin
      .from('teles')
      .select('id, total_order_amount, delivery_charge, pricing_rule_source')
      .eq('id', createdAdminTeleId)
      .single();

    assert.ok(teleRow, 'Registro da Tele não encontrado no banco');
    assert.equal(Number(teleRow.total_order_amount), 120.00, 'total_order_amount deve ser 120.00');
    assert.equal(Number(teleRow.delivery_charge), 20.00, 'delivery_charge deve ser 20.00 autoritativo');
    assert.equal(teleRow.pricing_rule_source, 'manual_entry', 'pricing_rule_source deve ser manual_entry');
  });

  test('2. CLIENTE: Criar Tele via RPC com Valor da Tele (R$ 18,50)', async () => {
    const idempotencyKey = `idemp-test-client-${Date.now()}`;
    const { data, error } = await adminClient.rpc('create_client_tele', {
      p_pickup_address: 'Av. Presidente Vargas, 1000 - Centro, Sapucaia do Sul - RS',
      p_delivery_address: 'Rua das Flores, 500 - Vargas, Sapucaia do Sul - RS',
      p_recipient_name: 'Cliente Teste Portal',
      p_recipient_phone: '(51) 97777-2222',
      p_idempotency_key: idempotencyKey,
      p_order_value: 50.00,
      p_delivery_charge: 18.50,
      p_operation_source: 'client_portal'
    });

    assert.ifError(error, 'Erro na chamada da RPC create_client_tele');
    assert.equal(data.success, true, `RPC retornou erro: ${data?.message}`);
    createdClientTeleId = data.tele_id;

    // Verificar no banco de dados public.teles
    const { data: teleRow } = await supabaseAdmin
      .from('teles')
      .select('id, total_order_amount, delivery_charge, pricing_rule_source')
      .eq('id', createdClientTeleId)
      .single();

    assert.ok(teleRow, 'Registro da Tele do cliente não encontrado no banco');
    assert.equal(Number(teleRow.delivery_charge), 18.50, 'delivery_charge do cliente deve ser exatamente 18.50');
    assert.equal(teleRow.pricing_rule_source, 'manual_entry', 'pricing_rule_source deve ser manual_entry');
  });

  test('3. PROTEÇÃO: Tentar criar Tele sem Valor da Tele (NULL, 0 ou Negativo) deve ser BLOQUEADO', async () => {
    // 3.1 Nulo
    const { data: dataNull } = await adminClient.rpc('create_admin_tele', {
      p_client_id: activeClientId,
      p_pickup_address: 'Av. Presidente Vargas, 1000',
      p_delivery_address: 'Rua Teste, 100',
      p_recipient_name: 'Sem Valor',
      p_recipient_phone: '(51) 99999-0000',
      p_idempotency_key: `idemp-block-null-${Date.now()}`,
      p_delivery_charge: null
    });

    assert.equal(dataNull.success, false, 'Deveria falhar se p_delivery_charge for null');
    assert.equal(dataNull.error_code, 'INVALID_DELIVERY_CHARGE');
    assert.equal(dataNull.message, 'Informe um valor válido para a Tele (maior que R$ 0,00).');

    // 3.2 Zero
    const { data: dataZero } = await adminClient.rpc('create_admin_tele', {
      p_client_id: activeClientId,
      p_pickup_address: 'Av. Presidente Vargas, 1000',
      p_delivery_address: 'Rua Teste, 100',
      p_recipient_name: 'Sem Valor Zero',
      p_recipient_phone: '(51) 99999-0000',
      p_idempotency_key: `idemp-block-zero-${Date.now()}`,
      p_delivery_charge: 0.00
    });

    assert.equal(dataZero.success, false, 'Deveria falhar se p_delivery_charge for 0');
    assert.equal(dataZero.error_code, 'INVALID_DELIVERY_CHARGE');

    // 3.3 Negativo
    const { data: dataNeg } = await adminClient.rpc('create_admin_tele', {
      p_client_id: activeClientId,
      p_pickup_address: 'Av. Presidente Vargas, 1000',
      p_delivery_address: 'Rua Teste, 100',
      p_recipient_name: 'Sem Valor Negativo',
      p_recipient_phone: '(51) 99999-0000',
      p_idempotency_key: `idemp-block-neg-${Date.now()}`,
      p_delivery_charge: -10.00
    });

    assert.equal(dataNeg.success, false, 'Deveria falhar se p_delivery_charge for negativo');
    assert.equal(dataNeg.error_code, 'INVALID_DELIVERY_CHARGE');
  });

  test('4. FINANCEIRO: Concluir Tele de R$ 20,00 e validar Split 85% Motoboy / 15% Empresa', async () => {
    assert.ok(createdAdminTeleId, 'Tele de teste Admin não criada');

    // Atribuir motoboy à Tele e colocar status em_rota
    const { data: currentTele, error: selectErr } = await supabaseAdmin
      .from('teles')
      .select('version')
      .eq('id', createdAdminTeleId)
      .single();

    assert.ifError(selectErr, 'Erro ao consultar versão da Tele');

    const { error: updateErr } = await supabaseAdmin
      .from('teles')
      .update({ motoboy_id: testMotoboyId, status: 'em_rota' })
      .eq('id', createdAdminTeleId);

    assert.ifError(updateErr, 'Erro ao atualizar motoboy na Tele');

    // Concluir a Tele via RPC complete_tele
    const { data: compResult, error: compErr } = await adminClient.rpc('complete_tele', {
      p_tele_id: createdAdminTeleId,
      p_expected_version: currentTele.version,
      p_completion_source: 'test_suite'
    });

    assert.ifError(compErr, `Erro RPC complete_tele: ${compErr?.message}`);
    assert.ok(compResult, 'compResult é nulo');
    console.log('compResult payload:', compResult);
    assert.equal(compResult.success, true, `Falha na conclusão da Tele: ${compResult?.message}`);

    // Validar os valores de retorno de complete_tele
    assert.equal(Number(compResult.rider_earning_amount), 17.00, 'Split do motoboy deve ser R$ 17,00 (85%)');
    assert.equal(Number(compResult.company_earning_amount), 3.00, 'Split da empresa deve ser R$ 3,00 (15%)');
    assert.equal(Number(compResult.rider_earning_amount + compResult.company_earning_amount), 20.00, 'Base financeira cobrada deve ser R$ 20,00 (Valor da Tele)');

    // Confirmar que o Valor do Pedido (R$ 120,00) NÃO alterou o split no ledger
    const { data: txRow } = await supabaseAdmin
      .from('rider_financial_transactions')
      .select('amount')
      .eq('tele_id', createdAdminTeleId)
      .eq('type', 'credito_entrega')
      .single();

    assert.ok(txRow, 'Lançamento de crédito do motoboy não encontrado no ledger');
    assert.equal(Number(txRow.amount), 17.00, 'Crédito do motoboy no ledger deve ser exatamente R$ 17,00');
  });
});
