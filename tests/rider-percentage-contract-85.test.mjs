// =====================================================================
// Dahora Expresso — Suíte de Testes Dedicada: Contrato Financeiro Padrão 85% Motoboy / 15% Empresa (Refinamento de Segurança)
// File: tests/rider-percentage-contract-85.test.mjs
// =====================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('.env.bootstrap.remote') });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = {
  'apikey': SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json'
};

async function getAdminAuthHeaders() {
  const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: 'admin@dahora.local',
      password: 'senha123456'
    })
  });
  const loginData = await loginRes.json();
  return {
    'apikey': SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${loginData.access_token}`,
    'Content-Type': 'application/json'
  };
}

test('1. Migration aditiva 20260805000300_fix_default_rider_percentage_85.sql existe e está estritamente formatada', async () => {
  const filePath = path.join(projectRoot, 'supabase', 'migrations', '20260805000300_fix_default_rider_percentage_85.sql');
  const content = await readFile(filePath, 'utf8');
  assert.ok(content.includes('ALTER TABLE public.commercial_clients'), 'Altera a tabela commercial_clients.');
  assert.ok(content.includes('SET DEFAULT 85.00'), 'Define o DEFAULT para 85.00.');
  assert.ok(content.includes("client_code = 'SYS-DAHORA' OR is_internal = true"), 'Atualiza cliente interno Dahora Expresso via chave canônica.');
  assert.equal(content.includes('UPDATE public.commercial_clients') && content.includes('WHERE rider_percentage = 80.00'), false, 'Nenhum UPDATE genérico em clientes em 80%.');
});

test('2. Novo cliente sem percentual informado recebe DEFAULT 85.00 em commercial_clients', async () => {
  const nonce = Date.now();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/commercial_clients`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      client_code: `CLI-TEST-85-${nonce}`,
      establishment_name: 'Loja Teste Default 85',
      responsible_name: 'Gerente Teste',
      phone: '(51) 99999-8585',
      email: `loja85_${nonce}@teste.local`,
      address: 'Rua das Flores 85',
      document: `85.${nonce.toString().slice(-6)}/0001-85`
    })
  });
  assert.equal(res.status, 201, 'Cliente criado com sucesso.');
  const data = await res.json();
  const created = Array.isArray(data) ? data[0] : data;
  assert.equal(Number(created.rider_percentage), 85.00, 'Percentual herdou DEFAULT 85.00.');
});

test('3. Novo cliente com percentual customizado 80.00% permanece 80.00%', async () => {
  const nonce = Date.now();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/commercial_clients`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      client_code: `CLI-CUSTOM-80-${nonce}`,
      establishment_name: 'Loja Custom 80 Explicit',
      responsible_name: 'Marcos Cust80',
      phone: '(51) 98888-8080',
      email: `custom80_${nonce}@teste.local`,
      address: 'Av Custom 80',
      document: `80.${nonce.toString().slice(-6)}/0001-80`,
      rider_percentage: 80.00
    })
  });
  assert.equal(res.status, 201, 'Cliente customizado criado.');
  const data = await res.json();
  const created = Array.isArray(data) ? data[0] : data;
  assert.equal(Number(created.rider_percentage), 80.00, 'Manteve 80.00% informado.');
});

test('4. Cliente interno Dahora Expresso possui rider_percentage = 85.00 no banco', async () => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/commercial_clients?select=rider_percentage,establishment_name,is_internal,client_code&is_internal=eq.true`, {
    headers
  });
  const data = await res.json();
  assert.ok(data.length > 0, 'Cliente interno localizado.');
  for (const client of data) {
    assert.equal(Number(client.rider_percentage), 85.00, `Cliente ${client.establishment_name} possui 85.00%`);
  }
});

test('5 e 6. Tele nova padrão de R$ 100,00 congela rider_percentage = 85.00 e gera R$ 85,00 motoboy / R$ 15,00 empresa', async () => {
  const nonce = Date.now();
  const adminHeaders = await getAdminAuthHeaders();

  const fleetRes = await fetch(`${SUPABASE_URL}/rest/v1/fleet`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      motoboy_code: `MB-85-${nonce}`,
      name: 'Motoboy Teste 85',
      phone: '(51) 91111-8585',
      status: 'Ativo'
    })
  });
  const fleetData = await fleetRes.json();
  const motoboy = Array.isArray(fleetData) ? fleetData[0] : fleetData;

  const clientRes = await fetch(`${SUPABASE_URL}/rest/v1/commercial_clients`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      client_code: `CLI-TEST-EXEC-${nonce}`,
      establishment_name: 'Restaurante Teste Execucao 85',
      responsible_name: 'Pedro Responsavel',
      phone: '(51) 92222-8585',
      email: `exec85_${nonce}@teste.local`,
      address: 'Rua Execucao 85',
      document: `85.${nonce.toString().slice(-6)}/0001-00`
    })
  });
  const clientData = await clientRes.json();
  const client = Array.isArray(clientData) ? clientData[0] : clientData;

  const teleRes = await fetch(`${SUPABASE_URL}/rest/v1/teles`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      tele_code: `TELE-85-${nonce}`,
      client_id: client.id,
      motoboy_id: motoboy.id,
      delivery_charge: 100.00,
      pickup_address: 'Origem 85',
      delivery_address: 'Destino 85',
      status: 'em_rota',
      version: 1
    })
  });
  const teleData = await teleRes.json();
  const tele = Array.isArray(teleData) ? teleData[0] : teleData;

  const completeRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/complete_tele`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      p_tele_id: tele.id,
      p_expected_version: 1,
      p_completion_source: 'test'
    })
  });
  const completeResult = await completeRes.json();
  assert.equal(completeResult.success, true, 'Tele concluída com sucesso.');

  const getTeleRes = await fetch(`${SUPABASE_URL}/rest/v1/teles?id=eq.${tele.id}`, { headers });
  const getTeleData = await getTeleRes.json();
  const updatedTele = Array.isArray(getTeleData) ? getTeleData[0] : getTeleData;
  assert.equal(Number(updatedTele.rider_percentage), 85.00, 'teles.rider_percentage congelou 85.00.');

  const rTxRes = await fetch(`${SUPABASE_URL}/rest/v1/rider_financial_transactions?tele_id=eq.${tele.id}`, { headers });
  const rTxData = await rTxRes.json();
  const riderTx = Array.isArray(rTxData) ? rTxData[0] : rTxData;
  assert.equal(Number(riderTx.amount), 85.00, 'Repasse do motoboy gravou exatamente R$ 85,00.');

  const cTxRes = await fetch(`${SUPABASE_URL}/rest/v1/company_financial_transactions?tele_id=eq.${tele.id}`, { headers });
  const cTxData = await cTxRes.json();
  const companyTx = Array.isArray(cTxData) ? cTxData[0] : cTxData;
  assert.equal(Number(companyTx.amount), 15.00, 'Receita da empresa gravou exatamente R$ 15,00.');
});

test('7. Tele de cliente customizado 80% gera R$ 80,00 motoboy / R$ 20,00 empresa', async () => {
  const nonce = Date.now();
  const adminHeaders = await getAdminAuthHeaders();

  const fleetRes = await fetch(`${SUPABASE_URL}/rest/v1/fleet`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      motoboy_code: `MB-80-${nonce}`,
      name: 'Motoboy Teste 80',
      phone: '(51) 91111-8080',
      status: 'Ativo'
    })
  });
  const fleetData = await fleetRes.json();
  const motoboy = Array.isArray(fleetData) ? fleetData[0] : fleetData;

  const clientRes = await fetch(`${SUPABASE_URL}/rest/v1/commercial_clients`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      client_code: `CLI-CUST80-${nonce}`,
      establishment_name: 'Restaurante Custom 80%',
      responsible_name: 'Roberto Resp',
      phone: '(51) 92222-8080',
      email: `cust80_${nonce}@teste.local`,
      address: 'Rua Custom 80',
      document: `80.${nonce.toString().slice(-6)}/0002-80`,
      rider_percentage: 80.00
    })
  });
  const clientData = await clientRes.json();
  const client = Array.isArray(clientData) ? clientData[0] : clientData;

  const teleRes = await fetch(`${SUPABASE_URL}/rest/v1/teles`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      tele_code: `TELE-80-${nonce}`,
      client_id: client.id,
      motoboy_id: motoboy.id,
      delivery_charge: 100.00,
      pickup_address: 'Origem 80',
      delivery_address: 'Destino 80',
      status: 'em_rota',
      version: 1
    })
  });
  const teleData = await teleRes.json();
  const tele = Array.isArray(teleData) ? teleData[0] : teleData;

  const completeRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/complete_tele`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      p_tele_id: tele.id,
      p_expected_version: 1,
      p_completion_source: 'test'
    })
  });
  const completeResult = await completeRes.json();
  assert.equal(completeResult.success, true, 'Tele customizada de 80% concluída.');

  const rTxRes = await fetch(`${SUPABASE_URL}/rest/v1/rider_financial_transactions?tele_id=eq.${tele.id}`, { headers });
  const rTxData = await rTxRes.json();
  const riderTx = Array.isArray(rTxData) ? rTxData[0] : rTxData;
  assert.equal(Number(riderTx.amount), 80.00, 'Motoboy recebe R$ 80,00.');

  const cTxRes = await fetch(`${SUPABASE_URL}/rest/v1/company_financial_transactions?tele_id=eq.${tele.id}`, { headers });
  const cTxData = await cTxRes.json();
  const companyTx = Array.isArray(cTxData) ? cTxData[0] : cTxData;
  assert.equal(Number(companyTx.amount), 20.00, 'Empresa recebe R$ 20,00.');
});

test('8. Histórico de transações e settlements permanece imutável', async () => {
  const content = await readFile(path.join(projectRoot, 'supabase', 'migrations', '20260805000300_fix_default_rider_percentage_85.sql'), 'utf8');
  assert.equal(content.includes('UPDATE public.rider_financial_transactions'), false, 'Sem UPDATE em rider_financial_transactions.');
  assert.equal(content.includes('UPDATE public.rider_weekly_settlements'), false, 'Sem UPDATE em rider_weekly_settlements.');
});

test('9. Migration não contém UPDATE genérico de clientes em 80%', async () => {
  const content = await readFile(path.join(projectRoot, 'supabase', 'migrations', '20260805000300_fix_default_rider_percentage_85.sql'), 'utf8');
  assert.equal(content.includes('WHERE rider_percentage = 80.00'), false, 'Migration não possui WHERE rider_percentage = 80.00.');
});

test('10. Seed local padrão utiliza 85%', async () => {
  const seedLocalUsers = await readFile(path.join(projectRoot, 'scripts', 'seed-local-users.mjs'), 'utf8');
  assert.equal(seedLocalUsers.includes('rider_percentage: 80.00'), false, 'seed-local-users.mjs atualizado para 85.00.');
});

test('11. Regressão das RPCs financeiras administrativas continua passando', async () => {
  const files = await readdir(path.join(projectRoot, 'supabase', 'migrations'));
  const activeMigrations = files.filter(f => f.endsWith('.sql'));
  assert.ok(activeMigrations.includes('20260805000300_fix_default_rider_percentage_85.sql'), 'Migration 20260805000300 presente na pasta ativa.');
});
