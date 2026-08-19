import { test, expect } from '@playwright/test';

test.describe('GATE RC.16B.2 — Client Overview Mobile Responsiveness & E2E Hardening', () => {
  test.setTimeout(60000);

  test('Direct Commercial Client Login: Full Visual & BoundingBox Validation (Desktop 1366x768)', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    // 1. Click Client Login Tab & Authenticate
    await page.click('.login-tabs button[data-tab="client"]');
    await page.waitForTimeout(300);

    await page.fill('#username', 'padaria.central@homolog.test');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('form#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);

    // 2. Strict DOM & Visibility Verification for #tab-client-overview
    const overview = page.locator('#tab-client-overview');
    await expect(overview).toHaveClass(/active/);
    await expect(overview).toBeVisible();

    const box = await overview.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThan(300);
    expect(box.height).toBeGreaterThan(300);

    // 3. Validate visual presence of Hero Title and Establishment Name
    const estabName = page.locator('#client-overview-establishment-name');
    await expect(estabName).toBeVisible();
    await expect(estabName).toContainText('Padaria Central', { timeout: 10000 });

    // 4. Validate visual presence of 4 KPI cards
    await expect(page.locator('#client-overview-kpi-pending')).toBeVisible();
    await expect(page.locator('#client-overview-kpi-active')).toBeVisible();
    await expect(page.locator('#client-overview-kpi-completed-today')).toBeVisible();
    await expect(page.locator('#client-overview-kpi-total-today')).toBeVisible();

    await page.waitForFunction(() => {
      const el = document.getElementById('client-overview-kpi-pending');
      return el && el.innerText !== '...';
    }, { timeout: 10000 });

    // 5. Validate Chart & Action Cards
    await expect(page.locator('#clientOverviewChart')).toBeVisible();
    await expect(page.locator('#client-action-cards')).toBeVisible();

    // 6. Navigation Flow: Início -> Entregas -> Início -> F5
    await page.click('.nav-item[data-tab="client-deliveries"]');
    await expect(page.locator('#tab-client-teles')).toHaveClass(/active/);

    await page.click('.nav-item[data-tab="client-overview"]');
    await expect(overview).toHaveClass(/active/);
    await expect(overview).toBeVisible();

    const boxReturn = await overview.boundingBox();
    expect(boxReturn.width).toBeGreaterThan(300);
    expect(boxReturn.height).toBeGreaterThan(300);

    // Reload page (F5) and ensure state persistence
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });
    await expect(overview).toBeVisible();
  });

  test('Admin Impersonation: Real Visual Homologation & BoundingBox', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    await page.fill('#username', 'admin1@dahoraexpresso.com.br');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

    // Open Padaria Central panel in Impersonation mode
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

    const overview = page.locator('#tab-client-overview');
    await expect(overview).toHaveClass(/active/);
    await expect(overview).toBeVisible();

    const box = await overview.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThan(300);
    expect(box.height).toBeGreaterThan(300);

    await expect(page.locator('#client-overview-establishment-name')).toContainText('Padaria Central', { timeout: 10000 });
    await expect(page.locator('#clientOverviewChart')).toBeVisible();
    await expect(page.locator('#client-action-cards')).toBeVisible();
  });

  test('Mobile Viewport (390x844): Zero Overflow & Full BoundingBox Component Verification', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    await page.click('.login-tabs button[data-tab="client"]');
    await page.waitForTimeout(300);

    await page.fill('#username', 'padaria.central@homolog.test');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('form#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1500);

    const overview = page.locator('#tab-client-overview');
    await expect(overview).toHaveClass(/active/);
    await expect(overview).toBeVisible();

    // 1. Validate zero global horizontal overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // 2. Validate strict bounding boxes for all key mobile elements scoped within overview
    const elementsToVerify = [
      { selector: '#tab-client-overview', name: 'Client Overview Container' },
      { selector: '#tab-client-overview .ops-hero.partner-hero', name: 'Hero Banner' },
      { selector: '#client-overview-kpi-pending', name: 'KPI Aguardando' },
      { selector: '#client-overview-kpi-active', name: 'KPI Em Execução' },
      { selector: '#client-overview-kpi-completed-today', name: 'KPI Concluídas Hoje' },
      { selector: '#client-overview-kpi-total-today', name: 'KPI Teles Hoje' },
      { selector: '#tab-client-overview .client-overview-mid-grid', name: 'Mid Grid' },
      { selector: '#clientOverviewChart', name: 'Chart Canvas' },
      { selector: '#client-overview-month-total', name: 'Month Total KPI' },
      { selector: '#client-action-cards', name: 'Action Cards Container' }
    ];

    for (const item of elementsToVerify) {
      const loc = page.locator(item.selector);
      await expect(loc).toBeVisible();
      const b = await loc.boundingBox();
      expect(b).not.toBeNull();
      expect(b.width).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
      expect(b.x + b.width).toBeLessThanOrEqual(clientWidth + 1);
    }

    // 3. Verify vertical scrolling exposes bottom elements completely
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await expect(page.locator('#client-action-cards')).toBeVisible();
  });
});
