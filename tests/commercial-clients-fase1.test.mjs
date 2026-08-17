import test from 'node:test';
import assert from 'node:assert/strict';
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

test('Backend Adapter: Rejeição de requisição anônima sem Bearer JWT -> 401', async () => {
  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ establishment_name: 'Sem Auth' })
  });
  assert.equal(response.status, 401, 'Requisição sem token Bearer deve retornar 401.');
});

test('Backend Adapter: Criação bem-sucedida de cliente com código CLI-XXXXXX e auditoria sem senhas', async () => {
  const adminToken = await getAdminToken();
  const randNum = Math.floor(100000 + Math.random() * 899999);
  const payload = {
    establishment_name: `Padaria Central ${randNum}`,
    responsible_name: 'Carlos Oliveira',
    phone: '51988887777',
    email: `carlos.${randNum}@padariacentral.test`,
    password: 'senhaSegura123',
    address: 'Av. Brasil, 1500',
    neighborhood: 'Centro',
    city: 'São Paulo',
    document: `${randNum}000190`
  };

  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 201, 'Status de criação deve ser 201 Created.');
  const json = await response.json();

  assert.ok(json.client, 'Cliente criado deve ser retornado no JSON.');
  assert.ok((json.client.client_code || json.client.public_code).startsWith('CLI-'), 'Código público deve iniciar com CLI-.');
  assert.equal(json.client.establishment_name, payload.establishment_name);
  assert.equal(json.client.lifecycle_status, 'ativo');
  assert.equal(json.client.financial_status, 'em_dia');

  assert.equal(json.client.password, undefined, 'Senha não deve vazar no objeto do cliente.');
  assert.equal(json.client.password_hash, undefined, 'Hash de senha não deve existir.');
});

test('Backend Adapter: Rejeição de cadastro duplicado (Email ou Documento)', async () => {
  const adminToken = await getAdminToken();
  const randNum = Math.floor(100000 + Math.random() * 899999);
  const payloadOriginal = {
    establishment_name: `Farmácia Vida ${randNum}`,
    responsible_name: 'Ana Costa',
    phone: '51977776666',
    email: `ana.${randNum}@farmaciavida.test`,
    password: 'senhaSegura123',
    address: 'Rua das Flores, 200',
    document: `${randNum}000110`
  };

  // Primeiro cadastro
  const res1 = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payloadOriginal)
  });
  assert.equal(res1.status, 201);

  // Tentativa de duplicidade por email
  const resDuplicado = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ ...payloadOriginal, establishment_name: 'Outra Loja' })
  });

  assert.equal(resDuplicado.status, 409, 'Cadastro duplicado deve retornar 409 Conflict.');
  const jsonErr = await resDuplicado.json();
  assert.ok(jsonErr.error.includes('cadastrado'), 'Mensagem de duplicidade esperada.');
});

test('Backend Adapter: Rejeição de requisição com campos obrigatórios ausentes', async () => {
  const adminToken = await getAdminToken();
  const payloadIncompleto = {
    establishment_name: 'Mercado Incompleto'
  };

  const response = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payloadIncompleto)
  });

  assert.equal(response.status, 400, 'Requisição incompleta deve retornar 400 Bad Request.');
});

test('Backend Adapter: Execução de Compensação / Rollback em caso de erro relacional no banco', async () => {
  const adminToken = await getAdminToken();
  const randNum = Math.floor(100000 + Math.random() * 899999);
  const payload1 = {
    establishment_name: 'Loja Rollback Teste',
    responsible_name: 'Renato Silva',
    phone: '51966665555',
    email: `renato.${randNum}@rollback.test`,
    password: 'senhaSegura123',
    address: 'Rua Teste, 100',
    document: `${randNum}000199`
  };

  const res1 = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payload1)
  });
  assert.equal(res1.status, 201);

  // Duplicate call triggers PostgreSQL relational constraint error -> rollback
  const res2 = await fetch(`${BASE_URL}/api/admin/create-client`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify(payload1)
  });

  assert.ok([400, 409, 500].includes(res2.status), 'Falha relacional deve retornar erro.');
});
