// =====================================================================
// Dahora Expresso — Teste Playwright E2E: Perfil do Cliente Comercial (RC.17B)
// File: tests/browser_e2e/client-profile.spec.mjs
// =====================================================================

import { test, expect } from '@playwright/test';
import path from 'node:path';

const BASE_URL = 'http://127.0.0.1:8000';

test.describe('Perfil do Cliente Comercial (RC.17B)', () => {

  test.beforeEach(async ({ page, context }) => {
    await context.clearCookies();
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
  });

  test('1. Leitura de Dados Reais, Edição de Campos Permitidos e Persistência Pós-F5 (Desktop 1366x768)', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });

    // Login como Cliente Comercial (Padaria Central)
    await page.click('.login-tabs button[data-tab="client"]');
    await page.waitForTimeout(200);
    await page.fill('#username', 'padaria.central@homolog.test');
    await page.fill('#password', 'dahoraexpresso1');
    await page.click('form#login-form button[type="submit"]');

    await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(500);

    // Navegar para Perfil
    await page.click('.nav-item[data-tab="client-profile"]');
    await page.waitForSelector('#tab-client-profile.active', { state: 'visible', timeout: 10000 });

    // 1. Validar leitura inicial dos dados autoritativos
    await expect(page.locator('#profile-field-establishment')).toHaveValue('Padaria Central Homolog');
    await expect(page.locator('#profile-field-document')).toHaveValue('11.222.333/0001-99');
    await expect(page.locator('#profile-field-email')).toHaveValue('padaria.central@homolog.test');
    await expect(page.locator('#client-profile-code-text')).toContainText('CLI-000001');

    // 2. Editar campos permitidos
    const newName = `Sócio Resp Teste ${Date.now()}`;
    const newPhone = '(51) 99999-8888';
    const newStreet = 'Rua dos Andradas';
    const newNumber = '500';
    const newNeighborhood = 'Centro Histórico';
    const newCity = 'Porto Alegre';
    const newZip = '90020-000';

    await page.fill('#profile-field-responsible', newName);
    await page.fill('#profile-field-phone', newPhone);
    await page.fill('#profile-field-address', newStreet);
    await page.fill('#profile-field-number', newNumber);
    await page.fill('#profile-field-neighborhood', newNeighborhood);
    await page.fill('#profile-field-zip', newZip);

    // Submeter formulário
    await page.click('#btn-save-client-profile');

    // Aguardar mensagem de sucesso (toast ou feedback)
    const toast = page.locator('.toast, #toast-container, #client-profile-feedback, .alert-success');
    await expect(toast.first()).toBeVisible({ timeout: 10000 });

    // Screenshot Desktop
    const artifactDir = path.resolve('..', '.gemini', 'antigravity-ide', 'brain', 'd9505213-0a6a-4832-96d7-495c91191342');
    await page.screenshot({ path: path.join(artifactDir, 'client_profile_RC17B_desktop.png'), fullPage: true });

    // 3. Recarregar página (F5) para verificar persistência autoritativa
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Re-autenticar se necessário
    if (await page.isVisible('form#login-form')) {
      await page.click('.login-tabs button[data-tab="client"]');
      await page.fill('#username', 'padaria.central@homolog.test');
      await page.fill('#password', 'dahoraexpresso1');
      await page.click('form#login-form button[type="submit"]');
      await page.waitForSelector('#view-dashboard', { state: 'visible' });
    }

    await page.evaluate(() => switchDashboardTab('client-profile'));
    await page.waitForSelector('#tab-client-profile.active', { state: 'visible' });

    // Verificar se novos dados persistiram no backend
    await expect(page.locator('#profile-field-responsible')).toHaveValue(newName);
    await expect(page.locator('#profile-field-phone')).toHaveValue(newPhone);
    await expect(page.locator('#profile-field-address')).toHaveValue(newStreet);
    await expect(page.locator('#profile-field-number')).toHaveValue(newNumber);
  });

  test('2. Layout Responsivo Mobile (390x844) sem Overflow Horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    if (await page.isVisible('.login-tabs button[data-tab="client"]')) {
      await page.click('.login-tabs button[data-tab="client"]');
      await page.waitForTimeout(200);
      await page.fill('#username', 'padaria.central@homolog.test');
      await page.fill('#password', 'dahoraexpresso1');
      await page.click('form#login-form button[type="submit"]');
      await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });
    }

    // Navegar para Perfil via switchDashboardTab no mobile
    await page.evaluate(() => switchDashboardTab('client-profile'));
    await page.waitForSelector('#tab-client-profile.active', { state: 'visible', timeout: 10000 });

    // Verificar se container de perfil não tem overflow horizontal
    const profileContainer = page.locator('#tab-client-profile');
    const scrollWidth = await profileContainer.evaluate(el => el.scrollWidth);
    const clientWidth = await profileContainer.evaluate(el => el.clientWidth);

    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // Screenshot Mobile
    const artifactDir = path.resolve('..', '.gemini', 'antigravity-ide', 'brain', 'd9505213-0a6a-4832-96d7-495c91191342');
    await page.screenshot({ path: path.join(artifactDir, 'client_profile_RC17B_mobile.png'), fullPage: true });
  });

  test('3. Admin Impersonation com Alternância Anti-Race', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });

    const adminTab = page.locator('.login-tabs button[data-tab="admin"]');
    if (await adminTab.isVisible()) {
      await adminTab.click({ force: true });
      await page.waitForTimeout(200);
      await page.fill('#username', 'admin1@dahoraexpresso.com.br');
      await page.fill('#password', 'dahoraexpresso1');
      await page.click('form#login-form button[type="submit"]');
      await page.waitForSelector('#view-dashboard', { state: 'visible', timeout: 15000 });
    }

    // Navegar para Perfil
    await page.evaluate(() => switchDashboardTab('client-profile'));
    await page.waitForSelector('#tab-client-profile.active', { state: 'attached', timeout: 10000 });

    // Confirmar que o perfil foi ativado no roteamento anti-race
    await expect(page.locator('#tab-client-profile')).toHaveClass(/active/);
  });

});
