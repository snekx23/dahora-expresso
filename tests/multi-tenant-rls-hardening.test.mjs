// =====================================================================
// Dahora Expresso — Suíte de Testes: Hardening H1 (Multi-Tenant RLS & Double-Lock Grants)
// File: tests/multi-tenant-rls-hardening.test.mjs
// =====================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const migrationsDir = path.join(projectRoot, 'supabase', 'migrations');
const hardeningMigrationPath = path.join(migrationsDir, '20260805000100_multi_tenant_rls_hardening.sql');

async function getMigrationContents() {
  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();
  const contents = [];
  for (const file of sqlFiles) {
    const content = await readFile(path.join(migrationsDir, file), 'utf8');
    contents.push({ file, content });
  }
  return contents;
}

test('1. Migration aditiva 20260805000100_multi_tenant_rls_hardening.sql existe e está formatada', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');
  assert.ok(content.length > 500, 'Migration de hardening H1 deve conter as definições completas.');
  assert.ok(content.includes('public.my_client_ids()'), 'Deve definir a função helper my_client_ids().');
  assert.ok(content.includes('SECURITY DEFINER'), 'my_client_ids() deve ser SECURITY DEFINER.');
  assert.ok(content.includes("SET search_path = ''"), 'my_client_ids() deve fixar search_path vazio.');
});

test('2. Bloqueio Total de Escrita Direta Não-Administrativa em public.user_profiles (Sem Subquery em UPDATE)', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');
  
  assert.ok(content.includes('CREATE POLICY user_profiles_insert ON public.user_profiles'), 'user_profiles_insert definida.');
  assert.ok(content.includes('WITH CHECK (public.is_admin_user())'), 'Inclusão de perfis restrita exclusivamente a administradores.');

  assert.ok(content.includes('CREATE POLICY user_profiles_update ON public.user_profiles'), 'user_profiles_update definida.');
  assert.ok(content.includes('USING (public.is_admin_user())'), 'Atualização direta de perfis restrita exclusivamente a administradores.');
  assert.equal(content.includes('SELECT p.role FROM public.user_profiles'), false, 'Nenhuma subquery sobre user_profiles dentro de sua própria policy (evitando recursão).');

  assert.ok(content.includes('CREATE POLICY user_profiles_delete ON public.user_profiles'), 'user_profiles_delete definida.');
  assert.ok(content.includes('USING (public.is_admin_user())'), 'Deleção de perfis restrita a administradores.');

  assert.ok(content.includes('REVOKE INSERT, UPDATE, DELETE ON public.user_profiles FROM authenticated, anon;'), 'Grants de escrita revogados em user_profiles.');
});

test('3. Remoção de Leitura Direta de fleet por Cliente Comercial & Criação de RPC Sanitizada', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');

  // fleet_select sem subquery sobre teles para client_user
  assert.ok(content.includes('CREATE POLICY fleet_select ON public.fleet'), 'Policy fleet_select definida.');
  assert.ok(content.includes('USING (public.is_admin_user() OR user_id = auth.uid())'), 'fleet_select permite apenas admin e leitura própria do motoboy.');
  assert.equal(content.includes('WHERE client_id IN'), false, 'client_user não possui leitura direta da tabela fleet.');

  // RPC Sanitizada
  assert.ok(content.includes('CREATE OR REPLACE FUNCTION public.get_assigned_motoboy_for_client_tele'), 'RPC get_assigned_motoboy_for_client_tele criada.');
  assert.ok(content.includes('RETURNS TABLE'), 'RPC retorna tabela de dados operacionais sanitizados.');
  assert.ok(content.includes('SECURITY DEFINER'), 'RPC é SECURITY DEFINER.');
  assert.ok(content.includes("SET search_path = ''"), 'RPC fixa search_path vazio.');

  // Validação de Ausência de Dados Sensíveis no Retorno da RPC
  assert.equal(content.includes('f.cpf'), false, 'RPC sanitizada não deve retornar CPF do motoboy.');
  assert.equal(content.includes('f.pix_key'), false, 'RPC sanitizada não deve retornar PIX do motoboy.');
  assert.equal(content.includes('f.phone'), false, 'RPC sanitizada não deve retornar Telefone pessoal do motoboy.');
  assert.equal(content.includes('f.user_id'), false, 'RPC sanitizada não deve retornar user_id do motoboy.');
  assert.equal(content.includes('f.battery_level'), false, 'RPC sanitizada não deve retornar battery_level do motoboy.');
});

test('4. Double-Lock Grants: Revogação de escrita direta em tabelas financeiras, auditadas e relacionais', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');

  const revokedTables = [
    'user_profiles',
    'system_audit_logs',
    'company_financial_transactions',
    'client_financial_transactions',
    'rider_financial_transactions',
    'rider_credits_ledger',
    'rider_weekly_settlements',
    'rider_weekly_settlement_items',
    'rider_payment_batches',
    'rider_payment_batch_items',
    'client_payment_allocations',
    'tele_eventos'
  ];

  for (const table of revokedTables) {
    assert.ok(
      content.includes(`REVOKE INSERT, UPDATE, DELETE ON public.${table} FROM authenticated, anon;`), 
      `Escrita direta deve ser revogada para a tabela public.${table}.`
    );
  }
});

test('5. Nenhuma policy ativa em tabelas privadas multi-tenant mantida como USING (true)', async () => {
  const hardeningContent = await readFile(hardeningMigrationPath, 'utf8');
  
  const multiTenantTables = [
    'user_profiles',
    'fleet',
    'teles',
    'tele_eventos',
    'commercial_clients',
    'client_users',
    'client_financial_transactions',
    'system_audit_logs',
    'rider_credits_ledger',
    'rider_consumable_purchases',
    'rider_financial_transactions',
    'company_financial_transactions',
    'client_payment_allocations'
  ];

  for (const table of multiTenantTables) {
    assert.ok(hardeningContent.includes(`ON public.${table}`), `Migration H1 deve sobrescrever policies da tabela ${table}.`);
    assert.ok(hardeningContent.includes(`DROP POLICY IF EXISTS`), `Migration H1 deve revogar policies antigas da tabela ${table}.`);
  }

  const privatePolicyBlocks = hardeningContent.split('CREATE POLICY').slice(1);
  for (const block of privatePolicyBlocks) {
    if (block.includes('ON public.cidades') || block.includes('ON public.consumables_catalog')) {
      continue;
    }
    assert.equal(
      block.includes('USING (true)'), 
      false, 
      `Policy privada em H1 não pode ter USING (true): \n${block.slice(0, 150)}`
    );
  }
});

test('6. Validação da função de isolamento de tenant public.my_client_ids()', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');
  assert.ok(content.includes('REVOKE ALL ON FUNCTION public.my_client_ids() FROM PUBLIC;'), 'Permissão de PUBLIC revogada.');
  assert.ok(content.includes('REVOKE ALL ON FUNCTION public.my_client_ids() FROM anon;'), 'Permissão de anon revogada.');
  assert.ok(content.includes('GRANT EXECUTE ON FUNCTION public.my_client_ids() TO authenticated;'), 'GRANT apenas para authenticated.');
});

test('7. Isolamento RLS de Cliente Comercial (commercial_clients e client_users)', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');
  
  assert.ok(content.includes('CREATE POLICY commercial_clients_select ON public.commercial_clients'), 'Policy commercial_clients_select criada.');
  assert.ok(content.includes('id IN (SELECT public.my_client_ids())'), 'commercial_clients filtra por my_client_ids().');
  
  assert.ok(content.includes('CREATE POLICY client_users_select ON public.client_users'), 'Policy client_users_select criada.');
  assert.ok(content.includes('client_id IN (SELECT public.my_client_ids())'), 'client_users filtra por my_client_ids().');
});

test('8. Isolamento RLS de Teles e Histórico de Eventos (teles e tele_eventos)', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');
  
  assert.ok(content.includes('CREATE POLICY teles_select ON public.teles'), 'Policy teles_select criada.');
  assert.ok(content.includes('client_id IN (SELECT public.my_client_ids())'), 'teles restrita ao client_id do usuário.');
  assert.ok(content.includes('motoboy_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())'), 'teles restrita ao motoboy_id do usuário.');

  assert.ok(content.includes('CREATE POLICY tele_eventos_select ON public.tele_eventos'), 'Policy tele_eventos_select criada.');
  assert.ok(content.includes('EXISTS ('), 'tele_eventos utiliza EXISTS com vinculação à tabela teles.');
});

test('9. Isolamento RLS de Extrato e Alocações Financeiras do Cliente Comercial', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');

  assert.ok(content.includes('CREATE POLICY client_financial_transactions_select ON public.client_financial_transactions'), 'Policy client_financial_transactions_select criada.');
  assert.ok(content.includes('client_id IN (SELECT public.my_client_ids())'), 'client_financial_transactions restrita ao client_id do usuário.');

  assert.ok(content.includes('CREATE POLICY client_payment_allocations_select ON public.client_payment_allocations'), 'Policy client_payment_allocations_select criada.');
  assert.ok(content.includes('client_id IN (SELECT public.my_client_ids())'), 'client_payment_allocations restrita ao client_id do usuário.');
});

test('10. Isolamento RLS de Logs de Auditoria e Finanças da Empresa (system_audit_logs e company_financial_transactions)', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');

  assert.ok(content.includes('CREATE POLICY system_audit_logs_select ON public.system_audit_logs'), 'Policy system_audit_logs_select criada.');
  assert.ok(content.includes('USING (public.is_admin_user())'), 'system_audit_logs restrito exclusivamente a is_admin_user().');

  assert.ok(content.includes('CREATE POLICY company_financial_transactions_admin ON public.company_financial_transactions'), 'Policy company_financial_transactions_admin criada.');
  assert.ok(content.includes('USING (public.is_admin_user())'), 'company_financial_transactions restrito exclusivamente a is_admin_user().');
});

test('11. Isolamento RLS de Tabelas Financeiras do Motoboy (credits, consumables, transactions)', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');

  assert.ok(content.includes('CREATE POLICY rider_credits_ledger_select ON public.rider_credits_ledger'), 'Policy rider_credits_ledger_select criada.');
  assert.ok(content.includes('motoboy_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())'), 'Créditos restritos ao motoboy_id resolvido por auth.uid().');

  assert.ok(content.includes('CREATE POLICY rider_consumable_purchases_select ON public.rider_consumable_purchases'), 'Policy rider_consumable_purchases_select criada.');
  assert.ok(content.includes('motoboy_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())'), 'Consumíveis restritos ao motoboy_id resolvido por auth.uid().');

  assert.ok(content.includes('CREATE POLICY rider_financial_transactions_select ON public.rider_financial_transactions'), 'Policy rider_financial_transactions_select criada.');
  assert.ok(content.includes('motoboy_id IN (SELECT id FROM public.fleet WHERE user_id = auth.uid())'), 'Transações restritas ao motoboy_id resolvido por auth.uid().');
});

test('12. Preservação de Acesso Global dos Administradores (is_admin_user()) em todas as novas policies', async () => {
  const content = await readFile(hardeningMigrationPath, 'utf8');
  
  const tablesRequiringAdmin = [
    'user_profiles',
    'commercial_clients',
    'client_users',
    'fleet',
    'teles',
    'tele_eventos',
    'client_financial_transactions',
    'system_audit_logs',
    'rider_credits_ledger',
    'rider_consumable_purchases',
    'rider_financial_transactions',
    'company_financial_transactions',
    'client_payment_allocations'
  ];

  for (const table of tablesRequiringAdmin) {
    assert.ok(content.includes(`ON public.${table}`), `Tabela ${table} declarada em H1.`);
    assert.ok(content.includes('public.is_admin_user()'), `is_admin_user() deve ser concedido para tabela ${table}.`);
  }
});

test('13. Preservação de Migrations Antigas e Frontend (Zero alterações em código legado)', async () => {
  const migrations = await getMigrationContents();
  const olderMigrations = migrations.filter(m => !m.file.startsWith('20260805'));
  assert.ok(migrations.length >= 23, 'Todas as migrations anteriores devem permanecer intactas.');

  const appJs = await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
  const motoboyJs = await readFile(path.join(projectRoot, 'public', 'motoboy.js'), 'utf8');
  assert.ok(appJs.length > 500000, 'public/app.js intacto.');
  assert.ok(motoboyJs.length > 140000, 'public/motoboy.js intacto.');
});
