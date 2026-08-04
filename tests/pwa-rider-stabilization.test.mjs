import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('1. Uma única instância do Supabase é criada em public/motoboy.js', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  const matches = motoboyJs.match(/createClient\(/g) || [];
  assert.equal(matches.length, 1, 'Deve existir exatamente uma chamada a createClient em motoboy.js.');
});

test('2. Sessão é restaurada antes de disparar consultas protegidas', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('await resolveCurrentRider()'), 'resolveCurrentRider deve ser invocado no DOMContentLoaded.');
  const riderIndex = motoboyJs.indexOf('await resolveCurrentRider()');
  const showAppIndex = motoboyJs.indexOf('showApp()');
  assert.ok(riderIndex < showAppIndex, 'A resolução de sessão deve preceder a execução do shell e consultas.');
});

test('3. currentRider é resolvido por auth.uid() e tabela public.fleet', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes(".from('fleet')"), 'A busca da frota deve ser feita na tabela fleet.');
  assert.ok(motoboyJs.includes(".eq('user_id', session.user.id)"), 'A busca deve utilizar exclusivamente user_id ligado a auth.uid().');
});

test('4. currentRiderId utiliza o UUID oficial (fleetRow.id)', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('currentRiderId = fleetRow.id;'), 'currentRiderId deve ser o UUID primário da tabela fleet.');
});

test('5. Consultas de teles do PWA utilizam exclusivamente a coluna motoboy_id', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes(".eq('motoboy_id', currentRiderId)"), 'Consultas de teles devem filtrar por motoboy_id.');
});

test('6. Consultas de teles do PWA não usam a coluna descontinuada rider_id', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(!motoboyJs.includes(".from('teles')\n    .select('*')\n    .eq('rider_id'"), 'rider_id não deve ser utilizado em consultas de teles.');
  assert.ok(!motoboyJs.includes(".from('teles')\n      .select('id')\n      .eq('rider_id'"), 'rider_id não deve ser utilizado em consultas de teles.');
});

test('7. Nome do motoboy não é utilizado como chave estrangeira de relacionamento', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(!motoboyJs.includes(".eq('motoboy', currentRider.name)"), 'Nome não deve ser usado como FK.');
  assert.ok(!motoboyJs.includes(".eq('rider', currentRider.name)"), 'Nome não deve ser usado como FK.');
});

test('8. Status legados (concluido, entregue, Entregue, em rota, Em andamento) não são utilizados em queries ativas', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes("['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega']"), 'Query deve utilizar lista de status canônicos ativos.');
  assert.ok(!motoboyJs.includes("neq('status', 'Entregue')"), 'Status legado Entregue não deve ser consultado.');
});

test('9. Mapa lê a chave googleMapsApiKey de window.SUPABASE_CONFIG', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('window.SUPABASE_CONFIG.googleMapsApiKey'), 'Chave do mapa deve ser lida de SUPABASE_CONFIG.');
  assert.ok(motoboyJs.includes('fullscreenControl: false'), 'fullscreenControl deve ser configurado como false.');
  assert.ok(motoboyJs.includes("window.google.maps.event.trigger(riderMap, 'resize')"), 'Reabrir mapa deve disparar o evento de resize do Google Maps.');
  assert.ok(!motoboyJs.includes('riderMap.invalidateSize()'), 'invalidateSize (Leaflet) deve ter sido removido.');
});

test('10. Tela sem Tele exibe estado "Você está disponível" e informações de status', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('Você está disponível'), 'Card de estado vazio deve ser renderizado.');
  assert.ok(motoboyJs.includes('Aguardando uma nova entrega'), 'Texto de espera deve ser informado.');
  assert.ok(motoboyJs.includes('Última Sincronização'), 'Informação de sincronização deve estar presente.');
});

test('11. Estrutura de navegação possui 4 botões na barra inferior', async () => {
  const motoboyHtml = await readFile(new URL('../public/motoboy.html', import.meta.url), 'utf8');
  assert.ok(motoboyHtml.includes("onclick=\"switchPWATab('map')\""), 'Aba Início presente.');
  assert.ok(motoboyHtml.includes("onclick=\"switchPWATab('teles')\""), 'Aba Minhas Teles presente.');
  assert.ok(motoboyHtml.includes("onclick=\"switchPWATab('reports')\""), 'Aba Ganhos presente.');
  assert.ok(motoboyHtml.includes("onclick=\"togglePWADrawer(true)\""), 'Botão de Menu presente.');
});

test('12. Apenas uma subscription Realtime é criada para public.teles', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('realtimeChannel = db.channel'), 'Canal realtime único criado.');
  assert.ok(motoboyJs.includes('.subscribe()'), 'Subscription iniciada.');
});

test('13. Logout remove o canal de Realtime', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('db.removeChannel(realtimeChannel)'), 'Limpeza de canal Realtime no logout.');
});

test('14. Falha de mapa não impede o carregamento do shell', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes("try { if (!riderMap) initRiderMap(); } catch"), 'initRiderMap é executado em bloco try/catch isolado.');
});

test('15. Falha de telemetria de bateria não impede o carregamento do shell', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes("try { initRiderDeviceTelemetry(); } catch"), 'initRiderDeviceTelemetry é executado em bloco try/catch isolado.');
});

test('16. Nenhuma chamada aponta para projeto remoto do Supabase', async () => {
  const configLocal = await readFile(new URL('../public/config.local.js', import.meta.url), 'utf8');
  const configJs = await readFile(new URL('../public/config.js', import.meta.url), 'utf8');
  assert.ok(configLocal.includes('http://127.0.0.1:54321'), 'config.local.js deve apontar para Supabase local.');
  assert.ok(configJs.includes('http://127.0.0.1:54321'), 'config.js deve ter fallback para Supabase local.');
});

test('17. ENABLE_PUSH_WORKER permanece desativado em serve.js', async () => {
  const serveJs = await readFile(new URL('../serve.js', import.meta.url), 'utf8');
  assert.ok(serveJs.includes('const ENABLE_PUSH_WORKER = false;'), 'ENABLE_PUSH_WORKER deve ser false em serve.js.');
  assert.ok(serveJs.includes('if (ENABLE_PUSH_WORKER)'), 'setInterval do worker só executa se ENABLE_PUSH_WORKER for true.');
});
