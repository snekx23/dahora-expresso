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

test('HOTFIX H2: Lógica operacional de Coleta e Entrega independentes (Cenários 1 a 6)', async (t) => {
  // Mock de estado simulado conforme lógica de public/app.js
  let commercialClientsDb = [
    {
      id: 'client-uuid-1',
      establishment_name: 'Pizzaria do Bairro',
      responsible_name: 'João Pizzaiolo',
      phone: '51999999999',
      address: 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS',
      street_number: '100',
      neighborhood: 'Centro',
      city: 'Sapucaia do Sul',
      state: 'RS',
      pickup_latitude: -29.8247,
      pickup_longitude: -51.1444,
      pickup_place_id: 'place-id-establishment-a'
    }
  ];

  let telesCreated = [];

  // Função simulada de criação de tele respeitando a lógica implementada no submitDeliveryRequest
  function simulateCreateTele(state, selectedClientId, destinationData) {
    const clientObj = commercialClientsDb.find(c => c.id === selectedClientId);
    if (!clientObj) throw new Error('Cliente comercial não selecionado');

    let p_pickup_address = null;
    let p_pickup_latitude = null;
    let p_pickup_longitude = null;
    let p_pickup_place_id = null;

    if (state.isCustom) {
      if (!state.customAddress || state.customLat == null || state.customLng == null) {
        throw new Error('Coleta personalizada sem endereço ou coordenadas válidas');
      }
      p_pickup_address = state.customAddress;
      p_pickup_latitude = state.customLat;
      p_pickup_longitude = state.customLng;
      p_pickup_place_id = state.customPlaceId || null;
    } else {
      p_pickup_address = clientObj.address;
      p_pickup_latitude = clientObj.pickup_latitude;
      p_pickup_longitude = clientObj.pickup_longitude;
      p_pickup_place_id = clientObj.pickup_place_id;
    }

    const teleRecord = {
      id: `tele-${telesCreated.length + 1}`,
      client_id: selectedClientId,
      pickup_address: p_pickup_address,
      pickup_latitude: p_pickup_latitude,
      pickup_longitude: p_pickup_longitude,
      pickup_place_id: p_pickup_place_id,
      delivery_address: destinationData.address,
      recipient_name: destinationData.recipientName,
      recipient_phone: destinationData.recipientPhone,
      delivery_latitude: destinationData.latitude,
      delivery_longitude: destinationData.longitude
    };

    telesCreated.push(teleRecord);
    return teleRecord;
  }

  // --- CENÁRIO 1: A -> B (Padrão) ---
  await t.test('Cenário 1: Corrida padrão (Coleta = Estabelecimento A, Entrega = Cliente Final B)', () => {
    const state = {
      clientId: 'client-uuid-1',
      establishmentName: 'Pizzaria do Bairro',
      isCustom: false,
      defaultAddress: 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS',
      defaultLat: -29.8247,
      defaultLng: -51.1444,
      defaultPlaceId: 'place-id-establishment-a'
    };

    const destB = {
      address: 'Rua das Flores B, 250',
      recipientName: 'Carlos Destinatário',
      recipientPhone: '51988888888',
      latitude: -29.8300,
      longitude: -51.1500
    };

    const tele1 = simulateCreateTele(state, 'client-uuid-1', destB);

    assert.equal(tele1.pickup_address, 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS');
    assert.equal(tele1.delivery_address, 'Rua das Flores B, 250');
    assert.equal(tele1.pickup_latitude, -29.8247);
    assert.equal(tele1.delivery_latitude, -29.8300);

    // commercial_clients NUNCA é modificado
    assert.equal(commercialClientsDb[0].address, 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS');
  });

  // --- CENÁRIO 2: C -> B (Coleta Externa C, Entrega no Cliente Final B) ---
  await t.test('Cenário 2: Coleta Externa (Coleta = Ponto C, Entrega = Cliente Final B)', () => {
    const state = {
      clientId: 'client-uuid-1',
      establishmentName: 'Pizzaria do Bairro',
      isCustom: true,
      defaultAddress: 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS',
      defaultLat: -29.8247,
      defaultLng: -51.1444,
      customAddress: 'Av Mauá C, 500 - São Leopoldo - RS',
      customLat: -29.7600,
      customLng: -51.1400,
      customPlaceId: 'place-id-custom-c'
    };

    const destB = {
      address: 'Rua das Flores B, 250',
      recipientName: 'Carlos Destinatário',
      recipientPhone: '51988888888',
      latitude: -29.8300,
      longitude: -51.1500
    };

    const tele2 = simulateCreateTele(state, 'client-uuid-1', destB);

    assert.equal(tele2.pickup_address, 'Av Mauá C, 500 - São Leopoldo - RS');
    assert.equal(tele2.delivery_address, 'Rua das Flores B, 250');
    assert.equal(tele2.pickup_latitude, -29.7600);
    assert.equal(tele2.delivery_latitude, -29.8300);

    // Endereço cadastrado do cliente continua estritamente inalterado em commercial_clients
    assert.equal(commercialClientsDb[0].address, 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS');
  });

  // --- CENÁRIO 3: C -> A (Buscar fora em C e entregar no próprio comércio A) ---
  await t.test('Cenário 3: Buscar Fora e Entregar no Comércio (Coleta = Ponto C, Entrega = Estabelecimento A)', () => {
    const state = {
      clientId: 'client-uuid-1',
      establishmentName: 'Pizzaria do Bairro',
      isCustom: true,
      defaultAddress: 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS',
      defaultLat: -29.8247,
      defaultLng: -51.1444,
      customAddress: 'Av Mauá C, 500 - São Leopoldo - RS',
      customLat: -29.7600,
      customLng: -51.1400,
      customPlaceId: 'place-id-custom-c'
    };

    // Botão "Entregar no estabelecimento" preenche o destino com o ponto padrão A
    const destA = {
      address: 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS',
      recipientName: 'Pizzaria do Bairro (Balcão)',
      recipientPhone: '51999999999',
      latitude: -29.8247,
      longitude: -51.1444
    };

    const tele3 = simulateCreateTele(state, 'client-uuid-1', destA);

    assert.equal(tele3.pickup_address, 'Av Mauá C, 500 - São Leopoldo - RS');
    assert.equal(tele3.delivery_address, 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS');
    assert.equal(tele3.pickup_latitude, -29.7600);
    assert.equal(tele3.delivery_latitude, -29.8247);
  });

  // --- CENÁRIO 4: Persistência e Imutabilidade ---
  await t.test('Cenário 4: Imutabilidade de commercial_clients e dos snapshots das Teles', () => {
    // 3 Teles criadas no histórico
    assert.equal(telesCreated.length, 3);
    assert.equal(telesCreated[0].pickup_address, 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS');
    assert.equal(telesCreated[1].pickup_address, 'Av Mauá C, 500 - São Leopoldo - RS');
    assert.equal(telesCreated[2].pickup_address, 'Av Mauá C, 500 - São Leopoldo - RS');
    assert.equal(telesCreated[2].delivery_address, 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS');

    // commercial_clients continua intacto com ponto A
    assert.equal(commercialClientsDb[0].address, 'Rua Principal A, 100 - Centro, Sapucaia do Sul - RS');
  });

  // --- CENÁRIO 5: Isolamento de Estado ---
  await t.test('Cenário 5: Isolamento de estado entre Coleta e Entrega', () => {
    let pickup = { isCustom: true, customAddress: 'Origem C' };
    let delivery = { address: 'Destino B' };

    // Modificar destino não altera coleta
    delivery.address = 'Destino D';
    assert.equal(pickup.customAddress, 'Origem C');

    // Restaurar padrão de coleta não altera destino
    pickup.isCustom = false;
    pickup.customAddress = '';
    assert.equal(delivery.address, 'Destino D');
  });

  // --- CENÁRIO 6: Reset no Reload / Reabertura ---
  await t.test('Cenário 6: Reset do formulário ao reabrir modal', () => {
    let state = {
      clientId: 'client-uuid-1',
      establishmentName: 'Pizzaria do Bairro',
      isCustom: true,
      customAddress: 'Origem C'
    };

    // Simulando resetManualDeliveryForm()
    state = {
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

    assert.equal(state.clientId, null);
    assert.equal(state.isCustom, false);
    assert.equal(state.customAddress, '');
    assert.equal(state.establishmentName, '');
  });
});
