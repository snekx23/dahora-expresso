import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Realtime Mapa da Frota — Auditoria de Código e Lógica de Atualização', async (t) => {
  const appJsPath = path.resolve(process.cwd(), 'public/app.js');
  const appJs = fs.readFileSync(appJsPath, 'utf-8');

  await t.test('1. CustomHTMLMapMarker possui método setContent para atualizar HTML do marcador', () => {
    assert.ok(appJs.includes('setContent(html)'), 'CustomHTMLMapMarker deve possuir o método setContent');
  });

  await t.test('2. renderMapMarkers invoca setContent ou atualiza div.innerHTML para marcadores existentes', () => {
    assert.ok(appJs.includes('markerEntry.setContent(markerHtml)'), 'renderMapMarkers deve chamar setContent para atualizar cor/pulso do marcador');
  });

  await t.test('3. handleRealtimeEvent para tabela fleet atualiza mockData.fleet e aciona renderMapMarkers', () => {
    assert.ok(appJs.includes("mockData.fleet.findIndex(r => String(r.id) === riderId)"), 'handleRealtimeEvent deve encontrar e atualizar o motoboy em mockData.fleet');
    assert.ok(appJs.includes("renderMapMarkers(ownerFleetCenterCoords)"), 'handleRealtimeEvent deve invocar renderMapMarkers se ownerFleetMap estiver ativo');
  });

  await t.test('4. Evento DELETE na tabela fleet remove do mapa e do dicionário ownerFleetMarkers', () => {
    assert.ok(appJs.includes("ownerFleetMarkers[rName].setMap(null)"), 'DELETE deve remover a bolinha do mapa com setMap(null)');
    assert.ok(appJs.includes("delete ownerFleetMarkers[rName]"), 'DELETE deve excluir o registro de ownerFleetMarkers');
  });

  await t.test('5. Troca de aba para owner-fleet-map garante chamada de initOperationsRealtimeChannel', () => {
    assert.ok(appJs.includes("initOperationsRealtimeChannel();"), 'switchDashboardTab deve garantir a inscrição no canal Realtime');
  });
});
