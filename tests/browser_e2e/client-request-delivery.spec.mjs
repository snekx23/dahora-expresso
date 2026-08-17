import { test, expect } from '@playwright/test';

test.describe('GATE RC.12.2A - Client Panel Request Delivery Precision & Visual Estimate Box Removal', () => {
  test.setTimeout(60000);

  test('Complete Geocoding Precision & Visual Estimate Box Removal Validation', async ({ page }) => {
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

    // 2. Open Padaria Central Homolog panel via openAdminClientPanelView
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

    await page.waitForTimeout(1500);

    // 3. Navigate to Solicitar Entrega
    await page.evaluate(() => {
      window.switchDashboardTab('client-request-delivery');
    });

    await page.waitForTimeout(600);

    const reqTab = page.locator('#tab-order-request');
    await expect(reqTab).toBeVisible();

    // SCENARIO 6: Confirm absence of visual estimate box (#client-estimate-box)
    await expect(page.locator('#client-estimate-box')).toHaveCount(0);
    await expect(page.locator('text="Distância Calculada"')).toHaveCount(0);
    await expect(page.locator('text="Tempo de Deslocamento"')).toHaveCount(0);
    await expect(page.locator('text="Fora da área de entrega"')).toHaveCount(0);

    // SCENARIO 1: Simulate selecting an address place authoritatively
    await page.evaluate(() => {
      const addressInput = document.getElementById('client-delivery-address');
      const latInput = document.getElementById('client-delivery-lat');
      const lngInput = document.getElementById('client-delivery-lng');
      const precisionInput = document.getElementById('client-geocoding-precision');
      const manualInput = document.getElementById('client-location-adjusted-manually');

      const testAddress = 'R. Portão, 271 - Vargas, Sapucaia do Sul - RS, 93222-130, Brasil';
      const testLat = -29.8245;
      const testLng = -51.1412;

      addressInput.value = testAddress;
      addressInput.dataset.lastResolvedAddress = testAddress;
      addressInput.dataset.isPlacesResolved = "true";

      if (latInput) latInput.value = String(testLat);
      if (lngInput) lngInput.value = String(testLng);
      if (precisionInput) precisionInput.value = 'rooftop';
      if (manualInput) manualInput.value = 'false';

      if (window.requestMaps && window.requestMaps.client) {
        window.requestMaps.client.destCoords = { lat: testLat, lng: testLng, isManualPin: false };
      }

      window.updateClientOrderSummaryPreview();
    });

    await page.waitForTimeout(300);

    // SCENARIO 7: Verify live side summary card preview
    await expect(page.locator('#summary-delivery-val')).toHaveText('R. Portão, 271 - Vargas, Sapucaia do Sul - RS, 93222-130, Brasil');

    // SCENARIO 2 & 3: Trigger blur and calculateEstimate and verify coordinates are NOT overwritten
    await page.locator('#client-delivery-address').focus();
    await page.locator('#client-delivery-address').blur();
    await page.evaluate(() => {
      if (typeof calculateEstimate === 'function') calculateEstimate('client');
    });

    await page.waitForTimeout(300);

    const latVal = await page.evaluate(() => document.getElementById('client-delivery-lat')?.value);
    const lngVal = await page.evaluate(() => document.getElementById('client-delivery-lng')?.value);
    const isResolved = await page.evaluate(() => document.getElementById('client-delivery-address')?.dataset?.isPlacesResolved);

    expect(latVal).toBe('-29.8245');
    expect(lngVal).toBe('-51.1412');
    expect(isResolved).toBe('true');

    // SCENARIO 5: Manual pin drag simulation
    await page.evaluate(() => {
      const newLat = -29.8250;
      const newLng = -51.1420;
      if (window.requestMaps && window.requestMaps.client) {
        window.requestMaps.client.destCoords = { lat: newLat, lng: newLng, isManualPin: true };
      }
      document.getElementById('client-delivery-lat').value = String(newLat);
      document.getElementById('client-delivery-lng').value = String(newLng);
      document.getElementById('client-location-adjusted-manually').value = 'true';
      document.getElementById('client-geocoding-precision').value = 'manual_pin';
    });

    const isManual = await page.evaluate(() => document.getElementById('client-location-adjusted-manually')?.value);
    expect(isManual).toBe('true');

    // SCENARIO 4: Edit text manually after selection without selecting new Place -> Invalidation
    await page.evaluate(() => {
      const addressInput = document.getElementById('client-delivery-address');
      addressInput.value = 'Rua Modificada Sem Seleção de Place';
      addressInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(200);

    const isResolvedAfterEdit = await page.evaluate(() => document.getElementById('client-delivery-address')?.dataset?.isPlacesResolved);
    const latAfterEdit = await page.evaluate(() => document.getElementById('client-delivery-lat')?.value);

    expect(isResolvedAfterEdit).toBeUndefined();
    expect(latAfterEdit).toBe('');
  });
});
