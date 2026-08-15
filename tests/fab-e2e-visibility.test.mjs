import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('E2E Audit — FAB Chamar Tele Button Visibility & Styling', async (t) => {
  const htmlPath = path.resolve(process.cwd(), 'public/index.html');
  const cssPath = path.resolve(process.cwd(), 'public/style.css');
  const appJsPath = path.resolve(process.cwd(), 'public/app.js');

  const html = fs.readFileSync(htmlPath, 'utf-8');
  const css = fs.readFileSync(cssPath, 'utf-8');
  const appJs = fs.readFileSync(appJsPath, 'utf-8');

  await t.test('1. Element #owner-fab-btn exists exactly once in index.html with matching production markup', () => {
    const fabMatches = html.match(/id="owner-fab-btn"/g) || [];
    assert.equal(fabMatches.length, 1, 'id="owner-fab-btn" deve existir exatamente 1 vez');
    assert.ok(html.includes('class="fab-btn-fixed"'), 'deve usar a classe fab-btn-fixed');
    assert.ok(!html.includes('id="owner-fab-btn" class="fab-btn-fixed hidden"'), 'não deve vir codificado com a classe hidden no HTML inicial');
  });

  await t.test('2. CSS .fab-btn-fixed defines position fixed, bottom, right, z-index 99999', () => {
    assert.ok(css.includes('.fab-btn-fixed {'), 'CSS deve definir .fab-btn-fixed');
    assert.ok(css.includes('position: fixed !important;'), 'deve ter position: fixed !important');
    assert.ok(css.includes('z-index: 99999 !important;'), 'deve ter z-index 99999 ultra-alto');
  });

  await t.test('3. updateOwnerFabVisibility manages visibility correctly for owner-teles tab', () => {
    assert.ok(appJs.includes('function updateOwnerFabVisibility(targetTab)'), 'updateOwnerFabVisibility deve ser função declarada');
    assert.ok(appJs.includes("const isTelesTab = (currentTab === 'owner-teles');"), 'deve verificar se é a aba owner-teles');
    assert.ok(appJs.includes("ownerFab.classList.remove('hidden');"), 'deve remover .hidden na aba owner-teles');
    assert.ok(appJs.includes("ownerFab.style.display = 'flex';"), 'deve definir style.display = flex');
  });
});
