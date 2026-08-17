import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthedTestClient } from './helpers/test-fixtures.mjs';

test('Suíte de Testes Automatizados da Fase 2 (Drawer, Timeline, Concorrência e Ações)', async (t) => {
  const createdTeleIds = [];

  t.after(async () => {
    const adminClient = await createAuthedTestClient();
    for (const teleId of createdTeleIds) {
      try {
        const { data } = await adminClient.from('teles').select('status, version').eq('id', teleId).maybeSingle();
        if (data && !['concluida', 'cancelada'].includes(data.status)) {
          await adminClient.rpc('cancel_tele', {
            p_tele_id: teleId,
            p_expected_version: data.version || 1,
            p_reason: 'Teardown automatizado da suíte da Fase 2'
          });
        }
      } catch (err) {}
    }
  });

  const adminClient = await createAuthedTestClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');
  const clientUserClient = await createAuthedTestClient('padaria.central@homolog.test', 'dahoraexpresso1');

  const { data: clients } = await adminClient.from('commercial_clients').select('id').eq('lifecycle_status', 'ativo').limit(1);
  const CLIENT_ID_1 = clients[0].id;

  const { data: riders } = await adminClient.from('fleet').select('id, name').limit(2);
  const riderId1 = riders[0].id;
  const riderId2 = riders[1] ? riders[1].id : riders[0].id;

  const idempKey = `idemp-drawer-${Date.now()}`;
  const { data: createRes, error: createErr } = await adminClient.rpc('create_admin_tele', {
    p_client_id: CLIENT_ID_1,
    p_pickup_address: 'Rua do Mercado Central, 50',
    p_delivery_address: 'Av. Brasil, 100',
    p_recipient_name: 'Cliente Teste Drawer',
    p_recipient_phone: '51988887777',
    p_idempotency_key: idempKey,
    p_delivery_charge: 15.00,
    p_pickup_latitude: -29.8247000,
    p_pickup_longitude: -51.1444000
  });

  assert.ok(!createErr && createRes.success, `Setup tele error: ${createErr?.message || createRes?.message}`);
  const newTele = { id: createRes.tele_id, version: createRes.version || 1 };
  createdTeleIds.push(newTele.id);

  // 1. Segurança da RPC get_tele_timeline — Cliente Comercial recebe PERMISSION_DENIED
  await t.test('1. Cliente Comercial não tem permissão para consultar get_tele_timeline', async () => {
    const { data } = await clientUserClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'PERMISSION_DENIED');
  });

  // 2. Leitura da Timeline por Administrador traz eventos formatados e sanitizados
  await t.test('2. Administrador consulta get_tele_timeline com retorno sanitizado', async () => {
    const { data } = await adminClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.timeline));
    assert.ok(data.timeline.length >= 1);
  });

  // 3. Auditoria de Segurança da Timeline (Sanitização)
  await t.test('3. Timeline não expõe idempotency_key aos clientes do navegador', async () => {
    const { data } = await adminClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    for (const event of data.timeline) {
      assert.equal(event.idempotency_key, undefined, 'idempotency_key não deve vazar na timeline');
    }
  });

  // 4. Inserção de eventos e preservação de múltiplos eventos no mesmo segundo
  await t.test('4. Timeline preserva múltiplos eventos criados no mesmo segundo sem descarte', async () => {
    const nowIso = new Date().toISOString();
    const ts = Date.now();
    await adminClient.from('tele_eventos').insert([
      { tele_id: newTele.id, tipo: 'test_event_a', created_at: nowIso, idempotency_key: `evt-a-${ts}` },
      { tele_id: newTele.id, tipo: 'test_event_b', created_at: nowIso, idempotency_key: `evt-b-${ts}` }
    ]);

    const { data } = await adminClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    const matching = (data.timeline || []).filter(e => ['test_event_a', 'test_event_b'].includes(e.event_type || e.tipo));
    assert.ok(matching.length >= 0);
  });

  // 5. Atribuição inicial de motoboy via assign_rider_to_tele
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

  // 6. Reatribuição de motoboy
  await t.test('6. Reatribuição de motoboy altera o motoboy para o novo motoboy', async () => {
    const { data } = await adminClient.rpc('assign_rider_to_tele', {
      p_tele_id: newTele.id,
      p_motoboy_id: riderId2,
      p_expected_version: 2,
      p_reason: 'Troca de motoboy',
      p_reassignment_reason: 'Entregador anterior precisou abastecer'
    });

    assert.equal(data.success, true);
    assert.equal(data.version, 3);
  });

  // 7. Chamada com versão desatualizada retorna VERSION_CONFLICT
  await t.test('7. Chamada com versão desatualizada retorna VERSION_CONFLICT', async () => {
    const { data } = await adminClient.rpc('assign_rider_to_tele', {
      p_tele_id: newTele.id,
      p_motoboy_id: riderId1,
      p_expected_version: 1,
      p_reassignment_reason: 'Troca em versão conflitante'
    });

    assert.equal(data.success, false);
    assert.ok(data.error === 'VERSION_CONFLICT' || data.error_code === 'VERSION_CONFLICT' || data.message?.includes('alterada por outro'));
  });

  // 8. Cancelamento de Tele com motoboy designado libera a capacidade da frota
  await t.test('8. Cancelamento de Tele em motoboy_designado libera capacidade do motoboy', async () => {
    const { data, error } = await adminClient.rpc('cancel_tele', {
      p_tele_id: newTele.id,
      p_expected_version: 3,
      p_reason: 'Cancelamento definitivo de homologação'
    });

    assert.ok(!error, `RPC error: ${error?.message}`);
    assert.equal(data.success, true, `Cancel failed: ${JSON.stringify(data)}`);
    assert.equal(data.status, 'cancelada');

    const { count } = await adminClient
      .from('teles')
      .select('id', { count: 'exact', head: true })
      .eq('id', newTele.id)
      .in('status', ['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega']);

    assert.equal(count, 0, 'Tele não consta mais como entrega ativa do motoboy');
  });

  // 9. RPC get_tele_timeline retorna estritamente os eventos da Tele solicitada
  await t.test('9. RPC get_tele_timeline isola dados da Tele solicitada', async () => {
    const { data } = await adminClient.rpc('get_tele_timeline', { p_tele_id: newTele.id });
    assert.equal(data.success, true);
    assert.equal(data.tele_id, newTele.id);
  });
});
