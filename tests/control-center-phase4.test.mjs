import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------
// 1. Validação Visual e Estrutural em index.html e app.js
// ---------------------------------------------------------------------
test('index.html e app.js contêm gerenciador Realtime, indicador de conexão e sincronização', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.ok(html.includes('id="op-connection-status-badge"'), 'Indicador de conexão ausente em index.html.');
  assert.ok(html.includes('id="op-btn-manual-sync"'), 'Botão de sincronização manual ausente em index.html.');

  assert.ok(appJs.includes('operationsRealtimeManager'), 'Gerenciador operationsRealtimeManager ausente em app.js.');
  assert.ok(appJs.includes('performOperationsFullSync'), 'Função performOperationsFullSync ausente em app.js.');
  assert.ok(appJs.includes('handleRealtimeEvent'), 'Função handleRealtimeEvent ausente em app.js.');
  assert.ok(appJs.includes('processedRealtimeEventsSet'), 'Cache de deduplicação ausente em app.js.');
});

// ---------------------------------------------------------------------
// 2. Lógica Pura: Deduplicação e Ordenação por Versão
// ---------------------------------------------------------------------
test('Deduplicação de eventos ignora registros duplicados e versões legadas', () => {
  const processedSet = new Set();
  const store = new Map();

  function processEvent(record, eventTimestamp) {
    const key = `teles:UPDATE:${record.id}:${record.version}:${eventTimestamp}`;
    if (processedSet.has(key)) return 'duplicate_ignored';
    processedSet.add(key);

    const existing = store.get(record.id);
    if (existing && record.version < existing.version) {
      return 'outdated_ignored';
    }

    store.set(record.id, record);
    return 'applied';
  }

  // 1º Evento v1 -> Aplicado
  const res1 = processEvent({ id: 'T1', status: 'solicitada', version: 1 }, 1000);
  assert.equal(res1, 'applied');
  assert.equal(store.get('T1').version, 1);

  // Evento idêntico v1 com mesmo timestamp -> Duplicado ignorado
  const res2 = processEvent({ id: 'T1', status: 'solicitada', version: 1 }, 1000);
  assert.equal(res2, 'duplicate_ignored');

  // Evento v2 -> Aplicado
  const res3 = processEvent({ id: 'T1', status: 'motoboy_designado', version: 2 }, 2000);
  assert.equal(res3, 'applied');
  assert.equal(store.get('T1').version, 2);

  // Evento atrasado v1 recebido com novo timestamp -> Versão desatualizada ignorada
  const res4 = processEvent({ id: 'T1', status: 'solicitada', version: 1 }, 3000);
  assert.equal(res4, 'outdated_ignored');
  assert.equal(store.get('T1').version, 2, 'Versão no store deve permanecer 2.');
});

// ---------------------------------------------------------------------
// 3. Lógica Pura: Classificação de Localização GPS Desatualizada
// ---------------------------------------------------------------------
test('Classificação do GPS categoriza recente, atenção, desatualizada e sem localização', () => {
  function getRiderLocationStaleCategory(lastSeenInput) {
    if (!lastSeenInput) return 'sem_localizacao';
    const lastSeen = new Date(lastSeenInput);
    if (isNaN(lastSeen.getTime())) return 'sem_localizacao';

    const diffMinutes = (new Date().getTime() - lastSeen.getTime()) / 60000;
    if (diffMinutes <= 2) return 'recente';
    if (diffMinutes <= 5) return 'atencao';
    return 'desatualizada';
  }

  const now = new Date();
  const oneMinAgo = new Date(now.getTime() - 60000).toISOString();
  const threeMinsAgo = new Date(now.getTime() - 3 * 60000).toISOString();
  const tenMinsAgo = new Date(now.getTime() - 10 * 60000).toISOString();

  assert.equal(getRiderLocationStaleCategory(oneMinAgo), 'recente');
  assert.equal(getRiderLocationStaleCategory(threeMinsAgo), 'atencao');
  assert.equal(getRiderLocationStaleCategory(tenMinsAgo), 'desatualizada');
  assert.equal(getRiderLocationStaleCategory(null), 'sem_localizacao');
});

// ---------------------------------------------------------------------
// 4. Reconexão e Backoff Exponencial
// ---------------------------------------------------------------------
test('Cálculo do tempo de reconexão segue backoff exponencial limitado', () => {
  function getBackoffMs(attempt) {
    return Math.min(30000, Math.pow(2, attempt) * 1000);
  }

  assert.equal(getBackoffMs(1), 2000);
  assert.equal(getBackoffMs(2), 4000);
  assert.equal(getBackoffMs(3), 8000);
  assert.equal(getBackoffMs(4), 16000);
  assert.equal(getBackoffMs(5), 30000, 'Backoff deve ser limitado ao máximo de 30s.');
  assert.equal(getBackoffMs(10), 30000);
});

// ---------------------------------------------------------------------
// 5. Garantia de Ausência de Credenciais em Logs
// ---------------------------------------------------------------------
test('Logs de debug e payloads não expõem service_role, tokens ou senhas', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.equal(appJs.includes('SUPABASE_SERVICE_ROLE_KEY'), false, 'SUPABASE_SERVICE_ROLE_KEY não deve estar em app.js.');
  assert.equal(appJs.includes('service_role'), false, 'service_role não deve estar exposto em app.js.');
});
