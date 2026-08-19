// =====================================================================
// Dahora Expresso — Suíte de Testes Automatizados da Fase 3A (Financeiro & Fechamento)
// File: tests/financial-phase3a.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

import dotenv from 'dotenv';
import path from 'path';

// Local test harness override
import { LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, createAuthedTestClient } from './helpers/test-fixtures.mjs';

const SUPABASE_URL = LOCAL_SUPABASE_URL;
const SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY;

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function createAuthedClient(email, password) {
  return await createAuthedTestClient(email, password);
}

test('Suíte de Testes da Fase 3A (Fundação Financeira Canônica e Fechamento Semanal)', async (t) => {
  const createdTeleIds = [];
  const createdBatchIds = [];
  let adminClient;
  let clientUserClient;
  let riderFleetId;
  let activeSettlementId;

  // 1. Auth setup
  adminClient = await createAuthedClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');
  clientUserClient = await createAuthedClient('padaria.central@homolog.test', 'dahoraexpresso1');

  const randNum = Math.floor(100000 + Math.random() * 899999);
  const { data: newClient, error: clientErr } = await serviceClient.from('commercial_clients').insert({
    client_code: `CLI-${randNum}`,
    establishment_name: `Padaria Fin ${randNum}`,
    responsible_name: 'João Teste',
    email: `fin.${randNum}@homolog.local`,
    phone: '(51) 99999-7777',
    address: 'Rua Teste, 100',
    neighborhood: 'Centro',
    city: 'Sapucaia do Sul',
    document: `${randNum}000199`,
    lifecycle_status: 'ativo',
    financial_status: 'em_dia',
    is_internal: false
  }).select('*').single();
  assert.ok(!clientErr, `Client creation error: ${clientErr?.message}`);
  const CLIENT_ID_1 = newClient.id;

  const { data: newRider } = await serviceClient.from('fleet').insert({
    name: `Motoboy Fin ${randNum}`,
    phone: `519${randNum}`,
    status: 'disponivel'
  }).select('id').single();
  riderFleetId = newRider.id;

  // Janela semanal isolada para o teste
  const pStart = '2026-08-10T00:00:00.000Z';
  const pEnd = '2026-08-17T00:00:00.000Z';

  // Limpar lotes e settlements prévios do mesmo período de teste
  await serviceClient.from('client_payment_allocations').delete().eq('client_id', CLIENT_ID_1);
  await serviceClient.from('client_financial_transactions').delete().eq('client_id', CLIENT_ID_1);
  await adminClient.from('rider_payment_batch_items').delete().filter('batch_id', 'in', adminClient.from('rider_payment_batches').select('id').eq('rider_id', riderFleetId));
  await adminClient.from('rider_payment_batches').delete().eq('rider_id', riderFleetId);
  await adminClient.from('rider_weekly_settlement_items').delete().filter('settlement_id', 'in', adminClient.from('rider_weekly_settlements').select('id').eq('rider_id', riderFleetId));
  await adminClient.from('rider_weekly_settlements').delete().eq('rider_id', riderFleetId);

  t.after(async () => {
    for (const teleId of createdTeleIds) {
      try {
        await adminClient.from('rider_weekly_settlement_items').delete().eq('tele_id', teleId);
        await adminClient.from('rider_financial_transactions').delete().eq('tele_id', teleId);
        await adminClient.from('company_financial_transactions').delete().eq('tele_id', teleId);
        await adminClient.from('client_payment_allocations').delete().eq('tele_id', teleId);
        await adminClient.from('teles').delete().eq('id', teleId);
      } catch (err) {}
    }
  });

  const { data: tele1, error: teleErr } = await adminClient.from('teles').insert({
    tele_code: `TEL-FIN-1-${Date.now()}`,
    client_id: CLIENT_ID_1,
    motoboy_id: riderFleetId,
    status: 'em_rota',
    pickup_address: 'Rua Origem, 10',
    delivery_address: 'Rua B, 20',
    recipient_name: 'Cliente Teste Fin',
    recipient_phone: '51988887777',
    delivery_charge: 20.00,
    total_order_amount: 20.00,
    version: 1,
    created_at: '2026-08-12T10:00:00.000Z'
  }).select('*').single();

  assert.ok(!teleErr, `Tele insert error: ${teleErr?.message}`);
  createdTeleIds.push(tele1.id);

  // 1. Conclusão de Tele via RPC complete_tele gera 85% para motoboy e 15% para plataforma
  await t.test('1. Conclusão da Tele via complete_tele gera 85% para motoboy (R$ 17,00) e 15% para plataforma (R$ 3,00)', async () => {
    const { data: compRes, error: compErr } = await adminClient.rpc('complete_tele', {
      p_tele_id: tele1.id,
      p_expected_version: 1
    });

    assert.ok(!compErr, `RPC error: ${compErr?.message}`);
    assert.equal(compRes.success, true);
    assert.equal(compRes.status, 'concluida');

    // Forçar completed_at e período do settlement na janela do teste
    await adminClient.from('teles').update({ completed_at: '2026-08-12T10:05:00.000Z' }).eq('id', tele1.id);
    await adminClient.from('rider_weekly_settlement_items').update({ period_start: pStart, period_end: pEnd }).eq('tele_id', tele1.id);

    const { data: rtx } = await adminClient.from('rider_financial_transactions').select('*').eq('tele_id', tele1.id).single();
    assert.equal(Number(rtx.amount), 17.00, 'Motoboy recebe 85% (17,00 de 20,00)');

    const { data: ctx } = await adminClient.from('company_financial_transactions').select('*').eq('tele_id', tele1.id).single();
    assert.equal(Number(ctx.amount), 3.00, 'Plataforma recebe 15% (3,00 de 20,00)');
  });

  // 2. Alocação de Pagamento do Cliente
  await t.test('2. Alocação de pagamento do cliente marca a Tele como fully_covered e funding_status = eligible', async () => {
    const { data: payRegRes, error: clientPayErr } = await adminClient.rpc('admin_register_client_payment', {
      p_client_id: CLIENT_ID_1,
      p_amount: 20.00,
      p_payment_method: 'PIX',
      p_notes: 'Pagamento PIX do cliente de teste',
      p_idempotency_key: `idemp-reg-pay-${Date.now()}`
    });

    assert.ok(!clientPayErr && payRegRes.success, `Client payment error: ${clientPayErr?.message || payRegRes?.message}`);
    const clientPaymentId = payRegRes.transaction_id || payRegRes.id || payRegRes.client_transaction_id;

    const { data: allocRes, error: allocErr } = await adminClient.rpc('admin_allocate_client_payment_to_teles', {
      p_client_transaction_id: clientPaymentId,
      p_tele_ids: [tele1.id],
      p_amounts: [20.00]
    });

    assert.ok(!allocErr, `Alloc RPC error: ${allocErr?.message}`);
    assert.equal(allocRes.success, true, `Alloc failed: ${JSON.stringify(allocRes)}`);
    assert.equal(allocRes.allocated_count, 1);

    const { data: allocRow } = await adminClient.from('client_payment_allocations').select('*').eq('tele_id', tele1.id).single();
    assert.ok(allocRow, 'Linha de alocação encontrada no banco');
    assert.equal(allocRow.is_fully_covered, true);
    assert.equal(Number(allocRow.allocated_amount), 20.00);
  });

  // 3. Cálculo do Fechamento Semanal via admin_calculate_rider_weekly_settlement
  await t.test('3. Cálculo do fechamento semanal calcula os 85% e define status em calculated', async () => {
    const { data: calcRes, error: calcErr } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: pStart,
      p_period_end: pEnd
    });

    assert.ok(!calcErr, `Calc RPC error: ${calcErr?.message}`);
    assert.equal(calcRes.success, true, `Calc failed: ${JSON.stringify(calcRes)}`);
    assert.ok(Number(calcRes.gross) >= 20.00);
    assert.ok(Number(calcRes.base_rider) >= 17.00);

    activeSettlementId = calcRes.settlement_id;
  });

  // 4. Fechamento da Semana via admin_close_rider_weekly_settlement
  await t.test('4. Fechamento da semana transiciona status para pending com expected_version', async () => {
    const { data: stl } = await adminClient.from('rider_weekly_settlements').select('id, version').eq('id', activeSettlementId).single();
    assert.ok(stl, 'Settlement encontrado para fechamento');

    const { data: closeRes, error: closeErr } = await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: stl.id,
      p_expected_version: stl.version
    });

    assert.ok(!closeErr, `Close RPC error: ${closeErr?.message}`);
    assert.equal(closeRes.success, true, `Close failed: ${JSON.stringify(closeRes)}`);
    assert.equal(closeRes.status, 'pending');
    assert.equal(closeRes.version, stl.version + 1);
  });

  // 5. Criação e Pagamento do Lote via admin_create_rider_payment_batch e admin_mark_rider_payment_batch_paid
  await t.test('5. Criação e marcação de lote de pagamento como pago altera status para paid', async () => {
    const { data: stl } = await adminClient.from('rider_weekly_settlements').select('id, version').eq('id', activeSettlementId).single();

    const { data: batchRes, error: batchErr } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: stl.id,
      p_expected_version: stl.version
    });

    assert.ok(!batchErr, `Batch create error: ${batchErr?.message}`);
    assert.equal(batchRes.success, true, `Batch create failed: ${JSON.stringify(batchRes)}`);
    createdBatchIds.push(batchRes.batch_id);

    const { data: payRes, error: payErr } = await adminClient.rpc('admin_mark_rider_payment_batch_paid', {
      p_batch_id: batchRes.batch_id,
      p_expected_version: 1,
      p_payment_method: 'PIX',
      p_payment_reference: 'PIX-TEST-12345',
      p_notes: 'Lote pago via PIX',
      p_idempotency_key: `idemp-mark-paid-${Date.now()}`
    });

    assert.ok(!payErr, `Pay RPC error: ${payErr?.message}`);
    assert.equal(payRes.success, true, `Pay failed: ${JSON.stringify(payRes)}`);
    assert.equal(payRes.status, 'paid');

    const { data: stlPaid } = await adminClient.from('rider_weekly_settlements').select('status, paid_amount').eq('id', stl.id).single();
    assert.equal(stlPaid.status, 'paid');
  });

  // 6. Estorno do Lote de Pagamento via admin_reverse_rider_payment_batch
  await t.test('6. Estorno do lote de pagamento reverte itens para eligible e settlement para pending sem apagar histórico', async () => {
    const batchId = createdBatchIds[createdBatchIds.length - 1];

    const { data: revRes, error: revErr } = await adminClient.rpc('admin_reverse_rider_payment_batch', {
      p_batch_id: batchId,
      p_expected_version: 1,
      p_reason: 'Erro de digitação no PIX',
      p_idempotency_key: `idemp-rev-${Date.now()}`
    });

    assert.ok(!revErr, `Reverse RPC error: ${revErr?.message}`);
    assert.equal(revRes.success, true, `Reverse failed: ${JSON.stringify(revRes)}`);
    assert.equal(revRes.status, 'reversed');

    const { data: stlRev } = await adminClient.from('rider_weekly_settlements').select('status, paid_amount').eq('id', activeSettlementId).single();
    assert.equal(stlRev.status, 'pending');
    assert.equal(Number(stlRev.paid_amount), 0.00);
  });

  // 7. Cliente comercial chamando RPCs administrativas financeiras recebe PERMISSION_DENIED
  await t.test('7. Cliente comercial chamando RPCs administrativas financeiras recebe PERMISSION_DENIED', async () => {
    const { data: denyRes } = await clientUserClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: pStart,
      p_period_end: pEnd
    });

    assert.equal(denyRes.success, false);
    assert.equal(denyRes.error_code, 'PERMISSION_DENIED');
  });
});
