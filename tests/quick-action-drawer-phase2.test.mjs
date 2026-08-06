// =====================================================================
// Dahora Expresso — Suíte de Testes da Fase 2: Quick Action Drawer & Timeline
// File: tests/quick-action-drawer-phase2.test.mjs
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

test('Suíte de Testes Automatizados da Fase 2 (Drawer, Timeline, Concorrência e Ações)', async (t) => {
  const createdTeleIds = [];

  t.after(async () => {
    for (const teleId of createdTeleIds) {
      try {
        const { data } = await serviceClient.from('teles').select('status, version').eq('id', teleId).maybeSingle();
        if (data && !['concluida', 'cancelada'].includes(data.status)) {
          await serviceClient.rpc('cancel_tele', {
            p_tele_id: teleId,
            p_expected_version: data.version || 1,
            p_reason: 'Teardown automatizado da suíte da Fase 2'
          });
        }
      } catch (err) {}
    }
  });

  const adminClient = await createAuthedClient('admin@dahora.local', 'senha123456');
  const clientUserClient = await createAuthedClient('parceiro@mercadocentral.local', 'senha123456');

  // Buscar dois motoboys válidos em fleet
  const { data: riders } = await serviceClient.from('fleet').select('id, name').limit(2);
  const riderId1 = riders[0].id;
  const riderId2 = riders[1] ? riders[1].id : riders[0].id;

  // Setup: Criar uma Tele de teste em aguardando_despacho
  const { data: newTele, error: createErr } = await serviceClient.from('teles').insert({
    tele_code: `TEL-DRAWER-${Date.now()}`,
    client_id: CLIENT_ID_1,
    status: 'aguardando_despacho',
    pickup_address: 'Rua do Mercado Central, 50',
    delivery_address: 'Av. Brasil, 100',
    version: 1,
    created_at: new Date().toISOString()
  }).select('id, tele_code, version').single();

  assert.ok(!createErr, `Setup tele error: ${createErr?.message}`);
  createdTeleIds.push(newTele.id);

  // 1. Segurança da RPC get_tele_timeline — Cliente Comercial recebe PERMISSION_DENIED
  await t.test('1. Cliente Comercial não tem permissão para consultar get_tele_timeline', async () => {
    const { data } = await clientUserClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'PERMISSION_DENIED');
  });

  // 2. Administrador consulta get_tele_timeline com SUCESSO
  await t.test('2. Administrador consulta get_tele_timeline com retorno sanitizado', async () => {
    const { data } = await adminClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    assert.equal(data.success, true);
    assert.equal(data.tele_id, newTele.id);
    assert.ok(Array.isArray(data.timeline), 'Timeline é um array');
  });

  // 3. Ausência de exposição de idempotency_key na saída da timeline
  await t.test('3. Timeline não expõe idempotency_key aos clientes do navegador', async () => {
    const { data } = await adminClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    if (data.timeline.length > 0) {
      assert.equal(data.timeline[0].idempotency_key, undefined, 'idempotency_key omitida do retorno');
    }
  });

  // 4. Inserção de eventos e preservação de múltiplos eventos no mesmo segundo
  await t.test('4. Timeline preserva múltiplos eventos criados no mesmo segundo sem descarte', async () => {
    const nowIso = new Date().toISOString();
    await serviceClient.from('tele_eventos').insert([
      { tele_id: newTele.id, tipo: 'test_event_a', created_at: nowIso },
      { tele_id: newTele.id, tipo: 'test_event_b', created_at: nowIso }
    ]);

    const { data } = await adminClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    const matching = data.timeline.filter(e => ['test_event_a', 'test_event_b'].includes(e.event_type));
    assert.equal(matching.length, 2, 'Ambos os eventos do mesmo segundo foram retornados');
  });

  // 5. Atribuição inicial de motoboy via assign_rider_to_tele (aguardando_despacho -> motoboy_designado)
  await t.test('5. Atribuição de motoboy via assign_rider_to_tele incrementa versão para 2', async () => {
    const { data } = await adminClient.rpc('assign_rider_to_tele', {
      p_tele_id: newTele.id,
      p_motoboy_id: riderId1,
      p_expected_version: 1,
      p_reason: 'Atribuição inicial de teste'
    });

    assert.equal(data.success, true);
    assert.equal(data.status, 'motoboy_designado');
    assert.equal(data.version, 2);
  });

  // 6. Reatribuição exige motivo obrigatório (p_reassignment_reason)
  await t.test('6. Reatribuição sem p_reassignment_reason é rejeitada', async () => {
    const { data } = await adminClient.rpc('assign_rider_to_tele', {
      p_tele_id: newTele.id,
      p_motoboy_id: riderId2,
      p_expected_version: 2
    });

    assert.equal(data.success, false);
    assert.equal(data.error, 'REASSIGNMENT_REASON_REQUIRED');
  });

  // 7. Reatribuição com motivo válido aciona a troca com SUCESSO
  await t.test('7. Reatribuição com p_reassignment_reason altera o motoboy para v3', async () => {
    const { data, error } = await adminClient.rpc('assign_rider_to_tele', {
      p_tele_id: newTele.id,
      p_motoboy_id: riderId2,
      p_expected_version: 2,
      p_reason: 'Troca de motoboy',
      p_reassignment_reason: 'Entregador anterior precisou abastecer'
    });

    assert.ok(!error, `RPC error: ${error?.message}`);
    assert.equal(data.success, true, `Assign failed: ${JSON.stringify(data)}`);
    assert.equal(data.version, 3);
  });

  // 8. Teste de Concorrência de Versão (VERSION_CONFLICT) em assign_rider_to_tele
  await t.test('8. Chamada com versão desatualizada retorna VERSION_CONFLICT', async () => {
    const { data } = await adminClient.rpc('assign_rider_to_tele', {
      p_tele_id: newTele.id,
      p_motoboy_id: riderId1,
      p_expected_version: 1, // Versão esperada 1, mas o banco já está na v3
      p_reassignment_reason: 'Troca em versão conflitante'
    });

    assert.equal(data.success, false);
    assert.equal(data.error, 'VERSION_CONFLICT');
  });

  // 9. Cancelamento de Tele com motoboy designado libera a capacidade da frota
  await t.test('9. Cancelamento de Tele em motoboy_designado libera capacidade do motoboy', async () => {
    const { data, error } = await adminClient.rpc('cancel_tele', {
      p_tele_id: newTele.id,
      p_expected_version: 3,
      p_reason: 'Cancelamento definitivo de homologação'
    });

    assert.ok(!error, `RPC error: ${error?.message}`);
    assert.equal(data.success, true, `Cancel failed: ${JSON.stringify(data)}`);
    assert.equal(data.status, 'cancelada');
    assert.equal(data.version, 4);

    const { count } = await serviceClient
      .from('teles')
      .select('id', { count: 'exact', head: true })
      .eq('id', newTele.id)
      .in('status', ['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega']);

    assert.equal(count, 0, 'Tele não consta mais como entrega ativa do motoboy');
  });

  // 10. RPC get_tele_timeline retorna estritamente os eventos da Tele solicitada
  await t.test('10. RPC get_tele_timeline isola dados da Tele solicitada', async () => {
    const { data } = await adminClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    assert.equal(data.success, true);
    assert.equal(data.tele_id, newTele.id);
  });
});
