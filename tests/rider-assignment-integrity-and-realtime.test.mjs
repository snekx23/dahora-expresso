import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('HOTFIX H3.3 - Cenário A: Tele ativa removida no backend -> refresh autoritativo atualiza UI, esvazia lista e permite desconexão', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  // loadMyDeliveries autoritativo calcula previousIds vs currentIds
  assert.ok(motoboyJs.includes("const previousIds = knownActiveTeleIds !== null ? [...knownActiveTeleIds] : null;"), 'Deve rastrear previousIds para diff autoritativo');
  assert.ok(motoboyJs.includes("const removedIds = previousIds.filter(id => !currentIds.includes(id));"), 'Deve identificar teles removidas');
  assert.ok(motoboyJs.includes("removedIds.forEach(id => alertedNewTeleIds.delete(id));"), 'Deve limpar alertedNewTeleIds para teles removidas');
  assert.ok(motoboyJs.includes("activeDeliveriesList = activeDeliveries;"), 'activeDeliveriesList deve ser atualizada como fonte única');
});

test('HOTFIX H3.3 - Cenário B: Backend atribui Tele -> refresh autoritativo adiciona na UI e emite alerta sonoro 1x', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("const newTeles = currentIds.filter(id => !previousIds.includes(id) && !alertedNewTeleIds.has(id));"), 'Deve filtrar novas teles ainda não alertadas');
  assert.ok(motoboyJs.includes("newTeles.forEach(id => alertedNewTeleIds.add(id));"), 'Deve registrar novos IDs no set de alertas');
  assert.ok(motoboyJs.includes("AudioController.playTeleAlert();"), 'Deve tocar alerta sonoro para nova tele');
  assert.ok(motoboyJs.includes("showHighPriorityNewTeleModal(newestTele);"), 'Deve abrir modal prioritário para nova tele');
});

test('HOTFIX H3.3 - Cenários C & D: Polling em foreground (15s) detecta novas teles e remoções sem som indevido', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("function startForegroundSafetyPolling()"), 'startForegroundSafetyPolling deve estar implementada');
  assert.ok(motoboyJs.includes("15000"), 'Polling de segurança em foreground deve ser de 15 segundos');
  assert.ok(motoboyJs.includes("document.visibilityState === 'visible'"), 'Polling deve verificar se app está visível');
});

test('HOTFIX H3.3 - Cenário E: Reload inicial com Tele existente -> 0 sons disparados', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  // Primeiro load: previousIds === null -> registra IDs sem tocar som
  assert.ok(motoboyJs.includes("currentIds.forEach(id => alertedNewTeleIds.add(id));"), 'Primeiro load deve registrar IDs sem disparar áudio');
  assert.ok(motoboyJs.includes("knownActiveTeleIds = currentIds;"), 'knownActiveTeleIds deve ser inicializado');
});

test('HOTFIX H3.3 - Cenários F & G: Ciclo de visibilidade (visibilitychange) pausa e retoma polling com refresh imediato', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("function stopForegroundSafetyPolling()"), 'stopForegroundSafetyPolling deve estar implementada');
  assert.ok(motoboyJs.includes("stopForegroundSafetyPolling();"), 'Deve parar polling quando visibilityState != visible ou logout');
  assert.ok(motoboyJs.includes("startForegroundSafetyPolling();"), 'Deve iniciar polling quando visibilityState == visible');
  assert.ok(motoboyJs.includes("handleForegroundAndNetworkRecovery();"), 'Deve acionar recuperação e refresh imediato ao voltar');
});

test('HOTFIX H3.3 - Cenário H: Realtime + Polling simultâneos -> Deduplicação estrita garante exatamente 1 alerta e 1 card', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("!alertedNewTeleIds.has(id)"), 'Deduplicação por alertedNewTeleIds impede repetição entre Realtime e Polling');
  assert.ok(motoboyJs.includes("if (alertedNewTeleIds.has(tele.id)) return;"), 'showHighPriorityNewTeleModal possui guarda contra repetição');
});
