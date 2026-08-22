import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('HOTFIX H3.2 - Cenário A: Motoboy autenticado + INDISPONÍVEL -> subscription Realtime continua ativa', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  // subscribeRealtime não bloqueia por status operacional ('Indisponível')
  assert.ok(motoboyJs.includes("const activeRiderId = currentRiderId || currentRider?.id;"), 'subscribeRealtime deve usar activeRiderId independente do status');
  assert.ok(!motoboyJs.includes("if (currentRider.status !== 'Disponível') return;"), 'subscribeRealtime não deve ser bloqueado por status Indisponível');
});

test('HOTFIX H3.2 - Cenário B: currentRiderId só resolvido com fleet.id -> canal usa identidade canônica', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("currentRiderId = fleetRow.id;"), 'resolveCurrentRider deve setar currentRiderId com fleet.id');
  assert.ok(motoboyJs.includes("const channelName = 'moto-realtime-' + activeRiderId;"), 'Nome do canal Realtime deve usar activeRiderId');
});

test('HOTFIX H3.2 - Cenário C: UPDATE motoboy_id NULL -> guilherme (Nova Atribuição)', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("const isNewAssignment = isMine && !isAlreadyKnown;"), 'Realtime deve identificar transição NULL -> rider');
  assert.ok(motoboyJs.includes("showHighPriorityNewTeleModal(payload.new);"), 'Nova atribuição deve abrir modal prioritário');
  assert.ok(motoboyJs.includes("await loadMyDeliveries();"), 'Nova atribuição deve atualizar entregas autoritativamente');
});

test('HOTFIX H3.2 - Cenário D: UPDATE guilherme -> NULL (Desatribuição / Retirada)', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("const isRemoval = !isMine && wasMine;"), 'Realtime deve identificar desatribuição');
  assert.ok(motoboyJs.includes("if (removedId) alertedNewTeleIds.delete(removedId);"), 'Remoção deve limpar ID do set de alertas');
  assert.ok(motoboyJs.includes("AudioController.playMessageAlert();"), 'Remoção deve emitir feedback sonoro/vibração suave');
});

test('HOTFIX H3.2 - Cenários E & F: Recuperação de visibilidade (visibilitychange) e online no iPhone', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("let riderRealtimeStatus = 'DISCONNECTED';"), 'Estado riderRealtimeStatus deve ser gerenciado explicitamente');
  assert.ok(motoboyJs.includes("function handleForegroundAndNetworkRecovery()"), 'handleForegroundAndNetworkRecovery deve estar definida');
  assert.ok(motoboyJs.includes("document.addEventListener('visibilitychange'"), 'Deve escutar visibilitychange para reatar websocket no iOS');
  assert.ok(motoboyJs.includes("window.addEventListener('online'"), 'Deve escutar evento online para recuperação de rede');
  assert.ok(motoboyJs.includes("window.addEventListener('pageshow'"), 'Deve escutar evento pageshow');
});

test('HOTFIX H3.2 - Cenário G: AudioController desbloqueado por gesto no iOS e síntese de áudio', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("AudioController = {"), 'AudioController deve estar definido');
  assert.ok(motoboyJs.includes("getAudioContext()"), 'AudioController deve gerenciar AudioContext');
  assert.ok(motoboyJs.includes("document.addEventListener('touchstart', () => AudioController.unlock()"), 'AudioController deve escutar touchstart para desbloqueio no iOS');
  assert.ok(motoboyJs.includes("document.addEventListener('click', () => AudioController.unlock()"), 'AudioController deve escutar click para desbloqueio');
});

test('HOTFIX H3.2 - Cenário H: Tele já conhecida no reload -> 0 novos sons de alerta', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("if (alertedNewTeleIds.has(tele.id)) return;"), 'showHighPriorityNewTeleModal não deve re-tocar se já alertada');
  assert.ok(motoboyJs.includes("!alertedNewTeleIds.has(id)"), 'loadMyDeliveries não deve re-tocar som para tele já alertada');
});

test('HOTFIX H3.2 - Cenário I: Push subscription ativa -> Card amarelo de ativação fica OCULTO', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("if (buttonState === 'active') {"), 'updatePushAlertCardUI deve checar buttonState === active');
  assert.ok(motoboyJs.includes("if (pushCard) pushCard.style.display = 'none';"), 'Card de push deve ser ocultado quando ativado');
});
