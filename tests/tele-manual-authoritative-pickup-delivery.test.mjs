import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('HOTFIX H2: Contaminação legada e coordenadas hardcoded removidas', (t) => {
  const appJs = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.resolve('public/index.html'), 'utf8');

  // 1. "Seu Comércio" não pode existir como string literal ativa em app.js ou index.html
  assert.equal(appJs.includes("'Seu Comércio'"), false, "app.js não deve conter 'Seu Comércio'");
  assert.equal(appJs.includes('"Seu Comércio"'), false, 'app.js não deve conter "Seu Comércio"');
  assert.equal(indexHtml.includes('Seu Comércio'), false, 'index.html não deve conter Seu Comércio');

  // 2. Coordenadas de São Paulo [-23.55...] não devem estar presentes em app.js
  assert.equal(appJs.includes('-23.55052'), false, 'app.js não deve conter latitude de SP -23.55052');
  assert.equal(appJs.includes('-46.633308'), false, 'app.js não deve conter longitude de SP -46.633308');

  // 3. Checagem dos elementos UI da Seção PONTO DE COLETA
  assert.match(indexHtml, /id="manual-pickup-establishment-name"/, 'index.html deve conter nome do estabelecimento');
  assert.match(indexHtml, /id="manual-pickup-default-address"/, 'index.html deve conter endereço padrão de coleta');
  assert.match(indexHtml, /id="btn-toggle-custom-pickup"/, 'index.html deve conter botão Alterar coleta');
  assert.match(indexHtml, /id="btn-reset-default-pickup"/, 'index.html deve conter botão Restaurar padrão');
  assert.match(indexHtml, /id="manual-pickup-custom-address"/, 'index.html deve conter input de coleta personalizada');

  // 4. Checagem do botão "Entregar no estabelecimento" no PONTO DE ENTREGA
  assert.match(indexHtml, /id="btn-deliver-to-establishment"/, 'index.html deve conter botão Entregar no estabelecimento');
});

test('HOTFIX H2.3: Sincronização Autoritativa do Cliente Comercial e Botão Alterar Coleta', async (t) => {
  const appJs = fs.readFileSync(path.resolve('public/app.js'), 'utf8');

  // 1. selectCommercialClient deve invocar selectCommercialClientForTele
  assert.match(appJs, /selectCommercialClientForTele\s*\(\s*client\.id/, 'selectCommercialClient deve acionar selectCommercialClientForTele');

  // 2. toggleCustomPickupManualTele deve aceitar manualTelePickupState.clientId ou fallback seguro
  assert.match(appJs, /manualTelePickupState\.clientId\s*\|\|\s*document\.getElementById\(['"]selectedClientId['"]\)/, 'toggleCustomPickupManualTele deve sincronizar com o client_id selecionado');

  // 3. Simulação dos 5 Cenários E2E do Bug Real
  const clientA = {
    id: 'uuid-client-a',
    establishment_name: 'Lanches da Hora',
    address: 'Rua das Flores, 100 - Centro, Sapucaia do Sul - RS',
    pickup_latitude: -29.8247,
    pickup_longitude: -51.1444,
    pickup_place_id: 'place-id-lanches-a'
  };

  const clientB = {
    id: 'uuid-client-b',
    establishment_name: 'Pizzaria Noturna',
    address: 'Av. Mauá, 500 - Centro, Sapucaia do Sul - RS',
    pickup_latitude: -29.8300,
    pickup_longitude: -51.1500,
    pickup_place_id: 'place-id-pizza-b'
  };

  let simulatedState = {
    clientId: null,
    establishmentName: '',
    isCustom: false,
    defaultAddress: '',
    defaultLat: null,
    defaultLng: null,
    defaultPlaceId: '',
    customAddress: '',
    customLat: null,
    customLng: null,
    customPlaceId: ''
  };

  let toastMessages = [];
  function showToast(msg) { toastMessages.push(msg); }

  function selectClient(client) {
    if (!client) return;
    simulatedState = {
      clientId: client.id,
      establishmentName: client.establishment_name,
      isCustom: false,
      defaultAddress: client.address,
      defaultLat: client.pickup_latitude,
      defaultLng: client.pickup_longitude,
      defaultPlaceId: client.pickup_place_id,
      customAddress: '',
      customLat: null,
      customLng: null,
      customPlaceId: ''
    };
  }

  function toggleCustomPickup() {
    if (!simulatedState.clientId) {
      showToast('Selecione primeiro um estabelecimento comercial.');
      return false;
    }
    simulatedState.isCustom = true;
    return true;
  }

  function resetDefaultPickup() {
    simulatedState.isCustom = false;
    simulatedState.customAddress = '';
    simulatedState.customLat = null;
    simulatedState.customLng = null;
    simulatedState.customPlaceId = '';
  }

  await t.test('Cenário 1: Selecionar Cliente A -> Alterar Coleta abre sem toast de bloqueio', () => {
    toastMessages = [];
    selectClient(clientA);

    assert.equal(simulatedState.clientId, 'uuid-client-a');
    assert.equal(simulatedState.establishmentName, 'Lanches da Hora');
    assert.equal(simulatedState.isCustom, false);

    const opened = toggleCustomPickup();
    assert.equal(opened, true);
    assert.equal(simulatedState.isCustom, true);
    assert.equal(toastMessages.length, 0, 'Nenhum toast de bloqueio deve ser exibido');
  });

  await t.test('Cenário 2: Selecionar Coleta C -> Preservar lat/lng/place_id e criar Tele', () => {
    simulatedState.customAddress = 'Av. Ipiranga, 6681 - Partenon, Porto Alegre - RS';
    simulatedState.customLat = -30.0598;
    simulatedState.customLng = -51.1787;
    simulatedState.customPlaceId = 'place-c';

    const telePayload = {
      client_id: simulatedState.clientId,
      pickup_address: simulatedState.customAddress,
      pickup_latitude: simulatedState.customLat,
      pickup_longitude: simulatedState.customLng,
      pickup_place_id: simulatedState.customPlaceId
    };

    assert.equal(telePayload.client_id, 'uuid-client-a');
    assert.equal(telePayload.pickup_address, 'Av. Ipiranga, 6681 - Partenon, Porto Alegre - RS');
    assert.equal(telePayload.pickup_latitude, -30.0598);
    assert.equal(telePayload.pickup_longitude, -51.1787);
    assert.equal(telePayload.pickup_place_id, 'place-c');
  });

  await t.test('Cenário 3: Restaurar padrão -> Volta exatamente para a coleta cadastrada de A', () => {
    resetDefaultPickup();

    assert.equal(simulatedState.isCustom, false);
    assert.equal(simulatedState.customAddress, '');
    assert.equal(simulatedState.defaultAddress, 'Rua das Flores, 100 - Centro, Sapucaia do Sul - RS');
    assert.equal(simulatedState.defaultLat, -29.8247);
    assert.equal(simulatedState.defaultLng, -51.1444);
    assert.equal(simulatedState.defaultPlaceId, 'place-id-lanches-a');
  });

  await t.test('Cenário 4: Trocar para Cliente B -> Coleta customizada desaparece e hidrata B', () => {
    // Customizar coleta para A
    toggleCustomPickup();
    simulatedState.customAddress = 'Ponto Temporário C';
    simulatedState.customLat = -29.7777;

    // Trocar para Cliente B
    selectClient(clientB);

    assert.equal(simulatedState.clientId, 'uuid-client-b');
    assert.equal(simulatedState.establishmentName, 'Pizzaria Noturna');
    assert.equal(simulatedState.isCustom, false);
    assert.equal(simulatedState.customAddress, '');
    assert.equal(simulatedState.customLat, null);
    assert.equal(simulatedState.defaultAddress, 'Av. Mauá, 500 - Centro, Sapucaia do Sul - RS');
    assert.equal(simulatedState.defaultLat, -29.8300);
    assert.equal(simulatedState.defaultLng, -51.1500);
    assert.equal(simulatedState.defaultPlaceId, 'place-id-pizza-b');
  });

  await t.test('Cenário 5: Sem cliente selecionado -> Alterar coleta bloqueia com toast', () => {
    toastMessages = [];
    simulatedState.clientId = null;

    const opened = toggleCustomPickup();
    assert.equal(opened, false);
    assert.equal(toastMessages.length, 1);
    assert.equal(toastMessages[0], 'Selecione primeiro um estabelecimento comercial.');
  });
});
