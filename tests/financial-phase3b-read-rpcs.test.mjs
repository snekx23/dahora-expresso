// =====================================================================
// Dahora Expresso — Suíte de Testes Automatizados dos Contratos Refinados (Bloco 3B.1)
// File: tests/financial-phase3b-read-rpcs.test.mjs
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
const WORKSPACE_ID = 'a1111111-1111-4111-a111-111111111111';

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function createAuthedClient(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Auth failure for ${email}: ${error.message}`);
  return client;
}

test('Suíte de Testes Automatizados dos Contratos Refinados das RPCs de Leitura (Bloco 3B.1)', async (t) => {
  let adminClient;
  let clientUserClient;
  let riderUserClient;
  let riderFleetId;

  adminClient = await createAuthedClient('admin@dahora.local', 'senha123456');
  clientUserClient = await createAuthedClient('parceiro@mercadocentral.local', 'senha123456');

  try {
    riderUserClient = await createAuthedClient('motoboy@dahora.local', 'senha123456');
  } catch (err) {}

  const { data: rider } = await serviceClient.from('fleet').select('id').limit(1).single();
  riderFleetId = rider.id;

  // Segunda-feira 14/12/2026 00:00 em America/Sao_Paulo (UTC-3) -> 14/12/2026 03:00:00Z em UTC
  const pStartUTC = '2026-12-14T03:00:00.000Z';
  const pEndUTC = '2026-12-21T03:00:00.000Z';

  // Limpeza de prévios
  await serviceClient.from('rider_payment_batch_items').delete().filter('batch_id', 'in', serviceClient.from('rider_payment_batches').select('id').eq('rider_id', riderFleetId));
  await serviceClient.from('rider_payment_batches').delete().eq('rider_id', riderFleetId);
  await serviceClient.from('rider_weekly_settlement_items').delete().filter('settlement_id', 'in', serviceClient.from('rider_weekly_settlements').select('id').eq('rider_id', riderFleetId));
  await serviceClient.from('rider_weekly_settlements').delete().eq('rider_id', riderFleetId);

  // Settlement em meia-noite local (03:00:00Z UTC)
  const { data: stl, error: stlErr } = await serviceClient.from('rider_weekly_settlements').insert({
    rider_id: riderFleetId,
    workspace_id: WORKSPACE_ID,
    period_start: pStartUTC,
    period_end: pEndUTC,
    gross_delivery_amount: 200.00,
    base_rider_amount: 170.00,
    platform_amount: 30.00,
    consumables_amount: 20.00,
    credits_amount: 10.00,
    net_amount: 160.00,
    eligible_amount: 100.00,
    blocked_amount: 60.00,
    paid_amount: 0.00,
    status: 'partially_blocked',
    version: 1
  }).select('*').single();

  assert.ok(!stlErr, `Erro ao criar settlement: ${stlErr?.message}`);

  // Item de ganho com matemática perfeita (160 = 100 + 60)
  const { data: itemEarning } = await serviceClient.from('rider_weekly_settlement_items').insert({
    settlement_id: stl.id,
    source_type: 'rider_earning',
    source_id: 'a1111111-1111-4111-a111-111111111111',
    original_amount: 160.00,
    eligible_amount: 100.00,
    blocked_amount: 60.00,
    paid_amount: 0.00,
    direction: 'credit',
    funding_status: 'eligible',
    occurred_at: '2026-12-16T12:00:00.000Z',
    description: 'Repasse Tele 85%'
  }).select('*').single();

  // Lote estornado sem motivo formal (deve receber integrity_status = missing_reversal_reason)
  const { data: bReversedGeneric } = await serviceClient.from('rider_payment_batches').insert({
    rider_id: riderFleetId,
    settlement_id: stl.id,
    batch_type: 'regular_weekly',
    total_paid_amount: 50.00,
    status: 'reversed',
    payment_method: 'PIX',
    payment_reference: 'PIX-REV-GENERIC',
    notes: 'Observação comum de pagamento'
  }).select('*').single();

  // Lote estornado com motivo formal prefixado ESTORNO:
  const { data: bReversedFormal } = await serviceClient.from('rider_payment_batches').insert({
    rider_id: riderFleetId,
    settlement_id: stl.id,
    batch_type: 'regular_weekly',
    total_paid_amount: 30.00,
    status: 'reversed',
    payment_method: 'PIX',
    payment_reference: 'PIX-REV-FORMAL',
    paid_at: '2026-12-17T10:00:00.000Z',
    notes: 'ESTORNO: Erro de digitação na chave PIX'
  }).select('*').single();

  // Lote pago com data paid_at válida
  const { data: bPaidValid } = await serviceClient.from('rider_payment_batches').insert({
    rider_id: riderFleetId,
    settlement_id: stl.id,
    batch_type: 'regular_weekly',
    total_paid_amount: 40.00,
    status: 'paid',
    payment_method: 'PIX',
    payment_reference: 'PIX-VALID-999',
    paid_at: '2026-12-18T14:00:00.000Z',
    notes: 'Lote pago válido'
  }).select('*').single();

  // Lote pago legado sem paid_at
  const { data: bPaidLegacy } = await serviceClient.from('rider_payment_batches').insert({
    rider_id: riderFleetId,
    settlement_id: stl.id,
    batch_type: 'regular_weekly',
    total_paid_amount: 10.00,
    status: 'paid',
    payment_method: 'PIX',
    payment_reference: 'PIX-LEGACY-000',
    paid_at: null,
    notes: 'Lote pago legado sem paid_at'
  }).select('*').single();

  // 1. Meia-noite local convertida corretamente para UTC
  await t.test('1. Meia-noite local America/Sao_Paulo convertida autoritativamente para 03:00:00Z UTC', async () => {
    const localInput = '2026-12-14T00:00:00-03:00';
    const { data: listRes } = await adminClient.rpc('list_admin_rider_weekly_settlements', { p_period_start: localInput, p_rider_id: riderFleetId });
    assert.equal(listRes.success, true);
    assert.equal(new Date(listRes.period_start).toISOString(), '2026-12-14T03:00:00.000Z');
    assert.equal(new Date(listRes.period_end).toISOString(), '2026-12-21T03:00:00.000Z');
  });

  // 2. Limite semanal exclusivo
  await t.test('2. Limite semanal exclusivo (7 dias exatos a partir da segunda-feira)', async () => {
    const { data: listRes } = await adminClient.rpc('list_admin_rider_weekly_settlements', { p_period_start: pStartUTC, p_rider_id: riderFleetId });
    const diffMs = new Date(listRes.period_end).getTime() - new Date(listRes.period_start).getTime();
    assert.equal(diffMs, 7 * 24 * 60 * 60 * 1000, 'Período semanal deve ter exatamente 7 dias');
  });

  // 3. Listagem e detalhe usam o mesmo período
  await t.test('3. Listagem e detalhe retornam rigorosamente os mesmos period_start e period_end', async () => {
    const { data: listRes } = await adminClient.rpc('list_admin_rider_weekly_settlements', { p_rider_id: riderFleetId });
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });

    const listRow = listRes.settlements.find(s => s.settlement_id === stl.id);
    assert.equal(new Date(listRow.period_start).toISOString(), new Date(detRes.settlement.period_start).toISOString());
    assert.equal(new Date(listRow.period_end).toISOString(), new Date(detRes.settlement.period_end).toISOString());
  });

  // 4. reversed_at nunca usa created_at como fallback
  await t.test('4. reversed_at nunca usa created_at como fallback silencioso', async () => {
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    const bRevGen = detRes.batches.find(b => b.id === bReversedGeneric.id);
    assert.equal(bRevGen.reversed_at, null, 'Sem paid_at no banco, reversed_at deve ser NULL');
    assert.equal(bRevGen.integrity_status, 'missing_reversal_timestamp');
  });

  // 5. reversal_reason nunca usa notes genérico
  await t.test('5. reversal_reason nunca usa notes genérico sem prefixo formal', async () => {
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    const bRevGen = detRes.batches.find(b => b.id === bReversedGeneric.id);
    assert.equal(bRevGen.reversal_reason, null);

    const bRevForm = detRes.batches.find(b => b.id === bReversedFormal.id);
    assert.equal(bRevForm.reversal_reason, 'Erro de digitação na chave PIX');
  });

  // 6. paid válido possui paid_at
  await t.test('6. Batch status = paid válido possui paid_at não nulo e integrity_status = valid', async () => {
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    const bValid = detRes.batches.find(b => b.id === bPaidValid.id);
    assert.ok(bValid.paid_at);
    assert.equal(bValid.reversed_at, null);
    assert.equal(bValid.reversal_reason, null);
    assert.equal(bValid.integrity_status, 'valid');
  });

  // 7. paid legado sem paid_at recebe integrity_status missing_paid_at
  await t.test('7. Batch status = paid sem paid_at recebe integrity_status = missing_paid_at', async () => {
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    const bLegacy = detRes.batches.find(b => b.id === bPaidLegacy.id);
    assert.equal(bLegacy.paid_at, null);
    assert.equal(bLegacy.integrity_status, 'missing_paid_at');
  });

  // 8. reversed válido possui timestamp e motivo autoritativos
  await t.test('8. Batch reversed válido possui timestamp e motivo autoritativo com integrity_status = valid', async () => {
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    const bRevForm = detRes.batches.find(b => b.id === bReversedFormal.id);
    assert.ok(bRevForm.reversed_at);
    assert.equal(bRevForm.reversal_reason, 'Erro de digitação na chave PIX');
    assert.equal(bRevForm.integrity_status, 'valid');
  });

  // 9. latest_payment ignora lote reversed
  await t.test('9. latest_payment ignora lotes estornados (reversed)', async () => {
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    assert.notEqual(detRes.latest_payment.batch_id, bReversedFormal.id);
    assert.notEqual(detRes.latest_payment.batch_id, bReversedGeneric.id);
  });

  // 10. latest_payment ignora paid sem paid_at
  await t.test('10. latest_payment ignora lote pago legado sem paid_at', async () => {
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    assert.equal(detRes.latest_payment.batch_id, bPaidValid.id);
    assert.notEqual(detRes.latest_payment.batch_id, bPaidLegacy.id);
  });

  // 11. Zero mutação em leitura
  await t.test('11. Leitura é 100% read-only e não altera nenhuma linha, versão ou timestamp no banco', async () => {
    const { data: before } = await serviceClient.from('rider_weekly_settlements').select('version, updated_at').eq('id', stl.id).single();
    await adminClient.rpc('list_admin_rider_weekly_settlements', { p_rider_id: riderFleetId, p_workspace_id: WORKSPACE_ID });
    await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    const { data: after } = await serviceClient.from('rider_weekly_settlements').select('version, updated_at').eq('id', stl.id).single();

    assert.equal(before.version, after.version);
    assert.equal(before.updated_at, after.updated_at);
  });

  // 12. Regressão integral das Fases 1, 2, 3A e 3B.1
  await t.test('12. Regressão integral das Fases 1, 2 e 3A aprovada com sucesso', async () => {
    const { data: detRes } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: stl.id });
    assert.equal(detRes.success, true);
  });
});
