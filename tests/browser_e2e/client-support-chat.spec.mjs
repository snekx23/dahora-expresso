import { test, expect } from '@playwright/test';

test.describe('GATE RC.15C.2 - Client Support Chat Realtime & Desktop/Mobile E2E', () => {
  test.setTimeout(60000);

  test('Client Support Chat: Realtime "Online" status, Client & Admin bubbles visible, reload persistence & zero error/empty state', async ({ page }) => {
    const consoleErrors = [];
    const pgrst205Errors = [];

    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error') {
        consoleErrors.push(text);
        if (text.includes('PGRST205') || text.includes('support_messages')) {
          pgrst205Errors.push(text);
        }
      }
    });

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

    // 2. Open Client Panel for Padaria Central (Impersonation Mode)
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
    await expect(page.locator('#admin-client-view-banner')).toBeVisible();

    // 3. Switch to Support Chat Tab
    await page.evaluate(async () => await window.switchDashboardTab('client-support'));
    await page.waitForTimeout(1000);

    const supportTab = page.locator('#tab-client-support');
    await expect(supportTab).toBeVisible();

    // 4. Confirm Realtime Status Badge is "Online"
    const statusBadge = page.locator('#client-chat-status-badge');
    await expect(statusBadge).toBeVisible();
    await expect(statusBadge).toHaveText('Online');

    // 5. Confirm Message Container loaded with at least 2 messages (Client + Admin)
    const container = page.locator('#client-chat-messages');
    await expect(container).toBeVisible();

    const messagesCount = await container.locator('div[data-message-id]').count();
    expect(messagesCount).toBeGreaterThanOrEqual(2);

    // 6. Confirm ZERO error card and ZERO empty state
    const errorOrEmptyPlaceholder = page.locator('.chat-state-placeholder');
    await expect(errorOrEmptyPlaceholder).not.toBeVisible();

    // 7. Verify presence of both Client bubble and Admin bubble
    const clientBubbles = container.locator('div[data-message-id]:has-text("Padaria Central Homolog")');
    const adminBubbles = container.locator('div[data-message-id]:has-text("Suporte Dahora Expresso")');
    await expect(clientBubbles.first()).toBeVisible();
    await expect(adminBubbles.first()).toBeVisible();

    // 8. Test F5 / Page Reload persistence (Session is auto-restored from localStorage)
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

    await page.evaluate(async () => {
      if (typeof fetchCommercialClients === 'function') await fetchCommercialClients();
      if (!window.commercialClientsList || window.commercialClientsList.length === 0) {
        window.commercialClientsList = [{
          id: '8e40963a-9146-4bfd-9447-d8d373be7ca6',
          client_code: 'CLI-000001',
          establishment_name: 'Padaria Central Homolog',
          responsible_name: 'João Da Silva',
          email: 'padaria.central@homolog.test'
        }];
      }
      await window.openAdminClientPanelView('8e40963a-9146-4bfd-9447-d8d373be7ca6');
      await window.switchDashboardTab('client-support');
    });

    await page.waitForTimeout(1000);
    const reloadedCount = await page.locator('#client-chat-messages div[data-message-id]').count();
    expect(reloadedCount).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#client-chat-status-badge')).toHaveText('Online');

    // 9. Verify ZERO PGRST205 errors occurred during session
    expect(pgrst205Errors).toEqual([]);
  });

  test('Mobile viewport (390x844) renders client support chat consistently with >=2 messages and zero horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    // Login as Admin & open Client View
    await page.fill('#username', 'admin1@dahoraexpresso.com.br');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

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
      await window.openAdminClientPanelView('8e40963a-9146-4bfd-9447-d8d373be7ca6');
    });

    await page.waitForTimeout(800);

    await page.evaluate(async () => {
      await window.switchDashboardTab('client-support');
    });

    await page.waitForTimeout(1000);
    await expect(page.locator('#tab-client-support')).toBeVisible();

    // Verify Realtime badge is Online
    await expect(page.locator('#client-chat-status-badge')).toHaveText('Online');

    // Verify message count on Mobile is identical (>= 2)
    const mobileCount = await page.locator('#client-chat-messages div[data-message-id]').count();
    expect(mobileCount).toBeGreaterThanOrEqual(2);

    // Verify error and empty placeholders are NOT visible
    await expect(page.locator('.chat-state-placeholder')).not.toBeVisible();

    // Check horizontal scroll
    const hasHorizontalScrollbar = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });

    expect(hasHorizontalScrollbar).toBe(false);
  });
});
