// Dahora Expresso — Testes Automatizados do Status do Dispositivo e Cadastro da Frota
// Execução: node --test --test-concurrency=1 tests/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import dotenv from 'dotenv';
import path from 'path';

// Local test harness override
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzc4NzcsImV4cCI6MjEwMTU1Mzg3N30.1BoD7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzc4NzcsImV4cCI6MjEwMTU1Mzg3N30.1BoD7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw';

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

test('1. Migration 20260728000300_rider_device_status.sql existe e configura tabela e RPC', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260728000300_rider_device_status.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.rider_device_status'), 'Tabela rider_device_status ausente.');
  assert.ok(sql.includes('CHECK (battery_level IS NULL OR (battery_level >= 0 AND battery_level <= 100))'), 'Constraint de nível de bateria ausente.');
  assert.ok(sql.includes('REVOKE ALL ON public.rider_device_status FROM PUBLIC'), 'Revoke PUBLIC ausente.');
  assert.ok(sql.includes('REVOKE ALL ON public.rider_device_status FROM anon'), 'Revoke anon ausente.');
  assert.ok(sql.includes('GRANT SELECT, INSERT, UPDATE ON public.rider_device_status TO authenticated'), 'Grant authenticated ausente.');
  assert.ok(!sql.includes('GRANT DELETE ON public.rider_device_status TO authenticated'), 'SEGURANÇA: GRANT DELETE não deve ser concedido para authenticated.');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.update_my_device_status'), 'RPC update_my_device_status ausente.');
});

test('2. Cadastro e edição de motoboy não enviam coluna fleet.battery ou fleet.battery_level no payload', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.ok(!indexHtml.includes('id="mb-battery"'), 'Input manual mb-battery deve ter sido removido do HTML.');
  assert.ok(!indexHtml.includes('id="edit-rider-battery"'), 'Input manual edit-rider-battery deve ter sido removido do HTML.');

  // Verificar que app.js não lê os campos manuais de bateria removidos
  assert.ok(!appJs.includes('mb-battery'), 'app.js não deve ler o input mb-battery.');
  assert.ok(!appJs.includes('edit-rider-battery'), 'app.js não deve ler o input edit-rider-battery.');
  assert.ok(appJs.includes('motoboy_code:'), 'Cadastro deve conter apenas colunas válidas da tabela fleet.');
});


test('3. Tabela rider_device_status aceita e persiste dados via RPC update_my_device_status para o motoboy autenticado', async () => {
  const auth = await loginUser('motoboy@dahora.local', 'senha123456');
  const token = auth.access_token;

  const { ok, data } = await callRpc('update_my_device_status', {
    p_battery_level: 85,
    p_is_charging: true,
    p_battery_supported: true
  }, token);

  assert.ok(ok);
  assert.equal(data.success, true);
  assert.equal(data.battery_level, 85);
  assert.equal(data.is_charging, true);
  assert.equal(data.battery_supported, true);
});

test('4. RPC update_my_device_status força campos nulos quando p_battery_supported = false', async () => {
  const auth = await loginUser('motoboy@dahora.local', 'senha123456');
  const token = auth.access_token;

  const { ok, data } = await callRpc('update_my_device_status', {
    p_battery_level: 95,
    p_is_charging: true,
    p_battery_supported: false
  }, token);

  assert.ok(ok);
  assert.equal(data.success, true);
  assert.equal(data.battery_level, null);
  assert.equal(data.is_charging, null);
  assert.equal(data.battery_supported, false);
});

test('5. RPC update_my_device_status rejeita nível de bateria inválido (< 0 ou > 100)', async () => {
  const auth = await loginUser('motoboy@dahora.local', 'senha123456');
  const token = auth.access_token;

  const { data: resInvalidHigh } = await callRpc('update_my_device_status', {
    p_battery_level: 150,
    p_is_charging: false,
    p_battery_supported: true
  }, token);

  assert.equal(resInvalidHigh.success, false);
  assert.ok(resInvalidHigh.message.includes('entre 0 e 100'));

  const { data: resInvalidLow } = await callRpc('update_my_device_status', {
    p_battery_level: -10,
    p_is_charging: false,
    p_battery_supported: true
  }, token);

  assert.equal(resInvalidLow.success, false);
  assert.ok(resInvalidLow.message.includes('entre 0 e 100'));
});

test('6. Usuário anônimo não consegue consultar nem alterar rider_device_status', async () => {
  const { ok: okSelect } = await queryRest('rider_device_status', ANON_KEY);
  assert.equal(okSelect, false, 'SEGURANÇA: Usuário anônimo conseguiu listar rider_device_status!');

  const { ok: okRpc } = await callRpc('update_my_device_status', { p_battery_level: 50, p_is_charging: false, p_battery_supported: true }, ANON_KEY);
  assert.equal(okRpc, false, 'SEGURANÇA: Usuário anônimo conseguiu executar update_my_device_status!');
});

test('7. Administrador autenticado consegue consultar todos os status de dispositivos', async () => {
  const auth = await loginUser('admin@dahora.local', 'senha123456');
  const token = auth.access_token;

  const { ok, data } = await queryRest('rider_device_status', token);
  assert.ok(ok);
  assert.ok(Array.isArray(data));
});

test('8. motoboy.js possui detecção de recursos, fallback para getBattery e aviso de privacidade', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('navigator.getBattery'), 'Detecção de recursos com getBattery ausente em motoboy.js.');
  assert.ok(motoboyJs.includes('sendDeviceStatus(null, null, false)'), 'Fallback para navegador sem suporte ausente.');
  assert.ok(motoboyJs.includes('showPrivacyConsentNotice'), 'Aviso de consentimento/privacidade ausente.');
  assert.ok(motoboyJs.includes('levelchange'), 'Listener de levelchange ausente.');
  assert.ok(motoboyJs.includes('chargingchange'), 'Listener de chargingchange ausente.');
});

test('9. Nenhuma service_role key está exposta nos arquivos estáticos do frontend', async () => {
  const files = ['public/app.js', 'public/config.js', 'public/motoboy.js', 'public/index.html'];

  for (const file of files) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(!text.includes(SERVICE_ROLE_KEY), `SEGURANÇA: service_role key encontrada em ${file}!`);
  }
});

test('10. Modal de cadastro possui estrutura valida com campos, erros e rodape contidos no modal-card', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  // Verificar que modal-card engloba todo o formulario
  const modalMatch = html.match(/<div id="modal-register-motoboy"[\s\S]*?<\/form>\s*<\/div>\s*<\/div>/);
  assert.ok(modalMatch, 'Modal modal-register-motoboy deve estar devidamente estruturado e fechado.');

  const modalHtml = modalMatch[0];
  assert.ok(modalHtml.includes('id="mb-phone"'), 'Campo mb-phone deve estar no modal.');
  assert.ok(modalHtml.includes('id="mb-phone-error"'), 'Mensagem mb-phone-error deve estar abaixo do campo de telefone.');
  assert.ok(modalHtml.includes('id="mb-pin-error"'), 'Mensagem mb-pin-error deve estar abaixo do campo de PIN.');
  assert.ok(modalHtml.includes('id="register-motoboy-submit-btn"'), 'Botão submit deve estar no rodapé dentro do modal-card.');
});

test('11. app.js possui mascara de telefone BR, validacao isolada de PIN e tratamento seguro contra toFixed em undefined', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.ok(appJs.includes('formatPhoneBR'), 'Função de máscara de telefone formatPhoneBR ausente.');
  assert.ok(appJs.includes('mb-phone-error'), 'Validação com mb-phone-error ausente.');
  assert.ok(appJs.includes('mb-pin-error'), 'Validação com mb-pin-error ausente.');
  assert.ok(appJs.includes('Number.isFinite(numRating)'), 'Tratamento seguro contra toFixed em undefined ausente em renderFleetTable.');
});

test('12. UUID do motoboy e removido da interface visual e substituido por Codigo de Acesso (motoboy_code) com opcao de copiar', async () => {
  const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const motoboyHtml = await readFile(new URL('../public/motoboy.html', import.meta.url), 'utf8');
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(indexHtml.includes('id="rider-action-code"'), 'Campo rider-action-code ausente em index.html.');
  assert.ok(indexHtml.includes('copyRiderAccessCode()'), 'Botão copyRiderAccessCode ausente em index.html.');
  assert.ok(appJs.includes('copyRiderAccessCode'), 'Função copyRiderAccessCode ausente em app.js.');
  assert.ok(motoboyHtml.includes('Código de Acesso'), 'Label Código de Acesso ausente em motoboy.html.');
  assert.ok(motoboyJs.includes('motoboy_code.eq'), 'Login por motoboy_code ausente em motoboy.js.');
});


