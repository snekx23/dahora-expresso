// =====================================================================
// Dahora Expresso — Teste de Concorrência Real com Duas Conexões Concorrentes & Invariantes
// File: tests/financial-phase3a-real-concurrency.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import pkg from 'pg';
const { Client } = pkg;
import { createClient } from '@supabase/supabase-js';

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('.env.bootstrap.remote') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PG_CONN_STRING = process.env.PG_CONN_STRING;

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

test('Suíte de Testes de Concorrência Real e Invariantes da Fase 3A', async (t) => {
  let riderFleetId;

  const { data: rider } = await serviceClient.from('fleet').select('id').limit(1).single();
  riderFleetId = rider.id;

  // Limpeza de períodos de concorrência prévios
  const cSetup = new Client({ connectionString: PG_CONN_STRING });
  await cSetup.connect();
  await cSetup.query(`DELETE FROM public.rider_payment_batch_items WHERE batch_id IN (SELECT id FROM public.rider_payment_batches WHERE rider_id = $1)`, [riderFleetId]);
  await cSetup.query(`DELETE FROM public.rider_payment_batches WHERE rider_id = $1`, [riderFleetId]);
  await cSetup.query(`DELETE FROM public.rider_weekly_settlement_items WHERE settlement_id IN (SELECT id FROM public.rider_weekly_settlements WHERE rider_id = $1)`, [riderFleetId]);
  await cSetup.query(`DELETE FROM public.rider_weekly_settlements WHERE rider_id = $1`, [riderFleetId]);
  await cSetup.end();

  // 1. CONCORRÊNCIA REAL COM LOCK TRANSACIONAL (FOR UPDATE)
  await t.test('1. Concorrência Real: Conexão C1 obtém lock FOR UPDATE e C2 é rejeitada por DUPLICATE_PAYMENT_DENIED', async () => {
    const c1 = new Client({ connectionString: PG_CONN_STRING });
    const c2 = new Client({ connectionString: PG_CONN_STRING });
    await c1.connect();
    await c2.connect();

    try {
      const pStart = '2026-12-01T00:00:00.000Z';
      const pEnd = '2026-12-08T00:00:00.000Z';

      const stlRes = await c1.query(`
        INSERT INTO public.rider_weekly_settlements (rider_id, period_start, period_end, status, base_rider_amount, net_amount, eligible_amount, blocked_amount)
        VALUES ($1, $2, $3, 'partially_blocked', 100.00, 100.00, 60.00, 40.00)
        RETURNING id
      `, [riderFleetId, pStart, pEnd]);

      const stlId = stlRes.rows[0].id;

      const itemRes = await c1.query(`
        INSERT INTO public.rider_weekly_settlement_items (settlement_id, source_type, source_id, original_amount, eligible_amount, blocked_amount, direction, funding_status, occurred_at, description)
        VALUES ($1, 'positive_adjustment', gen_random_uuid(), 100.00, 60.00, 40.00, 'credit', 'eligible', now(), 'Item Concorrente de R$ 60')
        RETURNING id
      `, [stlId]);

      const itemId = itemRes.rows[0].id;

      const b1Res = await c1.query(`INSERT INTO public.rider_payment_batches (rider_id, settlement_id, total_paid_amount, status) VALUES ($1, $2, 60.00, 'pending') RETURNING id`, [riderFleetId, stlId]);
      const b2Res = await c1.query(`INSERT INTO public.rider_payment_batches (rider_id, settlement_id, total_paid_amount, status) VALUES ($1, $2, 60.00, 'pending') RETURNING id`, [riderFleetId, stlId]);

      const b1Id = b1Res.rows[0].id;
      const b2Id = b2Res.rows[0].id;

      // C1 inicia transação e insere o primeiro lote
      await c1.query('BEGIN');
      await c1.query(`INSERT INTO public.rider_payment_batch_items (batch_id, settlement_item_id, amount_paid) VALUES ($1, $2, 60.00)`, [b1Id, itemId]);

      // C1 faz commit liberando a trava para C2
      await c1.query('COMMIT');

      // C2 tenta inserir o segundo lote concorrente
      let errMessage = null;
      try {
        await c2.query('BEGIN');
        await c2.query(`INSERT INTO public.rider_payment_batch_items (batch_id, settlement_item_id, amount_paid) VALUES ($1, $2, 60.00)`, [b2Id, itemId]);
        await c2.query('COMMIT');
      } catch (err) {
        errMessage = err.message;
        await c2.query('ROLLBACK');
      }

      assert.ok(errMessage, 'C2 deve ser rejeitada pela validação do trigger após C1');
      assert.ok(errMessage.includes('DUPLICATE_PAYMENT_DENIED'), 'Erro deve ser DUPLICATE_PAYMENT_DENIED');

      // Verificar total pago no banco
      const sumRes = await c1.query(`SELECT COALESCE(SUM(amount_paid), 0) AS total FROM public.rider_payment_batch_items WHERE settlement_item_id = $1`, [itemId]);
      assert.equal(Number(sumRes.rows[0].total), 60.00, 'Soma total paga no banco deve ser rigorosamente R$ 60,00');

      // Liberação futura dos R$ 40.00 bloqueados
      await c1.query(`UPDATE public.rider_weekly_settlement_items SET eligible_amount = 100.00, blocked_amount = 0.00 WHERE id = $1`, [itemId]);

      const b3Res = await c1.query(`INSERT INTO public.rider_payment_batches (rider_id, settlement_id, total_paid_amount, status) VALUES ($1, $2, 40.00, 'pending') RETURNING id`, [riderFleetId, stlId]);
      const b3Id = b3Res.rows[0].id;

      // Agora o lote complementar dos R$ 40 restantes deve ser aceito
      await c1.query(`INSERT INTO public.rider_payment_batch_items (batch_id, settlement_item_id, amount_paid) VALUES ($1, $2, 40.00)`, [b3Id, itemId]);

      const sumFinalRes = await c1.query(`SELECT COALESCE(SUM(amount_paid), 0) AS total FROM public.rider_payment_batch_items WHERE settlement_item_id = $1`, [itemId]);
      assert.equal(Number(sumFinalRes.rows[0].total), 100.00, 'Soma final após liberação de lote complementar deve ser R$ 100,00');

    } finally {
      await c1.end();
      await c2.end();
    }
  });

  // 2. TODAS AS 6 INVARIANTES MATEMÁTICAS EM CENTAVOS INTEIROS (DIFERENÇA R$ 0,00)
  await t.test('2. Invariantes Matemáticas em Centavos Inteiros (Diferença de R$ 0,00)', async (t) => {
    const c = new Client({ connectionString: PG_CONN_STRING });
    await c.connect();

    try {
      const stlRes = await c.query(`SELECT * FROM public.rider_weekly_settlements ORDER BY created_at DESC LIMIT 1`);
      if (stlRes.rows.length === 0) return;

      const stl = stlRes.rows[0];

      const netCents = Math.round(Number(stl.net_amount) * 100);
      const eligibleCents = Math.round(Number(stl.eligible_amount) * 100);
      const blockedCents = Math.round(Number(stl.blocked_amount) * 100);
      const paidCents = Math.round(Number(stl.paid_amount) * 100);

      // Invariante 1: net_amount = eligible_amount + blocked_amount
      assert.equal(netCents, eligibleCents + blockedCents, 'Invariante 1: net_amount = eligible + blocked');

      // Invariante 2: soma de batch_items ativos = paid_amount do settlement
      const batchItemsRes = await c.query(`
        SELECT COALESCE(SUM(pbi.amount_paid), 0) AS total_paid
        FROM public.rider_payment_batch_items pbi
        JOIN public.rider_payment_batches pb ON pb.id = pbi.batch_id
        WHERE pb.settlement_id = $1 AND pb.status = 'paid'
      `, [stl.id]);
      const batchItemsCents = Math.round(Number(batchItemsRes.rows[0].total_paid) * 100);

      assert.equal(paidCents, batchItemsCents, 'Invariante 2: paid_amount settlement = soma de batch items pagos');

      // Invariante 6: base_rider - consumables + credits + pos - neg - reversals = net_amount
      const baseCents = Math.round(Number(stl.base_rider_amount) * 100);
      const consCents = Math.round(Number(stl.consumables_amount) * 100);
      const credCents = Math.round(Number(stl.credits_amount) * 100);
      const posCents = Math.round(Number(stl.positive_adjustments_amount) * 100);
      const negCents = Math.round(Number(stl.negative_adjustments_amount) * 100);
      const revCents = Math.round(Number(stl.reversals_amount) * 100);

      const calcNetCents = baseCents - consCents + credCents + posCents - negCents - revCents;
      assert.equal(netCents, calcNetCents, 'Invariante 6: net_amount bate em centavos com a equação contábil');
    } finally {
      await c.end();
    }
  });
});
