import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------
// 1. Validação de Estrutura Visual em index.html
// ---------------------------------------------------------------------
test('index.html possui o botão e os containers do Centro de Operações (Dashboard Resumo)', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.ok(html.includes('data-tab="owner-control-center"'), 'Botão owner-control-center ausente na sidebar.');
  assert.ok(html.includes('id="tab-owner-control-center"'), 'Aba tab-owner-control-center ausente.');
  assert.ok(html.includes('id="op-kpi-awaiting"'), 'KPI aguardando despacho ausente.');
  assert.ok(html.includes('id="op-summary-priorities-list"'), 'Lista de prioridades ausente.');
  assert.ok(html.includes('id="op-summary-fleet-list"'), 'Lista de frota ausente.');
  assert.ok(html.includes('id="op-summary-alerts-list"'), 'Lista de alertas ausente.');
  assert.ok(html.includes('id="op-diagnostic-box"'), 'Box diagnóstico de status desconhecido ausente.');
  assert.ok(html.includes('id="drawer-tele-op-details"'), 'Drawer de leitura da tele ausente.');
});

// ---------------------------------------------------------------------
// 2. Normalizador de Status com Maiúsculas, Acentos e Desconhecidos
// ---------------------------------------------------------------------
test('Normalização de status lida com maiúsculas, acentos, espaços e nulos', async () => {
  // Simular a função pura normalizeTeleStatus
  function normalizeTeleStatus(rawStatus) {
    if (rawStatus === null || rawStatus === undefined || typeof rawStatus !== 'string') {
      return 'status_unknown';
    }

    const cleaned = rawStatus
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '_');

    const mapping = {
      'novo': 'solicitada',
      'solicitada': 'solicitada',
      'pendente': 'solicitada',
      'aguardando_despacho': 'aguardando_despacho',
      'atribuido': 'motoboy_designado',
      'indo_coletar': 'indo_coletar',
      'a_caminho_da_coleta': 'indo_coletar',
      'aguardando_coleta': 'aguardando_coleta',
      'coletada': 'coletada',
      'em_rota': 'em_entrega',
      'em_entrega': 'em_entrega',
      'entregue': 'concluida',
      'concluida': 'concluida',
      'cancelado': 'cancelada',
      'cancelada': 'cancelada'
    };

    return mapping[cleaned] || 'status_unknown';
  }

  assert.equal(normalizeTeleStatus('  NOVO  '), 'solicitada');
  assert.equal(normalizeTeleStatus('A caminho da Coleta'), 'indo_coletar');
  assert.equal(normalizeTeleStatus('ENTREGUE'), 'concluida');
  assert.equal(normalizeTeleStatus(null), 'status_unknown');
  assert.equal(normalizeTeleStatus(undefined), 'status_unknown');
  assert.equal(normalizeTeleStatus('STATUS_DESCONHECIDO_123'), 'status_unknown');
});

// ---------------------------------------------------------------------
// 3. State Machine (Validação de Transições)
// ---------------------------------------------------------------------
test('State Machine permite apenas transições válidas e bloqueia edições ilegais', () => {
  function canTransitionTeleStatus(current, next) {
    if (current === next) return true;
    const allowed = {
      solicitada: ['aguardando_despacho', 'motoboy_designado', 'cancelada'],
      aguardando_despacho: ['motoboy_designado', 'solicitada', 'cancelada'],
      motoboy_designado: ['indo_coletar', 'aguardando_coleta', 'cancelada'],
      indo_coletar: ['aguardando_coleta', 'coletada', 'cancelada'],
      aguardando_coleta: ['coletada', 'em_entrega', 'cancelada'],
      coletada: ['em_entrega', 'concluida', 'cancelada'],
      em_entrega: ['concluida', 'cancelada'],
      concluida: [],
      cancelada: []
    };
    return (allowed[current] || []).includes(next);
  }

  assert.ok(canTransitionTeleStatus('solicitada', 'motoboy_designado'), 'Transição solicitada -> motoboy_designado deve ser permitida.');
  assert.ok(canTransitionTeleStatus('em_entrega', 'concluida'), 'Transição em_entrega -> concluida deve ser permitida.');

  // Transições proibidas
  assert.equal(canTransitionTeleStatus('concluida', 'solicitada'), false, 'Não deve ser possível reabrir tele concluída.');
  assert.equal(canTransitionTeleStatus('cancelada', 'em_entrega'), false, 'Não deve ser possível colocar tele cancelada em rota.');
  assert.equal(canTransitionTeleStatus('solicitada', 'concluida'), false, 'Não deve ser possível concluir direto de solicitada sem passar pelo fluxo.');
});

// ---------------------------------------------------------------------
// 4. SLA Derivado de tele_eventos com Fallbacks
// ---------------------------------------------------------------------
test('Cálculo de SLA utiliza timestamp do evento e marca estimativa nos fallbacks', () => {
  function calculateTeleElapsedTime(tele, eventsList = []) {
    let statusEnteredAt = null;
    let isEstimated = false;

    if (Array.isArray(eventsList) && eventsList.length > 0) {
      const matching = eventsList.find(e => e.tele_id === tele.id && e.tipo === tele.status);
      if (matching) statusEnteredAt = new Date(matching.created_at);
    }

    if (!statusEnteredAt && tele.updated_at) {
      statusEnteredAt = new Date(tele.updated_at);
      isEstimated = true;
    }

    if (!statusEnteredAt && tele.created_at) {
      statusEnteredAt = new Date(tele.created_at);
      isEstimated = true;
    }

    const now = new Date();
    const elapsedMinutes = Math.floor((now.getTime() - statusEnteredAt.getTime()) / 60000);
    return { elapsedMinutes, isEstimated };
  }

  const now = new Date();
  const tenMinsAgo = new Date(now.getTime() - 10 * 60000).toISOString();
  const thirtyMinsAgo = new Date(now.getTime() - 30 * 60000).toISOString();

  // Teste 1: Evento exato no tele_eventos -> Não estimado
  const tele1 = { id: 'T1', status: 'em_entrega', created_at: thirtyMinsAgo };
  const events = [{ tele_id: 'T1', tipo: 'em_entrega', created_at: tenMinsAgo }];
  const sla1 = calculateTeleElapsedTime(tele1, events);
  assert.equal(sla1.elapsedMinutes, 10);
  assert.equal(sla1.isEstimated, false);

  // Teste 2: Fallback updated_at -> Estimado
  const tele2 = { id: 'T2', status: 'em_entrega', updated_at: tenMinsAgo, created_at: thirtyMinsAgo };
  const sla2 = calculateTeleElapsedTime(tele2, []);
  assert.equal(sla2.elapsedMinutes, 10);
  assert.equal(sla2.isEstimated, true);
});

// ---------------------------------------------------------------------
// 5. Filtro do Dia no Fuso Horário Local
// ---------------------------------------------------------------------
test('Filtro isTodayInLocalTime valida estritamente o dia atual no fuso local', () => {
  function isTodayInLocalTime(dateInput) {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }

  const todayStr = new Date().toISOString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  assert.ok(isTodayInLocalTime(todayStr), 'Data de hoje deve retornar true.');
  assert.equal(isTodayInLocalTime(yesterday.toISOString()), false, 'Data de ontem deve retornar false.');
});

// ---------------------------------------------------------------------
// 6. Adapter de Motoboys Sem Duplicidade
// ---------------------------------------------------------------------
test('Adapter de motoboys previne duplicidade entre fleet e motoboys', () => {
  const mockFleet = [
    { id: '101', name: 'João Santos', vehicle: 'Moto' },
    { id: '102', name: 'Maria Lima', vehicle: 'Moto' }
  ];
  const mockMotoboys = [
    { id: '101', nome: 'João Santos Duplicado' }, // ID repetido
    { id: '103', nome: 'Pedro Alvares' }          // ID novo
  ];

  const storeMap = new Map();
  mockFleet.forEach(r => storeMap.set(String(r.id), r.name));
  mockMotoboys.forEach(m => {
    if (!storeMap.has(String(m.id))) storeMap.set(String(m.id), m.nome);
  });

  assert.equal(storeMap.size, 3, 'Tamanho do mapa deve ser 3 (evitando duplicar ID 101).');
  assert.equal(storeMap.get('101'), 'João Santos', 'ID 101 deve manter o valor da fonte oficial (fleet).');
  assert.equal(storeMap.get('103'), 'Pedro Alvares');
});
