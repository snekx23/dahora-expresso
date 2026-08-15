// =====================================================================
// Dahora Expresso — Suíte de Testes Automatizados da Fase 3B.2A.1
// File: tests/financial-phase3b-admin-read-ui.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

import dotenv from 'dotenv';
import path from 'path';

// Local test harness override
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzc4NzcsImV4cCI6MjEwMTU1Mzg3N30.1BoD7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ANON_KEY;

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function createAuthedClient(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Auth failure for ${email}: ${error.message}`);
  return client;
}

test('Suíte de Testes da Fase 3B.2A.1 (Leitura Autoritativa do Repasse Semanal)', async (t) => {
  let adminClient;
  let clientUserClient;

  adminClient = await createAuthedClient('admin1@dahoraexpresso.com.br', 'senha123456');
  clientUserClient = await createAuthedClient('padaria.central@homolog.test', 'senha123456');

  // Buscar fleet.id válido
  const { data: fleetRiders } = await adminClient.from('fleet').select('id, name').limit(1);
  const testRiderId = fleetRiders && fleetRiders.length > 0 ? fleetRiders[0].id : null;

  // 1. Análise Estática Delimitada do Bloco 3B.2A.1 em app.js
  await t.test('1. Análise Estática: Ausência de cálculos financeiros e mutações no bloco novo', async () => {
    const appJsContent = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    
    // Extrair exclusivamente o bloco do novo módulo 3B.2A.1
    const moduleStartIndex = appJsContent.indexOf('Fase 3B.2A.1: Repasse Semanal');
    assert.ok(moduleStartIndex !== -1, 'Marcador do módulo 3B.2A.1 encontrado em app.js');
    
    const moduleEndIndex = appJsContent.indexOf('Fase 3B.2A.2: Operações Financeiras');
    const newModuleCode = moduleEndIndex !== -1 ? appJsContent.slice(moduleStartIndex, moduleEndIndex) : appJsContent.slice(moduleStartIndex);

    // Assert: Ausência de multiplicadores financeiros
    const multipliers = ['* 0.90', '* 0.10', '* 0.85', '* 0.15', '* 0.9'];
    multipliers.forEach(m => {
      assert.equal(newModuleCode.includes(m), false, `Multiplicador ${m} proibido no módulo novo`);
    });

    // Assert: Ausência de reduce para agregação financeira em settlements
    assert.equal(newModuleCode.includes('.reduce('), false, 'Proibido usar .reduce() para agregação financeira');

    // Assert: Ausência de mutações no banco de dados (.insert, .update, .delete, .upsert no Supabase)
    const dbMutations = ['.insert(', '.update(', '.delete(', '.upsert('];
    dbMutations.forEach(mut => {
      assert.equal(newModuleCode.includes(mut), false, `Mutação de banco de dados ${mut} proibida no módulo novo`);
    });

    // Assert: Presença explícita das duas RPCs homologadas de leitura
    assert.ok(newModuleCode.includes('list_admin_rider_weekly_settlements'), 'RPC list_admin_rider_weekly_settlements presente');
    assert.ok(newModuleCode.includes('get_admin_rider_weekly_settlement_detail'), 'RPC get_admin_rider_weekly_settlement_detail presente');
  });

  // 2. Chamada à RPC list_admin_rider_weekly_settlements por Administrador
  await t.test('2. RPC list_admin_rider_weekly_settlements retorna estrutura autoritativa', async () => {
    const todayIso = new Date().toISOString().split('T')[0];
    const { data, error } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: todayIso,
      p_limit: 10,
      p_offset: 0
    });

    assert.ok(!error, `Erro na RPC list_admin_rider_weekly_settlements: ${error?.message}`);
    assert.equal(data.success, true);
    assert.ok(typeof data.total_count === 'number', 'total_count é número');
    assert.ok(Array.isArray(data.settlements), 'settlements é um array');
  });

  // 3. Teste do Filtro de Status 'not_calculated' no Banco de Dados
  await t.test('3. RPC list_admin_rider_weekly_settlements aceita e filtra por status not_calculated', async () => {
    const todayIso = new Date().toISOString().split('T')[0];
    const { data, error } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: todayIso,
      p_status: 'not_calculated',
      p_limit: 10,
      p_offset: 0
    });

    assert.ok(!error, `Erro com p_status=not_calculated: ${error?.message}`);
    assert.equal(data.success, true);
    (data.settlements || []).forEach(s => {
      assert.equal(s.status, 'not_calculated', 'Todos os registros filtrados possuem status not_calculated');
    });
  });

  // 4. Busca por UUID autoritativo do fleet (p_rider_id)
  await t.test('4. RPC list_admin_rider_weekly_settlements aceita p_rider_id com public.fleet.id (UUID)', async () => {
    if (!testRiderId) return;

    const todayIso = new Date().toISOString().split('T')[0];
    const { data, error } = await adminClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: todayIso,
      p_rider_id: testRiderId,
      p_limit: 10,
      p_offset: 0
    });

    assert.ok(!error, `Erro com p_rider_id: ${error?.message}`);
    assert.equal(data.success, true);
    (data.settlements || []).forEach(s => {
      assert.equal(s.rider_id, testRiderId, 'Registros filtrados correspondem ao fleet.id');
    });
  });

  // 5. Negação de Acesso para Usuário Não Administrativo
  await t.test('5. Cliente comercial recebe PERMISSION_DENIED ao chamar list_admin_rider_weekly_settlements', async () => {
    const { data } = await clientUserClient.rpc('list_admin_rider_weekly_settlements', { p_period_start: new Date().toISOString() });
    assert.equal(data.success, false);
    assert.equal(data.error_code, 'PERMISSION_DENIED');
  });

  // 6. Teste de get_admin_rider_weekly_settlement_detail com Settlement Existente ou Mock
  await t.test('6. RPC get_admin_rider_weekly_settlement_detail retorna payload autoritativo completo', async () => {
    // Buscar um settlement_id real se houver no banco ou criar um temporário de teste
    const { data: listRes } = await adminClient.rpc('list_admin_rider_weekly_settlements', { p_limit: 50 });
    const realSettlement = (listRes?.settlements || []).find(s => s.settlement_id !== null);

    let settlementIdToTest = realSettlement ? realSettlement.settlement_id : null;

    if (!settlementIdToTest && testRiderId) {
      // Criar settlement temporário para validar RPC de detalhamento
      const pStartUTC = '2026-12-14T03:00:00.000Z';
      const pEndUTC = '2026-12-21T03:00:00.000Z';
      const { data: stl } = await adminClient.from('rider_weekly_settlements').insert({
        rider_id: testRiderId,
        workspace_id: 'a1111111-1111-4111-a111-111111111111',
        period_start: pStartUTC,
        period_end: pEndUTC,
        gross_delivery_amount: 100.00,
        base_rider_amount: 85.00,
        platform_amount: 15.00,
        consumables_amount: 0.00,
        credits_amount: 0.00,
        net_amount: 85.00,
        eligible_amount: 85.00,
        blocked_amount: 0.00,
        paid_amount: 0.00,
        status: 'calculated',
        version: 1
      }).select('id').single();

      settlementIdToTest = stl ? stl.id : null;
    }

    if (settlementIdToTest) {
      const { data: detailData, error: detailErr } = await adminClient.rpc('get_admin_rider_weekly_settlement_detail', {
        p_settlement_id: settlementIdToTest
      });

      assert.ok(!detailErr, `Erro na RPC get_admin_rider_weekly_settlement_detail: ${detailErr?.message}`);
      assert.equal(detailData.success, true);
      assert.ok(detailData.settlement, 'Contém nó settlement');
      assert.ok(detailData.summary, 'Contém nó summary');
      assert.ok(Array.isArray(detailData.items), 'Contém nó items como array');
      assert.ok(Array.isArray(detailData.batches), 'Contém nó batches como array');
    }
  });

  // 7. Validação da Estrutura HTML do Drawer no index.html
  await t.test('7. index.html contém a estrutura acessível do Drawer de Fechamento Semanal', async () => {
    const htmlContent = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

    assert.ok(htmlContent.includes('id="rider-settlement-drawer"'), 'Drawer presente no index.html');
    assert.ok(htmlContent.includes('role="dialog"'), 'Atributo role="dialog" presente');
    assert.ok(htmlContent.includes('aria-modal="true"'), 'Atributo aria-modal="true" presente');
    assert.ok(htmlContent.includes('id="rider-settlement-drawer-backdrop"'), 'Backdrop presente');
    assert.ok(htmlContent.includes('closeRiderSettlementDrawer()'), 'Função de fechamento vinculada ao backdrop e botão');
  });

  // 8. Validação de Acessibilidade e Funções de Fechamento em app.js
  await t.test('8. app.js possui focus trap, scroll lock e restauração de foco', async () => {
    const appJsContent = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

    assert.ok(appJsContent.includes('handleRiderDrawerKeyDown'), 'Manipulador de teclas Escape/Tab presente');
    assert.ok(appJsContent.includes("document.body.classList.add('drawer-open')"), 'Adição de scroll lock presente');
    assert.ok(appJsContent.includes("document.body.classList.remove('drawer-open')"), 'Remoção de scroll lock presente');
    assert.ok(appJsContent.includes('activeElementBeforeDrawer'), 'Preservação de elemento ativo originador presente');
    assert.ok(appJsContent.includes('drawerListenersAttached'), 'Idempotência de listeners presente');
  });
});
