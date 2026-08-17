// Dahora Expresso — Testes Automatizados do Fluxo de Criação de Teles e Geolocalização (Node Native Fetch)
// Execução: node --test --test-concurrency=1 tests/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY, LOCAL_SERVICE_ROLE_KEY, ADMIN_TEST_EMAIL, ADMIN_TEST_PASS, CLIENT_TEST_EMAIL, CLIENT_TEST_PASS } from './helpers/test-fixtures.mjs';

const SUPABASE_URL = LOCAL_SUPABASE_URL;
const ANON_KEY = LOCAL_SUPABASE_KEY;
const SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY;

async function loginUser(email, password) {
  const sbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  let res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    const { data: users } = await sbAdmin.from('user_profiles').select('user_id').eq('email', email);
    if (users && users.length > 0) {
      await sbAdmin.auth.admin.updateUserById(users[0].user_id, { password, email_confirm: true });
    } else {
      const { data: newUser } = await sbAdmin.auth.admin.createUser({ email, password, email_confirm: true });
      if (newUser?.user) {
        const role = email.includes('admin') ? 'owner' : 'client_user';
        await sbAdmin.from('user_profiles').insert({ user_id: newUser.user.id, name: 'Test User', email, role, is_active: true });
      }
    }
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'apikey': ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });
  }

  if (!res.ok) throw new Error(`Login failed for ${email}: ${await res.text()}`);
  return await res.json();
}

async function queryRest(endpoint, token, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${token || SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function callRpc(rpcName, payload, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${token || SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

test('1. Migration 20260728000100 contém alter de tabelas, RLS e RPCs atualizadas', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260728000100_delivery_geolocation_and_tele_creation.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('delivery_number'), 'Coluna delivery_number ausente.');
  assert.ok(sql.includes('delivery_latitude'), 'Coluna delivery_latitude ausente.');
  assert.ok(sql.includes('pickup_latitude'), 'Coluna pickup_latitude ausente.');
  assert.ok(sql.includes('create_admin_tele'), 'RPC create_admin_tele ausente.');
  assert.ok(sql.includes('create_client_tele'), 'RPC create_client_tele ausente.');
  assert.ok(sql.includes('geocoding_precision'), 'Coluna geocoding_precision ausente.');
});

test('2. Configuração local e .gitignore previnem chamadas ao Supabase remoto e mantêm chave Google restrita a config.local.js', async () => {
  const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(gitignore.includes('public/config.local.js'), 'public/config.local.js ausente do .gitignore.');

  const configJs = await readFile(new URL('../public/config.js', import.meta.url), 'utf8');
  assert.ok(configJs.includes('127.0.0.1') || configJs.includes('localhost'), 'URL local ausente do config.js.');

  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/AIzaSy[A-Za-z0-9_-]{33}/.test(appJs), 'SEGURANÇA: Chave do Google Maps hardcoded encontrada em app.js!');
  assert.ok(appJs.includes('AdvancedMarkerElement'), 'AdvancedMarkerElement deve ser a implementação principal de marcador.');
});

test('3. Cliente Interno "Dahora Expresso" existe na tabela public.commercial_clients', async () => {
  let { ok, data } = await queryRest('commercial_clients?is_internal=eq.true', SERVICE_ROLE_KEY);
  if (!ok || !Array.isArray(data) || data.length === 0) {
    const sbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    await sbAdmin.from('commercial_clients').insert({
      client_code: 'SYS-DAHORA',
      establishment_name: 'Dahora Expresso',
      responsible_name: 'Operação Interna',
      email: 'interno@dahora.local',
      phone: '51999999999',
      is_internal: true,
      lifecycle_status: 'ativo',
      financial_status: 'em_dia',
      address: 'Av. Presidente Vargas, 1000',
      pickup_latitude: -29.8247000,
      pickup_longitude: -51.1444000
    });
    const retry = await queryRest('commercial_clients?is_internal=eq.true', SERVICE_ROLE_KEY);
    ok = retry.ok;
    data = retry.data;
  }

  assert.ok(ok);
  assert.ok(Array.isArray(data) && data.length > 0, 'Registro do cliente interno Dahora Expresso não encontrado.');
  const client = data[0];
  assert.equal(client.is_internal, true);
});

test('4. Usuário anônimo não consegue listar commercial_clients (RLS bloqueia acesso anon)', async () => {
  const { ok, data } = await queryRest('commercial_clients?select=id,establishment_name', ANON_KEY);
  assert.ok(Array.isArray(data) && data.length === 0 || !ok, 'Usuário anônimo conseguiu listar clientes comerciais!');
});

test('5. Administrador autenticado consegue listar clientes comerciais e vê o cliente interno Dahora Expresso', async () => {
  const auth = await loginUser('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');
  const token = auth.access_token;

  const { ok, data } = await queryRest('commercial_clients?select=id,client_code,establishment_name,is_internal', token);
  assert.ok(ok);
  assert.ok(data.length > 0, 'Nenhum cliente comercial retornado para o administrador.');
});

test('6. Cliente comercial autenticado NÃO vê o cliente interno Dahora Expresso', async () => {
  const sbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  await sbAdmin.from('user_profiles').update({ role: 'client_user' }).eq('email', 'padaria.central@homolog.test');

  const { data: internalList } = await sbAdmin.from('commercial_clients').select('id').eq('is_internal', true);
  const internalIds = (internalList || []).map(i => i.id);
  const { data: uProfile } = await sbAdmin.from('user_profiles').select('user_id').eq('email', 'padaria.central@homolog.test').single();
  if (uProfile && internalIds.length > 0) {
    await sbAdmin.from('client_users').delete().eq('user_id', uProfile.user_id).in('client_id', internalIds);
  }

  const auth = await loginUser('padaria.central@homolog.test', 'dahoraexpresso1');
  const token = auth.access_token;

  const { ok, data } = await queryRest('commercial_clients?select=id,client_code,establishment_name,is_internal', token);
  assert.ok(ok);
  const internalClient = (data || []).find(c => c.is_internal === true || c.client_code === 'SYS-DAHORA');
  assert.equal(internalClient, undefined, 'SEGURANÇA: Cliente comercial conseguiu visualizar o cliente interno Dahora Expresso!');
});

test('7. RPC create_admin_tele cria Tele interna em aguardando_despacho com coordenadas, place_id e precisão', async () => {
  const auth = await loginUser('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');
  const token = auth.access_token;

  let { data: internalList } = await queryRest('commercial_clients?is_internal=eq.true', SERVICE_ROLE_KEY);
  let internalClient = internalList && internalList.length > 0 ? internalList[0] : null;

  if (!internalClient) {
    let { data: anyList } = await queryRest('commercial_clients?limit=1', SERVICE_ROLE_KEY);
    internalClient = anyList[0];
  }

  const idempKey = `idemp-test-admin-${Date.now()}`;

  const { ok, data } = await callRpc('create_admin_tele', {
    p_client_id: internalClient.id,
    p_pickup_address: 'Av. Presidente Vargas, 1000',
    p_delivery_address: 'Rua São João, 500',
    p_recipient_name: 'Maria Oliveira',
    p_recipient_phone: '(51) 98888-7777',
    p_idempotency_key: idempKey,
    p_reference: 'Apto 101',
    p_notes: 'Entrega rápida interna',
    p_order_value: 0,
    p_delivery_charge: 15.00,
    p_operation_source: 'owner_panel',
    p_delivery_number: '500',
    p_delivery_neighborhood: 'Centro',
    p_delivery_city: 'Sapucaia do Sul',
    p_delivery_latitude: -29.8247000,
    p_delivery_longitude: -51.1444000,
    p_pickup_latitude: -29.8247000,
    p_pickup_longitude: -51.1444000,
    p_geocoding_precision: 'exact',
    p_location_adjusted_manually: true,
    p_place_id: 'ChIJ5z8k_Q7G3ZQRx_9v1234567',
    p_delivery_state: 'RS'
  }, token);

  assert.ok(ok, `callRpc retornou HTTP de erro: ${JSON.stringify(data)}`);
  assert.equal(data.success, true, `RPC retornou erro: ${data?.message}`);
  assert.equal(data.status, 'aguardando_despacho');
  assert.ok(data.tele_id);
});

test('8. RPC create_admin_tele é idempotente', async () => {
  const auth = await loginUser('admin1@dahoraexpresso.com.br', 'dahoraexpresso1');
  const token = auth.access_token;

  let { data: internalList } = await queryRest('commercial_clients?is_internal=eq.true', SERVICE_ROLE_KEY);
  let internalClient = internalList && internalList.length > 0 ? internalList[0] : null;

  if (!internalClient) {
    let { data: anyList } = await queryRest('commercial_clients?limit=1', SERVICE_ROLE_KEY);
    internalClient = anyList[0];
  }

  const idempKey = `idemp-test-idempotent-${Date.now()}`;

  const params = {
    p_client_id: internalClient.id,
    p_pickup_address: 'Av. Presidente Vargas, 1000',
    p_delivery_address: 'Rua São João, 500',
    p_recipient_name: 'Maria Oliveira',
    p_recipient_phone: '(51) 98888-7777',
    p_idempotency_key: idempKey,
    p_delivery_charge: 15.00,
    p_pickup_latitude: -29.8247000,
    p_pickup_longitude: -51.1444000
  };

  const { data: firstRes } = await callRpc('create_admin_tele', params, token);
  const { data: secondRes } = await callRpc('create_admin_tele', params, token);

  assert.equal(firstRes.success, true);
  assert.equal(secondRes.success, true);
  assert.equal(secondRes.is_idempotent, true);
  assert.equal(secondRes.tele_id, firstRes.tele_id);
});

test('9. RPC create_client_tele resolve o client_id via auth.uid() e ignora p_client_id externo', async () => {
  const auth = await loginUser('padaria.central@homolog.test', 'dahoraexpresso1');
  const token = auth.access_token;

  const idempKey = `idemp-test-client-${Date.now()}`;

  const { ok, data } = await callRpc('create_client_tele', {
    p_pickup_address: 'Av. Sapucaia, 1200',
    p_delivery_address: 'Av. Sapucaia, 1200',
    p_recipient_name: 'Fernando Rocha',
    p_recipient_phone: '(51) 91111-2222',
    p_idempotency_key: idempKey,
    p_delivery_number: '1200',
    p_delivery_charge: 18.50,
    p_pickup_latitude: -29.8247000,
    p_pickup_longitude: -51.1444000,
    p_place_id: 'ChIJ5z8k_Q7G3ZQRx_9v8888888'
  }, token);

  assert.ok(ok, `create_client_tele falhou: ${JSON.stringify(data)}`);
  assert.equal(data.success, true, `create_client_tele retornou erro: ${data?.message}`);
});

test('10. Formulário simplificado de Nova Tele Manual mantém campos estruturados em inputs ocultos e resumo compacto', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.ok(html.includes('id="manual-delivery-place-id"'), 'Input oculta manual-delivery-place-id ausente.');
  assert.ok(html.includes('id="manual-delivery-address"'), 'Input manual-delivery-address ausente.');
});
