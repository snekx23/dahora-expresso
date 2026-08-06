import fs from 'fs';
import assert from 'assert';

console.log('==================================================');
console.log('TESTE DE HOMOLOGAÇÃO SAFARI / IPHONE MOBILE LOGIN');
console.log('==================================================\n');

const motoboyJsCode = fs.readFileSync('public/motoboy.js', 'utf8');

// 1. Simular ambiente Safari / iOS com APIs restritas/ausentes
let loginErrorText = '';
let loginErrorHidden = true;

const mockDOM = {
  'moto-id': { value: 'MB-101' },
  'moto-pin': { value: '1234' },
  'login-btn': { disabled: false, innerText: 'Entrar' },
  'login-error': {
    innerText: '',
    classList: {
      add: (cls) => { if (cls === 'hidden') loginErrorHidden = true; },
      remove: (cls) => { if (cls === 'hidden') loginErrorHidden = false; }
    },
    set innerText(val) { loginErrorText = val; },
    get innerText() { return loginErrorText; }
  },
  'pwa-login': { classList: { add: () => {}, remove: () => {} } },
  'pwa-app': { classList: { add: () => {}, remove: () => {} } },
  'pwa-rider-name': { innerText: '' },
  'drawer-rider-name': { innerText: '' },
  'drawer-rider-id': { innerText: '' }
};

// Mock Supabase DB
const mockMotoboyData = {
  id: 'uuid-rider-101',
  motoboy_code: 'MB-101',
  name: 'Motoboy Teste Safari',
  pin: '1234',
  status: 'ativo'
};

const mockQueryChain = {
  select: () => mockQueryChain,
  or: () => mockQueryChain,
  eq: () => mockQueryChain,
  in: () => mockQueryChain,
  order: () => mockQueryChain,
  limit: () => mockQueryChain,
  maybeSingle: async () => ({ data: mockMotoboyData, error: null }),
  single: async () => ({ data: mockMotoboyData, error: null }),
  then: (resolve) => resolve({ data: [mockMotoboyData], error: null })
};

const mockDbInstance = {
  from: () => mockQueryChain,
  rpc: async () => ({ data: null, error: null }),
  channel: () => ({
    on: () => mockDbInstance.channel(),
    subscribe: () => ({})
  })
};

// Simulação estrita do Safari iOS (Private Browsing + sem Push/Notification/Permissions)
const mockWindow = {
  SUPABASE_CONFIG: { url: 'https://test.supabase.co', key: 'anon-key' },
  supabase: { createClient: () => mockDbInstance },
  addEventListener: () => {},
  removeEventListener: () => {},
  // LocalStorage lança exceção em modo privado
  localStorage: {
    getItem: () => { throw new DOMException('SecurityError: The operation is insecure.', 'SecurityError'); },
    setItem: () => { throw new DOMException('QuotaExceededError: The quota has been exceeded.', 'QuotaExceededError'); },
    removeItem: () => { throw new DOMException('SecurityError: The operation is insecure.', 'SecurityError'); }
  },
  // APIs ausentes no Safari iOS antigo/restrito
  Notification: undefined,
  PushManager: undefined,
  AudioContext: undefined,
  webkitAudioContext: undefined
};

const mockNavigator = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  onLine: true,
  permissions: undefined, // Desativado no Safari iOS
  getBattery: undefined,   // Desativado no Safari iOS
  geolocation: {
    watchPosition: () => 1,
    clearWatch: () => {}
  }
};

// Executar código do motoboy.js dentro do sandbox simulado
const sandbox = new Function('window', 'document', 'navigator', `
  ${motoboyJsCode}
  return {
    handleMotoLogin,
    safeSetStorage,
    safeGetStorage,
    getCurrentRider: () => currentRider
  };
`);

const scope = sandbox(
  mockWindow,
  {
    body: { appendChild: () => {} },
    getElementById: (id) => mockDOM[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {} })
  },
  mockNavigator
);

async function runSafariLoginTest() {
  console.log('Executando submit de login com APIs do Safari desativadas e localStorage em modo privado...');

  const fakeEvent = { preventDefault: () => {} };
  await scope.handleMotoLogin(fakeEvent);

  // Validações
  const rider = scope.getCurrentRider();
  assert.ok(rider, 'Sessão do motoboy deve ser definida');
  assert.strictEqual(rider.id, 'uuid-rider-101', 'ID do motoboy deve corresponder ao retornado pelo banco');
  assert.strictEqual(loginErrorText, '', 'Nenhum erro visual de login deve ser exibido');

  // Testar fallback de safeStorage em modo privado
  const savedInMemory = scope.safeGetStorage('speedMotoSession');
  assert.ok(savedInMemory, 'Sessão deve ter sido salva no em-memory fallback');
  assert.strictEqual(JSON.parse(savedInMemory).id, 'uuid-rider-101');

  console.log('[PASS] Login do motoboy no Safari concluído com sucesso sem travar por APIs ausentes ou storage em modo privado.');
}

runSafariLoginTest().catch(err => {
  console.error('[FAIL] Erro no teste de homologação Safari:', err);
  process.exitCode = 1;
});
