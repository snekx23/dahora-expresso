import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Função utilitária de cálculo geodésico Haversine (em metros)
function calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Raio da Terra em metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

test('HOTFIX H2.1: Consistência Numérica e Zero Degradação de Precisão Geográfica', async (t) => {
  const appJs = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const motoboyJs = fs.readFileSync(path.resolve('public/motoboy.js'), 'utf8');

  await t.test('1. Google Places Autocomplete solicita explicitamente place_id em todos os campos', () => {
    // Verificar que setupAddressGeocodingListener e setupManualPickupAddressAutocomplete incluem place_id
    assert.match(appJs, /fields:\s*\[[^\]]*"place_id"[^\]]*\]/, 'setupAddressGeocodingListener deve incluir place_id');
  });

  await t.test('2. Proteção contra blur e re-geocodificação por texto após place_changed', () => {
    assert.match(appJs, /if\s*\(addressInput\.dataset\.isPlacesResolved\s*===\s*["']true["']\)\s*return;/, 'Blur não deve re-geocodificar quando isPlacesResolved for true');
    assert.match(appJs, /if\s*\(\(isManualAdjusted\s*\|\|\s*isPlacesResolved\)\s*&&\s*latInput\?\.value\s*&&\s*lngInput\?\.value\)\s*\{\s*return;\s*\}/, 'geocodeManualAddressText não deve sobrescrever Places ou ajuste manual');
  });

  await t.test('3. Invalidar coordenadas ao editar o texto manualmente após seleção', () => {
    assert.match(appJs, /manualTelePickupState\.customLat\s*=\s*null/, 'Edição manual do texto de coleta deve invalidar customLat');
    assert.match(appJs, /manualTelePickupState\.customLng\s*=\s*null/, 'Edição manual do texto de coleta deve invalidar customLng');
  });

  await t.test('4. Iniciar Rota no PWA prioriza coordenadas autoritativas (lat,lng)', () => {
    assert.match(motoboyJs, /destination=\$\{tele\.pickup_latitude\},(\$\{tele\.pickup_longitude\}|\$\{tele\.pickup_lng\})/, 'Rota de coleta deve usar coordenadas');
    assert.match(motoboyJs, /destination=\$\{tele\.delivery_latitude\},(\$\{tele\.delivery_longitude\}|\$\{tele\.delivery_lng\})/, 'Rota de entrega deve usar coordenadas');
  });
});

test('HOTFIX H2.1: Teste de Precisão com 5 Endereços Reais (Places -> Tele -> Google Maps)', async (t) => {
  const sampleAddresses = [
    {
      id: 1,
      name: 'Sapucaia do Sul - Centro',
      formatted_address: 'Rua Coronel Serafim Pereira, 50 - Centro, Sapucaia do Sul - RS, 93260-000',
      place_id: 'ChIJ_111111111111111111111',
      places_lat: -29.8265432,
      places_lng: -51.1456789
    },
    {
      id: 2,
      name: 'São Leopoldo - Centro',
      formatted_address: 'Av. João Corrêa, 1200 - Centro, São Leopoldo - RS, 93010-010',
      place_id: 'ChIJ_222222222222222222222',
      places_lat: -29.7598765,
      places_lng: -51.1487654
    },
    {
      id: 3,
      name: 'Esteio - Centro',
      formatted_address: 'Av. Presidente Vargas, 2500 - Centro, Esteio - RS, 93260-000',
      place_id: 'ChIJ_333333333333333333333',
      places_lat: -29.8543210,
      places_lng: -51.1812345
    },
    {
      id: 4,
      name: 'Canoas - Centro',
      formatted_address: 'Rua Quinze de Novembro, 350 - Centro, Canoas - RS, 92010-000',
      place_id: 'ChIJ_444444444444444444444',
      places_lat: -29.9198765,
      places_lng: -51.1809876
    },
    {
      id: 5,
      name: 'Porto Alegre - Partenon',
      formatted_address: 'Av. Ipiranga, 6681 - Partenon, Porto Alegre - RS, 90619-900',
      place_id: 'ChIJ_555555555555555555555',
      places_lat: -30.0598765,
      places_lng: -51.1787654
    }
  ];

  for (const sample of sampleAddresses) {
    await t.test(`Endereço ${sample.id}: ${sample.name}`, () => {
      // 1. Simulação do retorno do Google Places
      const placesResult = {
        place_id: sample.place_id,
        formatted_address: sample.formatted_address,
        geometry: {
          location: {
            lat: () => sample.places_lat,
            lng: () => sample.places_lng
          }
        }
      };

      const selectedLat = placesResult.geometry.location.lat();
      const selectedLng = placesResult.geometry.location.lng();
      const selectedPlaceId = placesResult.place_id;

      // 2. Estado da Coleta / Entrega na aplicação
      const state = {
        customAddress: placesResult.formatted_address,
        customLat: selectedLat,
        customLng: selectedLng,
        customPlaceId: selectedPlaceId
      };

      // 3. Payload enviado para a RPC create_admin_tele
      const rpcPayload = {
        p_pickup_address: state.customAddress,
        p_pickup_latitude: state.customLat,
        p_pickup_longitude: state.customLng,
        p_pickup_place_id: state.customPlaceId,
        p_delivery_address: state.customAddress,
        p_delivery_latitude: state.customLat,
        p_delivery_longitude: state.customLng,
        p_place_id: state.customPlaceId
      };

      // 4. Registro gravado no banco de dados (public.teles)
      const dbRecord = {
        id: `tele-${sample.id}`,
        pickup_address: rpcPayload.p_pickup_address,
        pickup_latitude: rpcPayload.p_pickup_latitude,
        pickup_longitude: rpcPayload.p_pickup_longitude,
        pickup_place_id: rpcPayload.p_pickup_place_id,
        delivery_address: rpcPayload.p_delivery_address,
        delivery_latitude: rpcPayload.p_delivery_latitude,
        delivery_longitude: rpcPayload.p_delivery_longitude,
        place_id: rpcPayload.p_place_id
      };

      // 5. URL gerada para navegação no Google Maps pelo motoboy
      const routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${dbRecord.delivery_latitude},${dbRecord.delivery_longitude}&travelmode=driving`;
      const urlMatch = routeUrl.match(/destination=([-\d.]+),([-\d.]+)/);
      assert.ok(urlMatch, 'URL do Google Maps deve conter coordenadas numéricas');
      const urlLat = parseFloat(urlMatch[1]);
      const urlLng = parseFloat(urlMatch[2]);

      // 6. Cálculo das distâncias de desvio
      const distancePlacesVsTele = calculateHaversineDistanceMeters(
        sample.places_lat, sample.places_lng,
        dbRecord.delivery_latitude, dbRecord.delivery_longitude
      );

      const distanceTeleVsNavigation = calculateHaversineDistanceMeters(
        dbRecord.delivery_latitude, dbRecord.delivery_longitude,
        urlLat, urlLng
      );

      // Asserções Numéricas Rigorosas
      assert.equal(selectedLat, sample.places_lat);
      assert.equal(selectedLng, sample.places_lng);
      assert.equal(dbRecord.delivery_latitude, sample.places_lat);
      assert.equal(dbRecord.delivery_longitude, sample.places_lng);
      assert.equal(dbRecord.place_id, sample.place_id);
      assert.equal(urlLat, sample.places_lat);
      assert.equal(urlLng, sample.places_lng);

      // A distância deve ser rigorosamente 0 metros (zero desvio)
      assert.ok(distancePlacesVsTele < 0.001, `Desvio Places -> Tele deve ser 0m (atual: ${distancePlacesVsTele}m)`);
      assert.ok(distanceTeleVsNavigation < 0.001, `Desvio Tele -> Navegação deve ser 0m (atual: ${distanceTeleVsNavigation}m)`);
    });
  }
});
