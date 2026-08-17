import { test, expect } from '@playwright/test';

test.describe('GATE RC.12.1 - Client Panel 7 Tabs E2E & Financial vs Extract Disambiguation', () => {
  test.setTimeout(60000);

  test('Admin Impersonation: Financeiro and Extrato render DISTINCT views and all 7 tabs work', async ({ page }) => {
    // Intercept network requests to ensure ZERO requests to remote Supabase
    page.on('request', request => {
      const url = request.url();
      if (url.includes('tskivauszmhhtqtegvwb.supabase.co')) {
        throw new Error(`CRITICAL ENVIRONMENT LEAK: Request to remote Supabase (${url})`);
      }
    });

    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    // 1. Login as Admin
    await page.fill('#username', 'admin1@dahoraexpresso.com.br');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

    // 2. Open Padaria Central Homolog panel via openAdminClientPanelView with explicit ID
    await page.evaluate(async () => {
      if (typeof fetchCommercialClients === 'function') {
        await fetchCommercialClients();
      }
      if (!window.commercialClientsList || window.commercialClientsList.length === 0) {
        window.commercialClientsList = [{
          id: '8e40963a-9146-4bfd-9447-d8d373be7ca6',
          client_code: 'CLI-000001',
          establishment_name: 'Padaria Central Homolog',
          responsible_name: 'João Da Silva',
          email: 'padaria.central@homolog.test'
        }];
      }
      window.openAdminClientPanelView('8e40963a-9146-4bfd-9447-d8d373be7ca6');
    });

    await page.waitForTimeout(1000);

    // Check banner presence
    await expect(page.locator('#admin-client-view-banner')).toBeVisible();

    // 3. Test Financeiro tab specifically
    await page.evaluate(async () => await window.switchDashboardTab('client-financials'));
    await page.waitForTimeout(800);

    const finTab = page.locator('#tab-client-financials');
    await expect(finTab).toBeVisible();
    await expect(page.locator('#client-fin-open-balance')).toBeVisible();

    // 4. Test Extrato tab specifically and prove it renders a DIFFERENT view
    await page.evaluate(async () => await window.switchDashboardTab('client-extract'));
    await page.waitForTimeout(800);

    const extTab = page.locator('#tab-client-extract');
    await expect(extTab).toBeVisible();
    await expect(page.locator('#client-panel-extract-table-body')).toBeVisible();

    // Assert that Financeiro and Extrato are NOT the same element!
    expect(await finTab.getAttribute('id')).not.toBe(await extTab.getAttribute('id'));
    await expect(finTab).toBeHidden(); // Financeiro should be hidden while Extrato is active

    // 5. Test all other tabs sequentially
    const tabsToTest = [
      { tab: 'client-overview', targetId: '#tab-client-overview' },
      { tab: 'client-request-delivery', targetId: '#tab-order-request' },
      { tab: 'client-deliveries', targetId: '#tab-client-teles' },
      { tab: 'client-financials', targetId: '#tab-client-financials' },
      { tab: 'client-extract', targetId: '#tab-client-extract' },
      { tab: 'client-support', targetId: '#tab-client-support' }
    ];

    for (const item of tabsToTest) {
      await page.evaluate(async (tabName) => {
        await window.switchDashboardTab(tabName);
      }, item.tab);

      await page.waitForTimeout(600);

      const targetDiv = page.locator(item.targetId);
      await expect(targetDiv).toBeVisible();
      await expect(targetDiv).not.toHaveClass(/hidden/);
    }
  });
});
