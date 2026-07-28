import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const BASE_URL = 'http://localhost:8000';

async function resetTestDb() {
  try {
    await fetch(`${BASE_URL}/api/admin/reset-test-db`, { method: 'POST' });
  } catch (e) {}
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
  const payload = {
    establishment_name: 'Restaurante Sabor Real',
    responsible_name: 'Marcos Souza',
    phone: '(11) 97777-1111',
    email: 'marcos@saborreal.test',
    password: 'senhaSegura123',
    address: 'Rua das Palmeiras, 800',
    neighborhood: 'Jardins',
    city: 'São Paulo',
    document: '11.222.333/0001-44'
  };

  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 201);
  const json = await response.json();

  assert.ok(json.client, 'Objeto client deve ser retornado.');
  assert.ok(json.client.public_code.startsWith('CLI-'), 'Código público deve iniciar com CLI-.');
  assert.equal(json.client.establishment_name, 'Restaurante Sabor Real');
  assert.equal(json.client.lifecycle_status, 'ativo');
  assert.equal(json.client.financial_status, 'em_dia');

  // Segurança: sem senhas no retorno ou logs
  assert.equal(json.client.password, undefined);
  assert.equal(json.client.password_hash, undefined);
  assert.equal(json.audit.details.password, undefined);
});

test('Backend API: Bloqueio de duplicidades de Email ou Documento', async () => {
  await resetTestDb();
  const payload = {
    establishment_name: 'Pizzaria Bella',
    responsible_name: 'Lucia Ferraz',
    phone: '11955554444',
    email: 'lucia@pizzariabella.test',
    password: 'senhaSegura123',
    address: 'Av. Paulista, 1000',
    document: '55.666.777/0001-88'
  };

  const res1 = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(res1.status, 201);

  const resDup = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(resDup.status, 409);
});

test('Backend API: Execução do mecanismo de Compensação (Rollback) em erro relacional', async () => {
  const payload = {
    establishment_name: 'Loja Rollback Total',
    responsible_name: 'Tiago Mendes',
    phone: '11944443333',
    email: 'tiago@rollbacktotal.test',
    password: 'senhaSegura123',
    address: 'Rua do Teste, 50',
    force_db_error: true
  };

  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 500);
  const json = await response.json();
  assert.ok(json.error.includes('Rollback'));
});
