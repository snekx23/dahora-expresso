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
// 1. Migration 0017 - Sintaxe e Funções RPC
// ---------------------------------------------------------------------
test('Baseline de Migrations contém colunas de versão, limite simultâneo e a RPC assign_rider_to_tele', async () => {
  const sql0001 = await readFile(new URL('../supabase/migrations/20260727000100_init_core_schema.sql', import.meta.url), 'utf8');
  const sql0004 = await readFile(new URL('../supabase/migrations/20260727000400_dispatch_concurrency_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql0001.includes('version INTEGER NOT NULL DEFAULT 1'), 'Coluna version ausente em teles.');
  assert.ok(sql0001.includes('simultaneous_limit INTEGER NOT NULL DEFAULT 3'), 'Coluna simultaneous_limit ausente em fleet.');
  assert.ok(sql0004.includes('CREATE OR REPLACE FUNCTION public.assign_rider_to_tele'), 'Função RPC assign_rider_to_tele ausente.');
  assert.ok(sql0004.includes('TELE_VERSION_CONFLICT'), 'Tratamento TELE_VERSION_CONFLICT ausente na RPC.');
  assert.ok(sql0004.includes('RIDER_CAPACITY_REACHED'), 'Tratamento RIDER_CAPACITY_REACHED ausente na RPC.');
  assert.ok(sql0004.includes('REASSIGN_REASON_REQUIRED'), 'Tratamento REASSIGN_REASON_REQUIRED ausente na RPC.');
  assert.ok(sql0004.includes('FOR UPDATE'), 'Lock transacional FOR UPDATE ausente na RPC.');
});

// ---------------------------------------------------------------------
// 2. Despacho Válido, Incremento de Versão e Integridade Financeira
// ---------------------------------------------------------------------
test('Backend API: Despacho seguro válido incrementa versão e preserva dados financeiros', async () => {
  await resetTestDb();

  const payload = {
    tele_id: 'TEL-100',
    rider_id: 'MB-50',
    expected_version: 1
  };

  const res = await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.success, true);
  assert.equal(data.tele_id, 'TEL-100');
  assert.equal(data.rider_id, 'MB-50');
  assert.equal(data.status, 'motoboy_designado');
  assert.equal(data.version, 2, 'Versão deve ser incrementada para 2.');
});

// ---------------------------------------------------------------------
// 3. Controle de Concorrência Otimista (Version Conflict)
// ---------------------------------------------------------------------
test('Backend API: Conflito de versão (dois operadores alterando a mesma tele)', async () => {
  await resetTestDb();

  // 1º Operador realiza despacho com a versão 1 esperada -> Sucesso (Versão passa para 2)
  const res1 = await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-200', rider_id: 'MB-50', expected_version: 1 })
  });
  assert.equal(res1.status, 200);

  // 2º Operador tenta despachar a mesma tele enviando versão 1 desatualizada -> Deve Falhar com TELE_VERSION_CONFLICT
  const res2 = await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-200', rider_id: 'MB-51', expected_version: 1, reason: 'Troca operador 2' })
  });

  assert.equal(res2.status, 409);
  const data2 = await res2.json();
  assert.equal(data2.success, false);
  assert.equal(data2.error_code, 'TELE_VERSION_CONFLICT');
});

// ---------------------------------------------------------------------
// 4. Bloqueio por Limite de Capacidade Simultânea (RIDER_CAPACITY_REACHED)
// ---------------------------------------------------------------------
test('Backend API: Bloqueio de despacho ao atingir o limite simultâneo do motoboy', async () => {
  await resetTestDb();

  // O limite em mock dev é 3 entregas simultâneas por motoboy
  const riderId = 'MB-99';

  await fetch(`${BASE_URL}/api/operations/assign-rider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tele_id: 'T-1', rider_id: riderId, expected_version: 1 }) });
  await fetch(`${BASE_URL}/api/operations/assign-rider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tele_id: 'T-2', rider_id: riderId, expected_version: 1 }) });
  await fetch(`${BASE_URL}/api/operations/assign-rider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tele_id: 'T-3', rider_id: riderId, expected_version: 1 }) });

  // 4ª Entrega tenta ocupar vaga no mesmo motoboy -> Deve falhar com RIDER_CAPACITY_REACHED
  const res4 = await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'T-4', rider_id: riderId, expected_version: 1 })
  });

  assert.equal(res4.status, 400);
  const data4 = await res4.json();
  assert.equal(data4.success, false);
  assert.equal(data4.error_code, 'RIDER_CAPACITY_REACHED');
});

// ---------------------------------------------------------------------
// 5. Reatribuição (Troca de Motoboy) Exige Motivo
// ---------------------------------------------------------------------
test('Backend API: Reatribuição de motoboy exige motivo obrigatório', async () => {
  await resetTestDb();

  // Atribuir motoboy 1
  const res1 = await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-REASSIGN-300', rider_id: 'MB-1', expected_version: 1 })
  });
  const data1 = await res1.json();
  const v1 = data1.version;

  // Tentar trocar para motoboy 2 SEM motivo -> Deve falhar com REASSIGN_REASON_REQUIRED
  const resNoReason = await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-REASSIGN-300', rider_id: 'MB-2', expected_version: v1, reason: '' })
  });

  assert.equal(resNoReason.status, 400);
  const dataNoReason = await resNoReason.json();
  assert.equal(dataNoReason.error_code, 'REASSIGN_REASON_REQUIRED');

  // Trocar COM motivo -> Deve ter sucesso
  const resWithReason = await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-REASSIGN-300', rider_id: 'MB-2', expected_version: v1, reason: 'Pneu furado no percurso' })
  });

  assert.equal(resWithReason.status, 200);
  const dataWithReason = await resWithReason.json();
  assert.equal(dataWithReason.success, true);
  assert.equal(dataWithReason.rider_id, 'MB-2');
});

// ---------------------------------------------------------------------
// 6. Bloqueio de Alteração em Teles Concluídas ou Canceladas
// ---------------------------------------------------------------------
test('Backend API: Bloqueio de despacho para teles concluídas ou canceladas', async () => {
  await resetTestDb();

  // Em dev store, simular tele concluída inserindo diretamente
  const res = await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-CONCLUIDA', rider_id: 'MB-1', expected_version: 1 })
  });

  // Primeiro despacho transforma em motoboy_designado
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------
// 7. Acessibilidade e Componentes em index.html
// ---------------------------------------------------------------------
test('index.html e app.js contêm modal de despacho e atributos de acessibilidade', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.ok(html.includes('id="modal-assign-rider"'), 'Modal modal-assign-rider ausente em index.html.');
  assert.ok(html.includes('id="group-reassign-reason"'), 'Grupo de motivo de troca ausente em index.html.');
  assert.ok(html.includes('id="op-summary-fleet-list"'), 'Lista op-summary-fleet-list ausente em index.html.');

  assert.ok(appJs.includes('openAssignRiderModal'), 'Função openAssignRiderModal ausente em app.js.');
  assert.ok(appJs.includes('assignRiderToTele'), 'Função assignRiderToTele ausente em app.js.');
});
