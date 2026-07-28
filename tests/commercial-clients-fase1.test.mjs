import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------
// 1. Validação Sintática das Migrations SQL da Fase 1
// ---------------------------------------------------------------------
test('Migration 20260727000200_commercial_clients.sql contém tabelas e restrições corretas', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000200_commercial_clients.sql', import.meta.url), 'utf8');

  // Verifica criação da sequence CLI-000001
  assert.ok(sql.includes('commercial_client_code_seq'), 'Sequence commercial_client_code_seq ausente.');

  // Verifica tabelas essenciais
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.commercial_clients'), 'Tabela commercial_clients ausente.');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.client_users'), 'Tabela client_users ausente.');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.client_financial_transactions'), 'Tabela client_financial_transactions ausente.');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.system_audit_logs'), 'Tabela system_audit_logs ausente.');

  // Verifica separação dos status (lifecycle vs financial)
  assert.ok(sql.includes('lifecycle_status'), 'Campo lifecycle_status ausente em commercial_clients.');
  assert.ok(sql.includes('financial_status'), 'Campo financial_status ausente em commercial_clients.');

  // Verifica ON DELETE RESTRICT
  assert.ok(sql.includes('REFERENCES public.commercial_clients(id) ON DELETE RESTRICT'), 'Restrição ON DELETE RESTRICT ausente.');

  // Garantia de segurança: sem password_hash em commercial_clients
  assert.ok(!sql.includes('password_hash'), 'ATENÇÃO: password_hash não deve existir no banco público/commercial_clients!');
});

test('Migration 20260727000200_commercial_clients.sql habilita RLS e cria políticas de segurança', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000200_commercial_clients.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('ALTER TABLE public.commercial_clients ENABLE ROW LEVEL SECURITY;'), 'RLS não habilitado em commercial_clients.');
  assert.ok(sql.includes('commercial_clients_select'), 'Políticas de RLS em commercial_clients ausentes.');
  assert.ok(sql.includes('client_users'), 'Junção com client_users ausente nas políticas de RLS.');
});

// ---------------------------------------------------------------------
// 2. Testes de Integração da API do Adapter Backend Seguro (/api/admin/create-client)
// ---------------------------------------------------------------------
const BASE_URL = 'http://localhost:8000';

async function resetTestDb() {
  try {
    await fetch(`${BASE_URL}/api/admin/reset-test-db`, { method: 'POST' });
  } catch (e) {}
}

test('Backend Adapter: Criação bem-sucedida de cliente com código CLI-XXXXXX e auditoria sem senhas', async () => {
  await resetTestDb();
  const payload = {
    establishment_name: 'Padaria Central',
    responsible_name: 'Carlos Oliveira',
    phone: '(11) 98888-7777',
    email: 'carlos@padariacentral.test',
    password: 'senhaSegura123',
    address: 'Av. Brasil, 1500',
    neighborhood: 'Centro',
    city: 'São Paulo',
    document: '12.345.678/0001-90'
  };

  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 201, 'Status de criação deve ser 201 Created.');
  const json = await response.json();

  assert.ok(json.client, 'Cliente criado deve ser retornado no JSON.');
  assert.ok(json.client.public_code.startsWith('CLI-'), 'Código público deve iniciar com CLI-.');
  assert.equal(json.client.establishment_name, 'Padaria Central');
  assert.equal(json.client.lifecycle_status, 'ativo');
  assert.equal(json.client.financial_status, 'em_dia');

  // Validação de Segurança Crítica: nenhuma senha nos dados retornados ou auditados!
  assert.equal(json.client.password, undefined, 'Senha não deve vazar no objeto do cliente.');
  assert.equal(json.client.password_hash, undefined, 'Hash de senha não deve existir.');
  assert.equal(json.audit.details.password, undefined, 'Senha não deve constar na auditoria.');
});

test('Backend Adapter: Rejeição de cadastro duplicado (Email ou Documento)', async () => {
  await resetTestDb();
  const payloadOriginal = {
    establishment_name: 'Farmácia Vida',
    responsible_name: 'Ana Costa',
    phone: '11977776666',
    email: 'ana@farmaciavida.test',
    password: 'senhaSegura123',
    address: 'Rua das Flores, 200',
    document: '98.765.432/0001-10'
  };

  // Primeiro cadastro
  const res1 = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadOriginal)
  });
  assert.equal(res1.status, 201);

  // Tentativa de duplicidade por email
  const resDuplicado = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payloadOriginal, establishment_name: 'Outra Loja' })
  });

  assert.equal(resDuplicado.status, 409, 'Cadastro duplicado deve retornar 409 Conflict.');
  const jsonErr = await resDuplicado.json();
  assert.ok(jsonErr.error.includes('já cadastrado'), 'Mensagem de duplicidade esperada.');
});

test('Backend Adapter: Rejeição de requisição com campos obrigatórios ausentes', async () => {
  const payloadIncompleto = {
    establishment_name: 'Mercado Incompleto'
    // Faltam campos obrigatórios
  };

  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadIncompleto)
  });

  assert.equal(response.status, 400, 'Requisição incompleta deve retornar 400 Bad Request.');
});

test('Backend Adapter: Execução de Compensação / Rollback em caso de erro relacional no banco', async () => {
  const payloadComErro = {
    establishment_name: 'Loja Rollback Teste',
    responsible_name: 'Renato Silva',
    phone: '11966665555',
    email: 'renato@rollback.test',
    password: 'senhaSegura123',
    address: 'Rua Teste, 100',
    force_db_error: true // Simula falha relacional no DB
  };

  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadComErro)
  });

  assert.equal(response.status, 500, 'Falha no banco deve retornar 500 Server Error.');
  const json = await response.json();
  assert.ok(json.error.includes('Rollback'), 'Mensagem deve indicar execução do rollback de compensação.');
});
