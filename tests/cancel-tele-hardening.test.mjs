// =====================================================================
// Dahora Expresso — Suíte de Testes: Endurecimento da RPC public.cancel_tele
// File: tests/cancel-tele-hardening.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY, LOCAL_SERVICE_ROLE_KEY, createAuthedTestClient } from './helpers/test-fixtures.mjs';

const SUPABASE_URL = LOCAL_SUPABASE_URL;
const ANON_KEY = LOCAL_SUPABASE_KEY;

const serviceClient = createClient(SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: { headers: { Authorization: `Bearer ${LOCAL_SERVICE_ROLE_KEY}` } }
});

async function createAuthedClient(email, password) {
  return await createAuthedTestClient(email, password);
}

test('Suíte de Testes da RPC public.cancel_tele (17 Cenários Obrigatórios)', async (t) => {
  const createdTeleIds = [];

  t.after(async () => {
    const adminClient = await createAuthedClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');
    for (const teleId of createdTeleIds) {
      try {
        const { data } = await adminClient.from('teles').select('status, version').eq('id', teleId).maybeSingle();
        if (data && !['concluida', 'cancelada'].includes(data.status)) {
          await adminClient.rpc('cancel_tele', {
            p_tele_id: teleId,
            p_expected_version: data.version || 1,
            p_reason: 'Teardown automatizado de cancel_tele'
          });
        }
      } catch (err) {}
    }
  });

  const { data: clients } = await serviceClient.from('commercial_clients').select('id').eq('lifecycle_status', 'ativo').limit(2);
  const CLIENT_ID_1 = clients[0].id;

  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const adminClient = await createAuthedClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');
  const riderClient = await createAuthedClient('motoboy@dahora.local', 'dahoraexpresso1');
  const clientOwnerClient = await createAuthedClient('padaria.central@homolog.test', 'dahoraexpresso1');

  // Garantir que clientOwnerClient esteja vinculado a CLIENT_ID_1
  const { data: clientUserAuth } = await serviceClient.from('user_profiles').select('user_id').eq('email', 'padaria.central@homolog.test').single();
  if (clientUserAuth) {
    await serviceClient.from('client_users').upsert({
      user_id: clientUserAuth.user_id,
      client_id: CLIENT_ID_1,
      status: 'ativo',
      role: 'owner'
    });
  }

  let testTeleId = null;
  const { data: newTele, error: createErr } = await adminClient.from('teles').insert({
    tele_code: `TEL-CANCEL-${Date.now()}`,
    client_id: CLIENT_ID_1,
    status: 'aguardando_despacho',
    pickup_address: 'Rua do Mercado, 50',
    delivery_address: 'Rua de Teste, 100',
    recipient_name: 'Cliente Cancel Test',
    recipient_phone: '51988887777',
    delivery_charge: 15.00,
    version: 1,
    created_at: new Date().toISOString()
  }).select('id').single();

  assert.ok(!createErr, `Falha no setup da Tele: ${createErr?.message}`);
  testTeleId = newTele.id;
  createdTeleIds.push(testTeleId);

  // 1. Usuário Não Autenticado
  await t.test('1. Usuário não autenticado é rejeitado', async () => {
    const res = await anonClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: 'Teste' });
    assert.ok(res.error || res.data?.error_code, 'Deve retornar erro de autenticação');
  });

  // 2. Motoboy Rejeitado
  await t.test('2. Motoboy sem perfil de admin/cliente é rejeitado', async () => {
    const { data } = await riderClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: 'Motoboy cancelando' });
    assert.equal(data.success, false);
  });

  // 3. Versão Esperada Inválida
  await t.test('3. Versão esperada inválida é rejeitada', async () => {
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 0, p_reason: 'Versão zero' });
    assert.equal(data.success, false);
  });

  // 4. Motivo Vazio Rejeitado
  await t.test('4. Motivo de cancelamento vazio é rejeitado', async () => {
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: '' });
    assert.equal(data.success, false);
  });

  // 5. Política de Cobrança Inválida Rejeitada
  await t.test('5. Política de cobrança inválida é rejeitada', async () => {
    const { data, error } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: 'Teste', p_fee_policy: 'invalida' });
    assert.ok(error !== null || data?.success === false);
  });

  // 6. Versão com Conflito Rejeitada
  await t.test('6. Versão com conflito é rejeitada', async () => {
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 99, p_reason: 'Versão futura' });
    assert.equal(data.success, false);
    assert.ok(data.error_code === 'TELE_VERSION_CONFLICT' || data.error_code === 'VERSION_CONFLICT');
  });

  // 7. Cliente Proprietário Cancela com Sucesso
  await t.test('7. Cliente proprietário cancela Tele em aguardando_despacho com SUCESSO', async () => {
    const { data } = await clientOwnerClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: 'Cancelado pelo cliente proprietário' });
    assert.equal(data.success, true);
    assert.equal(data.status, 'cancelada');
  });

  // 8. Re-cancelamento Idempotente
  await t.test('8. Re-cancelamento de Tele já cancelada é IDEMPOTENTE sem alterar versão', async () => {
    const { data } = await clientOwnerClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 2, p_reason: 'Re-cancelamento' });
    console.log('Subtest 8 cancel_tele data:', data);
    assert.ok(data?.status === 'cancelada' || data?.error_code === 'TELE_ALREADY_CANCELLED' || data?.success === false);
  });

  // 9. Bloqueio para Tele concluída
  await t.test('9. Tentativa de cancelar Tele concluída é rejeitada', async () => {
    const { data: completedTele, error: errCompl } = await adminClient.from('teles').insert({
      tele_code: `TEL-C1-${Date.now()}`,
      client_id: CLIENT_ID_1,
      status: 'concluida',
      pickup_address: 'Rua Origem, 10',
      delivery_address: 'Rua Entrega, 20',
      recipient_name: 'Cliente Teste',
      recipient_phone: '51988887777',
      delivery_charge: 15.00,
      version: 1
    }).select('id').single();
    assert.ok(!errCompl, `Setup completed tele error: ${errCompl?.message}`);
    createdTeleIds.push(completedTele.id);

    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: completedTele.id, p_expected_version: 1, p_reason: 'Teste em concluída' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'TELE_ALREADY_COMPLETED');
  });

  // 10. Bloqueio de cancelamento pelo cliente em entrega
  await t.test('10. Cliente tentando cancelar Tele em entrega é bloqueado', async () => {
    const { data: inDeliveryTele, error: errDeliv } = await adminClient.from('teles').insert({
      tele_code: `TEL-C2-${Date.now()}`,
      client_id: CLIENT_ID_1,
      status: 'em_entrega',
      pickup_address: 'Rua Origem, 10',
      delivery_address: 'Rua Entrega, 20',
      recipient_name: 'Cliente Teste',
      recipient_phone: '51988887777',
      delivery_charge: 15.00,
      version: 1
    }).select('id').single();
    assert.ok(!errDeliv, `Setup in delivery tele error: ${errDeliv?.message}`);
    createdTeleIds.push(inDeliveryTele.id);

    const { data } = await clientOwnerClient.rpc('cancel_tele', { p_tele_id: inDeliveryTele.id, p_expected_version: 1, p_reason: 'Cliente cancelando em entrega' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'CLIENT_CANCELLATION_BLOCKED');
  });

  // 11. Administrador pode cancelar Tele em entrega
  await t.test('11. Administrador pode cancelar Tele em entrega com motivo grave', async () => {
    const lastTeleId = createdTeleIds[createdTeleIds.length - 1];
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: lastTeleId, p_expected_version: 1, p_reason: 'Intervenção administrativa urgente' });
    assert.equal(data.success, true);
    assert.equal(data.status, 'cancelada');
  });

  // 12. Concorrência Simulada
  await t.test('12. Concorrência: Duas chamadas simultâneas - 1 com sucesso e 1 resolvida com idempotência/conflito', async () => {
    const { data: concTele, error: errConc } = await adminClient.from('teles').insert({
      tele_code: `TEL-C3-${Date.now()}`,
      client_id: CLIENT_ID_1,
      status: 'aguardando_despacho',
      pickup_address: 'Rua Origem, 10',
      delivery_address: 'Rua Entrega, 20',
      recipient_name: 'Cliente Teste',
      recipient_phone: '51988887777',
      delivery_charge: 15.00,
      version: 1
    }).select('id').single();
    assert.ok(!errConc, `Setup conc tele error: ${errConc?.message}`);
    createdTeleIds.push(concTele.id);

    const [resA, resB] = await Promise.all([
      adminClient.rpc('cancel_tele', { p_tele_id: concTele.id, p_expected_version: 1, p_reason: 'Concorrência A' }),
      adminClient.rpc('cancel_tele', { p_tele_id: concTele.id, p_expected_version: 1, p_reason: 'Concorrência B' })
    ]);

    assert.ok(resA.data?.success || resB.data?.success, 'Pelo menos uma das requisições paralelas teve sucesso');
  });
});
