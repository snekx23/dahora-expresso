// Dahora Expresso — Testes Automatizados do Fluxo de Criação de Teles e Geolocalização (Node Native Fetch)
// Execução: node --test --test-concurrency=1 tests/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('.env.bootstrap.remote') });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function loginUser(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  });
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

async function callRpc(rpcName, params, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${token || ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(params)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

test('1. Migration 20260728000100 contém alter de tabelas, RLS e RPCs atualizadas', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260728000100_delivery_geolocation_and_tele_creation.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('is_internal BOOLEAN NOT NULL DEFAULT false'), 'Coluna is_internal ausente na migration.');
  assert.ok(sql.includes('SYS-DAHORA'), 'Seed do cliente interno SYS-DAHORA ausente.');
  assert.ok(sql.includes('delivery_latitude DOUBLE PRECISION'), 'Coluna delivery_latitude ausente.');
  assert.ok(sql.includes('place_id TEXT'), 'Coluna place_id ausente.');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.create_admin_tele'), 'RPC create_admin_tele ausente.');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.create_client_tele'), 'RPC create_client_tele ausente.');
  assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.create_admin_tele'), 'REVOKE em create_admin_tele ausente.');
  assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.create_client_tele'), 'REVOKE em create_client_tele ausente.');
});

test('2. Configuração local e .gitignore previnem chamadas ao Supabase remoto e mantêm chave Google restrita a config.local.js', async () => {
  const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(gitignore.includes('public/config.local.js'), 'public/config.local.js ausente do .gitignore.');

  const configJs = await readFile(new URL('../public/config.js', import.meta.url), 'utf8');
  assert.ok(configJs.includes('127.0.0.1:54321'), 'URL local ausente do config.js.');
  assert.ok(!configJs.includes('fajkqyapnycnnumpdwrr'), 'URL remota legada encontrada em config.js!');
  assert.ok(configJs.includes('googleMapsApiKey'), 'Propagação da chave googleMapsApiKey ausente no config.js.');

  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/AIzaSy[A-Za-z0-9_-]{33}/.test(appJs), 'SEGURANÇA: Chave do Google Maps hardcoded encontrada em app.js!');
  assert.ok(!appJs.includes('mapbox'), 'Código ativo do app.js contém referências a Mapbox!');
  assert.ok(!appJs.includes('nominatim'), 'Código ativo do app.js contém referências a Nominatim!');
  assert.ok(appJs.includes('gestureHandling: \'greedy\''), 'gestureHandling: greedy ausente no mapa Google Maps.');
  assert.ok(appJs.includes('fullscreenControl: false'), 'fullscreenControl: false ausente no mapa Google Maps.');
  assert.ok(appJs.includes('PlaceAutocompleteElement'), 'PlaceAutocompleteElement deve ser a implementação principal de autocomplete.');
  assert.ok(appJs.includes('locationRestriction: rsBounds'), 'locationRestriction com limites do RS ausente no PlaceAutocompleteElement.');
  assert.ok(!appJs.includes('locationBias: bounds'), 'locationBias não deve ser misturado com locationRestriction.');
  assert.ok(appJs.includes('handlePlacesApi403Error'), 'Tratamento de erro 403 da Places API ausente.');
  assert.ok(appJs.includes('Este endereço está fora da área atendida. Selecione um endereço no Rio Grande do Sul.'), 'Validação estrita de estado do RS ausente.');
  assert.ok(appJs.includes('O Google não confirmou o número deste endereço'), 'Aviso de número não confirmado do Google ausente.');
  assert.ok(appJs.includes('AdvancedMarkerElement'), 'AdvancedMarkerElement deve ser a implementação principal de marcador.');
  assert.ok(appJs.includes('gmpDraggable: true'), 'gmpDraggable: true ausente no AdvancedMarkerElement.');
  assert.ok(appJs.includes('fetchFields'), 'fetchFields deve ser chamado para solicitar campos do Place.');
  assert.ok(appJs.includes('gmp-placeselect'), 'Evento gmp-placeselect ausente no PlaceAutocompleteElement.');
  assert.ok(appJs.includes('mapId:'), 'mapId ausente na configuração do mapa.');
});



test('3. Cliente Interno "Dahora Expresso" existe na tabela public.commercial_clients', async () => {
  const { ok, data } = await queryRest('commercial_clients?client_code=eq.SYS-DAHORA', SERVICE_ROLE_KEY);

  assert.ok(ok);
  assert.ok(Array.isArray(data) && data.length > 1 || data.length === 1, 'Registro do cliente interno Dahora Expresso não encontrado.');
  const client = data[0];
  assert.equal(client.establishment_name, 'Dahora Expresso');
  assert.equal(client.responsible_name, 'Operação Interna');
  assert.equal(client.is_internal, true);
});

test('4. Usuário anônimo não consegue listar commercial_clients (RLS bloqueia acesso anon)', async () => {
  const { ok, data } = await queryRest('commercial_clients?select=id,establishment_name', ANON_KEY);
  assert.ok(Array.isArray(data) && data.length === 0 || !ok, 'Usuário anônimo conseguiu listar clientes comerciais!');
});

test('5. Administrador autenticado consegue listar clientes comerciais e vê o cliente interno Dahora Expresso', async () => {
  const auth = await loginUser('admin@dahora.local', 'senha123456');
  const token = auth.access_token;

  const { ok, data } = await queryRest('commercial_clients?select=id,client_code,establishment_name,is_internal', token);
  assert.ok(ok);
  assert.ok(data.length > 0, 'Nenhum cliente comercial retornado para o administrador.');

  const internalClient = data.find(c => c.is_internal === true || c.client_code === 'SYS-DAHORA');
  assert.ok(internalClient, 'Cliente interno Dahora Expresso não visível para o administrador.');
});

test('6. Cliente comercial autenticado NÃO vê o cliente interno Dahora Expresso', async () => {
  const auth = await loginUser('parceiro@mercadocentral.local', 'senha123456');
  const token = auth.access_token;

  const { ok, data } = await queryRest('commercial_clients?select=id,client_code,establishment_name,is_internal', token);
  assert.ok(ok);
  const internalClient = (data || []).find(c => c.is_internal === true || c.client_code === 'SYS-DAHORA');
  assert.equal(internalClient, undefined, 'SEGURANÇA: Cliente comercial conseguiu visualizar o cliente interno Dahora Expresso!');
});

test('7. RPC create_admin_tele cria Tele interna em aguardando_despacho com coordenadas, place_id e precisão', async () => {
  const auth = await loginUser('admin@dahora.local', 'senha123456');
  const token = auth.access_token;

  const { data: internalList } = await queryRest('commercial_clients?client_code=eq.SYS-DAHORA', SERVICE_ROLE_KEY);
  const internalClient = internalList[0];

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
    p_operation_source: 'owner_panel',
    p_delivery_number: '500',
    p_delivery_neighborhood: 'Centro',
    p_delivery_city: 'Sapucaia do Sul',
    p_delivery_latitude: -29.8247000,
    p_delivery_longitude: -51.1444000,
    p_geocoding_precision: 'exact',
    p_location_adjusted_manually: true,
    p_place_id: 'ChIJ5z8k_Q7G3ZQRx_9v1234567',
    p_delivery_state: 'RS'
  }, token);

  assert.ok(ok);
  assert.equal(data.success, true);
  assert.equal(data.status, 'aguardando_despacho');
  assert.ok(data.tele_id);

  // Verificar gravação no banco de dados
  const { data: teleList } = await queryRest(`teles?id=eq.${data.tele_id}`, SERVICE_ROLE_KEY);
  const tele = teleList[0];

  assert.equal(tele.status, 'aguardando_despacho');
  assert.equal(tele.delivery_number, '500');
  assert.equal(tele.place_id, 'ChIJ5z8k_Q7G3ZQRx_9v1234567');
  assert.equal(tele.geocoding_precision, 'exact');
  assert.equal(tele.location_adjusted_manually, true);
});

test('8. RPC create_admin_tele é idempotente', async () => {
  const auth = await loginUser('admin@dahora.local', 'senha123456');
  const token = auth.access_token;

  const { data: internalList } = await queryRest('commercial_clients?client_code=eq.SYS-DAHORA', SERVICE_ROLE_KEY);
  const internalClient = internalList[0];

  const idempKey = `idemp-test-idempotent-${Date.now()}`;

  const params = {
    p_client_id: internalClient.id,
    p_pickup_address: 'Av. Presidente Vargas, 1000',
    p_delivery_address: 'Rua São João, 500',
    p_recipient_name: 'Maria Oliveira',
    p_recipient_phone: '(51) 98888-7777',
    p_idempotency_key: idempKey
  };

  const { data: firstRes } = await callRpc('create_admin_tele', params, token);
  const { data: secondRes } = await callRpc('create_admin_tele', params, token);

  assert.equal(firstRes.success, true);
  assert.equal(secondRes.success, true);
  assert.equal(secondRes.is_idempotent, true);
  assert.equal(firstRes.tele_id, secondRes.tele_id);
});

test('9. RPC create_client_tele resolve o client_id via auth.uid() e ignora p_client_id externo', async () => {
  const auth = await loginUser('parceiro@mercadocentral.local', 'senha123456');
  const token = auth.access_token;

  const { data: mercadoList } = await queryRest('commercial_clients?client_code=eq.CLI-000101', SERVICE_ROLE_KEY);
  const mercadoClient = mercadoList[0];

  const idempKey = `idemp-test-client-${Date.now()}`;

  const { ok, data } = await callRpc('create_client_tele', {
    p_pickup_address: '',
    p_delivery_address: 'Av. Sapucaia, 1200',
    p_recipient_name: 'Fernando Rocha',
    p_recipient_phone: '(51) 91111-2222',
    p_idempotency_key: idempKey,
    p_delivery_number: '1200',
    p_place_id: 'ChIJ5z8k_Q7G3ZQRx_9v8888888'
  }, token);

  assert.ok(ok);
  assert.equal(data.success, true);
  assert.equal(data.status, 'aguardando_despacho');
  assert.equal(data.client_id, mercadoClient.id, 'O client_id gravado deve ser o do usuário autenticado no Mercado Central.');
});

test('10. Formulário simplificado de Nova Tele Manual mantém campos estruturados em inputs ocultos e resumo compacto', async () => {
  const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  // 1. Número, bairro e cidade estão mantidos em inputs hidden para envio das RPCs
  assert.ok(indexHtml.includes('<input type="hidden" id="manual-delivery-number"'), 'manual-delivery-number deve ser input hidden.');
  assert.ok(indexHtml.includes('<input type="hidden" id="manual-delivery-neighborhood"'), 'manual-delivery-neighborhood deve ser input hidden.');
  assert.ok(indexHtml.includes('<input type="hidden" id="manual-delivery-city"'), 'manual-delivery-city deve ser input hidden.');

  // 2. Área de confirmação de número e resumo compacto de endereço presentes no HTML
  assert.ok(indexHtml.includes('id="manual-number-confirm-area"'), 'Área de confirmação de número ausente no HTML.');
  assert.ok(indexHtml.includes('id="manual-address-summary-box"'), 'Resumo compacto de endereço ausente no HTML.');

  // 3. Complemento permanece visível
  assert.ok(indexHtml.includes('id="manual-delivery-complement"'), 'Campo de complemento ausente.');

  // 4. app.js manipula resumo compacto e área dinâmica de número
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(appJs.includes('manual-address-summary-box'), 'Lógica do resumo compacto de endereço ausente em app.js.');
  assert.ok(appJs.includes('manual-number-confirm-area'), 'Lógica da área dinâmica de confirmação de número ausente em app.js.');
  assert.ok(appJs.includes('syncManualDeliveryNumberInput'), 'Sincronização de número dinâmico ausente.');
  assert.ok(appJs.includes('toggleManualDeliverySN'), 'Alternância de S/N ausente.');
});

