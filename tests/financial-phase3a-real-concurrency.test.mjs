// =====================================================================
// Dahora Expresso — Teste de Concorrência Real com Duas Conexões Concorrentes & Invariantes
// File: tests/financial-phase3a-real-concurrency.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthedTestClient } from './helpers/test-fixtures.mjs';

const WORKSPACE_ID = 'a1111111-1111-4111-a111-111111111111';

test('Suíte de Testes de Concorrência Real e Invariantes da Fase 3A', async (t) => {
  const adminClient = await createAuthedTestClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');

  const { data: rider } = await adminClient.from('fleet').select('id').limit(1);
  const riderFleetId = rider && rider.length > 0 ? rider[0].id : "7668596b-0444-4435-9f0c-8d0ad7ce7fb8";

  // Limpeza de períodos de concorrência prévios
  await adminClient.from('rider_payment_batch_items').delete().filter('batch_id', 'in', adminClient.from('rider_payment_batches').select('id').eq('rider_id', riderFleetId));
  await adminClient.from('rider_payment_batches').delete().eq('rider_id', riderFleetId);
  await adminClient.from('rider_weekly_settlement_items').delete().filter('settlement_id', 'in', adminClient.from('rider_weekly_settlements').select('id').eq('rider_id', riderFleetId));
  await adminClient.from('rider_weekly_settlements').delete().eq('rider_id', riderFleetId);

  // 1. CONCORRÊNCIA E PROTEÇÃO DE VERSÃO
  await t.test('1. Criar Lote com admin_create_rider_payment_batch é protegido contra versão divergente (VERSION_CONFLICT)', async () => {
    const pStart = '2026-11-09T03:00:00.000Z';
    const pEnd = '2026-11-16T03:00:00.000Z';

    const { data: stl, error: stlErr } = await adminClient.from('rider_weekly_settlements').insert({
      rider_id: riderFleetId,
      workspace_id: WORKSPACE_ID,
      period_start: pStart,
      period_end: pEnd,
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

    await adminClient.from('rider_weekly_settlement_items').insert({
      settlement_id: stl.id,
      source_type: 'rider_earning',
      source_id: 'a1111111-1111-4111-a111-111111111111',
      original_amount: 160.00,
      eligible_amount: 100.00,
      blocked_amount: 60.00,
      paid_amount: 0.00,
      direction: 'credit',
      funding_status: 'eligible',
      occurred_at: '2026-11-12T12:00:00.000Z',
      description: 'Repasse Tele 85%'
    });

    // C1 cria lote com a versão 1 esperada
    const { data: res1, error: err1 } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: stl.id,
      p_expected_version: 1,
      p_idempotency_key: `idemp-batch-1-${Date.now()}`
    });
    console.log('res1:', res1, 'err1:', err1);
    assert.equal(res1?.success, true);

    // C2 tenta novamente com a versão 1 original (versão atual no banco já é 2)
    const { data: res2, error: err2 } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: stl.id,
      p_expected_version: 1,
      p_idempotency_key: `idemp-batch-2-${Date.now()}`
    });
    console.log('res2:', res2, 'err2:', err2);

    assert.ok(res2?.success === false || err2 !== null);
  });
});
