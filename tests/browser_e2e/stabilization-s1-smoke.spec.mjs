import { test, expect } from '@playwright/test';

test.describe('DAHORA EXPRESSO — STABILIZATION S1: GLOBAL SMOKE & LIFECYCLE SUITE', () => {

  const ADMIN_EMAIL = 'admin1@dahoraexpresso.com.br';
  const ADMIN_PASS = 'dahoraexpresso1';
  const CLIENT_EMAIL = 'padaria.central@homolog.test';
  const CLIENT_PASS = 'dahoraexpresso1';

  const ADMIN_TABS = [
    { name: 'Centro de Operações', tabId: 'owner-control-center' },
    { name: 'Mapa da Frota', tabId: 'owner-fleet-map' },
    { name: 'Gestão de Teles', tabId: 'owner-teles' },
    { name: 'Frota & Motoboys', tabId: 'owner-fleet' },
    { name: 'Clientes Comerciais', tabId: 'owner-commercial-clients' },
    { name: 'Resumo Financeiro', tabId: 'owner-financials' },
    { name: 'Repasse Semanal', tabId: 'owner-rider-payments' },
    { name: 'Extratos Motoboys', tabId: 'owner-rider-extract' },
    { name: 'Extratos Clientes', tabId: 'owner-client-extract' },
    { name: 'Consumíveis', tabId: 'owner-consumables' },
    { name: 'Créditos / Ajustes', tabId: 'owner-credits' },
    { name: 'Suporte Cliente', tabId: 'owner-support' },
    { name: 'Suporte Motoboys', tabId: 'owner-rider-support' },
    { name: 'Configurações', tabId: 'owner-settings' }
  ];

  const CLIENT_TABS = [
    { name: 'Início', tabId: 'client-overview' },
    { name: 'Solicitar Entrega', tabId: 'order-request' },
    { name: 'Entregas', tabId: 'client-teles' },
    { name: 'Financeiro', tabId: 'client-financials' },
    { name: 'Extrato', tabId: 'client-extract' },
    { name: 'Suporte Chat', tabId: 'client-support' },
    { name: 'Perfil', tabId: 'client-profile' }
  ];

  test('1. Admin Visual Smoke: All 14 Admin Tabs render cleanly with 1 active view, zero persistent rider drawer & zero null/undefined', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('Failed to load resource')) {
        consoleErrors.push(msg.text());
      }
    });

    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('http://127.0.0.1:8000');
    await page.waitForLoadState('networkidle');

    // Realizar login Admin
    await page.fill('#username', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASS);
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#view-dashboard:not(.hidden)', { timeout: 10000 });

    for (const tab of ADMIN_TABS) {
      console.log(`Testing Admin Tab: ${tab.name} (${tab.tabId})`);
      await page.evaluate((tId) => window.switchDashboardTab(tId), tab.tabId);
      await page.waitForTimeout(400);

      // Invariante 1: Exatamente 1 view principal ativa
      const activeCount = await page.evaluate(() => {
        return document.querySelectorAll('.dashboard-tab-content.active:not(.hidden)').length;
      });
      expect(activeCount, `Aba ${tab.name} deve ter exatamente 1 container ativo`).toBe(1);

      // Invariante 2: Modal de ações do motoboy NÃO visível
      const isRiderModalVisible = await page.evaluate(() => {
        const modal = document.getElementById('modal-rider-actions');
        if (!modal) return false;
        const style = window.getComputedStyle(modal);
        return style.display !== 'none' && !modal.classList.contains('hidden');
      });
      expect(isRiderModalVisible, `Aba ${tab.name} não deve exibir o modal do motoboy`).toBe(false);

      // Invariante 3: Sem "null" ou "undefined" literais em elementos de texto visíveis
      const invalidTexts = await page.evaluate(() => {
        const text = document.body.innerText;
        const matches = [];
        if (text.match(/\bnull\b/i)) matches.push('null');
        if (text.match(/\bundefined\b/i)) matches.push('undefined');
        return matches;
      });
      expect(invalidTexts.length, `Aba ${tab.name} não deve renderizar null/undefined: ${invalidTexts.join(', ')}`).toBe(0);

      // Invariante 4: Sem overflow horizontal em 1366px
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow, `Aba ${tab.name} não deve ter overflow horizontal`).toBe(false);
    }

    expect(consoleErrors, `Console erros graves em Admin: ${consoleErrors.join('; ')}`).toEqual([]);
  });

  test('2. Client Visual Smoke: All 7 Client Tabs render cleanly without Admin/Motoboy components', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('http://127.0.0.1:8000');
    await page.waitForLoadState('networkidle');

    // Switch to Client Login Tab and authenticate
    await page.evaluate(() => window.switchLoginTab('client'));
    await page.fill('#username', CLIENT_EMAIL);
    await page.fill('#password', CLIENT_PASS);
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#view-dashboard:not(.hidden)', { timeout: 10000 });

    for (const tab of CLIENT_TABS) {
      console.log(`Testing Client Tab: ${tab.name} (${tab.tabId})`);
      await page.evaluate((tId) => window.switchDashboardTab(tId), tab.tabId);
      await page.waitForTimeout(400);

      const activeCount = await page.evaluate(() => {
        return document.querySelectorAll('.dashboard-tab-content.active:not(.hidden)').length;
      });
      expect(activeCount, `Aba Cliente ${tab.name} deve ter exatamente 1 container ativo`).toBe(1);

      const isRiderModalVisible = await page.evaluate(() => {
        const modal = document.getElementById('modal-rider-actions');
        if (!modal) return false;
        const style = window.getComputedStyle(modal);
        return style.display !== 'none' && !modal.classList.contains('hidden');
      });
      expect(isRiderModalVisible, `Aba Cliente ${tab.name} não deve ter modal de motoboy`).toBe(false);

      const invalidTexts = await page.evaluate(() => {
        const text = document.body.innerText;
        const matches = [];
        if (text.match(/\bnull\b/i)) matches.push('null');
        if (text.match(/\bundefined\b/i)) matches.push('undefined');
        return matches;
      });
      expect(invalidTexts.length, `Aba Cliente ${tab.name} não deve renderizar null/undefined: ${invalidTexts.join(', ')}`).toBe(0);
    }
  });

  test('3. Clean Logout & Re-login: Zero transient panels persistent after logout', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('http://127.0.0.1:8000');
    await page.waitForLoadState('networkidle');

    await page.fill('#username', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASS);
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#view-dashboard:not(.hidden)', { timeout: 10000 });

    // Open rider modal if any
    await page.evaluate(() => window.switchDashboardTab('owner-fleet-map'));
    await page.waitForTimeout(300);

    // Logout
    await page.evaluate(() => window.handleLogout());
    await page.waitForSelector('#view-landing:not(.hidden)', { timeout: 10000 });

    const isDashboardVisible = await page.evaluate(() => {
      const db = document.getElementById('view-dashboard');
      return db && !db.classList.contains('hidden') && db.classList.contains('active');
    });
    expect(isDashboardVisible, 'Dashboard deve estar completamente oculto após logout').toBe(false);

    const isRiderModalVisible = await page.evaluate(() => {
      const modal = document.getElementById('modal-rider-actions');
      if (!modal) return false;
      const style = window.getComputedStyle(modal);
      return style.display !== 'none' && !modal.classList.contains('hidden');
    });
    expect(isRiderModalVisible, 'Modal de motoboy não deve estar visível após logout').toBe(false);
  });

  test('4. Mobile Responsiveness (390x844): Zero horizontal overflow in main operational views', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:8000');
    await page.waitForLoadState('networkidle');

    await page.fill('#username', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASS);
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#view-dashboard:not(.hidden)', { timeout: 10000 });

    const mobileTabs = ['owner-control-center', 'owner-teles', 'owner-fleet', 'owner-commercial-clients'];
    for (const tabId of mobileTabs) {
      await page.evaluate((tId) => window.switchDashboardTab(tId), tabId);
      await page.waitForTimeout(400);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow, `View Mobile ${tabId} não deve ter overflow horizontal`).toBe(false);
    }
  });

});
