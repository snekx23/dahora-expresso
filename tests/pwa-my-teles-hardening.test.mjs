import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('1. Frontend public/motoboy.js não possui cálculo estático delivery_charge * 0.80', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(!motoboyJs.includes('delivery_charge * 0.80'), 'Cálculo estático 0.80 não deve existir no frontend.');
});

test('2. Frontend public/motoboy.js não possui percentual fixo de 80.00 inventado no frontend', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(!motoboyJs.includes('80.00%'), 'Percentual estático inventado não deve existir na UI do frontend.');
});

test('3. Frontend public/motoboy.js não realiza UPDATE direto em public.teles pelo navegador', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(!motoboyJs.includes(".from('teles')\n    .update("), 'UPDATE direto em teles foi totalmente removido do frontend.');
  assert.ok(!motoboyJs.includes(".from('teles')\n  .update("), 'UPDATE direto em teles foi totalmente removido do frontend.');
});

test('4. Frontend valida Number.isInteger(version) antes de chamar RPC e trata erro de versão', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('Number.isInteger'), 'Validação Number.isInteger deve existir no frontend.');
  assert.ok(motoboyJs.includes('Versão da entrega é inválida'), 'Mensagem de erro de versão deve ser exibida ao usuário.');
});

test('5. Frontend desabilita botão e altera texto para "Processando..." ao executar transição', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('submitBtn.disabled = true'), 'Botão deve ser desabilitado.');
  assert.ok(motoboyJs.includes("submitBtn.innerText = 'Processando...'"), 'Texto do botão deve mudar para Processando...');
});

test('6. Admin public/app.js utiliza renderOperationsDashboard e não invoca renderKanbanBoard inexistente', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(appJs.includes('renderOperationsDashboard()'), 'renderOperationsDashboard deve ser chamado ao receber eventos de teles.');
  assert.ok(!appJs.includes('renderKanbanBoard()'), 'renderKanbanBoard legada/inexistente não deve ser chamada.');
});

test('7. serve.js mantém ENABLE_PUSH_WORKER = false', async () => {
  const serveJs = await readFile(new URL('../serve.js', import.meta.url), 'utf8');
  assert.ok(serveJs.includes('const ENABLE_PUSH_WORKER = false;'), 'ENABLE_PUSH_WORKER deve ser estritamente false.');
});

test('8. Configurações locais não apontam para URLs remotas do Supabase', async () => {
  const configLocal = await readFile(new URL('../public/config.local.js', import.meta.url), 'utf8');
  assert.ok(configLocal.includes('http://127.0.0.1:54321'), 'Configuração local deve apontar para 127.0.0.1:54321.');
  assert.ok(!configLocal.includes('supabase.co'), 'URLs remotas do Supabase não devem existir no config.local.js.');
});

test('9. Migration 20260729000200_pwa_tele_hardening.sql padroniza INTEGER para version', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000200_pwa_tele_hardening.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('p_expected_version INTEGER'), 'Assinaturas das RPCs devem usar INTEGER.');
  assert.ok(!migrationSql.includes('p_expected_version BIGINT'), 'RPCs operacionais não devem usar BIGINT.');
});

test('10. Migration 20260729000200_pwa_tele_hardening.sql aplica permissões estritas por função (sem REVOKE ALL ON ALL FUNCTIONS)', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000200_pwa_tele_hardening.sql', import.meta.url), 'utf8');
  assert.ok(!migrationSql.includes('REVOKE EXECUTE ON ALL FUNCTIONS'), 'REVOKE amplo perigoso não deve existir na migration.');
  assert.ok(migrationSql.includes('REVOKE ALL ON FUNCTION public.calculate_tele_financial_split_internal(UUID) FROM authenticated;'), 'Função interna de cálculo deve ter EXECUTE revogado para authenticated.');
});
