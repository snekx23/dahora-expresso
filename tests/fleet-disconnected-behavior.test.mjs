import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Mapa da Frota — Auditoria de Regras do Motoboy Desconectado e Reutilização de Marcadores', async (t) => {
  const appJsPath = path.resolve(process.cwd(), 'public/app.js');
  const appJs = fs.readFileSync(appJsPath, 'utf-8');

  await t.test('1. ownerFleetMarkers utiliza exclusivamente o UUID imutável rider.id / riderId como chave', () => {
    assert.ok(appJs.includes('ownerFleetMarkers[riderId]'), 'ownerFleetMarkers deve ser indexado por riderId');
    assert.ok(!appJs.includes('ownerFleetMarkers[rider.name]'), 'ownerFleetMarkers NÃO deve usar rider.name como chave');
    assert.ok(!appJs.includes('ownerFleetMarkers[rName]'), 'DELETE em Realtime NÃO deve usar rName como chave');
  });

  await t.test('2. renderMapMarkers filtra motoboys sem lat/lng válidos (impede posições fictícias)', () => {
    assert.ok(appJs.includes('validRiders = (mockData.fleet || []).filter'), 'renderMapMarkers deve filtrar entregadores com coordenadas válidas');
    assert.ok(!appJs.includes('centerCoords[0] + rider.offset[0]'), 'Não deve haver cálculo de posição fictícia com offsets para entregadores sem GPS');
  });

  await t.test('3. Status Indisponível / Em Descanso renderiza marcadores cinzas (#8e8e9f) e sem pulso', () => {
    assert.ok(appJs.includes("currentStatus === 'Indisponível' || currentStatus === 'Em Descanso'"), 'Deve verificar status Indisponível e Em Descanso');
    assert.ok(appJs.includes("currentStatusColor = '#8e8e9f'"), 'Cor cinza #8e8e9f deve ser atribuída a Indisponível/Em Descanso');
  });

  await t.test('4. Status Disponível / Ativo / Em Rota renderiza marcadores verdes (#22c55e) com pulso ativo', () => {
    assert.ok(appJs.includes("currentStatus === 'Disponível' || currentStatus === 'Ativo' || currentStatus === 'Em Rota'"), 'Deve verificar os status operacionais para verde');
    assert.ok(appJs.includes("currentStatusColor = '#22c55e'"), 'Cor verde #22c55e deve ser atribuída a status operacionais');
  });

  await t.test('5. openRiderMapPopup atribui a badge de status cinza para entregadores Indisponíveis ou em Descanso', () => {
    assert.ok(appJs.includes("const isUnavailableOrRest = currentStatus === 'Indisponível' || currentStatus === 'Em Descanso'"), 'openRiderMapPopup deve verificar isUnavailableOrRest');
  });

  await t.test('6. Reutilização de marcador sem duplicação ao reconectar (usa setLatLng e setContent)', () => {
    assert.ok(appJs.includes('markerEntry.setLatLng(riderLatLng)'), 'Marcador existente deve atualizar posição via setLatLng');
    assert.ok(appJs.includes('markerEntry.setContent(markerHtml)'), 'Marcador existente deve atualizar HTML via setContent ao transicionar cinza ↔ verde');
  });

  await t.test('7. Evento Realtime DELETE remove o marcador do mapa por riderId', () => {
    assert.ok(appJs.includes('ownerFleetMarkers[riderId].setMap(null)'), 'Realtime DELETE deve zerar o marcador por riderId');
    assert.ok(appJs.includes('delete ownerFleetMarkers[riderId]'), 'Realtime DELETE deve remover riderId do dicionário ownerFleetMarkers');
  });

  await t.test('8. Preserva lat/lng anteriores em UPDATEs parciais de Realtime se novo evento não trouxer coords válidas', () => {
    assert.ok(appJs.includes('isValidCoord(record.lat) ? record.lat : currentItem.lat'), 'Deve preservar lat anterior se record.lat for inválido');
    assert.ok(appJs.includes('isValidCoord(record.lng) ? record.lng : currentItem.lng'), 'Deve preservar lng anterior se record.lng for inválido');
  });
});
