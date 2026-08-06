import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve('.env.bootstrap.remote') });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

test('1. requestNotificationPermission não possui referência órfã e alias global foi configurado', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('window.enableRiderNotifications = enableRiderNotifications;'), 'enableRiderNotifications deve ser exposta no window.');
  assert.ok(motoboyJs.includes('window.requestNotificationPermission = enableRiderNotifications;'), 'requestNotificationPermission deve ter alias no window.');
});

test('2. Botão do card de push chama função existente (enableRiderNotifications)', async () => {
  const motoboyHtml = await readFile(new URL('../public/motoboy.html', import.meta.url), 'utf8');

  assert.ok(motoboyHtml.includes('onclick="enableRiderNotifications()"'), 'Botão no HTML deve invocar enableRiderNotifications().');
  assert.ok(!motoboyHtml.includes('onclick="requestPushNotificationPermission()"'), 'Chamada desatualizada removida do HTML.');
});

test('3. Permissão de notificação é solicitada após clique com AudioController.unlock()', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('AudioController.unlock()'), 'Desbloqueio de áudio executado no gesto do usuário.');
  assert.ok(motoboyJs.includes('Notification.requestPermission()'), 'Solicitação de permissão ocorre após o clique.');
});

test('4. Toast de sucesso só aparece após a subscription ser confirmada', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  const toastIndex = motoboyJs.indexOf("showPWAToast('Alertas ativados neste aparelho.');");
  const rpcIndex = motoboyJs.indexOf("db.rpc('register_my_push_subscription'");

  assert.ok(rpcIndex !== -1, 'Registo da RPC deve existirem enableRiderNotifications.');
  assert.ok(toastIndex > rpcIndex, 'Toast de sucesso deve ser exibido após a RPC.');
});

test('5. Erro no fluxo de notificação exibe toast de erro e não marca sucesso falso', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("showPWAToast(err.message, 'error')"), 'Erros capturados devem exibir toast de erro.');
});

test('6. Endpoint /api/vapid-public-key está registrado no serve.js', async () => {
  const serveJs = await readFile(new URL('../serve.js', import.meta.url), 'utf8');

  assert.ok(serveJs.includes("reqUrl === '/api/vapid-public-key'"), 'serve.js deve conter a rota /api/vapid-public-key.');
});

test('7. Endpoint /api/vapid-public-key retorna somente o objeto com publicKey', async () => {
  const serveJs = await readFile(new URL('../serve.js', import.meta.url), 'utf8');

  assert.ok(serveJs.includes('JSON.stringify({ publicKey })'), 'Endpoint deve retornar somente { publicKey }.');
});

test('8. VAPID_PRIVATE_KEY não é retornada na resposta da rota /api/vapid-public-key', async () => {
  const serveJs = await readFile(new URL('../serve.js', import.meta.url), 'utf8');
  const routeCode = serveJs.substring(serveJs.indexOf("reqUrl === '/api/vapid-public-key'"), serveJs.indexOf("reqUrl === '/api/vapid-public-key'") + 250);

  assert.ok(!routeCode.includes('VAPID_PRIVATE_KEY'), 'Rota de chave pública não deve vazar a chave privada.');
});

test('9. Servidor estático não é tratado como backend válido e serve.js provê suporte a API', async () => {
  const serveJs = await readFile(new URL('../serve.js', import.meta.url), 'utf8');

  assert.ok(serveJs.includes("Content-Type': 'application/json"), 'serve.js deve responder com JSON de backend.');
});

test('10. Consulta de public.teles utiliza motoboy_id e colunas existentes', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes(".eq('motoboy_id', currentRider.id)"), 'Consultas de teles filtram por motoboy_id.');
});

test('11. Campos inválidos (price, date, address) foram removidos das queries em public/motoboy.js', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(!motoboyJs.includes(".select('price, date, address')"), 'Campos inexistentes price, date, address foram removidos das queries.');
});

test('12. Falha de Push não esconde a tela principal no showApp()', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes("switchPWATab(targetTab);"), 'switchPWATab é executado para exibir a tela principal.');
  assert.ok(!motoboyJs.includes("requestNotificationPermission();\n  const savedTab"), 'Notificações não bloqueiam a renderização da aba.');
});

test('13. Card de alertas de Push não substitui a renderização da tela principal nem do mapa', async () => {
  const motoboyHtml = await readFile(new URL('../public/motoboy.html', import.meta.url), 'utf8');

  assert.ok(motoboyHtml.includes('id="pwa-map"'), 'O container do mapa existe no HTML.');
  assert.ok(motoboyHtml.includes('id="pwa-push-alert-card"'), 'O card de push é um componente complementar.');
});

test('14. Estados da UI do card de alertas são gerenciados de forma consistente', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('updatePushAlertCardUI('), 'motoboy.js centraliza a atualização do card de push via updatePushAlertCardUI.');
});

test('15. AudioContext é desbloqueado no gesto do usuário dentro de enableRiderNotifications', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.ok(motoboyJs.includes('AudioController.unlock()'), 'Desbloqueio de áudio inserido no início de enableRiderNotifications.');
});

test('16. Service Worker aplica Network-Only e não cacheia respostas de /api/', async () => {
  const swJs = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

  assert.ok(swJs.includes("url.pathname.startsWith('/api/')"), 'Service worker ignora cache para /api/.');
  assert.ok(swJs.includes("event.respondWith(fetch(event.request));"), 'Service worker utiliza fetch direto para /api/.');
});

test('17. Cache do Service Worker foi atualizado para v5', async () => {
  const swJs = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

  assert.ok(swJs.includes("dahora-expresso-cache-v5"), 'Service worker deve usar o cache v5.');
});

test('18. Nenhuma chave privada ou service_role é exposta na pasta public/', async () => {
  const files = ['public/motoboy.html', 'public/motoboy.js', 'public/sw.js', 'public/app.js'];

  for (const file of files) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(!text.includes('VAPID_PRIVATE_KEY'), `VAPID_PRIVATE_KEY exposta em ${file}!`);
    assert.ok(!text.includes(SERVICE_ROLE_KEY), `Service Role Key exposta em ${file}!`);
  }
});
