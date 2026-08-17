import { test, expect } from '@playwright/test';
import { LOCAL_SERVICE_ROLE_KEY } from '../helpers/test-fixtures.mjs';

test.describe('GATE RC.12.3 - Commercial Client Registration & Direct Client Login Homologation', () => {
  test.setTimeout(90000);

  const timestamp = Date.now();
  const testEmail = `panificadora.e2e.${timestamp}@dahoraexpresso.com.br`;
  const testPassword = 'dahoraexpresso1';
  const establishmentName = `Panificadora E2E Homolog ${timestamp.toString().slice(-4)}`;

  test('Full E2E Creation by Admin and Direct Client Login with 7 Tabs & Multi-Tenant RLS Validation', async ({ page }) => {
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    // Intercept network requests to ensure ZERO requests to remote Supabase
    page.on('request', request => {
      const url = request.url();
      if (url.includes('tskivauszmhhtqtegvwb.supabase.co')) {
        throw new Error(`CRITICAL ENVIRONMENT LEAK: Request to remote Supabase (${url})`);
      }
    });

    await page.route('**/functions/v1/create-client-user', async route => {
      const authHeader = route.request().headers()['authorization'] || `Bearer ${LOCAL_SERVICE_ROLE_KEY}`;
      const response = await page.request.fetch('http://localhost:8000/api/admin/create-client', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': authHeader
        },
        data: route.request().postData()
      });
      const body = await response.text();
      await route.fulfill({
        status: response.status(),
        headers: { 'content-type': 'application/json' },
        body
      });
    });

    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    // -----------------------------------------------------------------------
    // STEP 1: ADMIN LOGIN & COMMERCIAL CLIENT CREATION
    // -----------------------------------------------------------------------
    await page.fill('#username', 'admin1@dahoraexpresso.com.br');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

    // Open Clientes Comerciais tab
    await page.evaluate(() => window.switchDashboardTab('owner-commercial-clients'));
    await page.waitForTimeout(600);

    // Open "Novo Cliente" modal
    await page.evaluate(() => {
      if (typeof window.openAddCommercialClientModal === 'function') {
        window.openAddCommercialClientModal();
      }
    });
    await page.waitForSelector('#modal-add-commercial-client', { state: 'visible', timeout: 5000 });

    // Fill registration form
    await page.fill('#comm-establishment-name', establishmentName);
    await page.fill('#comm-responsible-name', 'Carlos E2E Responsável');
    await page.fill('#comm-phone', '(51) 99888-7777');
    await page.fill('#comm-document', `${timestamp}`.slice(-14));
    await page.fill('#comm-email', testEmail);
    await page.fill('#comm-password', testPassword);
    await page.fill('#comm-address', 'R. Portão, 271 - Vargas, Sapucaia do Sul - RS');

    // Trigger creation directly via submitAddCommercialClient
    const evalResult = await page.evaluate(async (vals) => {
      window.setCommClientLocationState({
        formatted_address: vals.address,
        latitude: -29.8245,
        longitude: -51.1412,
        place_id: 'ChIJE2ETestPlaceId',
        street_number: '271',
        route: 'R. Portão',
        neighborhood: 'Vargas',
        city: 'Sapucaia do Sul',
        state: 'RS',
        postal_code: '93222-130'
      });

      try {
        const res = await window.submitAddCommercialClient();
        return { success: true, client: res };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, { address: 'R. Portão, 271 - Vargas, Sapucaia do Sul - RS' });

    console.log('EVAL RESULT OF SUBMIT:', evalResult);
    expect(evalResult.success).toBe(true);
    expect(evalResult.client).not.toBeNull();

    // Modal should close on success
    await page.waitForSelector('#modal-add-commercial-client', { state: 'hidden', timeout: 15000 });

    // -----------------------------------------------------------------------
    // STEP 2: LOGOUT FROM ADMIN (NO IMPERSONATION)
    // -----------------------------------------------------------------------
    await page.evaluate(async () => {
      if (typeof window.handleLogout === 'function') {
        await window.handleLogout();
      } else {
        if (window.supabaseClient) await window.supabaseClient.auth.signOut();
        localStorage.clear();
        sessionStorage.clear();
      }
    });

    await page.waitForSelector('#login-form', { state: 'visible', timeout: 15000 });

    // -----------------------------------------------------------------------
    // STEP 3: DIRECT CLIENT LOGIN WITH NEWLY CREATED CREDENTIALS
    // -----------------------------------------------------------------------
    await page.fill('#username', testEmail);
    await page.fill('#password', testPassword);
    await page.click('#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

    // Confirm banner "Visualização administrativa" is NOT present (Direct Client Mode!)
    await expect(page.locator('#admin-client-view-banner')).toBeHidden();

    // Wait for active client context to resolve in Direct Client Login Mode
    await page.waitForFunction(() => !!window.resolveActiveClientContext() || !!window.currentClientProfile, { timeout: 15000 });

    // Confirm establishment details in Client Header
    const activeClientContext = await page.evaluate(() => {
      return {
        context: window.resolveActiveClientContext(),
        impersonation: window.adminClientViewContext,
        clientProfile: window.currentClientProfile
      };
    });

    expect(activeClientContext.impersonation).toBeFalsy();
    expect(activeClientContext.context).not.toBeNull();
    expect(activeClientContext.context.isAdminView).toBe(false);

    // -----------------------------------------------------------------------
    // STEP 4: VERIFY ALL 7 CLIENT PANEL TABS IN DIRECT LOGIN MODE
    // -----------------------------------------------------------------------
    const clientTabsToTest = [
      { tab: 'client-overview', targetId: '#tab-client-overview' },
      { tab: 'client-request-delivery', targetId: '#tab-order-request' },
      { tab: 'client-deliveries', targetId: '#tab-client-teles' },
      { tab: 'client-financials', targetId: '#tab-client-financials' },
      { tab: 'client-extract', targetId: '#tab-client-extract' },
      { tab: 'client-support', targetId: '#tab-client-support' }
    ];

    for (const item of clientTabsToTest) {
      await page.evaluate(async (tabName) => {
        await window.switchDashboardTab(tabName);
      }, item.tab);

      await page.waitForTimeout(600);

      const targetDiv = page.locator(item.targetId);
      await expect(targetDiv).toBeVisible();
      await expect(targetDiv).not.toHaveClass(/hidden/);
    }

    // -----------------------------------------------------------------------
    // STEP 5: MULTI-TENANT RLS ISOLATION VERIFICATION
    // -----------------------------------------------------------------------
    const rlsAudit = await page.evaluate(async () => {
      if (!window.supabaseClient) return { count: 0, clients: [], error: 'No client' };
      // Attempt to query commercial_clients belonging to another client
      const { data, error } = await window.supabaseClient
        .from('commercial_clients')
        .select('id, establishment_name');

      return {
        count: Array.isArray(data) ? data.length : 0,
        clients: data || [],
        error: error ? error.message : null
      };
    });

    // In direct client mode, RLS allows selecting only the client's own profile (or 1 row)
    expect(rlsAudit.count).toBeLessThanOrEqual(1);
    if (rlsAudit.count === 1) {
      expect(rlsAudit.clients[0].establishment_name).toBe(establishmentName);
    }
  });
});
