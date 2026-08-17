import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, ADMIN_TEST_EMAIL, ADMIN_TEST_PASS } from './helpers/test-fixtures.mjs';

const supabaseUrl = LOCAL_SUPABASE_URL;
const supabaseSecretKey = LOCAL_SERVICE_ROLE_KEY;
const adminEmail = ADMIN_TEST_EMAIL;
const adminPassword = ADMIN_TEST_PASS;

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
    let { data: adminAuth, error: adminErr } = await supabaseAdmin.auth.signInWithPassword({
      email: adminEmail,
      password: adminPassword
    });
    
    if (adminErr) {
      const { data: users } = await supabaseAdmin.from('user_profiles').select('user_id').eq('email', adminEmail);
      if (users && users.length > 0) {
        await supabaseAdmin.auth.admin.updateUserById(users[0].user_id, { password: adminPassword, email_confirm: true });
        const retry = await supabaseAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
        adminAuth = retry.data;
        adminErr = retry.error;
      }
    }
    assert.ifError(adminErr, 'Falha ao autenticar Admin1');
    assert.ok(adminAuth.session?.access_token, 'Admin session token ausente');

    const adminUserId = adminAuth.user.id;

    adminClient = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${adminAuth.session.access_token}` } }
    });

    // 0.2 Selecionar e Configurar Cliente Comercial Ativo com Ponto de Coleta
    const { data: clients } = await supabaseAdmin
      .from('commercial_clients')
      .select('id, establishment_name')
      .eq('lifecycle_status', 'ativo')
      .limit(1);

    assert.ok(clients && clients.length > 0, 'Nenhum cliente comercial ativo encontrado');
    activeClientId = clients[0].id;

    await supabaseAdmin
      .from('commercial_clients')
      .update({
        address: 'Av. Presidente Vargas, 1000',
        city: 'Sapucaia do Sul',
        state: 'RS',
        pickup_latitude: -29.8247000,
        pickup_longitude: -51.1444000
      })
      .eq('id', activeClientId);

    // 0.3 Garantir Vínculo de client_users para o Usuário Autenticado via PG autoritativo
    const { default: pg } = await import('pg');
    const dbClient = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:54322/postgres' });
    await dbClient.connect();
    await dbClient.query(`INSERT INTO public.client_users (client_id, user_id, role, status) VALUES ($1, $2, 'admin', 'ativo') ON CONFLICT (client_id, user_id) DO UPDATE SET status = 'ativo';`, [activeClientId, adminUserId]);
    await dbClient.end();

    // 0.4 Selecionar Motoboy Canônico da Frota
    testMotoboyId = '7668596b-0444-4435-9f0c-8d0ad7ce7fb8';
    const { data: fleetRow } = await supabaseAdmin.from('fleet').select('id').eq('id', testMotoboyId);
    if (!fleetRow || fleetRow.length === 0) {
      await supabaseAdmin.from('fleet').insert({ id: testMotoboyId, name: 'Carlos Motoboy', phone: '51988887777', is_active: true });
    }
  });

  test('1. ADMIN: Criar Tele com Valor do Pedido (R$ 120,00) e Valor da Tele (R$ 20,00)', async () => {
    const idempotencyKey = `idemp-test-admin-${Date.now()}`;
    const { data, error } = await adminClient.rpc('create_admin_tele', {
      p_client_id: activeClientId,
      p_pickup_address: 'Av. Presidente Vargas, 1000',
      p_delivery_address: 'Rua Portão, 271 - Vargas, Sapucaia do Sul - RS',
      p_recipient_name: 'Cliente Teste Admin',
      p_recipient_phone: '(51) 98888-1111',
      p_idempotency_key: idempotencyKey,
      p_order_value: 120.00,
      p_delivery_charge: 20.00,
      p_operation_source: 'owner_panel',
      p_pickup_latitude: -29.8247000,
      p_pickup_longitude: -51.1444000
    });

    assert.ifError(error, 'Erro na chamada da RPC create_admin_tele');
    assert.equal(data.success, true, `RPC retornou erro: ${data?.message}`);
    createdAdminTeleId = data.tele_id;

    // Verificar no banco de dados public.teles
    const { data: teleRow } = await supabaseAdmin
      .from('teles')
      .select('*')
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
      p_pickup_address: 'Av. Presidente Vargas, 1000',
      p_delivery_address: 'Rua das Flores, 500 - Vargas, Sapucaia do Sul - RS',
      p_recipient_name: 'Cliente Teste Portal',
      p_recipient_phone: '(51) 97777-2222',
      p_idempotency_key: idempotencyKey,
      p_order_value: 50.00,
      p_delivery_charge: 18.50,
      p_operation_source: 'client_portal',
      p_pickup_latitude: -29.8247000,
      p_pickup_longitude: -51.1444000
    });

    assert.ifError(error, 'Erro na chamada da RPC create_client_tele');
    assert.equal(data.success, true, `RPC retornou erro: ${data?.message}`);
    createdClientTeleId = data.tele_id;
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

    const { data: currentTele, error: selectErr } = await supabaseAdmin
      .from('teles')
      .select('version')
      .eq('id', createdAdminTeleId)
      .single();

    assert.ifError(selectErr, 'Erro ao consultar versão da Tele');

    const motoboyId = '7668596b-0444-4435-9f0c-8d0ad7ce7fb8';
    const { error: updateErr } = await supabaseAdmin
      .from('teles')
      .update({ motoboy_id: motoboyId, status: 'em_rota' })
      .eq('id', createdAdminTeleId);

    assert.ifError(updateErr, 'Erro ao atualizar motoboy na Tele');

    const { data: compResult, error: compErr } = await adminClient.rpc('complete_tele', {
      p_tele_id: createdAdminTeleId,
      p_expected_version: currentTele.version,
      p_completion_source: 'test_suite'
    });

    assert.ifError(compErr, `Erro RPC complete_tele: ${compErr?.message}`);
    assert.ok(compResult, 'compResult é nulo');
    assert.equal(compResult.success, true, `Falha na conclusão da Tele: ${compResult?.message}`);

    const riderEarning = compResult.valor_motoboy !== undefined ? compResult.valor_motoboy : compResult.rider_earning_amount;
    const companyEarning = compResult.taxa_empresa !== undefined ? compResult.taxa_empresa : compResult.company_earning_amount;

    assert.equal(Number(riderEarning), 17.00, 'Split do motoboy deve ser R$ 17,00 (85%)');
    assert.equal(Number(companyEarning), 3.00, 'Split da empresa deve ser R$ 3,00 (15%)');

    const { data: txList } = await supabaseAdmin
      .from('rider_financial_transactions')
      .select('*')
      .eq('tele_id', createdAdminTeleId);

    const txRow = txList && txList.length > 0 ? txList[0] : null;
    assert.ok(txRow, 'Lançamento de crédito do motoboy não encontrado no ledger');
    assert.equal(Number(txRow.amount), 17.00, 'Crédito do motoboy no ledger deve ser exatamente R$ 17,00');
  });
});
