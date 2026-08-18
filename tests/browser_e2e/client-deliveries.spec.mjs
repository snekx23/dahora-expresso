import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY } from '../helpers/test-fixtures.mjs';

test.describe('GATE RC.13C — Client Deliveries Operational Redesign, Session Auth & Responsive Suite', () => {
  test.setTimeout(90000);

  // -------------------------------------------------------------------------
  // SESSION AUTH REGRESSION TESTS (TESTES 1, 2, 3, 4)
  // -------------------------------------------------------------------------
  test('Session Auth Test 1: Nova visita em contexto limpo exibe login SEM toast de expiração', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#view-landing')).toHaveClass(/active/);
    const expiredToast = page.locator('#toast-container .toast:has-text("expirou")');
    await expect(expiredToast).toHaveCount(0);
    await context.close();
  });

  test('Session Auth Test 2 & 3: Login normal e F5 restauram sessão SEM toast de expiração', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    // Login normal
    await page.fill('#username', 'admin1@dahoraexpresso.com.br');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

    let expiredToast = page.locator('#toast-container .toast:has-text("expirou")');
    await expect(expiredToast).toHaveCount(0);

    // F5 / Refresh com sessão válida
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#view-dashboard')).toHaveClass(/active/);

    expiredToast = page.locator('#toast-container .toast:has-text("expirou")');
    await expect(expiredToast).toHaveCount(0);

    await context.close();
  });

  test('Session Auth Test 4: Token persistido inválido retorna ao login E exibe toast "Sua sessão expirou"', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    // Injetar chave de token expirada/inválida no localStorage
    await page.evaluate(() => {
      const mockSession = {
        access_token: 'invalid-jwt-token-rc13c',
        refresh_token: 'invalid-refresh-token-rc13c',
        user: { id: 'invalid-user-uuid' },
        expires_at: 1000
      };
      localStorage.setItem('dahora-owner-auth', JSON.stringify(mockSession));
      localStorage.setItem('sb-127.0.0.1-auth-token', JSON.stringify(mockSession));
    });

    // Recarregar aplicação com token inválido
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Deve retornar à tela de login
    await expect(page.locator('#view-landing')).toHaveClass(/active/);

    // Deve exibir o toast legítimo de sessão expirada
    const expiredToast = page.locator('#toast-container .toast:has-text("expirou")');
    await expect(expiredToast).toBeVisible({ timeout: 5000 });

    await context.close();
  });

  // -------------------------------------------------------------------------
  // E2E ISOLATION, DESKTOP (1366x768) & MOBILE (390x844) RESPONSIVE SUITE
  // -------------------------------------------------------------------------
  test('Complete E2E Isolation, Desktop (1366x768) & Mobile (390x844) Responsive Validation', async ({ page }) => {
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    page.on('request', request => {
      const url = request.url();
      if (url.includes('tskivauszmhhtqtegvwb.supabase.co')) {
        throw new Error(`CRITICAL ENVIRONMENT LEAK: Request to remote Supabase (${url})`);
      }
    });

    // Step 1: Login on Desktop (1366x768)
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    await page.fill('#username', 'admin1@dahoraexpresso.com.br');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });

    // Seed test client with 18 mock teles in local Supabase DB
    const adminSupabase = createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY);
    const testEmail = `padaria.rc13c.${Date.now()}.${Math.floor(Math.random()*1000)}@homolog.test`;
    const testDoc = `${Date.now()}${Math.floor(Math.random()*1000)}`.slice(-14);

    const { data: newClient, error: clientErr } = await adminSupabase.from('commercial_clients').insert({
      establishment_name: 'Padaria E2E RC13C Test',
      responsible_name: 'Roberto Responsável RC13C',
      phone: '51999998888',
      email: testEmail,
      document: testDoc,
      address: 'R. Portão, 271 - Vargas, Sapucaia do Sul - RS',
      neighborhood: 'Vargas',
      city: 'Sapucaia do Sul',
      state: 'RS',
      postal_code: '93222-130',
      financial_status: 'em_dia',
      lifecycle_status: 'ativo'
    }).select().single();

    expect(clientErr).toBeNull();
    expect(newClient).toBeTruthy();
    const testClientId = newClient.id;

    const telesToInsert = [];
    const runId = Date.now();
    for (let i = 1; i <= 18; i++) {
      telesToInsert.push({
        client_id: testClientId,
        tele_code: `TEL-RC13C-${runId}-${String(i).padStart(3, '0')}`,
        pickup_address: 'R. Portão, 271 - Vargas, Sapucaia do Sul - RS',
        delivery_address: `Rua Teste RC13C, ${i}00`,
        recipient_name: `Destinatário RC13C ${i}`,
        delivery_charge: 15.50 + i,
        status: i <= 5 ? 'solicitada' : (i <= 10 ? 'em_rota' : 'entregue'),
        created_at: new Date(Date.now() - (18 - i) * 3600000).toISOString()
      });
    }
    const { error: telesErr } = await adminSupabase.from('teles').insert(telesToInsert);
    expect(telesErr).toBeNull();

    // Open Admin View for client
    await page.evaluate(async (clientId) => {
      if (typeof window.fetchCommercialClients === 'function') {
        await window.fetchCommercialClients();
      }
      window.openAdminClientPanelView(clientId);
    }, testClientId);
    await page.waitForTimeout(600);

    // Switch to Entregas tab
    await page.evaluate(() => window.switchDashboardTab('client-deliveries'));
    await page.waitForTimeout(1000);

    // -----------------------------------------------------------------------
    // DESKTOP (1366x768) ASSERTIONS
    // -----------------------------------------------------------------------
    const isDesktopTableVisible = await page.isVisible('.desktop-deliveries-table');
    const isMobileListHiddenOnDesktop = await page.isHidden('.mobile-deliveries-list');
    expect(isDesktopTableVisible).toBe(true);
    expect(isMobileListHiddenOnDesktop).toBe(true);

    const countAll = await page.textContent('#client-count-all');
    expect(countAll.trim()).toBe('18');

    // -----------------------------------------------------------------------
    // MOBILE (390x844) RESPONSIVE ASSERTIONS
    // -----------------------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);

    // 1. Zero horizontal overflow (scrollWidth <= clientWidth + 1)
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // 2. Mobile cards visible & Desktop table hidden
    const isMobileListVisible = await page.isVisible('.mobile-deliveries-list');
    const isDesktopTableHidden = await page.isHidden('.desktop-deliveries-table');
    expect(isMobileListVisible).toBe(true);
    expect(isDesktopTableHidden).toBe(true);

    // 3. Verify card elements rendering
    const cardContent = await page.textContent('.mobile-deliveries-list');
    expect(cardContent).toContain('TEL-RC13C-');
    expect(cardContent).toContain('Destinatário RC13C');
    expect(cardContent).toContain('Valor:');

    // 4. Verify no raw UUIDs or 85/15 internal info in cards
    expect(cardContent).not.toContain(testClientId);

    // 5. Test "Ver detalhes" button on mobile card opens modal
    const detailBtn = await page.$('.mobile-deliveries-list button');
    expect(detailBtn).not.toBeNull();
    await detailBtn.click();
    await page.waitForSelector('#modal-client-tele-detail.active', { timeout: 5000 });

    const modalText = await page.textContent('#modal-client-tele-detail');
    expect(modalText).toContain('Solicitada');
    expect(modalText).not.toContain('delivered_at');

    await page.click('#modal-client-tele-detail button');
    await page.waitForTimeout(300);

    // Exit Admin View
    await page.evaluate(() => window.exitAdminClientPanelView());
  });
});
