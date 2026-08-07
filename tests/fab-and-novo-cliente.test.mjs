import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Painel Admin — Auditoria de FAB Chamar Tele e Modal Novo Cliente', async (t) => {
  const appJsPath = path.resolve(process.cwd(), 'public/app.js');
  const appJs = fs.readFileSync(appJsPath, 'utf-8');

  await t.test('1. updateOwnerFabVisibility está no escopo de arquivo (não aninhada) e usa currentAdminProfile', () => {
    assert.ok(appJs.includes('function updateOwnerFabVisibility(targetTab)'), 'updateOwnerFabVisibility deve existir no escopo de arquivo');
    assert.ok(appJs.includes('currentAdminProfile?.role'), 'updateOwnerFabVisibility deve checar a role em currentAdminProfile');
  });

  await t.test('2. showRequestDeliveryModal é uma única função e abre o modal-request-delivery', () => {
    const occurrences = (appJs.match(/function showRequestDeliveryModal\(/g) || []).length;
    assert.equal(occurrences, 1, 'Deve existir exatamente 1 declaração de showRequestDeliveryModal');
    assert.ok(appJs.includes("document.getElementById('modal-request-delivery')"), 'showRequestDeliveryModal deve obter modal-request-delivery');
  });

  await t.test('3. Funções do modal de Clientes Comerciais estão expostas no objeto window', () => {
    assert.ok(appJs.includes('window.openAddCommercialClientModal = openAddCommercialClientModal;'), 'openAddCommercialClientModal deve estar exposta em window');
    assert.ok(appJs.includes('window.closeAddCommercialClientModal = closeAddCommercialClientModal;'), 'closeAddCommercialClientModal deve estar exposta em window');
    assert.ok(appJs.includes('window.submitAddCommercialClient = submitAddCommercialClient;'), 'submitAddCommercialClient deve estar exposta em window');
  });
});
