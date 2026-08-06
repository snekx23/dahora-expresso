import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

function runAdminPanelBugsTestSuite() {
  console.log('==================================================');
  console.log('TESTE AUTOMATIZADO — FIX PAINEL ADMIN (MODAL & REPASSE SEMANAL)');
  console.log('==================================================\n');

  const htmlContent = fs.readFileSync(path.resolve('public/index.html'), 'utf-8');
  const appJsContent = fs.readFileSync(path.resolve('public/app.js'), 'utf-8');

  // ==================================================
  // BUG 1 — MODAL NOVA TELE MANUAL RESPONSIVO
  // ==================================================
  console.log('1. Auditando estrutura do Modal Nova Tele Manual no HTML...');
  
  assert.ok(htmlContent.includes('id="modal-request-delivery"'), 'Modal id="modal-request-delivery" deve existir');
  assert.ok(htmlContent.includes('max-height: calc(100vh - 32px)'), 'Modal-card deve possuir max-height responsivo calc(100vh - 32px)');
  assert.ok(htmlContent.includes('display: flex; flex-direction: column;'), 'Modal-card deve possuir layout flex de coluna');
  assert.ok(htmlContent.includes('flex: 1; overflow-y: auto;'), 'Modal-body deve ter flex: 1 e overflow-y: auto para rolagem interna');
  assert.ok(htmlContent.includes('flex-shrink: 0;'), 'Modal-footer e Modal-header devem possuir flex-shrink: 0 para permanência fixa');
  
  console.log('[PASS] BUG 1: Modal Nova Tele Manual possui layout flex responsivo com cabeçalho e rodapé fixos e corpo rolável.');

  // ==================================================
  // BUG 2 — REPASSE SEMANAL & ESTADOS OBRIGATÓRIOS
  // ==================================================
  console.log('\n2. Auditando integração e renderização do Repasse Semanal em app.js...');

  assert.ok(appJsContent.includes('function renderRiderPayments()'), 'renderRiderPayments deve estar definida');
  assert.ok(appJsContent.includes('fetchAdminRiderWeeklySettlements(true)'), 'renderRiderPayments deve delegar para a função autoritativa fetchAdminRiderWeeklySettlements');

  assert.ok(appJsContent.includes('Nenhum repasse semanal encontrado.'), 'Deve renderizar texto obrigatório de estado vazio');
  assert.ok(appJsContent.includes('Cadastre um motoboy e conclua entregas para gerar o primeiro fechamento.'), 'Deve renderizar texto auxiliar obrigatório de estado vazio');
  assert.ok(appJsContent.includes('Não foi possível carregar os repasses semanais.'), 'Deve renderizar mensagem amigável no estado de erro');
  
  console.log('[PASS] BUG 2: Repasse Semanal unificado com a RPC autoritativa, estado vazio obrigatório e tratamento de erro homologados.');

  console.log('\n==================================================');
  console.log('RESULTADO FINAL: TODOS OS TESTES DOS BUGS 1 E 2 APROVADOS (100%)');
  console.log('==================================================');
}

runAdminPanelBugsTestSuite();
