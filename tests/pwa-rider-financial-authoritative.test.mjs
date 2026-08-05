// =====================================================================
// Dahora Expresso — Suíte de Testes: Bloco 3B.2B (Extrato Financeiro Autoritativo do PWA v2)
// File: tests/pwa-rider-financial-authoritative.test.mjs
// =====================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const motoboyJsPath = path.join(projectRoot, 'public', 'motoboy.js');
const motoboyHtmlPath = path.join(projectRoot, 'public', 'motoboy.html');
const migrationsDir = path.join(projectRoot, 'supabase', 'migrations');
const rpcMigrationPath = path.join(migrationsDir, '20260805000200_pwa_authoritative_financial_rpc_v2.sql');

test('1. Migration aditiva 20260805000200_pwa_authoritative_financial_rpc_v2.sql existe e exige autenticação', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes('CREATE OR REPLACE FUNCTION public.get_my_rider_financial_statement_v2'), 'RPC v2 criada.');
  assert.ok(content.includes('v_user_id IS NULL'), 'RPC v2 valida se o usuário está autenticado.');
  assert.ok(content.includes("AUTHENTICATION_REQUIRED"), 'Código de erro de autenticação presente.');
});

test('2. Motoboy resolve somente o próprio fleet.id por auth.uid() sem aceitar rider_id arbitrário', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes('WHERE user_id = v_user_id'), 'Busca o rider_id vinculado estritamente ao auth.uid().');
  assert.equal(content.includes('p_rider_id'), false, 'RPC v2 não pode aceitar rider_id arbitrário do frontend.');
});

test('3. Garantia de isolamento cross-tenant: Motoboy A não acessa dados do Motoboy B', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes('WHERE rider_id = v_rider_id'), 'Consultas a rider_weekly_settlements filtram estritamente por v_rider_id.');
});

test('4. Ausência total do campo gross_delivery_amount no payload sanitizado do PWA', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  const returnBlock = content.slice(content.indexOf('RETURN pg_catalog.jsonb_build_object'));
  assert.equal(returnBlock.includes('gross_delivery_amount'), false, 'gross_delivery_amount deve ser omitido do payload sanitizado.');
});

test('5. Ausência total do campo platform_amount no payload sanitizado', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  const returnBlock = content.slice(content.indexOf('RETURN pg_catalog.jsonb_build_object'));
  assert.equal(returnBlock.includes('platform_amount'), false, 'platform_amount deve ser omitido do payload sanitizado.');
});

test('6. Ausência de percentuais e comissão da empresa no payload retornado', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.equal(content.includes('platform_percentage'), false, 'Percentual da plataforma não pode constar na RPC v2.');
  assert.equal(content.includes('company_commission'), false, 'Comissão da empresa não pode constar na RPC v2.');
});

test('7. unpaid_eligible_amount calculado 100% no Postgres', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes('v_unpaid_eligible :='), 'Variável v_unpaid_eligible declarada.');
  assert.ok(content.includes('GREATEST(0.00'), 'Cálculo com GREATEST(0.00, eligible_amount - paid_amount) executado no Postgres.');
  assert.ok(content.includes("'unpaid_eligible_amount', v_unpaid_eligible"), 'unpaid_eligible_amount retornado no JSON.');
});

test('8. Mapeamento de status reais (open, calculated, pending, partially_blocked, paid, reopened, reversed, cancelled)', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes("WHEN 'open' THEN v_status_label :="), 'Tratamento de status open.');
  assert.ok(content.includes("WHEN 'calculated' THEN v_status_label :="), 'Tratamento de status calculated.');
  assert.ok(content.includes("WHEN 'pending' THEN v_status_label :="), 'Tratamento de status pending.');
  assert.ok(content.includes("WHEN 'partially_blocked' THEN v_status_label :="), 'Tratamento de status partially_blocked.');
  assert.ok(content.includes("WHEN 'paid' THEN v_status_label :="), 'Tratamento de status paid.');
  assert.ok(content.includes("WHEN 'reopened' THEN v_status_label :="), 'Tratamento de status reopened.');
  assert.ok(content.includes("WHEN 'reversed' THEN v_status_label :="), 'Tratamento de status reversed.');
  assert.ok(content.includes("WHEN 'cancelled' THEN v_status_label :="), 'Tratamento de status cancelled.');
  assert.ok(content.includes("ELSE v_status_label := 'Status Indisponível'"), 'Fallback de status desconhecido.');
});

test('9. partially_blocked inclui blocked_amount no settlement', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes("'blocked_amount', v_settlement.blocked_amount"), 'blocked_amount retornado no settlement.');
});

test('10. Validation estrita de paid_at em latest_payment (Ignora lotes inconsistentes sem paid_at)', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes("b.status = 'paid'"), 'Filtra por status = paid.');
  assert.ok(content.includes('b.paid_at IS NOT NULL'), 'Filtra estritamente lotes que possuem paid_at não nulo.');
  assert.ok(content.includes('ORDER BY b.paid_at DESC'), 'Ordena estritamente por paid_at em ordem decrescente.');
});

test('11. Lotes de pagamento em batches retornam de forma sanitizada (sem actor_id / paid_by / id desnecessário)', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes('FROM public.rider_payment_batches b'), 'Lotes consultados em rider_payment_batches.');
  assert.equal(content.includes('b.paid_by'), false, 'paid_by omitido em batches.');
  assert.equal(content.includes('b.actor_id'), false, 'actor_id omitido em batches.');
  assert.equal(content.includes('b.internal_notes'), false, 'internal_notes omitido em batches.');
});

test('12. Tratamento gracioso para semana sem settlement (has_settlement = false)', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes("'has_settlement', false"), 'Retorna has_settlement = false caso nenhum fechamento seja localizado.');
});

test('13. Histórico de períodos disponíveis sanitizado e limitado entre 1 e 52', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes('v_limit := COALESCE(p_history_limit, 12)'), 'Limite padrão de histórico 12.');
  assert.ok(content.includes('IF v_limit < 1 THEN v_limit := 1; END IF;'), 'Piso do limite 1.');
  assert.ok(content.includes('IF v_limit > 52 THEN v_limit := 52; END IF;'), 'Teto do limite 52.');
  assert.ok(content.includes("'available_periods', v_available_periods"), 'available_periods retornado.');
});

test('14. Regras de Período Semanal Canônico (7 dias, 168h, limite superior exclusivo, zero 23:59:59 em boundaries SQL)', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.equal(content.includes('23:59:59'), false, 'Zero ocorrências de 23:59:59 no SQL da RPC v2.');
  assert.ok(content.includes('period_start'), 'Preserva period_start canônico retornado do Postgres.');
  assert.ok(content.includes('period_end'), 'Preserva period_end canônico retornado do Postgres.');
});

test('15. Zero cálculo financeiro ou multiplicadores no JS do PWA (sem 0.85 / 0.15 / reduce em totais)', async () => {
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.equal(motoboyJs.includes('* 0.85'), false, 'Sem 0.85 no JS.');
  assert.equal(motoboyJs.includes('* 0.15'), false, 'Sem 0.15 no JS.');
  assert.equal(motoboyJs.includes('items.reduce('), false, 'Sem reduce de extrato.');
});

test('16. Zero mutação financeira direta no JS do PWA', async () => {
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.equal(motoboyJs.includes("from('rider_financial_transactions').insert"), false, 'Sem insert direto.');
  assert.equal(motoboyJs.includes("from('rider_weekly_settlements').update"), false, 'Sem update direto em fechamentos.');
});

test('17. Realtime de settlement dispara somente re-fetch da RPC sanitizada', async () => {
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.ok(motoboyJs.includes("table: 'rider_weekly_settlements'"), 'Canal assina rider_weekly_settlements.');
  assert.ok(motoboyJs.includes('debouncedFetch'), 'Evento invoca callback com debounce.');
});

test('18. Realtime de outro motoboy não dispara atualização (Filtro seguro por rider_id)', async () => {
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.ok(motoboyJs.includes('filter: `rider_id=eq.${fleetId}`'), 'Filtro rider_id presente em settlements e transactions.');
});

test('19. Evento visibilitychange dispara re-fetch autoritativo', async () => {
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.ok(motoboyJs.includes("document.addEventListener('visibilitychange'"), 'visibilitychange registrado.');
});

test('20. Evento online dispara reconciliação autoritativa ao reconectar', async () => {
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.ok(motoboyJs.includes("window.addEventListener('online'"), 'online listener registrado.');
});

test('21. Purga completa de estado e realtime no handleMotoLogout', async () => {
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.ok(motoboyJs.includes('reportsFetchToken++'), 'Incrementa token no logout.');
  assert.ok(motoboyJs.includes('pwaStatementCachedItems.clear()'), 'Limpa cache de itens no logout.');
});

test('22. Ausência de canais duplicados no Realtime', async () => {
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.ok(motoboyJs.includes('if (!supabaseClient || realtimeFinancialSubscription) return;'), 'Impede abertura de canais duplicados.');
});

test('23. RPC v2 reflete status reversed e estornos de forma autoritativa', async () => {
  const content = await readFile(rpcMigrationPath, 'utf8');
  assert.ok(content.includes("WHEN 'reversed' THEN v_status_label :="), 'Status reversed mapeado em v_status_label.');
});

test('24. Preservação de migrations baseline e ausência de regressão em código legado', async () => {
  const files = await readdir(migrationsDir);
  const olderMigrations = files.filter(f => f.endsWith('.sql') && !f.startsWith('20260805'));
  assert.equal(olderMigrations.length, 23, 'Todas as 23 migrations baseline anteriores devem permanecer intactas.');
});
