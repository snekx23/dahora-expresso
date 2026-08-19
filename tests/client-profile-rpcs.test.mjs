// =====================================================================
// Dahora Expresso — Testes das RPCs Autoritativas de Perfil do Cliente
// File: tests/client-profile-rpcs.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, createAuthedTestClient } from './helpers/test-fixtures.mjs';
import { createClient } from '@supabase/supabase-js';

const serviceClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY);

test('Módulo de Perfil do Cliente Comercial (RPCs Autoritativas)', async (t) => {
  const padariaId = '8e40963a-9146-4bfd-9447-d8d373be7ca6';
  const clientUser = await createAuthedTestClient('padaria.central@homolog.test', 'dahoraexpresso1');
  const adminUser = await createAuthedTestClient('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');

  await t.test('1. get_my_commercial_client_profile retorna perfil completo do cliente autenticado', async () => {
    const { data: profile, error } = await clientUser.rpc('get_my_commercial_client_profile');
    assert.ok(!error, `RPC error: ${error?.message}`);
    assert.equal(profile.success, true);
    assert.equal(profile.client_id, padariaId);
    assert.equal(profile.client_code, 'CLI-000001');
    assert.equal(profile.establishment_name, 'Padaria Central Homolog');
    assert.ok(profile.responsible_name);
    assert.ok(profile.phone);
    assert.ok(profile.email);
    assert.equal(profile.lifecycle_status, 'ativo');
    assert.equal(profile.financial_status, 'em_dia');
  });

  await t.test('2. update_my_commercial_client_profile atualiza dados permitidos e valida estado RS', async () => {
    const { data: updRes, error: updErr } = await clientUser.rpc('update_my_commercial_client_profile', {
      p_responsible_name: 'João Da Silva Teste',
      p_phone: '(51) 97777-6666',
      p_address: 'Av. Sapucaia, 2000',
      p_street_number: '2000',
      p_neighborhood: 'Centro',
      p_city: 'Sapucaia do Sul',
      p_state: 'RS',
      p_postal_code: '93260-000',
      p_pickup_latitude: -29.8250,
      p_pickup_longitude: -51.1400,
      p_pickup_place_id: 'ChIJ_place_test_123'
    });

    assert.ok(!updErr, `Update error: ${updErr?.message}`);
    assert.equal(updRes.success, true);

    // Confirmar leitura atualizada
    const { data: readBack } = await clientUser.rpc('get_my_commercial_client_profile');
    assert.equal(readBack.responsible_name, 'João Da Silva Teste');
    assert.equal(readBack.phone, '(51) 97777-6666');
    assert.equal(readBack.address, 'Av. Sapucaia, 2000');
    assert.equal(readBack.street_number, '2000');
    assert.equal(readBack.pickup_latitude, -29.8250);
    assert.equal(readBack.pickup_longitude, -51.1400);
    assert.equal(readBack.pickup_place_id, 'ChIJ_place_test_123');

    // Garantir que campos read-only não foram modificados
    assert.equal(readBack.establishment_name, 'Padaria Central Homolog');
    assert.equal(readBack.client_code, 'CLI-000001');
    assert.equal(readBack.document, '11.222.333/0001-99');
  });

  await t.test('3. Rejeição de estado fora do RS e coordenadas inválidas', async () => {
    const { data: spRes } = await clientUser.rpc('update_my_commercial_client_profile', {
      p_responsible_name: 'João Silva',
      p_phone: '(51) 97777-6666',
      p_address: 'Av. Paulista, 1000',
      p_state: 'SP'
    });
    assert.equal(spRes.success, false);
    assert.equal(spRes.error_code, 'STATE_NOT_ALLOWED');

    const { data: latRes } = await clientUser.rpc('update_my_commercial_client_profile', {
      p_responsible_name: 'João Silva',
      p_phone: '(51) 97777-6666',
      p_address: 'Av. Sapucaia, 2000',
      p_state: 'RS',
      p_pickup_latitude: 99.0
    });
    assert.equal(latRes.success, false);
    assert.equal(latRes.error_code, 'INVALID_COORDINATES');
  });

  await t.test('4. RPCs administrativas admin_get e admin_update exigem is_admin_user', async () => {
    const { data: adminRead } = await adminUser.rpc('admin_get_commercial_client_profile', { p_client_id: padariaId });
    assert.equal(adminRead.success, true);
    assert.equal(adminRead.client_id, padariaId);

    const { data: clientTryAdminRead } = await clientUser.rpc('admin_get_commercial_client_profile', { p_client_id: padariaId });
    assert.equal(clientTryAdminRead.success, false);
    assert.equal(clientTryAdminRead.error_code, 'FORBIDDEN');
  });
});
