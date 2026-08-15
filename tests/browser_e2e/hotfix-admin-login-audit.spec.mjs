import { test, expect } from '@playwright/test';

test.describe('HOTFIX RC.11.2 - Admin Login Forensic Validation', () => {
  test.setTimeout(60000);

  test('Valid Admin Case/Whitespace Variations with Canonical Password dahoraexpresso1', async ({ page }) => {
    // Intercept network requests to ensure ZERO requests to remote Supabase
    page.on('request', request => {
      const url = request.url();
      if (url.includes('tskivauszmhhtqtegvwb.supabase.co')) {
        throw new Error(`CRITICAL ENVIRONMENT LEAK: Request to remote Supabase (${url})`);
      }
    });

    const validVariations = [
      'adm',
      'ADM',
      ' admin ',
      'Admin',
      'admin1',
      'admin@dahoraexpresso.com.br',
      'ADMIN@DAHORAEXPRESSO.COM.BR',
      'admin@dahora.local'
    ];

    for (const inputVal of validVariations) {
      await page.goto('/index.html');
      await page.waitForLoadState('networkidle');

      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.reload();
      await page.waitForLoadState('networkidle');

      await page.fill('#username', inputVal);
      await page.fill('#password', 'dahoraexpresso1');
      await page.click('#login-form button[type="submit"]');

      await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });
      await expect(page.locator('#view-dashboard')).toBeVisible();
    }
  });

  test('Invalid Email Rejection', async ({ page }) => {
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await page.waitForLoadState('networkidle');

    let dialogShown = false;
    page.once('dialog', async dialog => {
      dialogShown = true;
      await dialog.dismiss();
    });

    await page.fill('#username', 'unknown@invalid.test');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('#login-form button[type="submit"]');

    await page.waitForTimeout(1000);
    expect(dialogShown).toBe(true);
    await expect(page.locator('#view-dashboard')).not.toBeVisible();
  });
});
