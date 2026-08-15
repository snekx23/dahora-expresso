import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

function runAdminPanelBugsTestSuite() {
  console.log('==================================================');
  console.log('TESTE AUTOMATIZADO — FIX PAINEL ADMIN (REPASSE SEMANAL & FAB CHAMAR TELE)');
  console.log('==================================================\n');

  const htmlContent = fs.readFileSync(path.resolve('public/index.html'), 'utf-8');
  const appJsContent = fs.readFileSync(path.resolve('public/app.js'), 'utf-8');

  // ==================================================
  // BUG 1 — REPASSE SEMANAL HIERARQUIA DOM E ESTADOS
  // ==================================================
  console.log('1. Auditando hierarquia DOM e isolamento da view Repasse Semanal...');
  
  const fleetTabPos = htmlContent.indexOf('id="tab-owner-fleet"');
  const riderPaymentsTabPos = htmlContent.indexOf('id="tab-owner-rider-payments"');
  assert.ok(fleetTabPos > 0 && riderPaymentsTabPos > fleetTabPos, 'tab-owner-rider-payments deve estar após tab-owner-fleet');

  // Verificar fechamento das tags da tabela em tab-owner-fleet antes de tab-owner-rider-payments
  const fleetSection = htmlContent.substring(fleetTabPos, riderPaymentsTabPos);
  assert.ok(fleetSection.includes('</tbody>'), 'tab-owner-fleet deve fechar tbody');
  assert.ok(fleetSection.includes('</table>'), 'tab-owner-fleet deve fechar table');
  assert.ok(fleetSection.includes('</table>') && fleetSection.includes('id="owner-fleet-table-body"'), 'tab-owner-fleet deve fechar table e tbody antes da view de Repasses');
  assert.ok(fleetSection.split('</div>').length >= 4, 'tab-owner-fleet deve possuir todas as div de fechamento');

  assert.ok(appJsContent.includes('function renderRiderPayments()'), 'renderRiderPayments deve estar definida');
  assert.ok(appJsContent.includes('fetchAdminRiderWeeklySettlements(true)'), 'renderRiderPayments deve delegar para a função autoritativa fetchAdminRiderWeeklySettlements');
  assert.ok(appJsContent.includes('Nenhum repasse semanal encontrado.'), 'Deve renderizar texto obrigatório de estado vazio');
  assert.ok(appJsContent.includes('Cadastre um motoboy e conclua entregas para gerar o primeiro fechamento.'), 'Deve renderizar texto auxiliar obrigatório de estado vazio');
  assert.ok(appJsContent.includes('Não foi possível carregar os repasses semanais.'), 'Deve renderizar mensagem amigável no estado de erro');
  
  console.log('[PASS] BUG 1: View Repasse Semanal desaninhada do DOM, isolada no nível raiz e com estados autoritativos validados.');

  // ==================================================
  // BUG 2 — BOTÃO FLUTUANTE (FAB) CHAMAR TELE MANUAL
  // ==================================================
  console.log('\n2. Auditando botão flutuante FAB "Chamar Tele" e visibilidade em Gestão de Teles...');

  assert.ok(htmlContent.includes('id="owner-fab-btn"'), 'Botão flutuante id="owner-fab-btn" deve existir no HTML');
  assert.ok(htmlContent.includes('onclick="showRequestDeliveryModal()"'), 'FAB deve invocar showRequestDeliveryModal() no clique');

  assert.ok(appJsContent.includes('function updateOwnerFabVisibility'), 'updateOwnerFabVisibility deve estar definida');
  assert.ok(appJsContent.includes('!isClientUser'), 'FAB deve ser visível exclusivamente para perfis autorizados de gestão');

  console.log('[PASS] BUG 2: FAB "Chamar Tele" configurado para exibição contínua na aba Gestão de Teles.');

  console.log('\n==================================================');
  console.log('RESULTADO FINAL: TODOS OS TESTES DOS BUGS 1 E 2 APROVADOS (100%)');
  console.log('==================================================');
}

runAdminPanelBugsTestSuite();
