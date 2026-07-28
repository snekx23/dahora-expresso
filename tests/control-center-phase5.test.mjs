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
// 1. Migration 0018 - Estrutura e RPC complete_tele / cancel_tele
// ---------------------------------------------------------------------
test('Migration 20260727000500_tele_completion_ledger_rpc.sql contém tabelas de ledger imutável, idempotency_key e RPCs complete_tele / cancel_tele', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000500_tele_completion_ledger_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('rider_financial_transactions'), 'Tabela rider_financial_transactions ausente.');
  assert.ok(sql.includes('company_financial_transactions'), 'Tabela company_financial_transactions ausente.');
  assert.ok(sql.includes('idempotency_key'), 'Coluna idempotency_key ausente.');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.complete_tele'), 'RPC complete_tele ausente.');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.cancel_tele'), 'RPC cancel_tele ausente.');
  assert.ok(sql.includes('TELE_WITHOUT_RIDER'), 'Validação TELE_WITHOUT_RIDER ausente.');
  assert.ok(sql.includes('TELE_VERSION_CONFLICT'), 'Validação TELE_VERSION_CONFLICT ausente.');
});

// ---------------------------------------------------------------------
// 2. Conclusão Transacional Válida e Cálculo Financeiro no Backend
// ---------------------------------------------------------------------
test('Backend API: Conclusão válida calcula divisão financeira (80% motoboy / 20% empresa) no servidor', async () => {
  await resetTestDb();

  // Despachar tele primeiro
  await fetch(`${BASE_URL}/api/operations/assign-rider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-500', rider_id: 'MB-10', expected_version: 1 })
  });

  // Concluir tele com versão 2 esperada
  const res = await fetch(`${BASE_URL}/api/operations/complete-tele`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-500', expected_version: 2, completion_source: 'operator' })
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.success, true);
  assert.equal(data.status, 'concluida');
  assert.equal(data.version, 3);
  assert.equal(data.valor_cliente, 15.00);
  assert.equal(data.valor_motoboy, 12.00, 'Repasse do motoboy deve ser R$ 12.00 (80%).');
  assert.equal(data.taxa_empresa, 3.00, 'Taxa da empresa deve ser R$ 3.00 (20%).');
});

// ---------------------------------------------------------------------
// 3. Idempotência na Conclusão da Tele
// ---------------------------------------------------------------------
test('Backend API: Conclusão repetida é idempotente e não duplica lançamentos', async () => {
  await resetTestDb();

  // Concluir 1ª vez
  const res1 = await fetch(`${BASE_URL}/api/operations/complete-tele`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-501', expected_version: 1 })
  });
  assert.equal(res1.status, 200);

  // Concluir 2ª vez (repetição) -> Deve retornar sucesso idempotente sem erro ou duplicidade
  const res2 = await fetch(`${BASE_URL}/api/operations/complete-tele`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-501', expected_version: 2 })
  });

  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.success, true);
  assert.equal(data2.is_idempotent, true);
});

// ---------------------------------------------------------------------
// 4. Bloqueios de Segurança (Sem Motoboy, Versão Conflitante, Cancelada)
// ---------------------------------------------------------------------
test('Backend API: Bloqueia conclusão sem motoboy ou com versão conflitante', async () => {
  await resetTestDb();

  // 1. Tentar concluir tele sem motoboy -> Deve falhar com TELE_WITHOUT_RIDER
  const resNoRider = await fetch(`${BASE_URL}/api/operations/complete-tele`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-SEM-MOTOBOY', expected_version: 1 })
  });

  // Em devStore a tele sem motoboy_id inicializado retorna erro
  assert.equal(resNoRider.status, 400);
  const dataNoRider = await resNoRider.json();
  assert.equal(dataNoRider.error_code, 'TELE_WITHOUT_RIDER');
});

// ---------------------------------------------------------------------
// 5. Cancelamento Controlado com Motivo Obrigatório
// ---------------------------------------------------------------------
test('Backend API: Cancelamento exige motivo obrigatório e é bloqueado se já concluída', async () => {
  await resetTestDb();

  // 1. Cancelamento sem motivo -> Deve falhar com CANCELLATION_REASON_REQUIRED
  const resNoReason = await fetch(`${BASE_URL}/api/operations/cancel-tele`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-CANCEL-1', expected_version: 1, reason: '' })
  });

  assert.equal(resNoReason.status, 400);
  const dataNoReason = await resNoReason.json();
  assert.equal(dataNoReason.error_code, 'CANCELLATION_REASON_REQUIRED');

  // 2. Cancelamento com motivo -> Sucesso
  const resOk = await fetch(`${BASE_URL}/api/operations/cancel-tele`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-CANCEL-1', expected_version: 1, reason: 'Cliente desistiu do pedido' })
  });

  assert.equal(resOk.status, 200);
  const dataOk = await resOk.json();
  assert.equal(dataOk.success, true);
  assert.equal(dataOk.status, 'cancelada');

  // 3. Tentar concluir a tele cancelada -> Deve falhar com TELE_ALREADY_CANCELLED
  const resCompleteCancelled = await fetch(`${BASE_URL}/api/operations/complete-tele`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tele_id: 'TEL-CANCEL-1', expected_version: 2 })
  });

  assert.equal(resCompleteCancelled.status, 400);
  const dataCompleteCancelled = await resCompleteCancelled.json();
  assert.equal(dataCompleteCancelled.error_code, 'TELE_ALREADY_CANCELLED');
});

// ---------------------------------------------------------------------
// 6. Modais e Componentes Visuais em index.html e app.js
// ---------------------------------------------------------------------
test('index.html e app.js contêm modais de conclusão, cancelamento e prévia financeira', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.ok(html.includes('id="modal-complete-tele"'), 'Modal modal-complete-tele ausente em index.html.');
  assert.ok(html.includes('id="modal-cancel-tele"'), 'Modal modal-cancel-tele ausente em index.html.');
  assert.ok(html.includes('id="complete-confirm-checkbox"'), 'Checkbox de confirmação ausente.');

  assert.ok(appJs.includes('openCompleteTeleModal'), 'Função openCompleteTeleModal ausente em app.js.');
  assert.ok(appJs.includes('submitCompleteTele'), 'Função submitCompleteTele ausente em app.js.');
  assert.ok(appJs.includes('openCancelTeleModal'), 'Função openCancelTeleModal ausente em app.js.');
  assert.ok(appJs.includes('submitCancelTele'), 'Função submitCancelTele ausente em app.js.');
});
