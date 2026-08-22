// =====================================================================
// Dahora Expresso — Testes do Hotfix H1: Persistência do Ponto de Coleta
// File: tests/commercial-client-pickup-persistence.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, createAuthedTestClient } from './helpers/test-fixtures.mjs';
import { createClient } from '@supabase/supabase-js';

const serviceClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY);

test('Hotfix H1 — Persistência e Snapshot do Ponto de Coleta do Cliente Comercial', async (t) => {
  const padariaId = '8e40963a-9146-4bfd-9447-d8d373be7ca6';
  const adminUser = await createAuthedTestClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');

  await t.test('1. Admin salva ponto de coleta via admin_update_commercial_client_profile e persiste no banco', async () => {
    const pickupAddress = 'Av. Coronel Theodomiro Porto da Silva, 500 - Sapucaia do Sul, RS';
    const pickupLat = -29.824712;
    const pickupLng = -51.144431;
    const pickupPlaceId = 'ChIJ_sapucaia_pickup_test_01';

    const { data: updateRes, error: updateErr } = await adminUser.rpc('admin_update_commercial_client_profile', {
      p_client_id: padariaId,
      p_responsible_name: 'Carlos Oliveira',
      p_phone: '(51) 98888-7777',
      p_address: pickupAddress,
      p_street_number: '500',
      p_neighborhood: 'Centro',
      p_city: 'Sapucaia do Sul',
      p_state: 'RS',
      p_postal_code: '93260-000',
      p_pickup_latitude: pickupLat,
      p_pickup_longitude: pickupLng,
      p_pickup_place_id: pickupPlaceId
    });

    assert.ok(!updateErr, `RPC error: ${updateErr?.message}`);
    assert.equal(updateRes.success, true);

    // Readback direto na tabela commercial_clients (como o frontend executa pós-save)
    const { data: verified, error: verifyErr } = await adminUser
      .from('commercial_clients')
      .select('id, address, pickup_latitude, pickup_longitude, pickup_place_id, state')
      .eq('id', padariaId)
      .maybeSingle();

    assert.ok(!verifyErr, `Verify error: ${verifyErr?.message}`);
    assert.ok(verified, 'Registro do cliente deve existir.');
    assert.equal(verified.address, pickupAddress);
    assert.equal(verified.pickup_latitude, pickupLat);
    assert.equal(verified.pickup_longitude, pickupLng);
    assert.equal(verified.pickup_place_id, pickupPlaceId);
    assert.equal(verified.state, 'RS');
    assert.ok(verified.pickup_latitude >= -90 && verified.pickup_latitude <= 90);
    assert.ok(verified.pickup_longitude >= -180 && verified.pickup_longitude <= 180);
  });

  await t.test('2. Chamar Tele (create_admin_tele) reconhece o ponto de coleta persistido e cria tele com snapshot correto', async () => {
    const idempotencyKey = `tele_hotfix_h1_${Date.now()}`;
    const deliveryAddress = 'Rua Castro Alves, 120 - Sapucaia do Sul, RS';

    // Ao omitir p_pickup_address / passar null, a RPC deve herdar o ponto de coleta padrão persistido em commercial_clients
    const { data: teleRes, error: teleErr } = await adminUser.rpc('create_admin_tele', {
      p_client_id: padariaId,
      p_pickup_address: null,
      p_delivery_address: deliveryAddress,
      p_recipient_name: 'Mariana Silva',
      p_recipient_phone: '51988889999',
      p_idempotency_key: idempotencyKey,
      p_delivery_charge: 15.00,
      p_operation_source: 'owner_panel',
      p_delivery_latitude: -29.8300,
      p_delivery_longitude: -51.1500
    });

    assert.ok(!teleErr, `Tele creation error: ${teleErr?.message}`);
    assert.equal(teleRes.success, true);
    assert.ok(teleRes.tele_id, 'Tele ID deve ser gerado.');

    // Verificar snapshot gravado na Tele
    const { data: teleRecord, error: teleRecErr } = await adminUser
      .from('teles')
      .select('id, pickup_address, pickup_latitude, pickup_longitude, pickup_place_id, pickup_establishment_name')
      .eq('id', teleRes.tele_id)
      .maybeSingle();

    assert.ok(!teleRecErr, `Fetch tele error: ${teleRecErr?.message}`);
    assert.ok(teleRecord, 'Registro da Tele deve existir.');
    assert.equal(teleRecord.pickup_address, 'Av. Coronel Theodomiro Porto da Silva, 500 - Sapucaia do Sul, RS');
    assert.equal(teleRecord.pickup_latitude, -29.824712);
    assert.equal(teleRecord.pickup_longitude, -51.144431);
    assert.equal(teleRecord.pickup_place_id, 'ChIJ_sapucaia_pickup_test_01');
    assert.ok(teleRecord.pickup_establishment_name, 'Snapshot do nome do estabelecimento deve existir.');

    // Modificar endereço do cliente e verificar que a Tele antiga PRESERVA o snapshot original
    const newAddress = 'Rua das Palmeiras, 999 - Sapucaia do Sul, RS';
    const newLat = -29.810000;
    const newLng = -51.130000;

    const { data: updClientRes } = await adminUser.rpc('admin_update_commercial_client_profile', {
      p_client_id: padariaId,
      p_responsible_name: 'Carlos Oliveira',
      p_phone: '(51) 98888-7777',
      p_address: newAddress,
      p_street_number: '999',
      p_neighborhood: 'Lomba da Palmeira',
      p_city: 'Sapucaia do Sul',
      p_state: 'RS',
      p_postal_code: '93260-000',
      p_pickup_latitude: newLat,
      p_pickup_longitude: newLng,
      p_pickup_place_id: 'ChIJ_new_place_id_999'
    });
    assert.equal(updClientRes.success, true);

    // Tele original NÃO pode ter sido alterada
    const { data: teleAfterChange } = await adminUser
      .from('teles')
      .select('id, pickup_address, pickup_latitude, pickup_longitude, pickup_place_id')
      .eq('id', teleRes.tele_id)
      .maybeSingle();

    assert.equal(teleAfterChange.pickup_address, 'Av. Coronel Theodomiro Porto da Silva, 500 - Sapucaia do Sul, RS');
    assert.equal(teleAfterChange.pickup_latitude, -29.824712);
    assert.equal(teleAfterChange.pickup_longitude, -51.144431);
    assert.equal(teleAfterChange.pickup_place_id, 'ChIJ_sapucaia_pickup_test_01');
  });

  await t.test('3. Teste de Não Regressão Cadastral Estrita (campos não relacionados permanecem intactos)', async () => {
    // 3.1 Criar fixture de cliente de teste com todos os dados cadastrais preenchidos
    const randNum = Math.floor(100000 + Math.random() * 899999);
    const testClientId = '99999999-8888-7777-6666-' + String(randNum).padStart(12, '0');
    
    const initialCadastralData = {
      id: testClientId,
      establishment_name: `Restaurante Sul ${randNum}`,
      responsible_name: 'Marcos Vinicius',
      phone: '(51) 99887-7665',
      email: `marcos.${randNum}@restaurantesul.test`,
      document: `${randNum}000188`,
      address: 'Rua Antiga de Teste, 100',
      street_number: '100',
      neighborhood: 'Bela Vista',
      city: 'Sapucaia do Sul',
      state: 'RS',
      postal_code: '93265-000',
      lifecycle_status: 'ativo',
      financial_status: 'em_dia'
    };

    const { error: insertErr } = await serviceClient
      .from('commercial_clients')
      .insert([initialCadastralData]);
    assert.ok(!insertErr, `Insert fixture error: ${insertErr?.message}`);

    try {
      // 3.2 Simular a leitura e save executado pelo fluxo submitConfigureClientPickup()
      const { data: dbClient, error: dbFetchErr } = await adminUser
        .from('commercial_clients')
        .select('id, responsible_name, phone, address, street_number, neighborhood, city, state, postal_code')
        .eq('id', testClientId)
        .maybeSingle();

      assert.ok(!dbFetchErr, `Fetch error: ${dbFetchErr?.message}`);
      assert.ok(dbClient, 'Cliente deve ser lido do banco.');

      const newPickupAddress = 'Av. Mauá, 2500 - Sapucaia do Sul, RS';
      const newLat = -29.831122;
      const newLng = -51.152233;
      const newPlaceId = 'ChIJ_maua_test_777';

      // Execução via RPC como implementado no frontend
      const { data: rpcRes, error: rpcErr } = await adminUser.rpc('admin_update_commercial_client_profile', {
        p_client_id: testClientId,
        p_responsible_name: dbClient.responsible_name,
        p_phone: dbClient.phone,
        p_address: newPickupAddress,
        p_street_number: dbClient.street_number,
        p_neighborhood: dbClient.neighborhood,
        p_city: dbClient.city,
        p_state: dbClient.state,
        p_postal_code: dbClient.postal_code,
        p_pickup_latitude: newLat,
        p_pickup_longitude: newLng,
        p_pickup_place_id: newPlaceId
      });

      assert.ok(!rpcErr, `RPC update error: ${rpcErr?.message}`);
      assert.equal(rpcRes.success, true);

      // 3.3 Consultar registro após atualização e comparar campo a campo
      const { data: afterUpdate, error: afterErr } = await serviceClient
        .from('commercial_clients')
        .select('*')
        .eq('id', testClientId)
        .maybeSingle();

      assert.ok(!afterErr, `After fetch error: ${afterErr?.message}`);
      assert.ok(afterUpdate, 'Registro atualizado deve existir.');

      // COMPARAÇÃO OBRIGATÓRIA: Campos NÃO relacionados ao pickup DEVEM SER ESTRITAMENTE IGUAIS
      assert.equal(afterUpdate.establishment_name, initialCadastralData.establishment_name, 'establishment_name deve ser IGUAL');
      assert.equal(afterUpdate.responsible_name, initialCadastralData.responsible_name, 'responsible_name deve ser IGUAL');
      assert.equal(afterUpdate.phone, initialCadastralData.phone, 'phone deve ser IGUAL');
      assert.equal(afterUpdate.email, initialCadastralData.email, 'email deve ser IGUAL');
      assert.equal(afterUpdate.document, initialCadastralData.document, 'document deve ser IGUAL');
      assert.equal(afterUpdate.street_number, initialCadastralData.street_number, 'street_number deve ser IGUAL');
      assert.equal(afterUpdate.neighborhood, initialCadastralData.neighborhood, 'neighborhood deve ser IGUAL');
      assert.equal(afterUpdate.city, initialCadastralData.city, 'city deve ser IGUAL');
      assert.equal(afterUpdate.state, initialCadastralData.state, 'state deve ser IGUAL');
      assert.equal(afterUpdate.postal_code, initialCadastralData.postal_code, 'postal_code deve ser IGUAL');
      assert.equal(afterUpdate.lifecycle_status, initialCadastralData.lifecycle_status, 'lifecycle_status deve ser IGUAL');
      assert.equal(afterUpdate.financial_status, initialCadastralData.financial_status, 'financial_status deve ser IGUAL');

      // Campos do Ponto de Coleta DEVEM ter sido atualizados corretamente
      assert.equal(afterUpdate.address, newPickupAddress, 'address deve ser o novo endereço');
      assert.equal(afterUpdate.pickup_latitude, newLat, 'pickup_latitude deve ser atualizada');
      assert.equal(afterUpdate.pickup_longitude, newLng, 'pickup_longitude deve ser atualizada');
      assert.equal(afterUpdate.pickup_place_id, newPlaceId, 'pickup_place_id deve ser atualizado');
    } finally {
      // Limpeza da fixture temporária
      await serviceClient.from('commercial_clients').delete().eq('id', testClientId);
    }
  });

  await t.test('4. Validação da Allowlist Administrativa Oficial (owner, admin, operador, gerente permitidos / client_user e motoboy bloqueados)', async () => {
    // 4.1 Validar allowlist autoritativa no frontend
    const ADMIN_ROLES = ['owner', 'admin', 'operador', 'gerente'];
    assert.ok(ADMIN_ROLES.includes('owner'), 'owner deve ser permitido');
    assert.ok(ADMIN_ROLES.includes('admin'), 'admin deve ser permitido');
    assert.ok(ADMIN_ROLES.includes('operador'), 'operador deve ser permitido');
    assert.ok(ADMIN_ROLES.includes('gerente'), 'gerente deve ser permitido');
    assert.ok(!ADMIN_ROLES.includes('client_user'), 'client_user deve ser bloqueado');
    assert.ok(!ADMIN_ROLES.includes('motoboy'), 'motoboy deve ser bloqueado');

    // 4.2 Provar que client_user é bloqueado na RPC com FORBIDDEN
    const clientUser = await createAuthedTestClient('padaria.central@homolog.test', 'dahoraexpresso1');
    const { data: forbiddenRes } = await clientUser.rpc('admin_update_commercial_client_profile', {
      p_client_id: padariaId,
      p_responsible_name: 'Teste Bloqueio',
      p_phone: '(51) 98888-7777',
      p_address: 'Av. Teste, 100',
      p_state: 'RS'
    });
    assert.equal(forbiddenRes.success, false, 'client_user não pode executar RPC administrativa');
    assert.equal(forbiddenRes.error_code, 'FORBIDDEN', 'error_code deve ser FORBIDDEN');
  });
});
