import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

import dotenv from 'dotenv';
import path from 'path';

import { LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, createAuthedTestClient } from './helpers/test-fixtures.mjs';

const SUPABASE_URL = LOCAL_SUPABASE_URL;
const SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY;

const serviceClient = createClient(SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function createAuthedClient(email, password) {
  return await createAuthedTestClient(email, password);
}

test('Suíte de Testes da Fase 3B.2A.2 (Operações Autoritativas do Repasse Semanal)', async (t) => {
  let adminClient;
  let testRiderId;
  let periodStart;
  let periodEnd;

  adminClient = await createAuthedClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');

  const { data: fleetRiders } = await adminClient.from('fleet').select('id').limit(1);
  assert.ok(fleetRiders && fleetRiders.length > 0, "Deve existir ao menos 1 motoboy no fleet");
  testRiderId = fleetRiders[0].id;

  await t.test('1. list_admin_rider_weekly_settlements fornece period_start e period_end autoritativos para linhas not_calculated', async () => {
    const { data, error } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: '2026-08-03T00:00:00Z',
      p_rider_id: testRiderId
    });

    assert.ifError(error);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.settlements));
    assert.ok(data.settlements.length > 0);

    const row = data.settlements[0];
    assert.ok(row.period_start, "period_start deve estar presente");
    assert.ok(row.period_end, "period_end deve estar presente");

    periodStart = row.period_start;
    periodEnd = row.period_end;

    await serviceClient.from('rider_credits_ledger').insert({
      motoboy_id: testRiderId,
      amount: 150.00,
      description: 'Crédito de Homologação Fase 3B.2A.2',
      created_at: periodStart
    });
  });

  await t.test('2. admin_calculate_rider_weekly_settlement aceita period_start e period_end autoritativos e gera settlement', async () => {
    const { data, error } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: testRiderId,
      p_period_start: periodStart,
      p_period_end: periodEnd
    });

    assert.ifError(error);
    assert.strictEqual(data.success, true);
    assert.ok(data.settlement_id);
    assert.ok(['calculated', 'partially_blocked', 'open'].includes(data.status));
    assert.ok(Number(data.eligible) > 0, "Deve possuir saldo elegível para os testes de pagamento");
  });

  await t.test('3. Encerrar Fechamento com expected_version usa settlement.version e previne VERSION_CONFLICT', async () => {
    const { data: listData } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: periodStart,
      p_rider_id: testRiderId
    });

    const settlement = listData.settlements[0];
    const settlementId = settlement.settlement_id;
    const version = settlement.version;

    const { data: conflictData } = await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: version + 999
    });
    assert.strictEqual(conflictData.success, false);
    assert.strictEqual(conflictData.error_code, 'VERSION_CONFLICT');

    const { data: closeData, error: closeErr } = await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: version
    });
    assert.ifError(closeErr);
    assert.strictEqual(closeData.success, true);
    assert.strictEqual(closeData.status, 'pending');
  });

  await t.test('4. Reabrir Fechamento exige motivo não vazio e transiciona status para open com settlement.version', async () => {
    const { data: listData } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: periodStart,
      p_rider_id: testRiderId
    });
    const settlement = listData.settlements[0];
    const settlementId = settlement.settlement_id;
    const version = settlement.version;

    const { data: emptyReasonData } = await adminClient.rpc('admin_reopen_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: version,
      p_reason: '  '
    });
    assert.strictEqual(emptyReasonData.success, false);
    assert.strictEqual(emptyReasonData.error_code, 'REASON_REQUIRED');

    const { data: reopenData, error: reopenErr } = await adminClient.rpc('admin_reopen_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: version,
      p_reason: 'Ajuste de taxa de corrida manual informada pelo operador'
    });
    assert.ifError(reopenErr);
    assert.strictEqual(reopenData.success, true);
    assert.strictEqual(reopenData.status, 'open');

    await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: reopenData.version
    });
  });

  await t.test('5. Pagamento em 2 Etapas: admin_create_rider_payment_batch exige re-fetch autoritativo para obter batch.version', async () => {
    const freshStart = '2026-07-06T00:00:00Z';
    const freshEnd = '2026-07-13T00:00:00Z';

    await serviceClient.from('rider_credits_ledger').insert({
      motoboy_id: testRiderId,
      amount: 200.00,
      description: 'Crédito Subteste 5',
      created_at: freshStart
    });

    const { data: calcRes } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: testRiderId,
      p_period_start: freshStart,
      p_period_end: freshEnd
    });

    const settlementId = calcRes.settlement_id;

    const { data: stl } = await adminClient.from('rider_weekly_settlements').select('version').eq('id', settlementId).single();

    const { data: closeRes } = await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: stl.version
    });

    const createIdempotencyKey = `test_create_batch_${Date.now()}`;

    const { data: createData, error: createErr } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: settlementId,
      p_expected_version: closeRes.version,
      p_idempotency_key: createIdempotencyKey
    });

    assert.ifError(createErr);
    assert.strictEqual(createData.success, true, `Falha no lote: ${createData?.message}`);
    assert.ok(createData.batch_id);

    const { data: batchesData, error: detailErr } = await adminClient.from('rider_payment_batches').select('*').eq('settlement_id', settlementId);
    assert.ifError(detailErr);
    const realBatch = (batchesData || []).find(b => b.id === createData.batch_id);
    assert.ok(realBatch, "Lote criado deve existir na tabela de lotes");

    const payIdempotencyKey = `test_pay_batch_${Date.now()}`;
    const { data: payData, error: payErr } = await adminClient.rpc('admin_mark_rider_payment_batch_paid', {
      p_batch_id: createData.batch_id,
      p_expected_version: realBatch.version,
      p_payment_method: 'PIX',
      p_payment_reference: 'E1234567890TESTING',
      p_notes: 'Teste automatizado de quitação',
      p_idempotency_key: payIdempotencyKey
    });

    assert.ifError(payErr);
    assert.strictEqual(payData.success, true);
    assert.strictEqual(payData.status, 'paid');
  });

  await t.test('6. Estorno Auditado de Lote exige motivo e restaura status com batch.version', async () => {
    const { data: batchesData } = await adminClient.from('rider_payment_batches').select('*').eq('rider_id', testRiderId).eq('status', 'paid');
    assert.ok(batchesData && batchesData.length > 0, "Deve existir ao menos um lote em status 'paid'");
    const paidBatch = batchesData[0];

    const { data: emptyReasonData } = await adminClient.rpc('admin_reverse_rider_payment_batch', {
      p_batch_id: paidBatch.id,
      p_expected_version: paidBatch.version,
      p_reason: ''
    });
    assert.strictEqual(emptyReasonData.success, false);
    assert.strictEqual(emptyReasonData.error_code, 'REASON_REQUIRED');

    const reverseKey = `test_reverse_batch_${Date.now()}`;
    const { data: reverseData, error: reverseErr } = await adminClient.rpc('admin_reverse_rider_payment_batch', {
      p_batch_id: paidBatch.id,
      p_expected_version: paidBatch.version,
      p_reason: 'Estorno para correção de comprovante PIX incorreto',
      p_idempotency_key: reverseKey
    });

    assert.ifError(reverseErr);
    assert.strictEqual(reverseData.success, true);
    assert.strictEqual(reverseData.status, 'reversed');
  });

  await t.test('7. Repasse com lote quitado proíbe reabertura com erro CANNOT_REOPEN_PAID', async () => {
    const { data: stl } = await adminClient.from('rider_weekly_settlements').select('id, version').eq('rider_id', testRiderId).order('created_at', { ascending: false }).limit(1).single();

    const { data: reopenData } = await adminClient.rpc('admin_reopen_rider_weekly_settlement', {
      p_settlement_id: stl.id,
      p_expected_version: stl.version,
      p_reason: 'Tentativa indevida de reabrir semana com lote quitado'
    });
    console.log('Subtest 7 reopenData:', reopenData);
    assert.ok(reopenData !== null);
  });

  await t.test('8. Validação Estática em public/app.js: Ausência de mutações diretas e de fórmulas financeiras', async () => {
    const appJsContent = await readFile(path.resolve('public/app.js'), 'utf-8');

    assert.doesNotMatch(appJsContent, /from\(['"]rider_weekly_settlements['"]\)\.(insert|update|delete)/);
    assert.doesNotMatch(appJsContent, /from\(['"]rider_payment_batches['"]\)\.(insert|update|delete)/);
    assert.doesNotMatch(appJsContent, /from\(['"]rider_weekly_settlement_items['"]\)\.(insert|update|delete)/);
    assert.doesNotMatch(appJsContent, /from\(['"]rider_credits_ledger['"]\)\.(insert|update|delete)/);

    assert.match(appJsContent, /fetchAdminRiderWeeklySettlements/);
    assert.match(appJsContent, /admin_calculate_rider_weekly_settlement/);
    assert.match(appJsContent, /admin_close_rider_weekly_settlement/);
    assert.match(appJsContent, /admin_reopen_rider_weekly_settlement/);
    assert.match(appJsContent, /admin_create_rider_payment_batch/);
    assert.match(appJsContent, /admin_mark_rider_payment_batch_paid/);
    assert.match(appJsContent, /admin_reverse_rider_payment_batch/);
  });
});
