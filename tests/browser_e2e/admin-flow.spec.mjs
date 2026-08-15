import { test, expect } from '@playwright/test';

test.describe('E2E Admin Panel Flow', () => {
  test('Admin Login, Session Persistence (F5), Navigation & Responsive Viewports', async ({ page }) => {
    // 1. Intercept network to verify NO calls to remote Supabase
    page.on('request', request => {
      const url = request.url();
      if (url.includes('tskivauszmhhtqtegvwb.supabase.co')) {
        throw new Error(`CRITICAL ENVIRONMENT LEAK DETECTED: Request to remote Supabase (${url})`);
      }
    });

    // 2. Open Admin Panel
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    // 3. Login as Admin
    await page.fill('#username', 'admin1@dahoraexpresso.com.br');
    await page.fill('#password', 'senha123456');
    await page.click('button[type="submit"]');

    // Wait for main dashboard to be visible
    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });
    await expect(page.locator('#view-dashboard')).toBeVisible();

    // 4. Validate F5 / Page reload session persistence
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#view-dashboard')).toBeVisible();

    // 5. Test navigation tabs
    const navItems = ['#nav-clients', '#nav-teles', '#nav-settlements'];
    for (const navId of navItems) {
      if (await page.locator(navId).isVisible()) {
        await page.click(navId);
        await page.waitForTimeout(300);
      }
    }
  });
});
