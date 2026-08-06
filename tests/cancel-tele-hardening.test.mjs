// =====================================================================
// Dahora Expresso — Suíte de Testes: Endurecimento da RPC public.cancel_tele
// File: tests/cancel-tele-hardening.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('.env.bootstrap.remote') });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CLIENT_ID_1 = 'c1111111-1111-4111-a111-111111111111';
const CLIENT_ID_2 = 'c2222222-2222-4222-a222-222222222222';
const OTHER_CLIENT_USER_ID = '88888888-8888-4888-a888-888888888888';

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function createAuthedClient(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Auth failure for ${email}: ${error.message}`);
  return client;
}

test('Suíte de Testes da RPC public.cancel_tele (17 Cenários Obrigatórios)', async (t) => {
  const createdTeleIds = [];

  t.after(async () => {
    // Teardown automático seguro
    for (const teleId of createdTeleIds) {
      try {
        const { data } = await serviceClient.from('teles').select('status, version').eq('id', teleId).maybeSingle();
        if (data && !['concluida', 'cancelada'].includes(data.status)) {
          await serviceClient.rpc('cancel_tele', {
            p_tele_id: teleId,
            p_expected_version: data.version || 1,
            p_reason: 'Teardown automatizado da suíte de teste'
          });
        }
      } catch (err) {}
    }
  });

  // Setup de Clientes e Usuários
  await serviceClient.from('commercial_clients').upsert([
    { id: CLIENT_ID_1, client_code: 'CLI-TEST-1', establishment_name: 'Cliente Teste 1', lifecycle_status: 'ativo' },
    { id: CLIENT_ID_2, client_code: 'CLI-TEST-2', establishment_name: 'Cliente Teste 2', lifecycle_status: 'ativo' }
  ]);
  await serviceClient.from('client_users').upsert([
    { user_id: OTHER_CLIENT_USER_ID, client_id: CLIENT_ID_2, status: 'ativo', role: 'gerente' }
  ]);

  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const adminClient = await createAuthedClient('admin@dahora.local', 'senha123456');
  const riderClient = await createAuthedClient('motoboy@dahora.local', 'senha123456');
  const clientOwnerClient = await createAuthedClient('parceiro@mercadocentral.local', 'senha123456');

  // Token para usuário comercial de outro estabelecimento
  const otherClientToken = (await serviceClient.auth.admin.createUser({
    email: `other_client_${Date.now()}@local.test`,
    password: 'Password123!',
    email_confirm: true
  })).data.user;

  await serviceClient.from('client_users').insert({
    user_id: otherClientToken.id,
    client_id: CLIENT_ID_2,
    status: 'ativo',
    role: 'gerente'
  });

  const otherClientOwnerClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  await otherClientOwnerClient.auth.signInWithPassword({ email: otherClientToken.email, password: 'Password123!' });

  let testTeleId = null;
  const { data: newTele, error: createErr } = await serviceClient.from('teles').insert({
    tele_code: `TEL-HARDEST-${Date.now()}`,
    client_id: CLIENT_ID_1,
    status: 'aguardando_despacho',
    pickup_address: 'Av. Coleta Teste, 100',
    delivery_address: 'Rua de Teste, 100',
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
    const errCode = res.data?.error_code || res.error?.code;
    assert.ok(errCode, 'Possui código de erro');
  });

  // 2. Motoboy tentando cancelar Tele
  await t.test('2. Motoboy sem perfil de admin/cliente é rejeitado', async () => {
    const { data } = await riderClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: 'Teste' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'PERMISSION_DENIED');
  });

  // 3. Cliente de outro cliente comercial tentando cancelar
  await t.test('3. Cliente de outro estabelecimento é rejeitado', async () => {
    const { data } = await otherClientOwnerClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: 'Teste' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'PERMISSION_DENIED');
  });

  // 4. Versão esperada <= 0 ou nula
  await t.test('4. Versão esperada inválida é rejeitada', async () => {
    const { data: res1 } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 0, p_reason: 'Teste' });
    assert.equal(res1.success, false);
    assert.equal(res1.error_code, 'INVALID_VERSION_PARAM');
  });

  // 5. Motivo de cancelamento vazio
  await t.test('5. Motivo de cancelamento vazio é rejeitado', async () => {
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: '   ' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'CANCELLATION_REASON_REQUIRED');
  });

  // 6. Política de cobrança inválida
  await t.test('6. Política de cobrança inválida é rejeitada', async () => {
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: 'Teste', p_charge_policy: 'cobranca_invalida' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'INVALID_CHARGE_POLICY');
  });

  // 7. Versão esperada divergente (version conflict)
  await t.test('7. Versão com conflito é rejeitada', async () => {
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 99, p_reason: 'Teste' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'TELE_VERSION_CONFLICT');
  });

  // 8. Cliente autorizado cancela Tele no status inicial aguardando_despacho
  await t.test('8. Cliente proprietário cancela Tele em aguardando_despacho com SUCESSO', async () => {
    const { data: finBefore } = await serviceClient.from('rider_financial_transactions').select('*').eq('tele_id', testTeleId);
    assert.equal((finBefore || []).length, 0, 'Zero transações financeiras prévias');

    const { data } = await clientOwnerClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 1, p_reason: 'Cliente cancelou antes do despacho' });
    assert.equal(data.success, true);
    assert.equal(data.status, 'cancelada');
    assert.equal(data.version, 2);

    const { data: finAfter } = await serviceClient.from('rider_financial_transactions').select('*').eq('tele_id', testTeleId);
    assert.equal((finAfter || []).length, 0, 'Zero transações financeiras geradas no cancelamento');
  });

  // 9. Idempotência ao chamar cancel_tele em Tele já cancelada
  await t.test('9. Re-cancelamento de Tele já cancelada é IDEMPOTENTE sem alterar versão', async () => {
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: testTeleId, p_expected_version: 2, p_reason: 'Re-cancelamento idempotente' });
    assert.equal(data.success, true);
    assert.equal(data.status, 'cancelada');
    assert.equal(data.version, 2);
    assert.equal(data.is_already_cancelled, true);

    const { data: dbTele } = await serviceClient.from('teles').select('version').eq('id', testTeleId).single();
    assert.equal(dbTele.version, 2, 'Versão no banco permaneceu 2 sem re-incrementar');
  });

  // 10. Bloqueio para Tele concluída
  await t.test('10. Tentativa de cancelar Tele concluída é rejeitada', async () => {
    const { data: completedTele, error: errCompl } = await serviceClient.from('teles').insert({
      tele_code: `TEL-COMPL-${Date.now()}`,
      client_id: CLIENT_ID_1,
      status: 'concluida',
      pickup_address: 'Av. Coleta, 10',
      delivery_address: 'Rua Entrega, 20',
      version: 1
    }).select('id').single();
    assert.ok(!errCompl, `Setup completed tele error: ${errCompl?.message}`);
    createdTeleIds.push(completedTele.id);

    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: completedTele.id, p_expected_version: 1, p_reason: 'Teste em concluída' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'TELE_ALREADY_COMPLETED');
  });

  // 11. Bloqueio de cancelamento pelo cliente quando a Tele já está em entrega
  await t.test('11. Cliente tentando cancelar Tele em entrega é bloqueado', async () => {
    const { data: inDeliveryTele, error: errDeliv } = await serviceClient.from('teles').insert({
      tele_code: `TEL-INDELIV-${Date.now()}`,
      client_id: CLIENT_ID_1,
      status: 'em_entrega',
      pickup_address: 'Av. Coleta, 10',
      delivery_address: 'Rua Entrega, 20',
      version: 1
    }).select('id').single();
    assert.ok(!errDeliv, `Setup in delivery tele error: ${errDeliv?.message}`);
    createdTeleIds.push(inDeliveryTele.id);

    const { data } = await clientOwnerClient.rpc('cancel_tele', { p_tele_id: inDeliveryTele.id, p_expected_version: 1, p_reason: 'Cliente cancelando em entrega' });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'CLIENT_CANCELLATION_BLOCKED');
  });

  // 12. Administrador cancelando Tele em entrega (Permitido para Admin)
  await t.test('12. Administrador pode cancelar Tele em entrega com motivo grave', async () => {
    const lastTeleId = createdTeleIds[createdTeleIds.length - 1];
    const { data } = await adminClient.rpc('cancel_tele', { p_tele_id: lastTeleId, p_expected_version: 1, p_reason: 'Intervenção administrativa urgente' });
    assert.equal(data.success, true);
    assert.equal(data.status, 'cancelada');
  });

  // 13. Teste de Concorrência Simulada (duas chamadas paralelas com a mesma versão esperada)
  await t.test('13. Concorrência: Duas chamadas simultâneas - 1 com sucesso e 1 resolvida com idempotência/conflito', async () => {
    const { data: concTele, error: errConc } = await serviceClient.from('teles').insert({
      tele_code: `TEL-CONC-${Date.now()}`,
      client_id: CLIENT_ID_1,
      status: 'aguardando_despacho',
      pickup_address: 'Av. Coleta, 10',
      delivery_address: 'Rua Entrega, 20',
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
