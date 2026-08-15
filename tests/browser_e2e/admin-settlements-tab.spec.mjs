import { test, expect } from '@playwright/test';

test.describe('E2E Admin Repasse Semanal Tab', () => {
  test('Admin Repasse Semanal tab loads RPC list without 404', async ({ page }) => {
    // Intercept network requests to ensure ZERO requests to remote Supabase
    page.on('request', request => {
      const url = request.url();
      if (url.includes('tskivauszmhhtqtegvwb.supabase.co')) {
        throw new Error(`CRITICAL ENVIRONMENT LEAK: Request to remote Supabase (${url})`);
      }
    });

    const failedUrls = [];
    page.on('response', response => {
      if (response.status() >= 400) {
        failedUrls.push({ url: response.url(), status: response.status() });
      }
    });

    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    await page.fill('#username', 'admin1@dahoraexpresso.com.br');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

    // Open Extratos / Repasses accordion or tab
    const settlementsNav = page.locator('#nav-settlements');
    if (await settlementsNav.isVisible()) {
      await settlementsNav.click();
      await page.waitForTimeout(1000);
    }

    console.log('Failed response URLs:', failedUrls);
    const rpc404s = failedUrls.filter(f => f.url.includes('rpc/list_admin_rider_weekly_settlements'));
    expect(rpc404s).toHaveLength(0);
  });
});
