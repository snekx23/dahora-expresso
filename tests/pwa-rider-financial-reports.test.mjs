// =====================================================================
// Dahora Expresso — Suíte de Testes Node.js: Relatórios e Ganhos do Motoboy
// File: tests/pwa-rider-financial-reports.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('.env.bootstrap.remote') });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

test('Suíte de Integração: Relatórios e Extrato Financeiro do Motoboy', async (t) => {
  const testMotoboyEmail = `test_rider_fin_${Date.now()}@dahora.local`;
  const testPassword = 'Password123!';
  let riderUserId = null;
  let riderFleetId = null;
  let riderAuthClient = null;

  t.after(async () => {
    if (riderFleetId) {
      await serviceClient.from('rider_financial_transactions').delete().eq('rider_id', riderFleetId);
      await serviceClient.from('rider_consumable_purchases').delete().eq('motoboy_id', riderFleetId);
      await serviceClient.from('rider_credits_ledger').delete().eq('motoboy_id', riderFleetId);
      await serviceClient.from('fleet').delete().eq('id', riderFleetId);
    }
    if (riderUserId) {
      await serviceClient.auth.admin.deleteUser(riderUserId);
    }
  });

  await t.test('1. Setup de Usuário Motoboy de Teste com Perfil em Fleet', async () => {
    const { data: authData, error: authErr } = await serviceClient.auth.admin.createUser({
      email: testMotoboyEmail,
      password: testPassword,
      email_confirm: true
    });
    assert.ifError(authErr);
    riderUserId = authData.user.id;

    await serviceClient.from('user_profiles').upsert({
      user_id: riderUserId,
      role: 'motoboy',
      full_name: 'Motoboy Teste Financeiro'
    });

    const { data: fleetData, error: fleetErr } = await serviceClient.from('fleet').insert({
      user_id: riderUserId,
      name: 'Motoboy Teste Financeiro',
      motoboy_code: `MB-FIN-${Date.now().toString().slice(-4)}`,
      status: 'Disponível'
    }).select().single();

    assert.ifError(fleetErr);
    riderFleetId = fleetData.id;

    const tempAnonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: loginData, error: loginErr } = await tempAnonClient.auth.signInWithPassword({
      email: testMotoboyEmail,
      password: testPassword
    });
    assert.ifError(loginErr);

    riderAuthClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: { Authorization: `Bearer ${loginData.session.access_token}` }
      },
      auth: { persistSession: false }
    });
  });

  await t.test('2. anon não possui acesso às RPCs financeiras (Retorna AUTHENTICATION_REQUIRED)', async () => {
    const unauthClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

    const { data: sumData, error: sumErr } = await unauthClient.rpc('get_my_rider_financial_summary', {
      p_start_date: null,
      p_end_date: null
    });
    const { data: stmtData, error: stmtErr } = await unauthClient.rpc('get_my_rider_financial_statement', {
      p_start_date: null,
      p_end_date: null,
      p_limit: 30,
      p_offset: 0
    });

    const isSumBlocked = Boolean(sumErr) || (sumData && sumData.success === false && sumData.error_code === 'AUTHENTICATION_REQUIRED');
    const isStmtBlocked = Boolean(stmtErr) || (stmtData && stmtData.success === false && stmtData.error_code === 'AUTHENTICATION_REQUIRED');

    assert.ok(isSumBlocked, `Summary RPC deve exigir autenticação. err: ${JSON.stringify(sumErr)}, data: ${JSON.stringify(sumData)}`);
    assert.ok(isStmtBlocked, `Statement RPC deve exigir autenticação. err: ${JSON.stringify(stmtErr)}, data: ${JSON.stringify(stmtData)}`);
  });

  await t.test('3. Motoboy sem dados iniciais recebe resumo zerado', async () => {
    const { data, error } = await riderAuthClient.rpc('get_my_rider_financial_summary', {
      p_start_date: null,
      p_end_date: null
    });
    assert.ifError(error);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.completed_deliveries_count, 0);
    assert.strictEqual(Number(data.gross_total), 0);
    assert.strictEqual(Number(data.deductions_total), 0);
    assert.strictEqual(Number(data.net_total), 0);
  });

  await t.test('4. Inserção de lançamentos e triggers de sincronização em rider_financial_transactions', async () => {
    const { data: tele1, error: teleErr } = await serviceClient.from('teles').insert({
      status: 'concluida',
      delivery_charge: 20.00,
      tele_code: `T-FIN-${Date.now().toString().slice(-4)}`,
      version: 1,
      pickup_address: 'Rua da Coleta 100',
      delivery_address: 'Rua da Entrega 200'
    }).select().single();

    assert.ifError(teleErr);
    assert.ok(tele1 && tele1.id);

    const { error: txErr } = await serviceClient.from('rider_financial_transactions').insert({
      rider_id: riderFleetId,
      tele_id: tele1.id,
      type: 'credito_entrega',
      direction: 'credit',
      amount: 16.00,
      description: `Ganhos da Tele ${tele1.tele_code}`,
      idempotency_key: `test:tele:${tele1.id}:v1`
    });
    assert.ifError(txErr);

    const { error: consErr } = await serviceClient.from('rider_consumable_purchases').insert({
      motoboy_id: riderFleetId,
      item_name: 'Óleo de Motor 20W50',
      quantidade: 1,
      valor_unitario: 35.00,
      amount: 35.00
    });
    assert.ifError(consErr);

    const { error: credErr } = await serviceClient.from('rider_credits_ledger').insert({
      motoboy_id: riderFleetId,
      amount: 25.00,
      description: 'Bônus Meta Semanal'
    });
    assert.ifError(credErr);
  });

  await t.test('5. Validação de cálculos consolidados em get_my_rider_financial_summary', async () => {
    const { data, error } = await riderAuthClient.rpc('get_my_rider_financial_summary', {
      p_start_date: null,
      p_end_date: null
    });
    assert.ifError(error);
    assert.strictEqual(data.success, true);

    assert.strictEqual(Number(data.delivery_earnings), 16.00);
    assert.strictEqual(Number(data.credits_total), 25.00);
    assert.strictEqual(Number(data.consumables_total), 35.00);
    assert.strictEqual(Number(data.gross_total), 41.00);
    assert.strictEqual(Number(data.deductions_total), 35.00);
    assert.strictEqual(Number(data.net_total), 6.00);
  });

  await t.test('6. Validação do extrato paginado e ocultação de idempotency_key', async () => {
    const { data, error } = await riderAuthClient.rpc('get_my_rider_financial_statement', {
      p_start_date: null,
      p_end_date: null,
      p_limit: 10,
      p_offset: 0
    });
    assert.ifError(error);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.total_count, 3);
    assert.strictEqual(data.items.length, 3);

    data.items.forEach(item => {
      assert.strictEqual(item.idempotency_key, undefined, 'idempotency_key não deve ser exposto na API pública!');
      assert.ok(item.transaction_id);
      assert.ok(item.direction);
      assert.ok(item.amount);
    });
  });

  await t.test('7. Validação da limitação de período máximo (366 dias)', async () => {
    const { data, error } = await riderAuthClient.rpc('get_my_rider_financial_summary', {
      p_start_date: '2024-01-01',
      p_end_date: '2025-06-01'
    });
    assert.ifError(error);
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.error_code, 'MAX_PERIOD_EXCEEDED');
  });

  await t.test('8. Isolamento RLS — Outro motoboy não acessa lançamentos do Motoboy Teste', async () => {
    const otherEmail = `other_rider_${Date.now()}@dahora.local`;
    const { data: oAuth } = await serviceClient.auth.admin.createUser({
      email: otherEmail,
      password: testPassword,
      email_confirm: true
    });

    const { data: oFleet } = await serviceClient.from('fleet').insert({
      user_id: oAuth.user.id,
      name: 'Outro Motoboy',
      motoboy_code: `MB-OTHER-${Date.now().toString().slice(-4)}`
    }).select().single();

    const tempAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: oLogin } = await tempAnon.auth.signInWithPassword({
      email: otherEmail,
      password: testPassword
    });

    const otherAuthClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${oLogin.session.access_token}` } },
      auth: { persistSession: false }
    });

    const { data: oSummary } = await otherAuthClient.rpc('get_my_rider_financial_summary', {
      p_start_date: null,
      p_end_date: null
    });
    assert.strictEqual(oSummary.success, true);
    assert.strictEqual(Number(oSummary.net_total), 0, 'Outro motoboy deve receber 0.00 pois seus lançamentos são isolados!');

    await serviceClient.from('fleet').delete().eq('id', oFleet.id);
    await serviceClient.auth.admin.deleteUser(oAuth.user.id);
  });
});
