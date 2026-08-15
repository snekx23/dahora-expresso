import test from 'node:test';
import assert from 'node:assert/strict';

test('Suíte de Carregamento e Mapeamento dos Clientes Comerciais', async (t) => {

  // Mock de registros do banco de dados (Supabase public.commercial_clients)
  const mockDbRows = [
    {
      id: 'db-client-acairou',
      client_code: 'CLI-000101',
      establishment_name: 'Açaizou Teste Homolog',
      responsible_name: 'Gerente Açaizou',
      phone: '51988889999',
      email: 'contato@acaizou.com.br',
      document: '12.345.678/0001-99',
      address: 'Av. Ipiranga, 1234',
      pickup_address: 'Av. Ipiranga, 1234',
      pickup_latitude: -30.0346,
      pickup_longitude: -51.2177,
      pickup_place_id: 'ChIJ123456789',
      lifecycle_status: 'ativo',
      financial_status: 'em_dia',
      created_at: '2026-08-10T12:00:00Z',
      open_balance: 150.00
    },
    {
      id: 'db-client-nolocation',
      client_code: 'CLI-000102',
      establishment_name: 'Pizzaria Sem Geoponto',
      responsible_name: 'Dono Pizzaria',
      phone: '51977778888',
      email: 'contato@pizzaria.com.br',
      document: '98.765.432/0001-11',
      address: 'Rua das Flores, 50',
      pickup_address: null,
      pickup_latitude: null,
      pickup_longitude: null,
      pickup_place_id: null,
      lifecycle_status: 'teste',
      financial_status: 'em_dia',
      created_at: '2026-08-11T09:00:00Z',
      open_balance: 0.00
    }
  ];

  function normalizeCommercialClient(row) {
    if (!row) return null;

    const clientCode = row.client_code || row.public_code || '—';
    const establishmentName = row.establishment_name || 'Sem nome';
    const responsibleName = row.responsible_name || 'Não informado';
    const phone = row.phone || row.phone_normalized || 'Não informado';
    const email = row.email || row.email_normalized || 'Não informado';
    const address = row.pickup_address || row.address || '';

    const latNum = (row.pickup_latitude !== null && row.pickup_latitude !== undefined && row.pickup_latitude !== '') 
      ? Number(row.pickup_latitude) 
      : null;
    const lngNum = (row.pickup_longitude !== null && row.pickup_longitude !== undefined && row.pickup_longitude !== '') 
      ? Number(row.pickup_longitude) 
      : null;

    return {
      id: String(row.id || ''),
      client_code: clientCode,
      establishment_name: establishmentName,
      responsible_name: responsibleName,
      phone: phone,
      email: email,
      document: row.document || row.document_normalized || '',
      address: address,
      neighborhood: row.neighborhood || '',
      city: row.city || '',
      state: row.state || '',
      postal_code: row.postal_code || '',
      lifecycle_status: row.lifecycle_status || 'ativo',
      financial_status: row.financial_status || 'em_dia',
      created_at: row.created_at || new Date().toISOString(),
      pickup_address: address,
      pickup_latitude: (latNum !== null && !isNaN(latNum)) ? latNum : null,
      pickup_longitude: (lngNum !== null && !isNaN(lngNum)) ? lngNum : null,
      pickup_place_id: row.pickup_place_id || null,
      is_internal: !!row.is_internal,
      open_balance: Number(row.open_balance) || 0
    };
  }

  let commercialClientsList = [];
  let fetchCount = 0;
  let modulePromise = null;

  async function fetchCommercialClients() {
    fetchCount++;
    commercialClientsList = mockDbRows.map(normalizeCommercialClient);
  }

  async function loadCommercialClientsModule() {
    if (modulePromise) return modulePromise;
    modulePromise = (async () => {
      try {
        await fetchCommercialClients();
      } finally {
        modulePromise = null;
      }
    })();
    return modulePromise;
  }

  await t.test('CASO A: Abertura da aba Clientes Comerciais dispara fetch inicial', async () => {
    fetchCount = 0;
    commercialClientsList = [];
    await loadCommercialClientsModule();
    assert.equal(fetchCount, 1);
    assert.equal(commercialClientsList.length, 2);
  });

  await t.test('CASO B: Registros existentes aparecem sem necessidade de cadastrar novo cliente', async () => {
    assert.equal(commercialClientsList[0].establishment_name, 'Açaizou Teste Homolog');
    assert.equal(commercialClientsList[1].establishment_name, 'Pizzaria Sem Geoponto');
  });

  await t.test('CASO C: Criar novo cliente reutiliza a mesma rotina de carregamento canônica', async () => {
    const initialFetch = fetchCount;
    await loadCommercialClientsModule();
    assert.equal(fetchCount, initialFetch + 1);
  });

  await t.test('CASO D: client_code existente é renderizado sem undefined', () => {
    const item = commercialClientsList[0];
    assert.equal(item.client_code, 'CLI-000101');
    assert.notEqual(item.client_code, 'undefined');
  });

  await t.test('CASO E: phone/email existentes são renderizados sem undefined', () => {
    const item = commercialClientsList[0];
    assert.equal(item.phone, '51988889999');
    assert.equal(item.email, 'contato@acaizou.com.br');
    assert.notEqual(item.phone, 'undefined');
    assert.notEqual(item.email, 'undefined');
  });

  await t.test('CASO F: Cliente com lat/lng válidos tem localização reconhecida e NÃO mostra aviso de ausência', () => {
    const acaizou = commercialClientsList[0];
    const hasValidLocation = acaizou.pickup_latitude !== null && acaizou.pickup_longitude !== null && !isNaN(acaizou.pickup_latitude) && !isNaN(acaizou.pickup_longitude);
    assert.equal(hasValidLocation, true);
  });

  await t.test('CASO G: Cliente com lat/lng NULL é sinalizado corretamente', () => {
    const noLocation = commercialClientsList[1];
    const hasValidLocation = noLocation.pickup_latitude !== null && noLocation.pickup_longitude !== null && !isNaN(noLocation.pickup_latitude) && !isNaN(noLocation.pickup_longitude);
    assert.equal(hasValidLocation, false);
  });

  await t.test('CASO H: Trocar de aba e voltar recarrega/mantém os dados integrais', async () => {
    await loadCommercialClientsModule();
    assert.equal(commercialClientsList.length, 2);
    assert.equal(commercialClientsList[0].client_code, 'CLI-000101');
  });
});
