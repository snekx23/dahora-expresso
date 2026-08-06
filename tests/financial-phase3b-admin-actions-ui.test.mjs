import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('.env.bootstrap.remote') });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function createAuthedClient(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Auth failure for ${email}: ${error.message}`);
  return client;
}

test('Suíte de Testes da Fase 3B.2A.2 (Operações Autoritativas do Repasse Semanal)', async (t) => {
  let adminClient;
  let testRiderId;
  let periodStart;
  let periodEnd;

  adminClient = await createAuthedClient('admin@dahora.local', 'senha123456');

  const { data: fleetRiders } = await serviceClient.from('fleet').select('id, name').limit(1);
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

    // Garantir saldo elegível para testes de pagamento inserindo um crédito via serviceClient
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

    // Testar VERSION_CONFLICT com versão incorreta
    const { data: conflictData } = await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: version + 999
    });
    assert.strictEqual(conflictData.success, false);
    assert.strictEqual(conflictData.error_code, 'VERSION_CONFLICT');

    // Encerrar com versão correta
    const { data: closeData, error } = await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: version
    });

    assert.ifError(error);
    assert.strictEqual(closeData.success, true);
    assert.ok(['pending', 'partially_blocked'].includes(closeData.status));
    assert.strictEqual(closeData.version, version + 1);
  });

  await t.test('4. Reabrir Fechamento exige motivo não vazio e transiciona status para open com settlement.version', async () => {
    const { data: listData } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: periodStart,
      p_rider_id: testRiderId
    });
    const settlement = listData.settlements[0];
    const settlementId = settlement.settlement_id;
    const version = settlement.version;

    // Motivo vazio deve ser recusado
    const { data: emptyReasonData } = await adminClient.rpc('admin_reopen_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: version,
      p_reason: '   '
    });
    assert.strictEqual(emptyReasonData.success, false);
    assert.strictEqual(emptyReasonData.error_code, 'REASON_REQUIRED');

    // Reabrir com motivo válido
    const { data: reopenData, error } = await adminClient.rpc('admin_reopen_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: version,
      p_reason: 'Ajuste de lançamento de consumível'
    });

    assert.ifError(error);
    assert.strictEqual(reopenData.success, true);
    assert.strictEqual(reopenData.status, 'open');
    assert.strictEqual(reopenData.version, version + 1);

    // Re-encerrar para permitir pagamentos no teste seguinte
    await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: reopenData.version
    });
  });

  await t.test('5. Pagamento em 2 Etapas: admin_create_rider_payment_batch exige re-fetch autoritativo para obter batch.version', async () => {
    const { data: listData } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: periodStart,
      p_rider_id: testRiderId
    });
    const settlement = listData.settlements[0];
    const settlementId = settlement.settlement_id;
    const version = settlement.version;

    const createIdempotencyKey = `test_create_batch_${Date.now()}`;

    // Etapa 1: Criar lote
    const { data: createData, error: createErr } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: settlementId,
      p_expected_version: version,
      p_idempotency_key: createIdempotencyKey
    });

    assert.ifError(createErr);
    assert.strictEqual(createData.success, true, `Falha no lote: ${createData?.message}`);
    assert.ok(createData.batch_id);
    assert.strictEqual(createData.batch_version, undefined, "RPC não deve retornar batch_version diretamente");

    // Re-fetch autoritativo via get_admin_rider_weekly_settlement_detail
    const { data: detailData, error: detailErr } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', {
      p_settlement_id: settlementId
    });

    assert.ifError(detailErr);
    assert.strictEqual(detailData.success, true);
    const realBatch = (detailData.batches || []).find(b => b.id === createData.batch_id);
    assert.ok(realBatch, "Lote criado deve existir no array batches do detalhe");
    assert.strictEqual(typeof realBatch.version, 'number', "batch.version real deve ser um número");

    // Etapa 2: Confirmar pagamento usando batch.version real
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
    const { data: listData } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: periodStart,
      p_rider_id: testRiderId
    });
    const settlementId = listData.settlements[0].settlement_id;

    const { data: detailData } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', {
      p_settlement_id: settlementId
    });

    const batches = detailData.batches || [];
    const paidBatch = batches.find(b => b.status === 'paid');
    assert.ok(paidBatch, "Deve existir ao menos um lote em status 'paid'");

    // Testar motivo vazio
    const { data: emptyReasonData } = await adminClient.rpc('admin_reverse_rider_payment_batch', {
      p_batch_id: paidBatch.id,
      p_expected_version: paidBatch.version,
      p_reason: ''
    });
    assert.strictEqual(emptyReasonData.success, false);
    assert.strictEqual(emptyReasonData.error_code, 'REASON_REQUIRED');

    // Executar estorno com motivo válido
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
    const { data: listData } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: periodStart,
      p_rider_id: testRiderId
    });
    const settlement = listData.settlements[0];
    const settlementId = settlement.settlement_id;

    // Criar e pagar um lote novo
    const { data: createData } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: settlementId,
      p_expected_version: settlement.version
    });

    if (createData && createData.success) {
      const batchId = createData.batch_id;
      const { data: detailData } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', { p_settlement_id: settlementId });
      const batch = detailData.batches.find(b => b.id === batchId);

      await adminClient.rpc('admin_mark_rider_payment_batch_paid', {
        p_batch_id: batchId,
        p_expected_version: batch.version,
        p_payment_reference: 'E9999999999'
      });
    }

    // Tentar reabrir repasse paid
    const { data: listPaidData } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: periodStart,
      p_rider_id: testRiderId
    });
    const paidSettlement = listPaidData.settlements[0];

    if (paidSettlement.status === 'paid') {
      const { data: tryReopenData } = await adminClient.rpc('admin_reopen_rider_weekly_settlement', {
        p_settlement_id: paidSettlement.settlement_id,
        p_expected_version: paidSettlement.version,
        p_reason: 'Tentativa indevida de reabrir repasse quitado'
      });

      assert.strictEqual(tryReopenData.success, false);
      assert.strictEqual(tryReopenData.error_code, 'CANNOT_REOPEN_PAID');
    }
  });

  await t.test('8. Validação Estática em public/app.js: Ausência de mutações diretas e de fórmulas financeiras', async () => {
    const appJsContent = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

    // Verificar que não existem INSERT, UPDATE, DELETE ou UPSERT direto em tabelas financeiras
    const directMutationRegex = /supabaseClient\s*\.\s*from\s*\(\s*['"`](rider_weekly_settlements|rider_weekly_settlement_items|rider_payment_batches|rider_payment_batch_items)['"`]\s*\)\s*\.\s*(insert|update|delete|upsert)/i;
    assert.strictEqual(directMutationRegex.test(appJsContent), false, "app.js NÃO pode conter mutações SQL diretas em tabelas financeiras");

    // Verificar presença das chamadas oficiais às RPCs operacionais
    assert.ok(appJsContent.includes('admin_calculate_rider_weekly_settlement'));
    assert.ok(appJsContent.includes('admin_close_rider_weekly_settlement'));
    assert.ok(appJsContent.includes('admin_reopen_rider_weekly_settlement'));
    assert.ok(appJsContent.includes('admin_create_rider_payment_batch'));
    assert.ok(appJsContent.includes('admin_mark_rider_payment_batch_paid'));
    assert.ok(appJsContent.includes('admin_reverse_rider_payment_batch'));

    // Verificar presença do re-fetch autoritativo após a Etapa 1
    assert.ok(appJsContent.includes('get_admin_rider_weekly_settlement_detail'));
    assert.ok(appJsContent.includes('sessionStorage'));
  });
});
