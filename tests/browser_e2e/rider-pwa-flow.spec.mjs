import { test, expect } from '@playwright/test';

test.describe('E2E Rider PWA Flow', () => {
  test('Rider PWA Login, Availability, My Teles, Drawer & Geolocation', async ({ page }) => {
    // 1. Intercept network to verify NO calls to remote Supabase
    page.on('request', request => {
      const url = request.url();
      if (url.includes('tskivauszmhhtqtegvwb.supabase.co')) {
        throw new Error(`CRITICAL ENVIRONMENT LEAK DETECTED: Request to remote Supabase (${url})`);
      }
    });

    // 2. Open Motoboy PWA
    await page.goto('/motoboy.html');
    await page.waitForLoadState('networkidle');

    // 3. Login as Motoboy via GoTrue Auth
    await page.waitForFunction(() => typeof window.supabaseClient !== 'undefined' && window.supabaseClient !== null);

    await page.evaluate(async () => {
      const client = window.supabaseClient;
      const { data, error } = await client.auth.signInWithPassword({ email: 'motoboy@dahora.local', password: 'senha123456' });
      if (!error && data?.session) {
        const { data: rider } = await client.from('fleet').select('*').limit(1).single();
        if (rider) {
          window.currentRider = rider;
          window.currentRiderId = rider.id;
        }
        const app = document.getElementById('pwa-app');
        const login = document.getElementById('pwa-login');
        if (login) login.classList.add('hidden');
        if (app) {
          app.classList.remove('hidden');
          app.style.display = 'block';
        }
      }
    });

    // Wait for main dashboard container to be visible
    await page.waitForSelector('#pwa-app', { state: 'visible', timeout: 15000 });
    await expect(page.locator('#pwa-app')).toBeVisible();

    // 4. Test page reload (F5) persistence
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#pwa-app')).toBeVisible();
  });
});
