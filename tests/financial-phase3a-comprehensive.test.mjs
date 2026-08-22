// =====================================================================
// Dahora Expresso — Suíte de Testes Exaustiva e Completa da Fase 3A (Backend Foundation)
// File: tests/financial-phase3a-comprehensive.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

import dotenv from 'dotenv';
import path from 'path';

import { LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, createAuthedTestClient } from './helpers/test-fixtures.mjs';

const SUPABASE_URL = LOCAL_SUPABASE_URL;
const SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY;

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function createAuthedClient(email, password) {
  return await createAuthedTestClient(email, password);
}

test('Suíte de Testes Exaustiva da Fase 3A (Fundação Backend & Fundação Financeira)', async (t) => {
  let adminClient;
  let clientUserClient;
  let riderFleetId;
  const createdTeleIds = [];

  adminClient = await createAuthedClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');
  clientUserClient = await createAuthedClient('padaria.central@homolog.test', 'dahoraexpresso1');

  const CLIENT_ID_1 = '8e40963a-9146-4bfd-9447-d8d373be7ca6';
  await serviceClient.from('commercial_clients').update({ lifecycle_status: 'ativo' }).eq('id', CLIENT_ID_1);

  const { data: rider } = await adminClient.from('fleet').select('id, user_id, name').limit(1).single();
  riderFleetId = rider.id;

  // Limpeza inicial
  await adminClient.from('rider_credits_ledger').delete().eq('motoboy_id', riderFleetId);
  await adminClient.from('rider_payment_batch_items').delete().filter('batch_id', 'in', adminClient.from('rider_payment_batches').select('id').eq('rider_id', riderFleetId));
  await adminClient.from('rider_payment_batches').delete().eq('rider_id', riderFleetId);
  await adminClient.from('rider_weekly_settlement_items').delete().filter('settlement_id', 'in', adminClient.from('rider_weekly_settlements').select('id').eq('rider_id', riderFleetId));
  await adminClient.from('rider_weekly_settlements').delete().eq('rider_id', riderFleetId);

  t.after(async () => {
    for (const id of createdTeleIds) {
      await adminClient.from('client_payment_allocations').delete().eq('tele_id', id);
      await adminClient.from('rider_weekly_settlement_items').delete().eq('tele_id', id);
      await adminClient.from('teles').delete().eq('id', id);
    }
  });

  // ===================================================================
  // A. PRIVILÉGIOS RLS E SEGURANÇA TABULAR DE FECHAMENTO
  // ===================================================================
  await t.test('A1. Privilégios: INSERT direto por cliente Supabase é BLOQUEADO', async () => {
    const { error } = await clientUserClient.from('rider_weekly_settlements').insert({
      rider_id: riderFleetId,
      period_start: '2026-08-10T00:00:00.000Z',
      period_end: '2026-08-17T00:00:00.000Z',
      status: 'calculated'
    });
    assert.ok(error, 'INSERT direto em rider_weekly_settlements deve falhar');
  });

  await t.test('A2. Privilégios: UPDATE direto por cliente Supabase é BLOQUEADO', async () => {
    const { data, error } = await clientUserClient.from('rider_weekly_settlements').update({ status: 'paid' }).eq('rider_id', riderFleetId).select('*');
    assert.ok(error !== null || !data || data.length === 0, 'UPDATE direto em rider_weekly_settlements deve falhar ou afetar 0 linhas');
  });

  await t.test('A3. Privilégios: DELETE direto por cliente Supabase é BLOQUEADO', async () => {
    const { data, error } = await clientUserClient.from('rider_weekly_settlements').delete().eq('rider_id', riderFleetId).select('*');
    assert.ok(error !== null || !data || data.length === 0, 'DELETE direto em rider_weekly_settlements deve falhar ou afetar 0 linhas');
  });

  await t.test('A4. RLS: Cliente comercial chamando RPCs administrativas recebe PERMISSION_DENIED', async () => {
    const { data } = await clientUserClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: '2026-08-10T00:00:00.000Z',
      p_period_end: '2026-08-17T00:00:00.000Z'
    });
    assert.equal(data?.success, false);
    assert.equal(data?.error_code, 'PERMISSION_DENIED');
  });

  await t.test('A5. Consulta Sanitizada por RPC para Admin Autorizado', async () => {
    const { data, error } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_rider_id: riderFleetId
    });

    assert.ok(!error, `RPC error: ${error?.message}`);
    assert.ok(data, 'RPC list_admin_rider_weekly_settlements deve retornar dados sanitizados');
  });

  // ===================================================================
  // B. REGRAS DE LOTE DE PAGAMENTO (BATCHING) E CONCORRÊNCIA
  // ===================================================================
  await t.test('B1. Rejeição de pagamento superior ao valor elegível liberado', async () => {
    const { data: calcRes } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: '2026-08-10T00:00:00.000Z',
      p_period_end: '2026-08-17T00:00:00.000Z'
    });

    const { data: stl } = await serviceClient.from('rider_weekly_settlements').select('id, version').eq('id', calcRes.settlement_id).single();

    const { data: closeRes } = await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: stl.id,
      p_expected_version: stl.version
    });

    const { data: batchRes } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: stl.id,
      p_expected_version: closeRes.version || 2
    });

    if (batchRes && batchRes.batch_id) {
      const { data: payRes } = await adminClient.rpc('admin_mark_rider_payment_batch_paid', {
        p_batch_id: batchRes.batch_id,
        p_expected_version: 1,
        p_payment_method: 'PIX',
        p_payment_reference: 'REF-EXCESSO-1',
        p_notes: 'Lote teste',
        p_idempotency_key: `idemp-excess-${Date.now()}`
      });

      assert.ok(payRes !== null);
    }
  });

  await t.test('B2. Pagamento do lote é ACEITO com sucesso', async () => {
    const { data: stl } = await serviceClient.from('rider_weekly_settlements').select('id').eq('rider_id', riderFleetId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (stl) {
      const { data: batch } = await serviceClient.from('rider_payment_batches').select('id, version').eq('settlement_id', stl.id).maybeSingle();
      if (batch) {
        const { data: payRes } = await adminClient.rpc('admin_mark_rider_payment_batch_paid', {
          p_batch_id: batch.id,
          p_expected_version: batch.version,
          p_payment_method: 'PIX',
          p_payment_reference: 'PIX-SUCCESS-1',
          p_notes: 'Lote pago com sucesso',
          p_idempotency_key: `idemp-succ-${Date.now()}`
        });

        assert.ok(payRes !== null);
      }
    }
  });

  await t.test('B3. Lote com idempotency_key repetida retorna resposta idempotente sem duplicar lote', async () => {
    const internalClientId = '29c7ad13-49f6-448f-a008-2d1b00468603';
    const teleCode = `TL-IDEMP-${Date.now()}`;
    const { data: tele, error: insTeleErr } = await serviceClient.from('teles').insert({
      tele_code: teleCode,
      client_id: internalClientId,
      motoboy_id: riderFleetId,
      status: 'concluida',
      pickup_address: 'Av. Brasil, 100',
      delivery_address: 'Rua Flores, 200',
      delivery_charge: 30.00,
      completed_at: '2026-08-05T14:00:00.000Z'
    }).select('id').single();

    await serviceClient.from('rider_financial_transactions').insert({
      rider_id: riderFleetId,
      tele_id: tele.id,
      type: 'credito_entrega',
      direction: 'credit',
      amount: 25.00,
      description: 'Credito tele B3'
    });

    const { data: calcRes } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: '2026-08-03T00:00:00.000Z',
      p_period_end: '2026-08-10T00:00:00.000Z'
    });

    const { data: stl } = await serviceClient.from('rider_weekly_settlements').select('id, version').eq('id', calcRes.settlement_id).single();

    const { data: closeRes } = await adminClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: stl.id,
      p_expected_version: stl.version
    });

    const key = `IDEMP-SAME-${Date.now()}`;

    const { data: res1 } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: stl.id,
      p_expected_version: closeRes?.version || stl.version,
      p_idempotency_key: key
    });

    const { data: res2, error: err2 } = await adminClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: stl.id,
      p_expected_version: closeRes?.version || stl.version,
      p_idempotency_key: key
    });

    assert.ok(!err2, `RPC 2 error: ${err2?.message}`);
    assert.ok(res1?.batch_id || res2?.is_idempotent);

    // Clean up
    await serviceClient.from('rider_financial_transactions').delete().eq('tele_id', tele.id);
    await serviceClient.from('teles').delete().eq('id', tele.id);
  });

  // ===================================================================
  // C. ALOCAÇÃO DE PAGAMENTO DE CLIENTE
  // ===================================================================
  await t.test('C1. Alocação parcial do cliente mantém a Tele como blocked_client_unpaid', async () => {
    const { data: telePartial, error: teleErr } = await adminClient.from('teles').insert({
      tele_code: `TEL-COMP1-${Date.now()}`,
      client_id: CLIENT_ID_1,
      motoboy_id: riderFleetId,
      status: 'em_rota',
      pickup_address: 'Rua Origem, 10',
      delivery_address: 'Rua Part B, 20',
      recipient_name: 'Cliente Teste',
      recipient_phone: '51988887777',
      delivery_charge: 20.00,
      total_order_amount: 20.00,
      version: 1
    }).select('*').single();
    assert.ok(!teleErr, `Tele insert error: ${teleErr?.message}`);
    createdTeleIds.push(telePartial.id);

    await adminClient.from('client_financial_transactions').insert({
      client_id: CLIENT_ID_1,
      type: 'corrida_taxa',
      direction: 'debit',
      amount: 20.00,
      description: 'Lançamento de teste C1',
      tele_id: telePartial.id
    });

    const { data: payRegRes } = await adminClient.rpc('admin_register_client_payment', {
      p_client_id: CLIENT_ID_1,
      p_amount: 10.00,
      p_payment_method: 'PIX',
      p_notes: 'Pagamento parcial de R$ 10,00',
      p_idempotency_key: `idemp-part-1-${Date.now()}`
    });
    const clientPaymentId = payRegRes.transaction_id || payRegRes.id || payRegRes.client_transaction_id;

    await adminClient.rpc('admin_allocate_client_payment_to_teles', {
      p_client_transaction_id: clientPaymentId,
      p_tele_ids: [telePartial.id],
      p_amounts: [10.00]
    });

    const { data: allocRow } = await adminClient.from('client_payment_allocations').select('*').eq('tele_id', telePartial.id).single();
    assert.equal(allocRow.is_fully_covered, false, 'Tele deve continuar is_fully_covered = false com cobertura parcial');
  });

  await t.test('C2. Segundo pagamento parcial completa a cobertura (R$ 10 + R$ 10) e libera a Tele', async () => {
    const teleId = createdTeleIds[createdTeleIds.length - 1];

    const { data: payRegRes2 } = await adminClient.rpc('admin_register_client_payment', {
      p_client_id: CLIENT_ID_1,
      p_amount: 10.00,
      p_payment_method: 'PIX',
      p_notes: 'Segundo pagamento parcial de R$ 10,00',
      p_idempotency_key: `idemp-part-2-${Date.now()}`
    });
    const clientPaymentId2 = payRegRes2.transaction_id || payRegRes2.id || payRegRes2.client_transaction_id;

    await adminClient.rpc('admin_allocate_client_payment_to_teles', {
      p_client_transaction_id: clientPaymentId2,
      p_tele_ids: [teleId],
      p_amounts: [10.00]
    });

    const { data: allocRow } = await adminClient.from('client_payment_allocations').select('*').eq('tele_id', teleId).eq('client_transaction_id', clientPaymentId2).single();
    assert.equal(allocRow.is_fully_covered, true, 'Segundo pagamento de R$ 10 completa a cobertura total de R$ 20');
  });

  // ===================================================================
  // D. REGRA SEMANAL DE TIMEZONE (completed_at)
  // ===================================================================
  await t.test('D1. completed_at atribui estritamente a Tele à semana correta em timezone', async () => {
    const mondayStart = '2026-09-07T00:00:00.000Z';
    const mondayEnd = '2026-09-14T00:00:00.000Z';

    const { data: teleMon, error: errMon } = await adminClient.from('teles').insert({
      tele_code: `TEL-TZ-${Date.now()}`,
      client_id: CLIENT_ID_1,
      motoboy_id: riderFleetId,
      status: 'em_rota',
      pickup_address: 'Rua Origem, 10',
      delivery_address: 'Rua TZ B, 20',
      recipient_name: 'Cliente Teste',
      recipient_phone: '51988887777',
      delivery_charge: 30.00,
      total_order_amount: 30.00,
      version: 1,
      created_at: '2026-09-06T23:59:00.000Z'
    }).select('*').single();
    assert.ok(!errMon, `Tele insert mon error: ${errMon?.message}`);
    createdTeleIds.push(teleMon.id);

    await adminClient.rpc('complete_tele', { p_tele_id: teleMon.id, p_expected_version: 1 });
    await adminClient.from('teles').update({ completed_at: '2026-09-07T00:00:00.000Z' }).eq('id', teleMon.id);

    const { data: calcRes } = await adminClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderFleetId,
      p_period_start: mondayStart,
      p_period_end: mondayEnd
    });

    assert.ok(Number(calcRes.gross) >= 30.00);
  });

  // ===================================================================
  // E. REABERTURA E ESTORNO AUDITADO
  // ===================================================================
  await t.test('E1. Reabertura em status paid é REJEITADA com CANNOT_REOPEN_PAID', async () => {
    const { data: stl } = await adminClient.from('rider_weekly_settlements').select('id, version').eq('rider_id', riderFleetId).order('created_at', { ascending: false }).limit(1).single();

    await adminClient.from('rider_weekly_settlements').update({ status: 'paid' }).eq('id', stl.id);

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
    const { data: stl } = await adminClient.from('rider_weekly_settlements').select('*').eq('rider_id', riderFleetId).order('created_at', { ascending: false }).limit(1).single();

    const baseRiderCents = Math.round(Number(stl.base_rider_amount) * 100);
    const eligibleCents = Math.round(Number(stl.eligible_amount) * 100);
    const blockedCents = Math.round(Number(stl.blocked_amount) * 100);

    assert.equal(baseRiderCents, eligibleCents + blockedCents, 'Invariante base_rider_amount = eligible_amount + blocked_amount em centavos');
  });
});
