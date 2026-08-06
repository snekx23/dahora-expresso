// =====================================================================
// Dahora Expresso — Suíte de Testes Exaustiva e Completa da Fase 3A (Backend Foundation)
// File: tests/financial-phase3a-comprehensive.test.mjs
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

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function createAuthedClient(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Auth failure for ${email}: ${error.message}`);
  return client;
}

test('Suíte de Testes Exaustiva da Fase 3A (Fundação Backend & Fundação Financeira)', async (t) => {
  let adminClient;
  let clientUserClient;
  let riderFleetId;
  const createdTeleIds = [];

  adminClient = await createAuthedClient('admin@dahora.local', 'senha123456');
  clientUserClient = await createAuthedClient('parceiro@mercadocentral.local', 'senha123456');

  const { data: rider } = await serviceClient.from('fleet').select('id, user_id, name').limit(1).single();
  riderFleetId = rider.id;

  await serviceClient.from('commercial_clients').update({ rider_percentage: 85.00 }).eq('id', CLIENT_ID_1);

  // Limpeza inicial
  await serviceClient.from('rider_credits_ledger').delete().eq('motoboy_id', riderFleetId);
  await serviceClient.from('rider_payment_batch_items').delete().filter('batch_id', 'in', serviceClient.from('rider_payment_batches').select('id').eq('rider_id', riderFleetId));
  await serviceClient.from('rider_payment_batches').delete().eq('rider_id', riderFleetId);
  await serviceClient.from('rider_weekly_settlement_items').delete().filter('settlement_id', 'in', serviceClient.from('rider_weekly_settlements').select('id').eq('rider_id', riderFleetId));
  await serviceClient.from('rider_weekly_settlements').delete().eq('rider_id', riderFleetId);

  t.after(async () => {
    for (const teleId of createdTeleIds) {
      try {
        await serviceClient.from('rider_weekly_settlement_items').delete().eq('tele_id', teleId);
        await serviceClient.from('rider_financial_transactions').delete().eq('tele_id', teleId);
        await serviceClient.from('company_financial_transactions').delete().eq('tele_id', teleId);
        await serviceClient.from('client_payment_allocations').delete().eq('tele_id', teleId);
        await serviceClient.from('teles').delete().eq('id', teleId);
      } catch (err) {}
    }
  });

  // ===================================================================
  // A. PRIVILÉGIOS E RLS
  // ===================================================================
  await t.test('A1. Privilégios: INSERT direto por cliente Supabase é BLOQUEADO', async () => {
    const { error: insErr } = await adminClient.from('rider_weekly_settlements').insert({
      rider_id: riderFleetId,
      period_start: '2026-10-01T00:00:00.000Z',
      period_end: '2026-10-08T00:00:00.000Z'
    });
    assert.ok(insErr);
    assert.equal(insErr.code, '42501');
  });

  await t.test('A2. Privilégios: UPDATE direto por cliente Supabase é BLOQUEADO', async () => {
    const { error: updErr } = await adminClient.from('rider_weekly_settlements').update({ status: 'paid' }).eq('rider_id', riderFleetId);
    assert.ok(updErr);
    assert.equal(updErr.code, '42501');
  });

  await t.test('A3. Privilégios: DELETE direto por cliente Supabase é BLOQUEADO', async () => {
    const { error: delErr } = await adminClient.from('rider_payment_batches').delete().eq('rider_id', riderFleetId);
    assert.ok(delErr);
    assert.equal(delErr.code, '42501');
  });

  await t.test('A4. RLS: Cliente comercial chamando RPCs administrativas recebe PERMISSION_DENIED', async () => {
    const { data: denyRes } = await clientUserClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: '2026-10-01T00:00:00.000Z',
      p_period_end: '2026-10-08T00:00:00.000Z'
    });
    assert.equal(denyRes.success, false);
    assert.equal(denyRes.error_code, 'PERMISSION_DENIED');
  });

  await t.test('A5. Consulta Sanitizada por RPC para Admin Autorizado', async () => {
    const pStart = '2026-08-17T00:00:00.000Z';
    const pEnd = '2026-08-24T00:00:00.000Z';

    const { data: calcRes } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: pStart,
      p_period_end: pEnd
    });

    const stlId = calcRes.settlement_id;
    const { data: adminStl } = await adminClient.rpc('get_admin_rider_weekly_settlement', { p_settlement_id: stlId });
    assert.equal(adminStl.success, true);
    assert.equal(adminStl.settlement.id, stlId);
  });

  // ===================================================================
  // B. DUPLO PAGAMENTO & CAP POR ELIGIBLE_AMOUNT (TETO ELEGÍVEL LIBERADO)
  // ===================================================================
  await t.test('B1. Rejeição de pagamento superior ao valor elegível liberado (Original R$ 100, Elegível R$ 60, Bloqueado R$ 40)', async () => {
    const { data: stl } = await serviceClient.from('rider_weekly_settlements').select('id').eq('rider_id', riderFleetId).order('created_at', { ascending: false }).limit(1).single();

    const { data: testItem } = await serviceClient.from('rider_weekly_settlement_items').insert({
      settlement_id: stl.id,
      source_type: 'positive_adjustment',
      source_id: 'b1111111-1111-4111-a111-111111111111',
      original_amount: 100.00,
      eligible_amount: 60.00,
      blocked_amount: 40.00,
      direction: 'credit',
      funding_status: 'eligible',
      occurred_at: new Date().toISOString(),
      description: 'Item parcialmente liberado de R$ 60,00'
    }).select('*').single();

    const { data: b1 } = await serviceClient.from('rider_payment_batches').insert({
      rider_id: riderFleetId,
      settlement_id: stl.id,
      total_paid_amount: 100.00,
      status: 'pending'
    }).select('*').single();

    const { error: dbCapErr } = await serviceClient.from('rider_payment_batch_items').insert({
      batch_id: b1.id,
      settlement_item_id: testItem.id,
      amount_paid: 100.00
    });

    assert.ok(dbCapErr, 'Inserção de R$ 100 em item com apenas R$ 60 elegíveis deve ser BLOQUEADA pelo trigger');
    assert.ok(dbCapErr.message.includes('DUPLICATE_PAYMENT_DENIED'), 'Mensagem de exceção deve indicar rejeição por teto elegível');
  });

  await t.test('B2. Pagamento de R$ 60 no item parcialmente liberado é ACEITO com sucesso', async () => {
    const { data: stl } = await serviceClient.from('rider_weekly_settlements').select('id').eq('rider_id', riderFleetId).order('created_at', { ascending: false }).limit(1).single();
    const { data: testItem } = await serviceClient.from('rider_weekly_settlement_items').select('*').eq('source_id', 'b1111111-1111-4111-a111-111111111111').single();

    const { data: bValid } = await serviceClient.from('rider_payment_batches').insert({
      rider_id: riderFleetId,
      settlement_id: stl.id,
      total_paid_amount: 60.00,
      status: 'pending'
    }).select('*').single();

    const { error: dbValidErr } = await serviceClient.from('rider_payment_batch_items').insert({
      batch_id: bValid.id,
      settlement_item_id: testItem.id,
      amount_paid: 60.00
    });

    assert.ok(!dbValidErr, 'Pagamento do montante exatamente elegível (R$ 60,00) deve ser aceito');
  });

  await t.test('B3. Lote com idempotency_key repetida retorna resposta idempotente sem duplicar lote', async () => {
    const pStartIdem = '2026-11-02T00:00:00.000Z';
    const pEndIdem = '2026-11-09T00:00:00.000Z';

    const { data: calcRes } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: pStartIdem,
      p_period_end: pEndIdem
    });

    const stlId = calcRes.settlement_id;

    await serviceClient.from('rider_weekly_settlement_items').insert({
      settlement_id: stlId,
      source_type: 'credit',
      source_id: 'c1111111-2222-4333-a444-555555555555',
      original_amount: 45.00,
      eligible_amount: 45.00,
      direction: 'credit',
      funding_status: 'eligible',
      occurred_at: new Date().toISOString(),
      description: 'Crédito para teste de idempotência'
    });

    await serviceClient.from('rider_weekly_settlements').update({ eligible_amount: 45.00 }).eq('id', stlId);

    const key = `IDEM-TEST-${Date.now()}`;

    const { data: res1, error: err1 } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: stlId,
      p_expected_version: 1,
      p_idempotency_key: key
    });

    assert.ok(!err1, `RPC 1 error: ${err1?.message}`);
    assert.equal(res1.success, true);

    const { data: res2, error: err2 } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: stlId,
      p_expected_version: 1,
      p_idempotency_key: key
    });

    assert.ok(!err2, `RPC 2 error: ${err2?.message}`);
    assert.equal(res1.batch_id, res2.batch_id);
    assert.equal(res2.is_idempotent, true);
  });

  // ===================================================================
  // C. ALOCAÇÃO DE PAGAMENTO DE CLIENTE
  // ===================================================================
  await t.test('C1. Alocação parcial do cliente mantém a Tele como blocked_client_unpaid', async () => {
    const { data: telePartial } = await serviceClient.from('teles').insert({
      tele_code: `TEL-PART-${Date.now()}`,
      client_id: CLIENT_ID_1,
      motoboy_id: riderFleetId,
      status: 'em_entrega',
      delivery_charge: 20.00,
      version: 1,
      rider_percentage: 85.00,
      pickup_address: 'Rua Part A',
      delivery_address: 'Rua Part B'
    }).select('*').single();
    createdTeleIds.push(telePartial.id);

    const { data: clientPayment } = await serviceClient.from('client_financial_transactions').insert({
      client_id: CLIENT_ID_1,
      type: 'pagamento_recebido',
      direction: 'credit',
      amount: 10.00,
      description: 'Pagamento parcial de R$ 10,00'
    }).select('*').single();

    await adminClient.rpc('admin_allocate_client_payment_to_teles', {
      p_client_transaction_id: clientPayment.id,
      p_tele_ids: [telePartial.id],
      p_amounts: [10.00]
    });

    const { data: allocRow } = await adminClient.from('client_payment_allocations').select('*').eq('tele_id', telePartial.id).single();
    assert.equal(allocRow.is_fully_covered, false, 'Tele deve continuar is_fully_covered = false com cobertura parcial');
  });

  await t.test('C2. Segundo pagamento parcial completa a cobertura (R$ 10 + R$ 10) e libera a Tele', async () => {
    const teleId = createdTeleIds[createdTeleIds.length - 1];

    const { data: clientPayment2 } = await serviceClient.from('client_financial_transactions').insert({
      client_id: CLIENT_ID_1,
      type: 'pagamento_recebido',
      direction: 'credit',
      amount: 10.00,
      description: 'Segundo pagamento parcial de R$ 10,00'
    }).select('*').single();

    await adminClient.rpc('admin_allocate_client_payment_to_teles', {
      p_client_transaction_id: clientPayment2.id,
      p_tele_ids: [teleId],
      p_amounts: [10.00]
    });

    const { data: allocRow } = await adminClient.from('client_payment_allocations').select('*').eq('tele_id', teleId).eq('client_transaction_id', clientPayment2.id).single();
    assert.equal(allocRow.is_fully_covered, true, 'Segundo pagamento de R$ 10 completa a cobertura total de R$ 20');
  });

  // ===================================================================
  // D. REGRA SEMANAL DE TIMEZONE (completed_at)
  // ===================================================================
  await t.test('D1. completed_at atribui estritamente a Tele à semana correta em timezone', async () => {
    const mondayStart = '2026-09-07T00:00:00.000Z';
    const mondayEnd = '2026-09-14T00:00:00.000Z';

    const { data: teleMon } = await serviceClient.from('teles').insert({
      tele_code: `TEL-TZ-${Date.now()}`,
      client_id: CLIENT_ID_1,
      motoboy_id: riderFleetId,
      status: 'em_entrega',
      delivery_charge: 30.00,
      version: 1,
      rider_percentage: 85.00,
      pickup_address: 'Rua TZ A',
      delivery_address: 'Rua TZ B',
      created_at: '2026-09-06T23:59:00.000Z'
    }).select('*').single();
    createdTeleIds.push(teleMon.id);

    await adminClient.rpc('complete_tele', { p_tele_id: teleMon.id, p_expected_version: 1 });
    await serviceClient.from('teles').update({ completed_at: '2026-09-07T00:00:00.000Z' }).eq('id', teleMon.id);

    const { data: calcRes } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: mondayStart,
      p_period_end: mondayEnd
    });

    assert.equal(Number(calcRes.gross), 30.00);
  });

  // ===================================================================
  // E. REABERTURA E ESTORNO AUDITADO
  // ===================================================================
  await t.test('E1. Reabertura em status paid é REJEITADA com CANNOT_REOPEN_PAID', async () => {
    const pStart = '2026-08-17T00:00:00.000Z';
    const { data: stl } = await serviceClient.from('rider_weekly_settlements').select('id, version').eq('rider_id', riderFleetId).order('created_at', { ascending: false }).limit(1).single();

    await serviceClient.from('rider_weekly_settlements').update({ status: 'paid' }).eq('id', stl.id);

    const { data: reopenRes } = await adminClient.rpc('admin_reopen_rider_weekly_settlement', {
      p_settlement_id: stl.id,
      p_expected_version: stl.version,
      p_reason: 'Tentativa de reabrir semana paga'
    });

    assert.equal(reopenRes.success, false);
    assert.equal(reopenRes.error_code, 'CANNOT_REOPEN_PAID');
  });

  // ===================================================================
  // F. INVARIANTES MATEMÁTICOS EM CENTAVOS (Diferença R$ 0,00)
  // ===================================================================
  await t.test('F1. Invariantes Matemáticos em Centavos Inteiros com R$ 0,00 de divergência', async () => {
    const { data: stl } = await serviceClient.from('rider_weekly_settlements').select('*').eq('rider_id', riderFleetId).order('created_at', { ascending: false }).limit(1).single();

    const netCents = Math.round(Number(stl.net_amount) * 100);
    const eligibleCents = Math.round(Number(stl.eligible_amount) * 100);
    const blockedCents = Math.round(Number(stl.blocked_amount) * 100);

    assert.equal(netCents, eligibleCents + blockedCents, 'Invariante net_amount = eligible_amount + blocked_amount em centavos');
  });
});
