import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

test('HOTFIX H3.4 - Áudios Oficiais Físicos: nova-tele.mp3 e tele-retirada.mp3 existem com tamanhos válidos', async () => {
  const novaTeleStat = await stat(new URL('../public/audio/nova-tele.mp3', import.meta.url));
  const teleRetiradaStat = await stat(new URL('../public/audio/tele-retirada.mp3', import.meta.url));

  assert.ok(novaTeleStat.isFile(), 'nova-tele.mp3 deve ser um arquivo físico');
  assert.strictEqual(novaTeleStat.size, 182521, 'nova-tele.mp3 deve ter exatamente 182521 bytes');

  assert.ok(teleRetiradaStat.isFile(), 'tele-retirada.mp3 deve ser um arquivo físico');
  assert.strictEqual(teleRetiradaStat.size, 42884, 'tele-retirada.mp3 deve ter exatamente 42884 bytes');
});

test('HOTFIX H3.4 - Cenários A, B & C: Polling em foreground a cada 5000ms com timer único e guarda de visibilidade', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('5000'), 'Intervalo do polling em foreground deve ser de 5000ms (5s)');
  assert.ok(motoboyJs.includes("document.visibilityState === 'visible'"), 'Polling deve verificar se app está visível');
  assert.ok(motoboyJs.includes('stopForegroundSafetyPolling()'), 'Deve limpar timer anterior garantindo no máximo 1 timer ativo');
  assert.ok(motoboyJs.includes('foregroundSafetyPollingInterval = null;'), 'Deve anular timer em stopForegroundSafetyPolling');
});

test('HOTFIX H3.4 - Cenário D: Proteção contra execuções concorrentes de loadMyDeliveries com fila pendente', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('let isDeliveriesLoading = false;'), 'Flag isDeliveriesLoading deve existir');
  assert.ok(motoboyJs.includes('let hasPendingDeliveriesRefresh = false;'), 'Flag hasPendingDeliveriesRefresh deve existir');
  assert.ok(motoboyJs.includes('if (isDeliveriesLoading) {'), 'Deve verificar se já existe leitura em andamento');
  assert.ok(motoboyJs.includes('hasPendingDeliveriesRefresh = true;'), 'Deve enfileirar refresh pendente se ocupado');
  assert.ok(motoboyJs.includes('if (hasPendingDeliveriesRefresh) {'), 'Deve reexecutar no bloco finally se houver refresh pendente');
});

test('HOTFIX H3.4 - Cenários E, F & G: Nova Tele via Realtime ou Polling toca nova-tele.mp3 exatamente 1x', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('AudioController.playNewTeleAlert()'), 'Deve invocar playNewTeleAlert() para nova tele');
  assert.ok(motoboyJs.includes("new Audio('/audio/nova-tele.mp3')"), 'AudioController deve instanciar nova-tele.mp3');
  assert.ok(motoboyJs.includes('!alertedNewTeleIds.has(id)'), 'Deduplicação estrita por alertedNewTeleIds deve impedir repetição');
});

test('HOTFIX H3.4 - Cenário H: Reload inicial com Tele pré-existente -> 0 sons disparados', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('currentIds.forEach(id => alertedNewTeleIds.add(id));'), 'Primeiro load deve registrar IDs sem acionar áudio');
});

test('HOTFIX H3.4 - Cenários I & J: Retirada administrativa toca tele-retirada.mp3 exatamente 1x', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('AudioController.playTeleRemovedAlert()'), 'Deve invocar playTeleRemovedAlert() na retirada administrativa');
  assert.ok(motoboyJs.includes("new Audio('/audio/tele-retirada.mp3')"), 'AudioController deve instanciar tele-retirada.mp3');
});

test('HOTFIX H3.4 - Cenário K: Conclusão normal pelo motoboy NÃO toca som de retirada', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('const locallyCompletedTeleIds = new Set();'), 'Deve rastrear teles concluídas localmente pelo motoboy');
  assert.ok(motoboyJs.includes('locallyCompletedTeleIds.add(tele.id);'), 'Ação complete deve registrar ID em locallyCompletedTeleIds');
  assert.ok(motoboyJs.includes('if (locallyCompletedTeleIds.has(id)) {'), 'Deve suprimir alerta sonoro de retirada para conclusão local');
});

test('HOTFIX H3.4 - Cenários L & M: Botões de teste direto no AudioController', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('testNewTeleSound()'), 'AudioController deve ter método testNewTeleSound()');
  assert.ok(motoboyJs.includes('testTeleRemovedSound()'), 'AudioController deve ter método testTeleRemovedSound()');
});

test('HOTFIX H3.4 - Cenários N & O: Preferências de Som persistidas e isolamento visual', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  const motoboyHtml = await readFile(new URL('../public/motoboy.html', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('dahora_rider_alert_preferences_v1'), 'Chave de armazenamento de preferências deve ser dahora_rider_alert_preferences_v1');
  assert.ok(motoboyJs.includes('getRiderAlertPreferences'), 'Função getRiderAlertPreferences deve estar implementada');
  assert.ok(motoboyJs.includes('saveRiderAlertPreferences'), 'Função saveRiderAlertPreferences deve estar implementada');
  assert.ok(motoboyHtml.includes('pwa-setting-sound-btn'), 'Botão de configuração de som deve existir na UI');
  assert.ok(motoboyHtml.includes('pwa-setting-vibration-btn'), 'Botão de configuração de vibração deve existir na UI');
  assert.ok(motoboyHtml.includes('btn-test-sound-new'), 'Botão de teste de nova tele deve existir na UI');
  assert.ok(motoboyHtml.includes('btn-test-sound-removed'), 'Botão de teste de tele retirada deve existir na UI');
});
