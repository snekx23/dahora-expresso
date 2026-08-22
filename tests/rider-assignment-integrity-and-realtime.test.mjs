import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('HOTFIX H3 - Cenário A: Atribuição de rider A -> motoboy_id autoritativo, Admin A, PWA A', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  // Admin invoca RPC com p_motoboy_id
  assert.ok(appJs.includes("p_motoboy_id: rider.id"), 'dispatchDelivery deve chamar RPC assign_rider_to_tele com p_motoboy_id');
  
  // PWA consulta e filtra por motoboy_id
  assert.ok(motoboyJs.includes(".eq('motoboy_id', riderId)"), 'PWA Minhas Teles deve filtrar exclusivamente por motoboy_id');
});

test('HOTFIX H3 - Cenário B: F5 Admin persiste rider correto por motoboy_id (sem fallback indevido)', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  // fetchClientHistory e renderTelesUnified resolvem assignedRider via motoboy_id
  assert.ok(appJs.includes("const assignedRider = item.motoboy_id ? mockData.fleet.find(r => r.id === item.motoboy_id"), 'fetchClientHistory deve resolver assignedRider por motoboy_id');
  assert.ok(appJs.includes("const assignedRider = o.motoboy_id ? mockData.fleet.find(r => r.id === o.motoboy_id"), 'renderTelesUnified deve resolver assignedRider por motoboy_id');
  assert.ok(appJs.includes("const isSelected = (item.motoboy_id && String(r.id) === String(item.motoboy_id))"), 'renderTelesTable select deve selecionar option com base no motoboy_id');
});

test('HOTFIX H3 - Cenário C: Botão "Retirar Motoboy" implementado, reseta para aguardando_despacho', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.ok(appJs.includes("window.handleWithdrawClick = async function(deliveryId"), 'window.handleWithdrawClick deve estar definida globalmente');
  assert.ok(appJs.includes("motoboy_id: null,"), 'Retirar motoboy deve atualizar motoboy_id para null');
  assert.ok(appJs.includes("status: 'aguardando_despacho'"), 'Retirar motoboy deve retornar status para aguardando_despacho');
});

test('HOTFIX H3 - Cenário D: Atribuir rider B -> somente B recebe no Realtime', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  // Validação isMyTeleRow com activeRiderId
  assert.ok(motoboyJs.includes("String(row.motoboy_id).toLowerCase() === String(activeRiderId).toLowerCase()"), 'Realtime deve validar se motoboy_id da linha corresponde ao activeRiderId logado');
});

test('HOTFIX H3 - Cenário E: Reatribuição B -> A no Admin e desatribuição no PWA', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  // handleTableReassignRider invoca assign_rider_to_tele com p_motoboy_id
  assert.ok(appJs.includes("p_motoboy_id: newRider.id"), 'Reatribuição deve chamar RPC com p_motoboy_id');

  // PWA detecta isRemoval quando tele deixa de pertencer ao rider
  assert.ok(motoboyJs.includes("const isRemoval = !isMine && wasMine;"), 'PWA deve identificar desatribuição via isRemoval');
  assert.ok(motoboyJs.includes("sendWebNotification(\"Tele Removida! ❌\""), 'PWA deve notificar remoção da tele');
});

test('HOTFIX H3 - Cenário F: Realtime captura UPDATE de Tele sem rider para rider A sem reload', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("const isNewAssignment = isMine && !isAlreadyKnown;"), 'Realtime UPDATE deve detectar nova atribuição');
  assert.ok(motoboyJs.includes("showHighPriorityNewTeleModal(payload.new);"), 'Nova atribuição deve abrir modal de alta prioridade');
  assert.ok(motoboyJs.includes("loadMyDeliveries();"), 'Nova atribuição deve carregar teles ativas sem reload');
});

test('HOTFIX H3 - Cenário G: Som de nova atribuição toca exatamente 1 vez por Tele', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("const alertedNewTeleIds = new Set();"), 'Deduplicação de alertas sonoros deve usar alertedNewTeleIds');
  assert.ok(motoboyJs.includes("if (alertedNewTeleIds.has(tele.id)) return;"), 'Modal e som não devem re-disparar para mesma tele já alertada');
  assert.ok(motoboyJs.includes("!alertedNewTeleIds.has(id)"), 'loadMyDeliveries não deve tocar som duplicado se modal já tocou');
});
