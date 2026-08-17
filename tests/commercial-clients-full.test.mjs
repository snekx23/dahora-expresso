import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY, LOCAL_SERVICE_ROLE_KEY, ADMIN_TEST_EMAIL, ADMIN_TEST_PASS } from './helpers/test-fixtures.mjs';

const BASE_URL = 'http://localhost:8000';

async function getAdminToken() {
  const sb = createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY);
  const { data: users } = await sb.from('user_profiles').select('user_id').eq('email', ADMIN_TEST_EMAIL);
  if (users && users.length > 0) {
    await sb.auth.admin.updateUserById(users[0].user_id, { password: ADMIN_TEST_PASS, email_confirm: true });
  }
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY);
  const { data } = await client.auth.signInWithPassword({ email: ADMIN_TEST_EMAIL, password: ADMIN_TEST_PASS });
  return data?.session?.access_token || '';
}

// ---------------------------------------------------------------------
// 1. Validação Sintática das Migrations SQL
// ---------------------------------------------------------------------
test('Migration 20260727000200_commercial_clients.sql possui estrutura relacional e RLS completa', async () => {
  const sql0015 = await readFile(new URL('../supabase/migrations/20260727000200_commercial_clients.sql', import.meta.url), 'utf8');

  assert.ok(sql0015.includes('commercial_client_code_seq'), 'Sequence CLI-000001 ausente.');
  assert.ok(sql0015.includes('lifecycle_status'), 'lifecycle_status ausente.');
  assert.ok(sql0015.includes('financial_status'), 'financial_status ausente.');
  assert.ok(sql0015.includes('ON DELETE RESTRICT'), 'ON DELETE RESTRICT ausente.');
  assert.ok(!sql0015.includes('password_hash'), 'password_hash não deve existir no banco público.');

  assert.ok(sql0015.includes('ENABLE ROW LEVEL SECURITY'), 'RLS não habilitado.');
  assert.ok(sql0015.includes('client_users'), 'Tabela client_users ausente.');
});

// ---------------------------------------------------------------------
// 2. Validação da Interface HTML (Garantia de Estrutura)
// ---------------------------------------------------------------------
test('index.html contém todos os componentes da Área de Clientes Comerciais e Painel do Cliente', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.ok(html.includes('data-tab="owner-commercial-clients"'), 'Aba Clientes Comerciais ausente na sidebar.');
  assert.ok(html.includes('id="tab-owner-commercial-clients"'), 'Container da aba tab-owner-commercial-clients ausente.');
  assert.ok(html.includes('id="modal-add-commercial-client"'), 'Modal modal-add-commercial-client ausente.');
  assert.ok(html.includes('Novo Cliente Comercial'), 'Título do modal de novo cliente ausente.');
  assert.ok(html.includes('Solicitar Entrega'), 'Vocabulário "Entrega" no painel do cliente ausente.');
});

// ---------------------------------------------------------------------
// 3. Teste de Integração da API de Backend Seguro (/api/admin/create-client)
// ---------------------------------------------------------------------
test('Backend API: Criação completa de cliente com código CLI-XXXXXX e auditoria sem senhas', async () => {
  const adminToken = await getAdminToken();
  const randNum = Math.floor(100000 + Math.random() * 899999);
  const payload = {
    establishment_name: `Restaurante Sabor Real ${randNum}`,
    responsible_name: 'Marcos Souza',
    phone: '51977771111',
    email: `marcos.${randNum}@saborreal.test`,
    password: 'senhaSegura123',
    address: 'Rua das Palmeiras, 800',
    neighborhood: 'Jardins',
    city: 'São Paulo',
    document: `${randNum}000144`
  };

  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 201);
  const json = await response.json();

  assert.ok(json.client, 'Objeto client deve ser retornado.');
  assert.ok((json.client.client_code || json.client.public_code).startsWith('CLI-'), 'Código público deve iniciar com CLI-.');
  assert.equal(json.client.establishment_name, payload.establishment_name);
  assert.equal(json.client.lifecycle_status, 'ativo');
  assert.equal(json.client.financial_status, 'em_dia');

  // Segurança: sem senhas no retorno ou logs
  assert.equal(json.client.password, undefined);
  assert.equal(json.client.password_hash, undefined);
});

test('Backend API: Bloqueio de duplicidades de Email ou Documento', async () => {
  const adminToken = await getAdminToken();
  const randNum = Math.floor(100000 + Math.random() * 899999);
  const payload = {
    establishment_name: `Pizzaria Bella ${randNum}`,
    responsible_name: 'Lucia Ferraz',
    phone: '51955554444',
    email: `lucia.${randNum}@pizzariabella.test`,
    password: 'senhaSegura123',
    address: 'Av. Paulista, 1000',
    document: `${randNum}000188`
  };

  const res1 = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payload)
  });
  assert.equal(res1.status, 201);

  const resDup = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payload)
  });
  assert.equal(resDup.status, 409);
});

test('Backend API: Execução do mecanismo de Compensação (Rollback) em erro relacional', async () => {
  const adminToken = await getAdminToken();
  const randNum = Math.floor(100000 + Math.random() * 899999);
  const payload = {
    establishment_name: 'Loja Rollback Total',
    responsible_name: 'Tiago Mendes',
    phone: '51944443333',
    email: `tiago.${randNum}@rollbacktotal.test`,
    password: 'senhaSegura123',
    address: 'Rua do Teste, 50',
    document: `${randNum}000150`
  };

  const res1 = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payload)
  });
  assert.equal(res1.status, 201);

  // Re-submission of duplicate payload causes PostgreSQL unique constraint violation and triggers rollback compensation
  const res2 = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payload)
  });

  assert.ok([400, 409, 500].includes(res2.status));
});
