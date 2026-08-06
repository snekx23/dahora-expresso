// Dahora Expresso — Motoboy PWA Logic
let db = null;

(function initSupabaseMotoboyClient() {
  if (typeof window === 'undefined') return;

  if (!window.SUPABASE_CONFIG || !window.SUPABASE_CONFIG.url || !window.SUPABASE_CONFIG.key) {
    console.error("[SUPABASE INIT MOTOBOY] Configuração do ambiente não disponível.");
    document.addEventListener('DOMContentLoaded', () => {
      const errInfo = window.__CONFIGURATION_ERROR || { message: 'Ambiente não configurado. Verifique as configurações do sistema.' };
      const banner = document.createElement('div');
      banner.className = 'config-error-banner';
      banner.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:#0f172a; color:#f87171; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:99999; padding:24px; text-align:center; font-family:sans-serif;';
      banner.innerHTML = `<h2 style="font-size:1.5rem; margin-bottom:12px;">⚠️ Sistema Indisponível</h2><p style="font-size:1rem; max-width:480px; color:#94a3b8;">${errInfo.message}</p>`;
      document.body.appendChild(banner);
    });
    return;
  }

  const SUPABASE_URL = window.SUPABASE_CONFIG.url;
  const SUPABASE_KEY = window.SUPABASE_CONFIG.key;

  if (window.supabase && !db) {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }
})();

const supabaseClient = db;
if (typeof window !== 'undefined') window.supabaseClient = db;

let currentRider = null;   // fleet row do motoboy logado
let currentRiderId = null; // UUID real (public.fleet.id)
let riderMap = null;       // Instância do Google Maps

let realtimeChannel = null;
let watchId = null;       // ID de monitoramento de geolocalização
let lastPosition = null;  // { lat, lng }
let currentBatteryLevel = null;
let hasCenteredOnce = false;
let knownActiveTeleIds = null;
let activeRiderDeliveryMarkers = {};
let activeDeliveriesList = [];
let lastActiveTeleId = null;

// ─── SAFARI PRIVATE BROWSING SAFE STORAGE HELPER ─────────────────────────────
const memoryStorageMap = new Map();

function safeSetStorage(key, value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch (e) {
    console.warn(`[SafeStorage] Could not write '${key}' to localStorage:`, e);
  }
  memoryStorageMap.set(key, value);
}

function safeGetStorage(key) {
  try {
    if (typeof localStorage !== 'undefined') {
      const val = localStorage.getItem(key);
      if (val !== null) return val;
    }
  } catch (e) {
    console.warn(`[SafeStorage] Could not read '${key}' from localStorage:`, e);
  }
  return memoryStorageMap.get(key) || null;
}

function safeRemoveStorage(key) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  } catch (e) {
    console.warn(`[SafeStorage] Could not remove '${key}' from localStorage:`, e);
  }
  memoryStorageMap.delete(key);
}

// ─── CONTROLADOR DE ÁUDIO ───────────────────────────────────────────────────
const AudioController = {
  unlocked: false,
  teleAudio: null,

  init() {
    if (typeof window === 'undefined') return;
    try {
      this.teleAudio = new Audio('data:audio/wav;base64,UklGRl9vAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU...');
    } catch (e) {}
  },

  unlock() {
    if (this.unlocked) return;
    try {
      if (this.teleAudio) {
        this.teleAudio.play().then(() => {
          this.teleAudio.pause();
          this.teleAudio.currentTime = 0;
          this.unlocked = true;
        }).catch(() => {});
      }
    } catch (e) {}
  },

  playTeleAlert() {
    try {
      if (this.teleAudio) {
        this.teleAudio.currentTime = 0;
        this.teleAudio.play().catch(err => {
          console.warn("Áudio em primeiro plano bloqueado pelo navegador:", err.message);
        });
      }
    } catch (e) {}

    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate([600, 250, 600, 250, 900]); } catch (e) {}
    }
  },

  playMessageAlert() {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate([250, 120, 250]); } catch (e) {}
    }
  }
};

AudioController.init();

function logSafeError(op, err) {
  if (!err) return;
  console.error(`[PWA ${op}]`, {
    operation: op,
    code: err.code || 'UNKNOWN_ERROR',
    message: err.message || String(err),
    details: err.details || null,
    hint: err.hint || null
  });
}

// ─── RESOLVER MOTOBOY AUTENTICADO POR AUTH.UID() ─────────────────────────────
async function resolveCurrentRider() {
  if (!db) return currentRider;
  try {
    const { data: { session }, error: sessionErr } = await db.auth.getSession();
    if (sessionErr) logSafeError('getSession', sessionErr);

    if (session?.user?.id) {
      const { data: fleetRow, error: fleetErr } = await db
        .from('fleet')
        .select('*')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (fleetErr) logSafeError('resolveCurrentRiderFleetQuery', fleetErr);

      if (fleetRow) {
        currentRider = fleetRow;
        currentRiderId = fleetRow.id;
        safeSetStorage('speedMotoSession', JSON.stringify(fleetRow));
        return fleetRow;
      } else {
        showLoginError("Seu usuário não está vinculado a um motoboy ativo.");
        return null;
      }
    }
  } catch (e) {
    logSafeError('resolveCurrentRiderException', e);
  }

  const saved = safeGetStorage('speedMotoSession');
  if (saved) {
    try {
      currentRider = JSON.parse(saved);
      currentRiderId = currentRider ? currentRider.id : null;
      return currentRider;
    } catch {
      safeRemoveStorage('speedMotoSession');
    }
  }
  return null;
}

// ─── INIT ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
  registerSW();

  await resolveCurrentRider();
  if (currentRider) {
    showApp();
  } else {
    document.getElementById('pwa-login')?.classList.remove('hidden');
    document.getElementById('pwa-app')?.classList.add('hidden');
  }
});

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        reg.update();
      })
      .catch(() => {});
  }
}

function urlBase64ToUint8Array(base64String) {
  if (!base64String || typeof base64String !== 'string' || base64String.trim() === '') {
    return new Uint8Array(0);
  }
  const cleanStr = base64String.trim().replace(/^["']|["']$/g, '');
  const padding = '='.repeat((4 - (cleanStr.length % 4)) % 4);
  const base64 = (cleanStr + padding).replace(/\-/g, '+').replace(/_/g, '/');
  try {
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  } catch (e) {
    console.warn("⚠️ urlBase64ToUint8Array failed to decode base64 string:", e.message);
    return new Uint8Array(0);
  }
}

function updatePushAlertCardUI(statusText, buttonText, buttonState = 'normal') {
  const badge = document.getElementById('pwa-push-status-badge');
  const btn = document.getElementById('pwa-push-toggle-btn') || document.querySelector('#pwa-push-alert-card button');

  if (badge && statusText) {
    badge.innerText = statusText;
  }

  if (btn) {
    if (buttonText) btn.innerText = buttonText;
    if (buttonState === 'loading') {
      btn.disabled = true;
      btn.style.background = 'var(--primary)';
      btn.style.color = '#000000';
    } else if (buttonState === 'active') {
      btn.disabled = true;
      btn.style.background = 'var(--success)';
      btn.style.color = '#ffffff';
    } else if (buttonState === 'error') {
      btn.disabled = false;
      btn.style.background = 'var(--primary)';
      btn.style.color = '#000000';
    } else {
      btn.disabled = false;
      btn.style.background = 'var(--primary)';
      btn.style.color = '#000000';
    }
  }
}

async function enableRiderNotifications() {
  updatePushAlertCardUI('Status: Solicitando...', 'Ativando...', 'loading');

  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      updatePushAlertCardUI('Status: Não suportado neste navegador', 'Navegador não suporta alertas', 'error');
      throw new Error('Notificações Push não são suportadas neste navegador.');
    }

    // Desbloqueio do AudioContext no gesto explícito do usuário
    AudioController.unlock();

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      updatePushAlertCardUI('Status: Permissão negada', 'Permissão de notificações negada', 'error');
      throw new Error('Permissão de notificações negada pelo usuário.');
    }

    const registration = await navigator.serviceWorker.ready;

    // Buscar chave VAPID pública no backend
    let vapidPublicKey = null;
    try {
      const res = await fetch('/api/vapid-public-key');
      if (res.ok) {
        const data = await res.json();
        if (data && data.publicKey) {
          vapidPublicKey = data.publicKey;
        }
      }
    } catch (e) {
      console.warn("⚠️ Não foi possível obter VAPID key do backend:", e.message);
    }

    if (!vapidPublicKey) {
      updatePushAlertCardUI('Status: Servidor de notificações não configurado', 'Servidor de notificações não configurado', 'error');
      throw new Error('Servidor de notificações não configurado.');
    }

    // Criar ou obter subscription
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });
    }

    if (!subscription) {
      updatePushAlertCardUI('Status: Não foi possível registrar este aparelho', 'Não foi possível registrar este aparelho', 'error');
      throw new Error('Não foi possível criar a subscrição no navegador.');
    }

    // Registrar no backend Supabase via RPC
    const subObj = subscription.toJSON();
    const p256dh = subObj.keys?.p256dh || '';
    const auth = subObj.keys?.auth || '';

    if (db && (currentRiderId || (currentRider && currentRider.id))) {
      const riderId = currentRiderId || currentRider.id;
      const { error: rpcErr } = await db.rpc('register_my_push_subscription', {
        p_endpoint: subscription.endpoint,
        p_p256dh: p256dh,
        p_auth: auth,
        p_user_agent: navigator.userAgent
      });

      if (rpcErr) {
        console.warn("Aviso na RPC de push subscription:", rpcErr.message);
        await db.from('rider_push_subscriptions').upsert([{
          rider_id: riderId,
          endpoint: subscription.endpoint,
          p256dh: p256dh,
          auth: auth,
          user_agent: navigator.userAgent,
          is_active: true
        }], { onConflict: 'endpoint' });
      }
    }

    // SOMENTE DEPOIS DE TODAS AS ETAPAS CONCLUÍDAS
    updatePushAlertCardUI('Status: Alertas ativados neste aparelho', 'Alertas ativados neste aparelho', 'active');
    
    // Ocultar card da tela e expandir área do mapa
    const pushCard = document.getElementById('pwa-push-alert-card');
    if (pushCard) {
      pushCard.style.display = 'none';
    }
    if (riderMap && typeof window.google !== 'undefined' && window.google.maps) {
      window.google.maps.event.trigger(riderMap, 'resize');
    }

    showPWAToast('Alertas ativados neste aparelho.');
    return { success: true };

  } catch (err) {
    console.warn("⚠️ Erro no fluxo de notificações:", err.message);
    showPWAToast(err.message, 'error');
    return { success: false, error: err.message };
  }
}

async function checkExistingPushSubscription() {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) return;

  if (Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        updatePushAlertCardUI('Status: Alertas ativados neste aparelho', 'Alertas ativados neste aparelho', 'active');
      } else {
        updatePushAlertCardUI('Status: Não ativado neste aparelho', 'Ativar alertas de novas Teles', 'normal');
      }
    } catch (e) {
      updatePushAlertCardUI('Status: Não ativado', 'Ativar alertas de novas Teles', 'normal');
    }
  } else if (Notification.permission === 'denied') {
    updatePushAlertCardUI('Status: Permissão de notificações negada', 'Permissão de notificações negada', 'error');
  } else {
    updatePushAlertCardUI('Status: Não ativado', 'Ativar alertas de novas Teles', 'normal');
  }
}

// Exposição explícita para o escopo global do navegador
if (typeof window !== 'undefined') {
  window.enableRiderNotifications = enableRiderNotifications;
  window.requestPushNotificationPermission = enableRiderNotifications;
  window.requestNotificationPermission = enableRiderNotifications;
  window.checkExistingPushSubscription = checkExistingPushSubscription;
}

function updatePushBadgeStatus(text) {
  const badge = document.getElementById('pwa-push-status-badge');
  if (badge) badge.innerText = text;
}


function showHighPriorityNewTeleModal(tele) {
  AudioController.playTeleAlert();

  const clientEl = document.getElementById('high-priority-client');
  const pickupEl = document.getElementById('high-priority-pickup');
  const addrEl   = document.getElementById('high-priority-address');
  const priceEl  = document.getElementById('high-priority-price');

  if (clientEl) clientEl.innerText = tele.client || 'Cliente Comercial';
  if (pickupEl) pickupEl.innerText = tele.pickup_address || 'Endereço de Coleta';
  if (addrEl)   addrEl.innerText   = tele.address || 'Endereço de Entrega';
  if (priceEl)  priceEl.innerText  = tele.price || 'R$ 8,00';

  const modal = document.getElementById('modal-high-priority-tele');
  if (modal) modal.classList.remove('hidden');
}

function closeHighPriorityModal() {
  const modal = document.getElementById('modal-high-priority-tele');
  if (modal) modal.classList.add('hidden');
  switchPWATab('teles');
}


function sendWebNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    console.log('Notifications not permitted or not supported.');
    return;
  }

  // Try showing notification via Service Worker registration
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification(title, {
        body: body,
        icon: '/logo.png',
        badge: '/logo.png',
        vibrate: [200, 100, 200],
        tag: 'speed-delivery-notif',
        renotify: true
      });
    }).catch(err => {
      console.warn("ServiceWorker notification failed, fallback to Notification construct:", err);
      new Notification(title, { body, icon: '/logo.png' });
    });
  } else {
    new Notification(title, { body, icon: '/logo.png' });
  }
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────

async function handleMotoLogin(e) {
  if (e) e.preventDefault();

  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  const rawIdEl = document.getElementById('moto-id');
  const pinEl = document.getElementById('moto-pin');

  if (errEl) errEl.classList.add('hidden');

  // ETAPA 1: LEITURA E VALIDAÇÃO DOS INPUTS
  const rawId = rawIdEl ? rawIdEl.value.trim() : '';
  const pin = pinEl ? pinEl.value.trim() : '';

  if (!rawId || !pin) {
    showLoginError('Informe o Código de Acesso e o PIN para entrar.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Verificando...';
  }

  // ETAPA 2: VERIFICAÇÃO DO CLIENTE SUPABASE DB
  if (!db) {
    console.error("[LOGIN FAIL STEP 2] Supabase client 'db' is null or uninitialized.");
    showLoginError('Serviço de banco de dados indisponível. Recarregue a página.');
    if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
    return;
  }

  const digits = rawId.replace(/\D/g, '');
  const inputCode = rawId.replace('#', '').trim();

  // ETAPA 3: CONSULTA À TABELA FLEET COM TIMEOUT E SEPARAÇÃO DE ERROS
  try {
    // Timeout de 15 segundos para conexões móveis (4G/5G no Safari)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), 15000)
    );

    const queryPromise = db
      .from('fleet')
      .select('*')
      .or(`motoboy_code.eq.${inputCode},motoboy_code.eq.MB-${digits},motoboy_code.eq.${digits}`)
      .maybeSingle();

    const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

    if (error) {
      console.error("[LOGIN DB ERROR STEP 3]", { code: error.code, message: error.message });
      if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }

      const msg = (error.message || '').toLowerCase();
      if (msg.includes('fetch') || msg.includes('network') || msg.includes('failed to fetch') || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        showLoginError('Sem conexão com a internet. Verifique sua rede móvel ou Wi-Fi.');
      } else if (error.code === '42501' || error.code === 'PGRST301') {
        showLoginError('Acesso não autorizado às informações do motoboy.');
      } else {
        showLoginError(`Erro ao consultar cadastro (${error.code || 'DB'}): ${error.message}`);
      }
      return;
    }

    // ETAPA 4: VERIFICAÇÃO DO MOTOBOY E COMPARAÇÃO DO PIN
    if (!data) {
      console.warn("[LOGIN FAIL STEP 4] Código de acesso não encontrado no banco:", inputCode);
      if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
      showLoginError('Código de Acesso incorreto. Contate o administrador.');
      return;
    }

    if (data.status === 'inativo' || data.status === 'suspenso') {
      console.warn("[LOGIN FAIL STEP 4] Motoboy inativo/suspenso:", data.id);
      if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
      showLoginError('Seu cadastro de motoboy está inativo ou suspenso. Contate a administração.');
      return;
    }

    if (data.pin && String(data.pin).trim() !== String(pin).trim()) {
      console.warn("[LOGIN FAIL STEP 4] PIN incorreto para o motoboy:", data.id);
      if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
      showLoginError('PIN incorreto. Verifique seus dados e tente novamente.');
      return;
    }

    // ETAPA 5: ARMAZENAMENTO DE SESSÃO SEGURO E CONCLUIR LOGIN PRIMEIRO
    currentRider = data;
    currentRiderId = data.id;
    safeSetStorage('speedMotoSession', JSON.stringify(data));

    if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }

    // Redirecionamento e transição de tela concluem PRIMEIRO
    showApp();

    // ETAPA 6: INICIALIZAÇÕES DE SEGUNDO PLANO NÃO-BLOQUEANTES
    setTimeout(() => {
      try { loadMyDeliveries(); } catch (err) { logSafeError('login:loadMyDeliveries', err); }
      try { startGeolocation(); } catch (err) { logSafeError('login:startGeolocation', err); }
      try { initPWAFinancialRealtime(); } catch (err) { logSafeError('login:realtime', err); }
      try { enableRiderNotifications(); } catch (err) { logSafeError('login:notifications', err); }
    }, 100);

  } catch (err) {
    console.error("[LOGIN EXCEPTION]", err);
    if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }

    if (err && err.message === 'TIMEOUT') {
      showLoginError('Tempo limite excedido ao conectar ao servidor. Tente novamente.');
    } else {
      showLoginError(`Exceção de login: ${err.message || String(err)}`);
    }
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  if (el) {
    el.innerText = msg;
    el.classList.remove('hidden');
  }
}

async function handleMotoLogout() {
  if (!confirm('Sair do aplicativo?')) return;
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && db) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.pushManager) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await db.rpc('deactivate_my_push_subscription', { p_endpoint: sub.endpoint }).catch(() => null);
        }
      }
    } catch (e) {}
  }
  safeRemoveStorage('speedMotoSession');
  safeRemoveStorage('activePWATab');
  if (realtimeChannel && db) db.removeChannel(realtimeChannel);
  if (realtimeFinancialSubscription && supabaseClient) {
    try { supabaseClient.removeChannel(realtimeFinancialSubscription); } catch (e) {}
    realtimeFinancialSubscription = null;
  }
  if (watchId && typeof navigator !== 'undefined' && navigator.geolocation) {
    try { navigator.geolocation.clearWatch(watchId); } catch (e) {}
  }
  reportsFetchToken++;
  if (pwaStatementCachedItems) pwaStatementCachedItems.clear();
  reportsStatementOffset = 0;
  currentRider = null;
  knownActiveTeleIds = null;
  hasCenteredOnce = false;
  document.getElementById('pwa-app').classList.add('hidden');
  document.getElementById('pwa-login').classList.remove('hidden');
  document.getElementById('moto-id').value = '';
  document.getElementById('moto-pin').value = '';
  togglePWADrawer(false);
  if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
}


// ─── SCREEN TRANSITIONS ───────────────────────────────────────────────────────

function showApp() {
  document.getElementById('pwa-login')?.classList.add('hidden');
  document.getElementById('pwa-app')?.classList.remove('hidden');

  // Fill header info
  if (currentRider) {
    const nameEl = document.getElementById('pwa-rider-name');
    if (nameEl) nameEl.innerText = currentRider.name || 'Motoboy';
    setRiderStatusBadge(currentRider.status || 'Disponível');

    // Fill drawer info
    const drawerName = document.getElementById('drawer-rider-name');
    const drawerId = document.getElementById('drawer-rider-id');
    if (drawerName) drawerName.innerText = currentRider.name || 'Motoboy';
    if (drawerId) drawerId.innerText = currentRider.motoboy_code || currentRider.id || '#MB-0000';

    updateConnectionButtonState(currentRider.status || 'Disponível');
  }

  const savedTab = safeGetStorage('activePWATab');
  const targetTab = savedTab ? savedTab : 'map';
  hasCenteredOnce = false;
  switchPWATab(targetTab);

  // Execução por ordem estrita de serviços principais isolados
  try { if (!riderMap) initRiderMap(); } catch (e) { logSafeError('showApp:initRiderMap', e); }
  try { loadMyDeliveries(); } catch (e) { logSafeError('showApp:loadMyDeliveries', e); }
  try { initRiderDeviceTelemetry(); } catch (e) { logSafeError('showApp:telemetry', e); }
  try { startGeolocation(); } catch (e) { logSafeError('showApp:geolocation', e); }
  try { subscribeRealtime(); } catch (e) { logSafeError('showApp:subscribeRealtime', e); }

  // Execução independente de dados secundários
  try { loadLocalProfile(); } catch (e) {}
  try { loadWeeklyBalance(); } catch (e) {}
  try { loadConsumablesData(); } catch (e) {}
  try { checkExistingPushSubscription(); } catch (e) {}
  try { if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons(); } catch (e) {}
}


function setRiderStatusBadge(status) {
  const el = document.getElementById('pwa-rider-status');
  if (!el) return;
  el.innerText = status;
  el.className = 'pwa-status-badge';
  if (status === 'Disponível') el.classList.add('badge-available');
  else if (status.includes('Descanso')) el.classList.add('badge-rest');
  else el.classList.add('badge-busy');
}

// ─── CONNECTION / STATUS TOGGLING (DATABASE AS SINGLE SOURCE OF TRUTH) ────────

async function fetchAndUpdateRiderStatusFromDB() {
  if (!db) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session?.user?.id) return;

    const { data, error } = await db
      .from('fleet')
      .select('id, name, status, motoboy_code, lat, lng')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (error) {
      logSafeError('fetchAndUpdateRiderStatusFromDB', error);
      return;
    }

    if (data) {
      currentRider = { ...currentRider, ...data };
      safeSetStorage('speedMotoSession', JSON.stringify(currentRider));
      setRiderStatusBadge(data.status || 'Disponível');
      updateConnectionButtonState(data.status || 'Disponível');
    }
  } catch (e) {
    logSafeError('fetchAndUpdateRiderStatusFromDBException', e);
  }
}

function updateConnectionButtonState(status) {
  const mapBtn = document.getElementById('pwa-map-connect-btn');
  const mapTextEl = document.getElementById('pwa-map-connect-btn-text');
  const mapIconEl = document.getElementById('pwa-map-connect-btn-icon');

  const drawerBtn = document.getElementById('pwa-connect-btn');
  const drawerTextEl = document.getElementById('pwa-connect-btn-text') || drawerBtn;
  const statusVal = document.getElementById('map-status-val');

  if (status === 'Em Descanso') {
    if (mapBtn) {
      mapBtn.className = 'pwa-map-connect-btn main-connect-btn offline';
      if (mapTextEl) mapTextEl.innerText = 'Conectar';
      if (mapIconEl) mapIconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`;
    }
    if (drawerTextEl) drawerTextEl.innerText = 'Conectar';
    if (statusVal) {
      statusVal.innerText = 'OFFLINE';
      statusVal.className = 'status-val offline';
    }
  } else {
    if (mapBtn) {
      mapBtn.className = 'pwa-map-connect-btn main-connect-btn online';
      if (mapTextEl) mapTextEl.innerText = 'Desconectar';
      if (mapIconEl) mapIconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`;
    }
    if (drawerTextEl) drawerTextEl.innerText = 'Desconectar';
    if (statusVal) {
      statusVal.innerText = 'ONLINE';
      statusVal.className = 'status-val online';
    }
  }
}

// ─── MODAL ACESSÍVEL DE ALERTA DE TELES ATIVAS (PARTE 3) ─────────────────────

let lastFocusedElementBeforeModal = null;

function openActiveTelesModal() {
  const modal = document.getElementById('modal-active-teles-warning');
  if (!modal || !modal.classList.contains('hidden')) return;

  lastFocusedElementBeforeModal = document.activeElement;
  modal.classList.remove('hidden');
  modal.focus();

  document.addEventListener('keydown', handleActiveTelesModalKeyDown);
}

function closeModalActiveTelesWarning() {
  const modal = document.getElementById('modal-active-teles-warning');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', handleActiveTelesModalKeyDown);

  if (lastFocusedElementBeforeModal && typeof lastFocusedElementBeforeModal.focus === 'function') {
    lastFocusedElementBeforeModal.focus();
  }
}

function closeModalAndGoToTeles() {
  closeModalActiveTelesWarning();
  switchPWATab('teles');
}

function handleActiveTelesModalKeyDown(e) {
  const modal = document.getElementById('modal-active-teles-warning');
  if (!modal || modal.classList.contains('hidden')) return;

  if (e.key === 'Escape') {
    closeModalActiveTelesWarning();
    return;
  }

  if (e.key === 'Tab') {
    const focusableElements = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === firstElement || document.activeElement === modal) {
        e.preventDefault();
        lastElement.focus();
      }
    } else {
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
  }
}

async function toggleConnectionState() {
  if (!db) return;
  const { data: { session } } = await db.auth.getSession();
  if (!session?.user?.id) {
    showPWAToast('Sessão expirada. Faça login novamente.');
    return;
  }

  // Sincronizar estado real do banco antes de alterar
  await fetchAndUpdateRiderStatusFromDB();
  if (!currentRider) return;

  const mapBtn = document.getElementById('pwa-map-connect-btn');
  const mapTextEl = document.getElementById('pwa-map-connect-btn-text');
  const drawerBtn = document.getElementById('pwa-connect-btn');
  const drawerTextEl = document.getElementById('pwa-connect-btn-text') || drawerBtn;

  const currentStatus = currentRider.status || 'Disponível';

  // Desativar botões para prevenir clique duplo durante a transação
  if (mapBtn) mapBtn.disabled = true;
  if (drawerBtn) drawerBtn.disabled = true;

  if (currentStatus === 'Em Descanso') {
    // CONECTAR: Altera status no Postgres para 'Disponível' restrito a user_id = auth.uid()
    if (mapTextEl) mapTextEl.innerText = 'Conectando...';
    if (drawerTextEl) drawerTextEl.innerText = 'Conectando...';

    const { error } = await db
      .from('fleet')
      .update({ status: 'Disponível' })
      .eq('user_id', session.user.id);

    if (error) {
      showPWAToast('Erro ao conectar. Tente novamente.');
      if (mapBtn) mapBtn.disabled = false;
      if (drawerBtn) drawerBtn.disabled = false;
      updateConnectionButtonState(currentStatus);
      return;
    }

    // Confirmação autoritativa do Postgres antes de alterar a UI
    await fetchAndUpdateRiderStatusFromDB();

    if (mapBtn) mapBtn.disabled = false;
    if (drawerBtn) drawerBtn.disabled = false;
    showPWAToast('Você está online!');
    enableRiderNotifications();
  } else {
    // DESCONECTAR: Verificação prévia de teles ativas
    if (mapTextEl) mapTextEl.innerText = 'Desconectando...';
    if (drawerTextEl) drawerTextEl.innerText = 'Desconectando...';

    const activeStatuses = ['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega'];
    const { data: activeTeles, error: countError } = await db
      .from('teles')
      .select('id')
      .eq('motoboy_id', currentRider.id)
      .in('status', activeStatuses);

    if (countError) {
      showPWAToast('Erro ao verificar status de corridas. Tente novamente.');
      if (mapBtn) mapBtn.disabled = false;
      if (drawerBtn) drawerBtn.disabled = false;
      updateConnectionButtonState(currentStatus);
      return;
    }

    if (activeTeles && activeTeles.length > 0) {
      // Exibir modal interno sem alert() nativo
      if (mapBtn) mapBtn.disabled = false;
      if (drawerBtn) drawerBtn.disabled = false;
      updateConnectionButtonState(currentStatus);
      openActiveTelesModal();
      return;
    }

    // Tentar desconectar no Postgres
    const { error: updateError } = await db
      .from('fleet')
      .update({ status: 'Em Descanso' })
      .eq('user_id', session.user.id);

    if (updateError) {
      showPWAToast('Erro ao desconectar. Tente novamente.');
      if (mapBtn) mapBtn.disabled = false;
      if (drawerBtn) drawerBtn.disabled = false;
      updateConnectionButtonState(currentStatus);
      return;
    }

    // Verificação pós-alteração para condição de corrida
    const { data: postCheckTeles } = await db
      .from('teles')
      .select('id')
      .eq('motoboy_id', currentRider.id)
      .in('status', activeStatuses);

    if (postCheckTeles && postCheckTeles.length > 0) {
      // Reverter desconexão!
      await db
        .from('fleet')
        .update({ status: 'Disponível' })
        .eq('user_id', session.user.id);

      if (mapBtn) mapBtn.disabled = false;
      if (drawerBtn) drawerBtn.disabled = false;
      await fetchAndUpdateRiderStatusFromDB();
      openActiveTelesModal();
      return;
    }

    // Confirmação autoritativa do Postgres antes de alterar a UI
    await fetchAndUpdateRiderStatusFromDB();

    if (mapBtn) mapBtn.disabled = false;
    if (drawerBtn) drawerBtn.disabled = false;
    showPWAToast('Você está offline.');
  }
}

// ─── TAB NAVIGATION ──────────────────────────────────────────────────────────

function switchPWATab(tab) {
  safeSetStorage('activePWATab', tab);
  document.querySelectorAll('.pwa-tab').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.pwa-drawer-item').forEach(b => b.classList.remove('active'));

  const tabEl = document.getElementById('pwa-tab-' + tab);
  if (tabEl) tabEl.classList.remove('hidden');

  const navEl = document.getElementById('pwa-nav-' + tab);
  if (navEl) navEl.classList.add('active');

  // Activate bottom bar chat icon if tab is chat
  const bottomChatBtn = document.getElementById('pwa-bottom-chat-btn');
  if (bottomChatBtn) {
    if (tab === 'chat') {
      bottomChatBtn.classList.add('active');
    } else {
      bottomChatBtn.classList.remove('active');
    }
  }

  if (tab === 'map') {
    setTimeout(() => {
      if (!riderMap) {
        initRiderMap();
      } else {
        if (window.google && window.google.maps) {
          window.google.maps.event.trigger(riderMap, 'resize');
        }
        if (lastPosition) {
          riderMap.setCenter({ lat: lastPosition.lat, lng: lastPosition.lng });
        }
      }
    }, 100);
  } else if (tab === 'reports') {
    loadReportsData();
  } else if (tab === 'consumables') {
    loadConsumablesData();
  } else if (tab === 'chat') {
    const chatDot = document.getElementById('pwa-chat-dot');
    if (chatDot) chatDot.classList.add('hidden');
    fetchMotoChatHistory();
  }
  if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
}

// ─── DRAWER MENU NAVIGATION ──────────────────────────────────────────────────

function togglePWADrawer(isOpen) {
  const drawer = document.getElementById('pwa-drawer');
  if (!drawer) return;
  if (isOpen) {
    drawer.classList.add('active');
  } else {
    drawer.classList.remove('active');
  }
}

function handleDrawerNav(tab) {
  switchPWATab(tab);
  togglePWADrawer(false);
}

function handleDrawerLogout() {
  togglePWADrawer(false);
  handleMotoLogout();
}

// ─── LOAD DELIVERIES ─────────────────────────────────────────────────────────

let commercialClientsMapCache = new Map();
let activeTeleDetailsMap = new Map();
let currentModalActionTele = null;
let currentModalActionType = null;

async function loadMyDeliveries() {
  const container = document.getElementById('pwa-teles-container');
  if (container) {
    container.innerHTML = `
      <div class="pwa-loading">
        <div class="pwa-spinner"></div>
        <p>Carregando teles...</p>
      </div>
    `;
  }

  if (!db || !currentRiderId) {
    if (container) renderEmptyStateCard();
    return;
  }

  const { data: telesData, error } = await db
    .from('teles')
    .select('id, tele_code, client_id, motoboy_id, status, version, pickup_address, pickup_latitude, pickup_longitude, delivery_address, delivery_reference, delivery_latitude, delivery_longitude, delivery_number, delivery_complement, delivery_neighborhood, delivery_city, delivery_state, delivery_postal_code, recipient_name, recipient_phone, notes, total_order_amount, delivery_charge, payment_method, created_at, updated_at, completed_at')
    .eq('motoboy_id', currentRiderId)
    .in('status', ['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega'])
    .order('created_at', { ascending: true });

  if (error) {
    logSafeError('loadMyDeliveries', error);
    if (container) container.innerHTML = `<p class="pwa-empty-msg">Erro ao carregar teles. Tente novamente.</p>`;
    return;
  }

  const telesList = telesData || [];

  const clientIds = [...new Set(telesList.map(t => t.client_id).filter(Boolean))];
  if (clientIds.length > 0) {
    try {
      const { data: clientsData } = await db
        .from('commercial_clients')
        .select('id, establishment_name, responsible_name, phone')
        .in('id', clientIds);

      (clientsData || []).forEach(c => {
        commercialClientsMapCache.set(String(c.id), c);
      });
    } catch (e) {
      logSafeError('loadCommercialClients', e);
    }
  }

  const activeDeliveries = await Promise.all(telesList.map(async (item) => {
    let riderEarning = null;
    try {
      const { data: earningRes } = await db.rpc('get_tele_rider_earning', { p_tele_id: item.id });
      if (earningRes !== null && earningRes !== undefined) {
        riderEarning = parseFloat(earningRes);
      }
    } catch (e) {}

    const clientInfo = item.client_id ? commercialClientsMapCache.get(String(item.client_id)) : null;

    const formattedTele = {
      ...item,
      establishment_name: clientInfo?.establishment_name || 'Cliente Comercial',
      client_phone: clientInfo?.phone || null,
      rider_earning: riderEarning,
      rider_earning_display: (riderEarning !== null && !isNaN(riderEarning))
        ? `R$ ${riderEarning.toFixed(2).replace('.', ',')}`
        : 'Valor do motoboy ainda não calculado'
    };

    activeTeleDetailsMap.set(String(item.id), formattedTele);
    return formattedTele;
  }));

  const currentIds = activeDeliveries.map(t => t.id);

  if (knownActiveTeleIds !== null) {
    const newTeles = currentIds.filter(id => !knownActiveTeleIds.includes(id));
    if (newTeles.length > 0) {
      playNotificationSound();
    }
  }
  knownActiveTeleIds = currentIds;
  activeDeliveriesList = activeDeliveries;

  // Sincronizar badge de Minhas Teles (#map-teles-badge)
  const activeCount = activeDeliveries.length;
  const mapBadgeEl = document.getElementById('map-teles-badge');
  if (mapBadgeEl) {
    if (activeCount > 0) {
      mapBadgeEl.innerText = activeCount;
      mapBadgeEl.classList.remove('hidden');
    } else {
      mapBadgeEl.innerText = '0';
      mapBadgeEl.classList.add('hidden');
    }
  }

  updateMapOverlays(activeDeliveries);
  renderTeleCards(activeDeliveries);
}

function formatOrderDateForPWA(dateText, createdAt) {
  const ts = createdAt ? new Date(createdAt) : (dateText ? parseOrderDate(dateText) : new Date());
  if (isNaN(ts.getTime())) return dateText || 'Agora';
  const hrs = String(ts.getHours()).padStart(2, '0');
  const mins = String(ts.getMinutes()).padStart(2, '0');
  const day = String(ts.getDate()).padStart(2, '0');
  const month = String(ts.getMonth() + 1).padStart(2, '0');

  const now = new Date();
  if (ts.getDate() === now.getDate() && ts.getMonth() === now.getMonth() && ts.getFullYear() === now.getFullYear()) {
    return `${hrs}:${mins}`;
  }
  return `${day}/${month}, ${hrs}:${mins}`;
}

function getFixedPriceByAddress(address) {
  const addr = (address || '').toLowerCase();
  if (addr.includes('esteio')) {
    return 10.00;
  }
  return 8.00;
}

function renderEmptyStateCard() {
  const container = document.getElementById('pwa-teles-container');
  if (!container) return;

  const bLvl = currentBatteryLevel !== null ? `${currentBatteryLevel}%` : 'Indisponível';
  const isChargingTxt = (window._batteryManagerRef && window._batteryManagerRef.charging) ? ' (Carregando)' : '';
  const batteryInfo = `${bLvl}${isChargingTxt}`;

  const posTxt = lastPosition ? `Ativo (${lastPosition.lat.toFixed(4)}, ${lastPosition.lng.toFixed(4)})` : 'Buscando GPS...';
  const notifState = ('Notification' in window && Notification.permission === 'granted') ? 'Ativados' : 'Não ativados';
  const lastSync = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const statusRider = (currentRider && currentRider.status === 'Em Descanso') ? 'Offline' : 'Online';

  container.innerHTML = `
    <div class="pwa-empty-state" style="background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 10px;">
      <div style="width: 52px; height: 52px; border-radius: 50%; background: rgba(16, 185, 129, 0.12); display: flex; align-items: center; justify-content: center;">
        <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      </div>
      <h3 style="font-family: var(--font-display); font-size: 1.15rem; font-weight: 800; color: var(--text);">Você está disponível</h3>
      <p style="font-size: 0.85rem; color: var(--muted); margin-bottom: 8px;">Aguardando uma nova entrega</p>

      <div style="width: 100%; border-top: 1px solid var(--border); padding-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.76rem; text-align: left;">
        <div><span style="color: var(--muted);">Status:</span> <strong style="color: ${statusRider === 'Online' ? '#10b981' : '#ef4444'};">${statusRider}</strong></div>
        <div><span style="color: var(--muted);">Bateria:</span> <strong>${batteryInfo}</strong></div>
        <div><span style="color: var(--muted);">GPS:</span> <strong>${posTxt}</strong></div>
        <div><span style="color: var(--muted);">Alertas:</span> <strong>${notifState}</strong></div>
        <div style="grid-column: span 2;"><span style="color: var(--muted);">Última Sincronização:</span> <strong>${lastSync}</strong></div>
      </div>
    </div>
  `;
}

function getCommercialPaymentBadge(paymentMethod) {
  const paymentBadge = 'Faturado';
  if (!paymentMethod) return paymentBadge;
  const pm = paymentMethod.toLowerCase();
  if (pm.includes('dinheiro')) return 'Dinheiro';
  if (pm.includes('cartão') || pm.includes('cartao')) return 'Cartão';
  if (pm.includes('pix')) return 'PIX';
  return paymentBadge;
}

function renderTeleCards(deliveries) {
  const container = document.getElementById('pwa-teles-container');
  if (!container) return;

  if (!deliveries || deliveries.length === 0) {
    renderEmptyStateCard();
    return;
  }

  container.innerHTML = '';

  const currentTele = deliveries[0];
  const upcomingTeles = deliveries.slice(1);

  const currentSection = document.createElement('div');
  currentSection.className = 'pwa-tele-section';
  currentSection.style.marginBottom = '20px';
  currentSection.innerHTML = `
    <div style="font-size: 0.75rem; color: var(--primary); font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
      <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--primary); display: inline-block;"></span>
      Tele Atual (Em Fila)
    </div>
  `;

  const currentCard = createSingleTeleCard(currentTele, true);
  currentSection.appendChild(currentCard);
  container.appendChild(currentSection);

  if (upcomingTeles.length > 0) {
    const upcomingSection = document.createElement('div');
    upcomingSection.className = 'pwa-tele-section';
    upcomingSection.innerHTML = `
      <div style="font-size: 0.75rem; color: var(--muted); font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;">
        Próximas Teles (${upcomingTeles.length})
      </div>
    `;

    upcomingTeles.forEach(tele => {
      const card = createSingleTeleCard(tele, false);
      upcomingSection.appendChild(card);
    });

    container.appendChild(upcomingSection);
  }
}

function createSingleTeleCard(order, isMain) {
  const isCollected = order.status === 'coletada';
  const isInTransit = order.status === 'em_entrega';
  const isAssigned = order.status === 'motoboy_designado' || order.status === 'indo_coletar' || order.status === 'aguardando_coleta';

  let statusBadgeClass = 'badge-busy';
  let statusText = order.status;

  if (isAssigned) statusText = 'Aguardando Coleta';
  else if (isCollected) statusText = 'Coletada';
  else if (isInTransit) statusText = 'Em Entrega';

  const card = document.createElement('div');
  card.className = 'pwa-tele-card';
  card.style.cssText = `
    background: var(--bg-card);
    border: 1px solid ${isMain ? 'var(--primary)' : 'var(--border)'};
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    cursor: pointer;
    transition: transform 0.15s, border-color 0.15s;
  `;

  const orderCode = order.tele_code || order.id;
  const shortDest = [order.delivery_neighborhood, order.delivery_city].filter(Boolean).join(', ') || order.delivery_address || 'Endereço de Entrega';

  let actionButtonHtml = '';
  if (isAssigned) {
    actionButtonHtml = `
      <button class="pwa-btn pwa-btn-primary" onclick="event.stopPropagation(); requestActionConfirmation('${order.id}', 'collect')" style="width: 100%; padding: 10px; font-weight: 700; background: var(--primary); color: #000; border: none; border-radius: 8px; cursor: pointer;">
        Marcar como coletada
      </button>
    `;
  } else if (isCollected) {
    actionButtonHtml = `
      <button class="pwa-btn pwa-btn-primary" onclick="event.stopPropagation(); requestActionConfirmation('${order.id}', 'start')" style="width: 100%; padding: 10px; font-weight: 700; background: #3b82f6; color: #fff; border: none; border-radius: 8px; cursor: pointer;">
        Iniciar entrega
      </button>
    `;
  } else if (isInTransit) {
    actionButtonHtml = `
      <button class="pwa-btn pwa-btn-success" onclick="event.stopPropagation(); requestActionConfirmation('${order.id}', 'complete')" style="width: 100%; padding: 10px; font-weight: 700; background: #10b981; color: #fff; border: none; border-radius: 8px; cursor: pointer;">
        Finalizar entrega
      </button>
    `;
  }

  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center;" onclick="showTeleDetailsModal('${order.id}')">
      <strong style="font-family: var(--font-display); font-size: 1.05rem; color: var(--text);">${orderCode}</strong>
      <span class="pwa-tele-status ${statusBadgeClass}" style="padding: 4px 10px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; background: rgba(255,183,0,0.12); color: var(--primary);">${statusText}</span>
    </div>

    <div style="display: flex; flex-direction: column; gap: 4px; font-size: 0.82rem;" onclick="showTeleDetailsModal('${order.id}')">
      <div><span style="color: var(--muted);">Estabelecimento:</span> <strong style="color: var(--text);">${escapeHtml(order.establishment_name)}</strong></div>
      <div><span style="color: var(--muted);">Destino:</span> <strong style="color: var(--text);">${escapeHtml(shortDest)}</strong></div>
      <div style="display: flex; justify-content: space-between; margin-top: 4px;">
        <span style="color: var(--muted);">Solicitado às: ${formatOrderDateForPWA(null, order.created_at)}</span>
        <strong style="color: #10b981; font-weight: 700;">${order.rider_earning_display}</strong>
      </div>
    </div>

    <div style="margin-top: 4px;">
      ${actionButtonHtml}
    </div>
  `;

  return card;
}

// ─── TELE DETAILS MODAL ───────────────────────────────────────────────────────

function showTeleDetailsModal(teleId) {
  const tele = activeTeleDetailsMap.get(String(teleId));
  if (!tele) return;

  const modal = document.getElementById('pwa-tele-details-modal');
  if (!modal) return;

  const orderCode = tele.tele_code || tele.id;
  document.getElementById('pwa-detail-tele-code').innerText = orderCode;

  // Coleta
  document.getElementById('pwa-detail-client-name').innerText = tele.establishment_name || 'Cliente Comercial';
  document.getElementById('pwa-detail-pickup-address').innerText = tele.pickup_address || 'Endereço de Coleta';
  const clientPhoneEl = document.getElementById('pwa-detail-client-phone-container');
  if (clientPhoneEl) {
    clientPhoneEl.innerText = tele.client_phone ? `Contato: ${tele.client_phone}` : '';
  }

  // Entrega
  document.getElementById('pwa-detail-recipient-name').innerText = tele.recipient_name || 'Destinatário';
  document.getElementById('pwa-detail-recipient-phone').innerText = tele.recipient_phone ? `Tel: ${tele.recipient_phone}` : 'Sem telefone registrado';

  const fullDeliveryAddress = [
    tele.delivery_address,
    tele.delivery_number ? `nº ${tele.delivery_number}` : '',
    tele.delivery_neighborhood ? `- ${tele.delivery_neighborhood}` : '',
    tele.delivery_city ? `/ ${tele.delivery_city}` : ''
  ].filter(Boolean).join(' ');

  document.getElementById('pwa-detail-delivery-address').innerText = fullDeliveryAddress || 'Endereço não informado';

  const detailsTxt = [
    tele.delivery_complement ? `Comp: ${tele.delivery_complement}` : '',
    tele.delivery_reference ? `Ref: ${tele.delivery_reference}` : ''
  ].filter(Boolean).join(' | ');

  document.getElementById('pwa-detail-delivery-details').innerText = detailsTxt;
  document.getElementById('pwa-detail-notes').innerText = tele.notes ? `Obs: ${tele.notes}` : '';

  // Valores
  const orderAmount = parseFloat(tele.total_order_amount) || 0;
  const chargeAmount = parseFloat(tele.delivery_charge) || 0;

  document.getElementById('pwa-detail-order-amount').innerText = formatMoney(orderAmount);
  document.getElementById('pwa-detail-delivery-charge').innerText = formatMoney(chargeAmount);
  document.getElementById('pwa-detail-payment-method').innerText = tele.payment_method || 'Faturado';
  document.getElementById('pwa-detail-rider-earning').innerText = tele.rider_earning_display;

  // Botão WhatsApp
  const whatsappBtn = document.getElementById('pwa-detail-whatsapp-btn');
  if (whatsappBtn) {
    const normPhone = (tele.recipient_phone || '').replace(/\D/g, '');
    let finalPhone = normPhone;
    if (normPhone.length === 10 || normPhone.length === 11) {
      finalPhone = '55' + normPhone;
    }

    if (finalPhone.length >= 12 && finalPhone.startsWith('55')) {
      const msg = encodeURIComponent("Olá, sou o motoboy da Dahora Expresso responsável pela sua entrega.");
      whatsappBtn.disabled = false;
      whatsappBtn.style.opacity = '1';
      whatsappBtn.style.cursor = 'pointer';
      whatsappBtn.innerText = '💬 WhatsApp Cliente';
      whatsappBtn.onclick = () => {
        window.open(`https://wa.me/${finalPhone}?text=${msg}`, '_blank');
      };
    } else {
      whatsappBtn.disabled = true;
      whatsappBtn.style.opacity = '0.5';
      whatsappBtn.style.cursor = 'not-allowed';
      whatsappBtn.innerText = 'Telefone indisponível';
      whatsappBtn.onclick = null;
    }
  }

  // Botão Rota Google Maps
  const routeBtn = document.getElementById('pwa-detail-route-btn');
  if (routeBtn) {
    routeBtn.onclick = () => {
      let routeUrl = '';
      if (tele.delivery_latitude !== null && tele.delivery_longitude !== null && !isNaN(tele.delivery_latitude) && !isNaN(tele.delivery_longitude)) {
        routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${tele.delivery_latitude},${tele.delivery_longitude}&travelmode=driving`;
      } else {
        routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullDeliveryAddress)}&travelmode=driving`;
      }
      window.open(routeUrl, '_blank');
    };
  }

  // Container de Ação Principal no Modal
  const actionContainer = document.getElementById('pwa-detail-action-container');
  if (actionContainer) {
    const isCollected = tele.status === 'coletada';
    const isInTransit = tele.status === 'em_entrega';
    const isAssigned = tele.status === 'motoboy_designado' || tele.status === 'indo_coletar' || tele.status === 'aguardando_coleta';

    if (isAssigned) {
      actionContainer.innerHTML = `
        <button class="pwa-btn pwa-btn-primary" onclick="requestActionConfirmation('${tele.id}', 'collect')" style="width: 100%; padding: 12px; font-weight: 700; font-size: 0.95rem; background: var(--primary); color: #000; border: none; border-radius: 8px; cursor: pointer;">
          Marcar como coletada
        </button>
      `;
    } else if (isCollected) {
      actionContainer.innerHTML = `
        <button class="pwa-btn pwa-btn-primary" onclick="requestActionConfirmation('${tele.id}', 'start')" style="width: 100%; padding: 12px; font-weight: 700; font-size: 0.95rem; background: #3b82f6; color: #fff; border: none; border-radius: 8px; cursor: pointer;">
          Iniciar entrega
        </button>
      `;
    } else if (isInTransit) {
      actionContainer.innerHTML = `
        <button class="pwa-btn pwa-btn-success" onclick="requestActionConfirmation('${tele.id}', 'complete')" style="width: 100%; padding: 12px; font-weight: 700; font-size: 0.95rem; background: #10b981; color: #fff; border: none; border-radius: 8px; cursor: pointer;">
          Finalizar entrega
        </button>
      `;
    } else {
      actionContainer.innerHTML = '';
    }
  }

  modal.classList.remove('hidden');
}

function closeTeleDetailsModal() {
  const modal = document.getElementById('pwa-tele-details-modal');
  if (modal) modal.classList.add('hidden');
}

// ─── ACTION CONFIRMATION MODAL & EXECUTION ─────────────────────────────────────

function requestActionConfirmation(teleId, actionType) {
  const tele = activeTeleDetailsMap.get(String(teleId));
  if (!tele) return;

  currentModalActionTele = tele;
  currentModalActionType = actionType;

  const modal = document.getElementById('pwa-action-confirm-modal');
  const titleEl = document.getElementById('pwa-confirm-title');
  const msgEl = document.getElementById('pwa-confirm-message');
  const submitBtn = document.getElementById('pwa-confirm-submit-btn');

  if (!modal || !submitBtn) return;

  if (actionType === 'collect') {
    titleEl.innerText = 'Confirmar Coleta';
    msgEl.innerText = 'Confirma que o pedido foi coletado?';
    submitBtn.style.background = 'var(--primary)';
    submitBtn.style.color = '#000';
  } else if (actionType === 'start') {
    titleEl.innerText = 'Iniciar Entrega';
    msgEl.innerText = 'Confirma o início do deslocamento para a entrega?';
    submitBtn.style.background = '#3b82f6';
    submitBtn.style.color = '#fff';
  } else if (actionType === 'complete') {
    titleEl.innerText = 'Finalizar Entrega';
    msgEl.innerText = 'Confirma que a entrega foi concluída com sucesso?';
    submitBtn.style.background = '#10b981';
    submitBtn.style.color = '#fff';
  }

  submitBtn.onclick = () => executeConfirmedAction();
  modal.classList.remove('hidden');
}

function closeActionConfirmModal() {
  const modal = document.getElementById('pwa-action-confirm-modal');
  if (modal) modal.classList.add('hidden');
  currentModalActionTele = null;
  currentModalActionType = null;
}

async function executeConfirmedAction() {
  if (!currentModalActionTele || !currentModalActionType || !db) return;

  const tele = currentModalActionTele;
  const actionType = currentModalActionType;

  if (!tele.version || !Number.isInteger(Number(tele.version))) {
    closeActionConfirmModal();
    closeTeleDetailsModal();
    showPWAToast('Versão da entrega é inválida. Os dados foram recarregados.');
    loadMyDeliveries();
    return;
  }

  const expectedVersion = parseInt(tele.version, 10);

  const submitBtn = document.getElementById('pwa-confirm-submit-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Processando...';
  }

  try {
    let rpcName = '';
    if (actionType === 'collect') rpcName = 'mark_my_tele_collected';
    else if (actionType === 'start') rpcName = 'start_my_tele_delivery';
    else if (actionType === 'complete') rpcName = 'complete_my_tele';

    const { data: res, error: rpcErr } = await db.rpc(rpcName, {
      p_tele_id: tele.id,
      p_expected_version: expectedVersion
    });

    closeActionConfirmModal();
    closeTeleDetailsModal();

    if (rpcErr) {
      logSafeError(rpcName, rpcErr);
      showPWAToast('Erro ao processar transição. Tente novamente.');
      return;
    }

    if (res && res.success === false) {
      if (res.error_code === 'TELE_VERSION_CONFLICT') {
        showPWAToast('Esta entrega foi atualizada em outro dispositivo. Os dados foram recarregados.');
        loadMyDeliveries();
      } else {
        showPWAToast(res.message || 'Erro operacional.');
      }
      return;
    }

    if (res && res.success === true) {
      if (actionType === 'complete') {
        showPWAToast('Entrega concluída com sucesso! 🏍️');
      } else if (actionType === 'collect') {
        showPWAToast('Pedido marcado como coletado.');
      } else if (actionType === 'start') {
        showPWAToast('Entrega iniciada com sucesso.');
      }
      loadMyDeliveries();
    }
  } catch (e) {
    logSafeError('executeConfirmedAction', e);
    closeActionConfirmModal();
    showPWAToast('Falha na comunicação com o servidor.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Confirmar';
    }
  }
}

// ─── REALTIME SUBSCRIPTION ────────────────────────────────────────────────────

function subscribeRealtime() {
  if (!db || !currentRider) return;
  if (realtimeChannel) db.removeChannel(realtimeChannel);

  realtimeChannel = db.channel('moto-realtime-' + currentRider.id)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'teles'
    }, (payload) => {
      const isMyTele = (row) => {
        return Boolean(
          row &&
          currentRider &&
          row.motoboy_id === currentRider.id
        );
      };




      if (payload.eventType === 'INSERT') {
        if (isMyTele(payload.new)) {
          showHighPriorityNewTeleModal(payload.new);
          sendWebNotification("Nova Tele Atribuída! 🏍️", `A tele ${payload.new.id} foi atribuída a você.`);
          loadMyDeliveries();
          loadReportsData();
          loadWeeklyBalance();
        }
      } else if (payload.eventType === 'DELETE') {
        const wasMine = isMyTele(payload.old) || (knownActiveTeleIds && knownActiveTeleIds.includes(payload.old?.id));
        if (wasMine) {
          sendWebNotification("Tele Removida! ❌", `A tele ${payload.old?.id} foi removida.`);
          AudioController.playMessageAlert();
          loadMyDeliveries();
          loadReportsData();
          loadWeeklyBalance();
        }
      } else if (payload.eventType === 'UPDATE') {
        const isMine = isMyTele(payload.new);
        const isAlreadyKnown = knownActiveTeleIds && knownActiveTeleIds.includes(payload.new?.id);
        const isNewAssignment = isMine && !isAlreadyKnown;
        const isRemoval = !isMine && isAlreadyKnown;

        if (isNewAssignment) {
          showHighPriorityNewTeleModal(payload.new);
          sendWebNotification("Nova Tele Atribuída! 🏍️", `A tele ${payload.new.id} foi atribuída a você.`);
          loadMyDeliveries();
          loadReportsData();
          loadWeeklyBalance();
        } else if (isRemoval) {
          sendWebNotification("Tele Removida! ❌", `A tele ${payload.new.id} foi removida.`);
          AudioController.playMessageAlert();
          loadMyDeliveries();
          loadReportsData();
          loadWeeklyBalance();
        } else if (isMine) {
          loadMyDeliveries();
          loadReportsData();
          loadWeeklyBalance();
        }
      }
    })
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'support_messages'
    }, (payload) => {

      const newMsg = payload.new;
      if (newMsg.client_email === currentRider.id) {
        if (newMsg.sender_role !== 'rider') {
          playNotificationSound();
          sendWebNotification("Nova Mensagem do Suporte! 💬", `${newMsg.sender_name}: ${newMsg.message}`);
          
          // Check if chat tab is active
          const isChatActive = document.getElementById('pwa-tab-chat') && !document.getElementById('pwa-tab-chat').classList.contains('hidden');
          if (!isChatActive) {
            const chatDot = document.getElementById('pwa-chat-dot');
            if (chatDot) chatDot.classList.remove('hidden');
          }
        }
        
        // Append to chat container if it exists
        const container = document.getElementById('pwa-chat-messages');
        if (container) {
          const emptyState = container.querySelector('svg');
          if (emptyState) {
            container.innerHTML = '';
          }
          
          const isMe = newMsg.sender_role === 'rider';
          const alignStyle = isMe ? 'align-self: flex-end; align-items: flex-end;' : 'align-self: flex-start; align-items: flex-start;';
          const bubbleStyle = isMe 
            ? 'background: linear-gradient(135deg, var(--primary), #c2410c); color: #ffffff; border-radius: 16px 16px 2px 16px; box-shadow: 0 4px 12px rgba(255, 183, 0, 0.25);'
            : 'background: #272732; border: 1px solid var(--border); color: var(--text); border-radius: 16px 16px 16px 2px;';
          const time = newMsg.created_at ? new Date(newMsg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'Agora';

          const div = document.createElement('div');
          div.style.display = 'contents';
          div.innerHTML = `
            <div style="display: flex; flex-direction: column; max-width: 80%; ${alignStyle}">
              <span style="font-size: 0.72rem; color: var(--muted); margin-bottom: 4px; font-weight: 500;">${newMsg.sender_name}</span>
              <div style="padding: 10px 14px; font-size: 0.88rem; line-height: 1.45; word-break: break-word; ${bubbleStyle}">
                ${escapeHtml(newMsg.message)}
              </div>
              <span style="font-size: 0.65rem; color: var(--muted); margin-top: 4px;">${time}</span>
            </div>
          `;
          container.appendChild(div);
          container.scrollTop = container.scrollHeight;
        }
      }
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'rider_consumables'
    }, (payload) => {
      if (!currentRider) return;
      
      const isInsert = payload.eventType === 'INSERT';
      const isDelete = payload.eventType === 'DELETE';
      const isUpdate = payload.eventType === 'UPDATE';
      
      let belongsToMe = false;
      
      if (isInsert && payload.new && payload.new.rider_id === currentRider.id) {
        belongsToMe = true;
        sendWebNotification("Novo Consumível Lançado! 🍔", `Um novo consumível de tipo ${payload.new.item_type} (${formatMoney(parseFloat(payload.new.amount))}) foi lançado para você.`);
        playNotificationSound();
      } else if (isDelete) {
        // Fallback for delete: reload just in case, since old payload may not contain all columns
        belongsToMe = true;
      } else if (isUpdate && (payload.new.rider_id === currentRider.id || (payload.old && payload.old.rider_id === currentRider.id))) {
        belongsToMe = true;
      }
      
      if (belongsToMe) {
        loadConsumablesData();
        loadWeeklyClosures();
      }
    })
    .subscribe();
}

// ─── MAP (SINGLETON LOADER & REUSABLE INSTANCE) ──────────────────────────────

let googleMapsLoaderPromise = null;

function ensureGoogleMapsLoaded() {
  if (window.google && window.google.maps && window.google.maps.Map) {
    return Promise.resolve(true);
  }
  if (window._googleMapsLoaderPromise) {
    return window._googleMapsLoaderPromise;
  }

  const apiKey = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.googleMapsApiKey) ||
                 (window.LOCAL_SUPABASE_CONFIG && window.LOCAL_SUPABASE_CONFIG.googleMapsApiKey) || '';

  if (!apiKey) {
    console.warn("⚠️ Google Maps API Key não configurada.");
    return Promise.resolve(false);
  }

  const existingScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
  if (existingScript) {
    window._googleMapsLoaderPromise = new Promise((resolve) => {
      let checks = 0;
      const interval = setInterval(() => {
        checks++;
        if (window.google && window.google.maps && window.google.maps.Map) {
          clearInterval(interval);
          resolve(true);
        } else if (checks > 100) {
          clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });
    return window._googleMapsLoaderPromise;
  }

  window._googleMapsLoaderPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker&loading=async`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    script.onerror = (err) => {
      console.error("Erro ao carregar script do Google Maps:", err);
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return window._googleMapsLoaderPromise;
}

async function initRiderMap() {
  const mapEl = document.getElementById('pwa-map');
  if (!mapEl) return;

  const loaded = await ensureGoogleMapsLoaded();
  if (!loaded || typeof window.google === 'undefined' || typeof window.google.maps === 'undefined') {
    mapEl.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--muted); font-size:0.82rem; text-align:center; padding:16px;">Aguardando chave do Google Maps Platform em window.SUPABASE_CONFIG.googleMapsApiKey</div>`;
    return;
  }

  if (riderMap) {
    // Reutilizar a instância existente sem reinstanciar o mapa
    window.google.maps.event.trigger(riderMap, 'resize');
    if (lastPosition) {
      riderMap.setCenter({ lat: lastPosition.lat, lng: lastPosition.lng });
    }
    return;
  }

  const centerPos = lastPosition ? { lat: lastPosition.lat, lng: lastPosition.lng } : { lat: -29.842173, lng: -51.126764 };

let currentMapTheme = safeGetStorage('pwaMapTheme') || 'dark';

const darkOperationalStyles = [
  { featureType: 'all', elementType: 'labels.text.fill', stylers: [{ color: '#ffffff' }] },
  { featureType: 'all', elementType: 'labels.text.stroke', stylers: [{ color: '#000000' }, { lightness: 13 }] },
  { featureType: 'administrative', elementType: 'geometry.fill', stylers: [{ color: '#000000' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#144b53' }, { lightness: 14 }, { weight: 1.4 }] },
  { featureType: 'landscape', elementType: 'all', stylers: [{ color: '#181820' }] },
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#272732' }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'on' }] },
  { featureType: 'water', elementType: 'all', stylers: [{ color: '#111827' }] }
];

const lightOperationalStyles = [
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ visibility: 'on' }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'on' }] },
  { featureType: 'administrative', elementType: 'labels', stylers: [{ visibility: 'on' }] }
];

function setMapTheme(theme) {
  currentMapTheme = theme;
  safeSetStorage('pwaMapTheme', theme);
  applyMapThemeUI(theme);
  if (riderMap) {
    const styles = theme === 'dark' ? darkOperationalStyles : lightOperationalStyles;
    riderMap.setOptions({ styles });
  }
  showPWAToast(`Tema do mapa alterado para ${theme === 'dark' ? 'Escuro' : 'Claro'}.`);
}

function applyMapThemeUI(theme) {
  const lightBtn = document.getElementById('btn-theme-light');
  const darkBtn = document.getElementById('btn-theme-dark');
  if (lightBtn && darkBtn) {
    if (theme === 'light') {
      lightBtn.className = 'pwa-filter-pill active';
      darkBtn.className = 'pwa-filter-pill';
    } else {
      darkBtn.className = 'pwa-filter-pill active';
      lightBtn.className = 'pwa-filter-pill';
    }
  }
}

  const cleanOperationalStyles = currentMapTheme === 'dark' ? darkOperationalStyles : lightOperationalStyles;

  const topRightPos = (window.google && window.google.maps && window.google.maps.ControlPosition)
    ? window.google.maps.ControlPosition.TOP_RIGHT
    : 1;

  riderMap = new window.google.maps.Map(mapEl, {
    center: centerPos,
    zoom: 14,
    gestureHandling: 'greedy',
    zoomControl: true,
    zoomControlOptions: {
      position: topRightPos
    },
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    styles: cleanOperationalStyles
  });

  // Permanent Collection Central Marker
  new window.google.maps.Marker({
    position: { lat: -29.842173, lng: -51.126764 },
    map: riderMap,
    title: 'Central de Coleta - Rua Ana Rosa 221'
  });

  if (lastPosition) {
    placeRiderMarker(lastPosition.lat, lastPosition.lng);
  }
}

let riderMarker = null;

function placeRiderMarker(lat, lng) {
  if (!riderMap || typeof window.google === 'undefined') return;

  const pos = { lat, lng };

  if (riderMarker) {
    riderMarker.setPosition(pos);
  } else {
    riderMarker = new window.google.maps.Marker({
      position: pos,
      map: riderMap,
      title: currentRider ? currentRider.name : 'Sua Localização'
    });
  }

  if (!hasCenteredOnce) {
    riderMap.setCenter(pos);
    riderMap.setZoom(15);
    hasCenteredOnce = true;
  }

  updateMapOverlays(activeDeliveriesList || []);
}


let lastBatteryPayloadKey = null;
let lastBatterySentTime = 0;
const BATTERY_THROTTLE_MS = 60000;

async function sendDeviceStatus(batteryLevel, isCharging, batterySupported) {
  if (!db || !currentRider) return;

  const payloadKey = `${batteryLevel}_${isCharging}_${batterySupported}`;
  const now = Date.now();

  if (lastBatteryPayloadKey === payloadKey && (now - lastBatterySentTime) < BATTERY_THROTTLE_MS) {
    return;
  }

  lastBatteryPayloadKey = payloadKey;
  lastBatterySentTime = now;

  try {
    const { error } = await db.rpc('update_my_device_status', {
      p_battery_level: batterySupported ? batteryLevel : null,
      p_is_charging: batterySupported ? isCharging : null,
      p_battery_supported: batterySupported
    });

    if (error) {
      console.warn("update_my_device_status notice:", error.message || error);
    }
  } catch (err) {
    console.warn("update_my_device_status exception:", err.message || err);
  }
}

let isTelemetryInitialized = false;

async function initRiderDeviceTelemetry() {
  showPrivacyConsentNotice();

  if (isTelemetryInitialized) {
    if (currentRider) {
      lastBatterySentTime = 0;
      refreshCurrentBatteryState();
    }
    return;
  }
  isTelemetryInitialized = true;

  if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
    try {
      const battery = await navigator.getBattery();

      window._batteryManagerRef = battery;

      const syncFn = () => {
        const level = Math.round(battery.level * 100);
        const charging = Boolean(battery.charging);
        currentBatteryLevel = level;
        sendDeviceStatus(level, charging, true);
      };

      syncFn();

      battery.addEventListener('levelchange', syncFn);
      battery.addEventListener('chargingchange', () => {
        lastBatterySentTime = 0;
        syncFn();
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          syncFn();
        }
      });
      return;
    } catch (err) {
      console.warn("navigator.getBattery fallback notice:", err.message || err);
    }
  }

  // Fallback para navegadores sem suporte ou permissão negada (executa apenas uma vez)
  sendDeviceStatus(null, null, false);
}

function refreshCurrentBatteryState() {
  if (window._batteryManagerRef) {
    const level = Math.round(window._batteryManagerRef.level * 100);
    const charging = Boolean(window._batteryManagerRef.charging);
    sendDeviceStatus(level, charging, true);
  } else {
    sendDeviceStatus(null, null, false);
  }
}

function showPrivacyConsentNotice() {
  if (!safeGetStorage('privacy_consent_shown')) {
    safeSetStorage('privacy_consent_shown', 'true');
    showPWAToast('O aplicativo utiliza localização e o nível de bateria para acompanhamento operacional.');
  }
}

function startGeolocation() {
  if (!navigator.geolocation) return;

  initRiderDeviceTelemetry();

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      lastPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (riderMap) placeRiderMarker(lastPosition.lat, lastPosition.lng);

      if (db && currentRider) {
        await db
          .from('fleet')
          .update({ lat: lastPosition.lat, lng: lastPosition.lng })
          .eq('id', currentRider.id);
      }
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}


// ─── TOAST ───────────────────────────────────────────────────────────────────

function showPWAToast(msg) {
  if (typeof document === 'undefined' || !document.body) return;
  let container = document.getElementById('pwa-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'pwa-toast-container';
    container.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;width:90%;max-width:360px;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.style.cssText = 'background:#181820;border-left:4px solid #ffb700;border:1px solid #272732;border-left:4px solid #ffb700;color:#f4f4f5;padding:14px 18px;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,0.4);font-size:0.9rem;font-weight:500;text-align:center;';
  toast.innerText = msg;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => { if (toast && typeof toast.remove === 'function') toast.remove(); }, 300);
  }, 3500);
}

// ─── NOTIFICATION AUDIO SYNTHESIZER ──────────────────────────────────────────

let audioContextUnlocked = false;
function unlockAudioContext() {
  if (audioContextUnlocked) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        audioContextUnlocked = true;
        document.removeEventListener('click', unlockAudioContext);
        document.removeEventListener('touchstart', unlockAudioContext);
      });
    } else {
      audioContextUnlocked = true;
      document.removeEventListener('click', unlockAudioContext);
      document.removeEventListener('touchstart', unlockAudioContext);
    }
  } catch (e) {
    console.error('AudioContext unlock failed:', e);
  }
}
document.addEventListener('click', unlockAudioContext);
document.addEventListener('touchstart', unlockAudioContext);

function playNotificationSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    
    const now = ctx.currentTime;
    
    // Play a crisp bell chime 3 times (constant bell ringing)
    for (let i = 0; i < 3; i++) {
      const startTime = now + i * 0.75; // 750ms spacing between rings
      const duration = 0.55;
      
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, startTime); // D5
      
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, startTime); // A5 (consonant fifth)
      
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.55, startTime + 0.04); // Quick attack
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration); // Smooth decay
      
      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      osc1.start(startTime);
      osc1.stop(startTime + duration);
      osc2.start(startTime);
      osc2.stop(startTime + duration);
    }
  } catch (error) {
    console.error('Error playing notification sound:', error);
  }
}

// ─── PROFILE AND STATS HELPERS ───────────────────────────────────────────────

let localProfileImage = null;
let currentPeriod = 'day';
let riderHistory = [];

function loadLocalProfile() {
  if (!currentRider) return;
  const localAvatar = safeGetStorage(`speedRiderAvatar_${currentRider.id}`);
  const localEmail = safeGetStorage(`speedRiderEmail_${currentRider.id}`) || 'motoboy@speedlog.com.br';
  
  localProfileImage = localAvatar || null;

  // Update Drawer Profile Image
  const drawerImg = document.getElementById('drawer-avatar-img');
  const drawerPlaceholder = document.getElementById('drawer-avatar-placeholder');
  if (localAvatar && drawerImg && drawerPlaceholder) {
    drawerImg.src = localAvatar;
    drawerImg.classList.remove('hidden');
    drawerPlaceholder.classList.add('hidden');
  } else if (drawerImg && drawerPlaceholder) {
    drawerImg.classList.add('hidden');
    drawerPlaceholder.classList.remove('hidden');
  }

  // Update Floating Map Profile Image
  const mapImg = document.getElementById('map-avatar-img');
  const mapPlaceholder = document.getElementById('map-avatar-placeholder');
  if (localAvatar && mapImg && mapPlaceholder) {
    mapImg.src = localAvatar;
    mapImg.classList.remove('hidden');
    mapPlaceholder.classList.add('hidden');
  } else if (mapImg && mapPlaceholder) {
    mapImg.classList.add('hidden');
    mapPlaceholder.classList.remove('hidden');
  }

  // Pre-fill Profile Edit Form
  const profileName = document.getElementById('profile-name');
  const profileEmail = document.getElementById('profile-email');
  const profilePin = document.getElementById('profile-pin');
  const profileUrl = document.getElementById('profile-avatar-url');
  
  if (profileName) profileName.value = currentRider.name || '';
  if (profileEmail) profileEmail.value = localEmail;
  if (profilePin) profilePin.value = currentRider.pin || '';
  if (profileUrl) profileUrl.value = (localAvatar && !localAvatar.startsWith('data:')) ? localAvatar : '';

  updateProfilePreview(localAvatar);
}

function updateProfilePreview(imgSrc) {
  const profileImg = document.getElementById('profile-avatar-img');
  const profilePlaceholder = document.getElementById('profile-avatar-placeholder');
  if (imgSrc && profileImg && profilePlaceholder) {
    profileImg.src = imgSrc;
    profileImg.classList.remove('hidden');
    profilePlaceholder.classList.add('hidden');
  } else if (profileImg && profilePlaceholder) {
    profileImg.classList.add('hidden');
    profilePlaceholder.classList.remove('hidden');
  }
}

// ─── FILE UPLOAD AND PHOTO LINK HANDLING ────────────────────────────────────

function handleProfileUrlInput(url) {
  localProfileImage = url.trim() || null;
  updateProfilePreview(localProfileImage);
}

function handleProfileImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    localProfileImage = e.target.result;
    updateProfilePreview(localProfileImage);
    const urlInput = document.getElementById('profile-avatar-url');
    if (urlInput) urlInput.value = ''; // clear URL input to avoid confusion
  };
  reader.readAsDataURL(file);
}

function clearProfileImage() {
  localProfileImage = null;
  updateProfilePreview(null);
  const fileInput = document.getElementById('profile-file-input');
  const urlInput = document.getElementById('profile-avatar-url');
  if (fileInput) fileInput.value = '';
  if (urlInput) urlInput.value = '';
}

async function saveProfileChanges(event) {
  event.preventDefault();
  if (!db || !currentRider) return;

  const email = document.getElementById('profile-email').value.trim();
  const pin = document.getElementById('profile-pin').value.trim();
  const saveBtn = document.getElementById('save-profile-btn');

  if (pin.length !== 4 || isNaN(pin)) {
    alert('O PIN deve conter exatamente 4 dígitos numéricos.');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.innerText = 'Salvando...';

  // 1. Update PIN on Supabase
  const { error } = await db
    .from('fleet')
    .update({ pin })
    .eq('id', currentRider.id);

  saveBtn.disabled = false;
  saveBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    Salvar Alterações
  `;

  if (error) {
    alert('Erro ao salvar no banco de dados. Tente novamente.');
    return;
  }

  // 2. Persist local variables (email and photo)
  safeSetStorage(`speedRiderEmail_${currentRider.id}`, email);
  if (localProfileImage) {
    safeSetStorage(`speedRiderAvatar_${currentRider.id}`, localProfileImage);
  } else {
    safeRemoveStorage(`speedRiderAvatar_${currentRider.id}`);
  }

  // Update session
  currentRider.pin = pin;
  safeSetStorage('speedMotoSession', JSON.stringify(currentRider));

  // Reload profile indicators in UI
  loadLocalProfile();
  showPWAToast('Perfil atualizado com sucesso!');
  switchPWATab('map');
}

// ─── FINANCIAL CALCULATIONS AND HISTORICAL DATA ──────────────────────────────

function parseMoney(value) {
  if (!value) return 0;
  return parseFloat(String(value).replace(/[^\d,.-]/g, '').replace(',', '.')) || 0;
}

function formatMoney(value) {
  return 'R$ ' + value.toFixed(2).replace('.', ',');
}

function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  return new Date(dateStr);
}

function parseOrderDate(dateText) {
  const raw = String(dateText || '').trim();
  const now = new Date();
  if (!raw) return now;
  if (raw.startsWith('Hoje')) {
    return now;
  }
  if (raw.startsWith('Ontem')) {
    const d = new Date(now);
    d.setDate(now.getDate() - 1);
    return d;
  }
  const brDate = raw.match(/(\d{2})\/(\d{2})(?:\/(\d{4}))?/);
  if (brDate) {
    const year = brDate[3] ? parseInt(brDate[3]) : now.getFullYear();
    const month = parseInt(brDate[2]) - 1;
    const day = parseInt(brDate[1]);
    return new Date(year, month, day);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

function isDateToday(date) {
  const today = new Date();
  return date.getDate() === today.getDate() &&
         date.getMonth() === today.getMonth() &&
         date.getFullYear() === today.getFullYear();
}

function isDateInCurrentWeek(date) {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(today.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return date >= monday && date <= sunday;
}

function isDateInCurrentMonth(date) {
  const today = new Date();
  return date.getMonth() === today.getMonth() &&
         date.getFullYear() === today.getFullYear();
}

async function loadWeeklyBalance() {
  const balanceEl = document.getElementById('drawer-weekly-balance');
  if (!db || !currentRider) return;

  const { data, error } = await db
    .from('teles')
    .select('delivery_charge, created_at, delivery_address, status')
    .eq('motoboy_id', currentRider.id)
    .in('status', ['concluida', 'concluido', 'entregue', 'Entregue']);




  if (error || !data) return;

  const { data: credits, error: creditsErr } = await db
    .from('rider_credits_ledger')
    .select('amount, target_date')
    .eq('motoboy_id', currentRider.id);

  let totalWeekly = 0;
  data.forEach(order => {
    const orderDate = parseOrderDate(order.date || order.created_at);
    if (isDateInCurrentWeek(orderDate)) {
      totalWeekly += parseFloat(order.delivery_charge || 0);
    }
  });

  if (!creditsErr && credits) {
    credits.forEach(c => {
      const creditDate = parseLocalDate(c.target_date);
      if (creditDate && isDateInCurrentWeek(creditDate)) {
        totalWeekly += parseFloat(c.amount) || 0;
      }
    });
  }

  if (balanceEl) balanceEl.innerText = formatMoney(totalWeekly);
}

// ─── MAP INTERACTION OVERLAYS ───────────────────────────────────────────────

function safeAddRouteLayer(mapInstance, sourceId, layerId, startCoords, endCoords, color) {
  if (!mapInstance) return;

  const geojson = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [startCoords[1], startCoords[0]], // [lng, lat]
        [endCoords[1], endCoords[0]]
      ]
    }
  };

  const draw = () => {
    if (!mapInstance.getSource(sourceId)) {
      mapInstance.addSource(sourceId, { type: 'geojson', data: geojson });
      mapInstance.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': color || '#10b981',
          'line-width': 3.5,
          'line-dasharray': [2, 4]
        }
      });
    } else {
      const src = mapInstance.getSource(sourceId);
      if (src && typeof src.setData === 'function') {
        src.setData(geojson);
      }
    }
  };

  if (mapInstance.isStyleLoaded()) {
    draw();
  } else {
    mapInstance.once('style.load', draw);
  }
}

function safeRemoveRouteLayer(mapInstance, sourceId, layerId) {
  if (!mapInstance) return;
  const remove = () => {
    if (mapInstance.getLayer(layerId)) {
      mapInstance.removeLayer(layerId);
    }
    if (mapInstance.getSource(sourceId)) {
      mapInstance.removeSource(sourceId);
    }
  };

  if (mapInstance.isStyleLoaded()) {
    remove();
  } else {
    mapInstance.once('style.load', remove);
  }
}

function centerMapOnRider() {
  if (riderMap && lastPosition) {
    riderMap.setCenter([lastPosition.lng, lastPosition.lat]);
    riderMap.setZoom(16);
  }
}

function updateMapOverlays(deliveries) {
  // Update badge count
  const badge = document.getElementById('map-teles-badge');
  if (badge) {
    if (deliveries.length > 0) {
      badge.innerText = deliveries.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (!riderMap) return;

  if (!riderMap || typeof window.google === 'undefined' || typeof window.google.maps === 'undefined') return;

  const bounds = new window.google.maps.LatLngBounds();
  if (lastPosition && lastPosition.lat && lastPosition.lng) {
    bounds.extend(new window.google.maps.LatLng(lastPosition.lat, lastPosition.lng));
  }

  const currentActiveIds = new Set();

  deliveries.forEach(order => {
    let targetLat = null;
    let targetLng = null;
    let title = '';

    if (order.status === 'Em rota de entrega') {
      targetLat = order.dest_lat !== null ? parseFloat(order.dest_lat) : null;
      targetLng = order.dest_lng !== null ? parseFloat(order.dest_lng) : null;
      title = `Entrega: ${order.destName || 'Cliente'}`;
    }

    if (targetLat !== null && targetLng !== null && !isNaN(targetLat) && !isNaN(targetLng)) {
      currentActiveIds.add(order.id);
      const pos = { lat: targetLat, lng: targetLng };
      bounds.extend(new window.google.maps.LatLng(targetLat, targetLng));

      if (activeRiderDeliveryMarkers[order.id]) {
        const entry = activeRiderDeliveryMarkers[order.id];
        if (entry.lat !== targetLat || entry.lng !== targetLng) {
          entry.marker.setPosition(pos);
          entry.lat = targetLat;
          entry.lng = targetLng;
        }
      } else {
        const marker = new window.google.maps.Marker({
          position: pos,
          map: riderMap,
          title: title
        });
        activeRiderDeliveryMarkers[order.id] = { marker, lat: targetLat, lng: targetLng };
      }
    }
  });

  for (const id in activeRiderDeliveryMarkers) {
    if (!currentActiveIds.has(id)) {
      const entry = activeRiderDeliveryMarkers[id];
      if (entry.marker && typeof entry.marker.setMap === 'function') {
        entry.marker.setMap(null);
      }
      delete activeRiderDeliveryMarkers[id];
    }
  }


  // Fit bounds once if active tele ID changed to show both the rider and target clearly
  const activeTeleId = deliveries.length > 0 ? deliveries[0].id : null;
  if (activeTeleId !== lastActiveTeleId && !bounds.isEmpty()) {
    riderMap.fitBounds(bounds, { padding: 50, maxZoom: 16 });
    lastActiveTeleId = activeTeleId;
  } else if (activeTeleId === null) {
    lastActiveTeleId = null;
  }
}

function triggerQuickAction() {
  const btn = document.getElementById('map-quick-action-btn');
  if (!btn) return;
  const teleId = btn.dataset.teleId;
  const status = btn.dataset.teleStatus;
  
  if (!teleId || !status) return;
  
  if (status === 'A caminho da coleta') {
    confirmPickup(teleId);
  } else if (status === 'Em rota de entrega') {
    confirmDelivery(teleId);
  }
}

// ─── REPORTS GENERATOR AND PERIOD FILTER ─────────────────────────────────────

async function loadReportsData() {
  const listContainer = document.getElementById('pwa-reports-list-container');
  if (listContainer) {
    listContainer.innerHTML = `
      <div class="pwa-loading" style="padding: 30px 0;">
        <div class="pwa-spinner"></div>
      </div>
    `;
  }

  if (!db || !currentRider) return;

  const { data, error } = await db
    .from('teles')
    .select('*')
    .eq('motoboy_id', currentRider.id)
    .in('status', ['concluida', 'concluido', 'entregue', 'Entregue'])
    .order('created_at', { ascending: false });




  if (error || !data) {
    if (listContainer) listContainer.innerHTML = '<p class="pwa-empty-msg">Erro ao carregar histórico.</p>';
    return;
  }

  riderHistory = (data || []).map(item => {
    const fixedPrice = getFixedPriceByAddress(item.address);
    const valorRepasseLiquido = fixedPrice * 0.90;
    return {
      ...item,
      price: `R$ ${valorRepasseLiquido.toFixed(2).replace('.', ',')}`
    };
  });
  renderReports(currentPeriod);
  loadWeeklyClosures();
}

function applyCustomDateFilter() {
  const startVal = document.getElementById('pwa-filter-start-date').value;
  const endVal = document.getElementById('pwa-filter-end-date').value;

  if (!startVal && !endVal) {
    showPWAToast("Escolha pelo menos uma data.");
    return;
  }

  currentPeriod = 'custom';

  // Deactivate period selector pills since we are in custom mode
  document.querySelectorAll('.pwa-reports-filters .pwa-filter-pill').forEach(btn => {
    btn.classList.remove('active');
  });

  renderReports('custom');
  loadWeeklyClosures();
}

function clearCustomDateFilter() {
  document.getElementById('pwa-filter-start-date').value = '';
  document.getElementById('pwa-filter-end-date').value = '';

  // Restore default day filter
  setReportsPeriod('day');
}

function setReportsPeriod(period) {
  currentPeriod = period;
  
  // Update filter pills active class
  document.querySelectorAll('.pwa-reports-filters .pwa-filter-pill').forEach(btn => {
    btn.classList.remove('active');
  });
  const activeBtn = document.getElementById('filter-btn-' + period);
  if (activeBtn) activeBtn.classList.add('active');

  renderReports(period);
}

function renderReports(period) {
  const listContainer = document.getElementById('pwa-reports-list-container');
  const totalEarnedEl = document.getElementById('reports-total-earned');
  const totalCountEl = document.getElementById('reports-total-count');

  if (!listContainer) return;

  let startDate = null;
  let endDate = null;

  const startVal = document.getElementById('pwa-filter-start-date').value;
  const endVal = document.getElementById('pwa-filter-end-date').value;

  if (startVal) {
    startDate = new Date(startVal);
    startDate.setHours(0, 0, 0, 0);
  }
  if (endVal) {
    endDate = new Date(endVal);
    endDate.setHours(23, 59, 59, 999);
  }

  // Filter deliveries based on date period
  const filtered = riderHistory.filter(order => {
    const orderDate = parseOrderDate(order.date);
    if (period === 'custom') {
      if (startDate && orderDate < startDate) return false;
      if (endDate && orderDate > endDate) return false;
      return true;
    }
    if (period === 'day') return isDateToday(orderDate);
    if (period === 'week') return isDateInCurrentWeek(orderDate);
    if (period === 'month') return isDateInCurrentMonth(orderDate);
    return false;
  });

  // Calculate totals
  let totalEarned = 0;
  filtered.forEach(order => {
    totalEarned += parseMoney(order.price);
  });

  if (totalEarnedEl) totalEarnedEl.innerText = formatMoney(totalEarned);
  if (totalCountEl) totalCountEl.innerText = filtered.length;

  // Render items
  if (filtered.length === 0) {
    listContainer.innerHTML = '<p class="pwa-empty-msg" style="text-align:center; color:var(--muted); margin: 30px 0; font-size:0.85rem;">Nenhuma tele entregue neste período.</p>';
    return;
  }

  listContainer.innerHTML = filtered.map(order => `
    <div class="pwa-report-item">
      <div>
        <strong style="font-family: var(--font-display); font-size: 0.9rem; color: var(--text);">${order.id}</strong>
        <p style="font-size: 0.78rem; color: var(--muted); margin-top: 2px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; max-width: 170px;">${order.address}</p>
        <span style="font-size: 0.72rem; color: var(--muted); display: block; margin-top: 4px;">${order.date}</span>
      </div>
      <div style="text-align: right;">
        <strong style="font-size: 0.95rem; color: #10b981;">${order.price}</strong>
        <span style="font-size: 0.7rem; color: var(--success); font-weight: 700; display: block; text-transform: uppercase; margin-top: 2px;">Entregue</span>
      </div>
    </div>
  `).join('');
}

function switchReportsView(view) {
  const historyToggle = document.getElementById('reports-toggle-history');
  const weeksToggle = document.getElementById('reports-toggle-weeks');
  const historyView = document.getElementById('reports-history-view');
  const weeksView = document.getElementById('reports-weeks-view');

  if (view === 'history') {
    if (historyToggle) historyToggle.classList.add('active');
    if (weeksToggle) weeksToggle.classList.remove('active');
    if (historyView) historyView.classList.remove('hidden');
    if (weeksView) weeksView.classList.add('hidden');
  } else {
    if (historyToggle) historyToggle.classList.remove('active');
    if (weeksToggle) weeksToggle.classList.add('active');
    if (historyView) historyView.classList.add('hidden');
    if (weeksView) weeksView.classList.remove('hidden');
    loadWeeklyClosures();
  }
}

async function loadWeeklyClosures() {
  const container = document.getElementById('pwa-weeks-list-container');
  if (container) {
    container.innerHTML = `
      <div class="pwa-loading" style="padding: 30px 0;">
        <div class="pwa-spinner"></div>
      </div>
    `;
  }

  if (!db || !currentRider) return;

  try {
    const { data: deliveries, error: deliveriesErr } = await db
      .from('teles')
      .select('id, delivery_charge, created_at')
      .eq('motoboy_id', currentRider.id)
      .in('status', ['concluida', 'concluido', 'entregue', 'Entregue']);




    if (deliveriesErr) throw deliveriesErr;

    let consumables = [];
    try {
      const { data: cData, error: cErr } = await db
        .from('rider_consumable_purchases')
        .select('*')
        .eq('motoboy_id', currentRider.id);
      if (!cErr && cData) consumables = cData;
    } catch (e) {
      console.warn("Aviso ao buscar rider_consumable_purchases:", e.message);
    }

    const { data: credits, error: creditsErr } = await db
      .from('rider_credits_ledger')
      .select('*')
      .eq('motoboy_id', currentRider.id);

    if (creditsErr) throw creditsErr;

    const weeks = {};

    function getMondayOfDate(date) {
      const d = new Date(date);
      const day = d.getDay();
      const monday = new Date(d);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(d.getDate() - ((day + 6) % 7));
      return monday;
    }

    (deliveries || []).forEach(order => {
      const orderDate = parseOrderDate(order.date);
      const mon = getMondayOfDate(orderDate);
      const key = mon.toISOString();

      if (!weeks[key]) {
        weeks[key] = {
          monday: mon,
          sunday: new Date(mon),
          deliveriesCount: 0,
          gross: 0,
          consumablesTotal: 0,
          creditsTotal: 0,
          creditsList: [],
          isPaid: true
        };
        weeks[key].sunday.setDate(mon.getDate() + 6);
        weeks[key].sunday.setHours(23, 59, 59, 999);
      }

      weeks[key].deliveriesCount += 1;
      weeks[key].gross += getFixedPriceByAddress(order.address);
      if (order.payment_status !== 'Pago') {
        weeks[key].isPaid = false;
      }
    });

    (consumables || []).forEach(item => {
      const itemDate = item.created_at ? new Date(item.created_at) : new Date();
      const mon = getMondayOfDate(itemDate);
      const key = mon.toISOString();

      if (!weeks[key]) {
        weeks[key] = {
          monday: mon,
          sunday: new Date(mon),
          deliveriesCount: 0,
          gross: 0,
          consumablesTotal: 0,
          creditsTotal: 0,
          creditsList: [],
          isPaid: true
        };
        weeks[key].sunday.setDate(mon.getDate() + 6);
        weeks[key].sunday.setHours(23, 59, 59, 999);
      }

      weeks[key].consumablesTotal += parseFloat(item.amount) || 0;
    });

    (credits || []).forEach(item => {
      const itemDate = parseLocalDate(item.target_date);
      const mon = getMondayOfDate(itemDate);
      const key = mon.toISOString();

      if (!weeks[key]) {
        weeks[key] = {
          monday: mon,
          sunday: new Date(mon),
          deliveriesCount: 0,
          gross: 0,
          consumablesTotal: 0,
          creditsTotal: 0,
          creditsList: [],
          isPaid: true
        };
        weeks[key].sunday.setDate(mon.getDate() + 6);
        weeks[key].sunday.setHours(23, 59, 59, 999);
      }

      weeks[key].creditsTotal = (weeks[key].creditsTotal || 0) + (parseFloat(item.amount) || 0);
      if (!weeks[key].creditsList) weeks[key].creditsList = [];
      weeks[key].creditsList.push(item);
    });

    renderWeeklyClosures(weeks);
  } catch (err) {
    console.error("Error loading weekly closures:", err);
    if (container) container.innerHTML = '<p class="pwa-empty-msg">Erro ao carregar fechamentos.</p>';
  }
}

function renderWeeklyClosures(weeks) {
  const container = document.getElementById('pwa-weeks-list-container');
  if (!container) return;

  let startDate = null;
  let endDate = null;

  if (currentPeriod === 'custom') {
    const startVal = document.getElementById('pwa-filter-start-date').value;
    const endVal = document.getElementById('pwa-filter-end-date').value;

    if (startVal) {
      startDate = new Date(startVal);
      startDate.setHours(0, 0, 0, 0);
    }
    if (endVal) {
      endDate = new Date(endVal);
      endDate.setHours(23, 59, 59, 999);
    }
  }

  const sortedKeys = Object.keys(weeks).filter(key => {
    const week = weeks[key];
    if (currentPeriod === 'custom') {
      if (startDate && week.sunday < startDate) return false;
      if (endDate && week.monday > endDate) return false;
    }
    return true;
  }).sort((a, b) => new Date(b) - new Date(a));

  if (sortedKeys.length === 0) {
    container.innerHTML = `
      <div class="pwa-empty-state" style="text-align: center; padding: 40px 20px; color: var(--muted);">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 16px; opacity: 0.3; display: block; margin-left: auto; margin-right: auto;"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
        <p style="font-size: 1rem; font-weight: 600; color: var(--text); margin-bottom: 6px;">Nenhum fechamento semanal.</p>
        <span style="font-size: 0.85rem;">Você não possui corridas ou consumíveis registrados.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  sortedKeys.forEach(key => {
    const week = weeks[key];
    const gross = week.gross;
    const discount = gross * 0.10;
    const consumables = week.consumablesTotal || 0;
    const credits = week.creditsTotal || 0;
    const net = gross * 0.90 - consumables + credits;

    const fmt = { day: '2-digit', month: '2-digit' };
    const dateRangeLabel = `${week.monday.toLocaleDateString('pt-BR', fmt)} a ${week.sunday.toLocaleDateString('pt-BR', fmt)}`;

    const statusBadge = week.isPaid 
      ? `<span class="pwa-tele-status status-success" style="font-weight: 700; text-transform: uppercase;">PAGO</span>`
      : `<span class="pwa-tele-status status-progress" style="font-weight: 700; text-transform: uppercase;">PENDENTE</span>`;

    let creditsDetailHtml = '';
    if (week.creditsList && week.creditsList.length > 0) {
      creditsDetailHtml = week.creditsList.map(c => {
        const itemDate = parseLocalDate(c.target_date);
        const dateFmt = itemDate ? itemDate.toLocaleDateString('pt-BR') : '';
        return `
          <div style="display: flex; justify-content: space-between; font-size: 0.76rem; color: #10b981; padding-left: 12px; margin-top: 1px;">
            <span>↳ + ${formatMoney(c.amount)} (${c.description} - ${dateFmt})</span>
          </div>
        `;
      }).join('');
    }

    const card = document.createElement('div');
    card.className = 'pwa-tele-card';
    card.style.marginBottom = '14px';
    card.innerHTML = `
      <div class="pwa-tele-header" style="padding: 12px 16px;">
        <strong class="pwa-tele-id" style="font-size: 0.95rem; color: var(--text); font-family: var(--font-display);">${dateRangeLabel}</strong>
        ${statusBadge}
      </div>
      <div class="pwa-tele-body" style="padding: 12px 16px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
          <span style="color: var(--muted);">Corridas Concluídas:</span>
          <strong>${week.deliveriesCount}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
          <span style="color: var(--muted);">Consumíveis / Vales:</span>
          <strong style="color: var(--error);">- ${formatMoney(consumables)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
          <span style="color: var(--muted);">Créditos Adicionais:</span>
          <strong style="color: #10b981;">+ ${formatMoney(credits)}</strong>
        </div>
        ${creditsDetailHtml}
        <hr style="border: 0; border-top: 1px solid var(--border); margin: 4px 0;">
        <div style="display: flex; justify-content: space-between; font-size: 0.95rem; font-weight: 700;">
          <span style="color: var(--text);">Saldo Líquido:</span>
          <strong style="color: #10b981;">${formatMoney(net)}</strong>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

// ─── CONSUMABLES LOADER AND RENDERER ─────────────────────────────────────────

async function loadConsumablesData() {
  const container = document.getElementById('pwa-consumables-list-container');
  if (container) {
    container.innerHTML = `
      <div class="pwa-loading" style="padding: 30px 0;">
        <div class="pwa-spinner"></div>
      </div>
    `;
  }

  if (!db || !currentRider) return;

  try {
    let { data, error } = await db
      .from('rider_consumable_purchases')
      .select('*')
      .eq('motoboy_id', currentRider.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.warn("Aviso ao buscar rider_consumable_purchases:", error.message);
      data = [];
    }

    renderConsumablesList(data || []);
  } catch (err) {
    console.warn("Aviso ao carregar consumíveis:", err.message);
    if (container) container.innerHTML = '<p class="pwa-empty-msg">Nenhum consumível registrado.</p>';
  }
}

function renderConsumablesList(list) {
  const container = document.getElementById('pwa-consumables-list-container');
  const totalAmountEl = document.getElementById('consumables-total-amount');

  if (!container) return;

  let totalAmount = 0;
  if (list.length === 0) {
    container.innerHTML = `
      <div class="pwa-empty-state" style="text-align: center; padding: 40px 20px; color: var(--muted);">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 16px; opacity: 0.3; display: block; margin-left: auto; margin-right: auto;"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
        <p style="font-size: 1rem; font-weight: 600; color: var(--text); margin-bottom: 6px;">Nenhum consumível lançado.</p>
        <span style="font-size: 0.85rem;">Você não possui lançamentos de consumíveis.</span>
      </div>
    `;
    if (totalAmountEl) totalAmountEl.innerText = formatMoney(0);
    return;
  }

  container.innerHTML = '';
  list.forEach(item => {
    const amount = parseFloat(item.amount) || 0;
    totalAmount += amount;

    const date = item.created_at ? new Date(item.created_at).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) : 'Data desconhecida';

    const card = document.createElement('div');
    card.className = 'pwa-report-item';
    card.style.background = 'var(--bg-card)';
    card.style.border = '1px solid var(--border)';
    card.style.borderRadius = 'var(--radius)';
    card.style.padding = '14px 16px';
    card.style.marginBottom = '10px';
    card.style.display = 'flex';
    card.style.justifyContent = 'space-between';
    card.style.alignItems = 'center';

    card.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 4px; text-align: left;">
        <strong style="font-size: 0.95rem; font-weight: 700; color: var(--text);">${escapeHtml(item.item_type)}</strong>
        <span style="font-size: 0.72rem; color: var(--muted);">${date}</span>
      </div>
      <strong style="font-size: 1rem; color: var(--error); font-weight: 800;">- ${formatMoney(amount)}</strong>
    `;
    container.appendChild(card);
  });

  if (totalAmountEl) totalAmountEl.innerText = formatMoney(totalAmount);
}

// ─── PWA INSTALLATION HANDLER ────────────────────────────────────────────────

let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent Chrome 67 and earlier from automatically showing the prompt
  e.preventDefault();
  // Stash the event so it can be triggered later.
  deferredPrompt = e;
  
  // Show install buttons
  const loginInstallBtn = document.getElementById('pwa-install-app-btn');
  const drawerInstallBtn = document.getElementById('pwa-nav-install');
  
  if (loginInstallBtn) loginInstallBtn.classList.remove('hidden');
  if (drawerInstallBtn) drawerInstallBtn.classList.remove('hidden');
});

function triggerAppInstall() {
  if (!deferredPrompt) {
    alert('O atalho já foi instalado ou não é suportado pelo seu navegador atual. Se estiver usando iPhone/Safari, toque no botão de compartilhar e selecione "Adicionar à Tela de Início".');
    return;
  }
  
  // Show the prompt
  deferredPrompt.prompt();
  
  // Wait for the user to respond to the prompt
  deferredPrompt.userChoice.then((choiceResult) => {
    if (choiceResult.outcome === 'accepted') {
      showPWAToast('Obrigado por instalar o aplicativo!');
    }
    deferredPrompt = null;
    
    // Hide install buttons
    const loginInstallBtn = document.getElementById('pwa-install-app-btn');
    const drawerInstallBtn = document.getElementById('pwa-nav-install');
    
    if (loginInstallBtn) loginInstallBtn.classList.add('hidden');
    if (drawerInstallBtn) drawerInstallBtn.classList.add('hidden');
  });
}

// Listen for successful installation
window.addEventListener('appinstalled', () => {
  showPWAToast('Aplicativo Dahora Expresso instalado com sucesso!');
  deferredPrompt = null;
  
  const loginInstallBtn = document.getElementById('pwa-install-app-btn');
  const drawerInstallBtn = document.getElementById('pwa-nav-install');
  
  if (loginInstallBtn) loginInstallBtn.classList.add('hidden');
  if (drawerInstallBtn) drawerInstallBtn.classList.add('hidden');
});

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ─── SUPPORT TICKETS MODULE (AUTHORITATIVE RPCs) ──────────────────────────────

let riderSupportState = {
  filter: 'all',
  tickets: [],
  currentTicketId: null,
  isSubmitting: false,
  realtimeChannel: null
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getCategoryLabel(cat) {
  const categories = {
    delivery_issue: 'Problema em Entrega',
    payment_question: 'Dúvida sobre Pagamento',
    consumable_question: 'Consumíveis / Bag',
    app_problem: 'Problema no Aplicativo',
    account_problem: 'Problema na Conta',
    other: 'Outros Assuntos'
  };
  return categories[cat] || cat || 'Outros Assuntos';
}

function getStatusBadgeHtml(status) {
  const styles = {
    open: 'background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);',
    in_progress: 'background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);',
    waiting_rider: 'background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);',
    waiting_admin: 'background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3);',
    resolved: 'background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3);',
    closed: 'background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid rgba(107, 114, 128, 0.3);'
  };
  const labels = {
    open: 'Novo Chamado',
    in_progress: 'Em Atendimento',
    waiting_rider: 'Aguardando Você',
    waiting_admin: 'Aguardando Suporte',
    resolved: 'Resolvido',
    closed: 'Encerrado'
  };
  const st = styles[status] || styles.closed;
  const lb = labels[status] || status;
  return `<span style="padding: 3px 8px; border-radius: 6px; font-size: 0.68rem; font-weight: 700; ${st}">${lb}</span>`;
}

function setRiderSupportFilter(filterName) {
  riderSupportState.filter = filterName;
  document.querySelectorAll('.support-filter-pill').forEach(btn => {
    if (btn.dataset.filter === filterName) {
      btn.classList.add('active');
      btn.style.background = 'linear-gradient(135deg, var(--primary), #c2410c)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'transparent';
    } else {
      btn.classList.remove('active');
      btn.style.background = 'var(--bg-card)';
      btn.style.color = 'var(--text)';
      btn.style.borderColor = 'var(--border)';
    }
  });
  renderRiderSupportTickets();
}

async function loadRiderSupportTickets() {
  const container = document.getElementById('pwa-rider-tickets-list');
  if (!container) return;

  if (!db || !supabaseClient) {
    container.innerHTML = `<p style="text-align: center; color: var(--muted); padding: 20px;">Sessão não disponível.</p>`;
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc('get_my_rider_support_tickets', {
      p_status: null,
      p_limit: 50,
      p_offset: 0
    });

    if (error) throw error;

    if (data && data.success) {
      riderSupportState.tickets = data.items || [];
      updateRiderUnreadBadge(riderSupportState.tickets);
      renderRiderSupportTickets();
      subscribeRiderSupportRealtime();
    } else {
      throw new Error(data?.message || 'Falha ao carregar chamados.');
    }
  } catch (err) {
    console.error("Error loading rider support tickets:", err);
    container.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 24px; font-size: 0.85rem;">Erro ao carregar chamados. Tente novamente.</div>`;
  }
}

function updateRiderUnreadBadge(tickets) {
  const badge = document.getElementById('pwa-support-unread-badge');
  if (!badge) return;
  const totalUnread = tickets.reduce((sum, t) => sum + (t.unread_messages_count || 0), 0);
  if (totalUnread > 0) {
    badge.textContent = totalUnread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderRiderSupportTickets() {
  const container = document.getElementById('pwa-rider-tickets-list');
  if (!container) return;

  let filtered = riderSupportState.tickets;
  if (riderSupportState.filter === 'open') {
    filtered = filtered.filter(t => ['open', 'in_progress', 'waiting_rider', 'waiting_admin'].includes(t.status));
  } else if (riderSupportState.filter === 'resolved') {
    filtered = filtered.filter(t => ['resolved', 'closed'].includes(t.status));
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--muted); gap: 12px; padding: 40px 20px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color: var(--muted);"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <p style="font-size: 0.9rem; font-weight: 700; margin: 0; color: var(--text);">Você ainda não possui chamados de suporte.</p>
        <p style="font-size: 0.78rem; margin: 0; color: var(--muted);">Clique em "+ Novo Chamado" para abrir uma solicitação para a central.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(t => {
    const timeStr = t.last_message_at ? new Date(t.last_message_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const unreadHtml = t.unread_messages_count > 0 
      ? `<span style="background: #ef4444; color: white; border-radius: 10px; padding: 2px 7px; font-size: 0.65rem; font-weight: 800;">${t.unread_messages_count} nova(s)</span>`
      : '';

    return `
      <div onclick="openRiderSupportChat('${t.ticket_id}')" style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px; cursor: pointer; transition: transform 0.1s; position: relative;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
          <h4 style="font-size: 0.9rem; font-weight: 800; margin: 0; color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.subject)}</h4>
          ${getStatusBadgeHtml(t.status)}
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.73rem; color: var(--muted);">
          <span>${escapeHtml(getCategoryLabel(t.category))}</span>
          <span>${timeStr}</span>
        </div>
        ${t.last_message_preview ? `<div style="font-size: 0.78rem; color: var(--text); background: var(--bg); padding: 8px; border-radius: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.last_message_preview)}</div>` : ''}
        ${unreadHtml ? `<div style="display: flex; justify-content: flex-end;">${unreadHtml}</div>` : ''}
      </div>
    `;
  }).join('');
}

function openCreateRiderTicketModal() {
  const modal = document.getElementById('modal-create-rider-ticket');
  if (modal) modal.classList.remove('hidden');
}

function closeCreateRiderTicketModal() {
  const modal = document.getElementById('modal-create-rider-ticket');
  if (modal) modal.classList.add('hidden');
}

async function submitCreateRiderTicket(event) {
  if (event) event.preventDefault();
  if (riderSupportState.isSubmitting) return;

  const subjectInput = document.getElementById('rider-ticket-subject');
  const categorySelect = document.getElementById('rider-ticket-category');
  const prioritySelect = document.getElementById('rider-ticket-priority');
  const messageInput = document.getElementById('rider-ticket-message');
  const submitBtn = document.getElementById('submit-create-rider-ticket-btn');

  const subject = subjectInput?.value.trim();
  const category = categorySelect?.value;
  const priority = prioritySelect?.value;
  const message = messageInput?.value.trim();

  if (!subject || subject.length < 3 || subject.length > 120) {
    showPWAToast("O assunto deve conter entre 3 e 120 caracteres.");
    return;
  }
  if (!message || message.length < 1 || message.length > 4000) {
    showPWAToast("A mensagem deve conter entre 1 e 4000 caracteres.");
    return;
  }

  riderSupportState.isSubmitting = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';
  }

  try {
    const { data, error } = await supabaseClient.rpc('create_my_rider_support_ticket', {
      p_subject: subject,
      p_category: category,
      p_priority: priority,
      p_message: message
    });

    if (error) throw error;

    if (data && data.success) {
      showPWAToast("Chamado criado com sucesso!");
      closeCreateRiderTicketModal();
      if (subjectInput) subjectInput.value = '';
      if (messageInput) messageInput.value = '';
      await loadRiderSupportTickets();
      if (data.ticket_id) {
        openRiderSupportChat(data.ticket_id);
      }
    } else {
      showPWAToast(data?.message || "Erro ao criar chamado.");
    }
  } catch (err) {
    console.error("Error creating rider support ticket:", err);
    showPWAToast("Erro de conexão ao criar chamado.");
  } finally {
    riderSupportState.isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Abrir Chamado';
    }
  }
}

async function fetchMotoChatHistory() {
  if (!db) return;
  try {
    const { data, error } = await db.rpc('get_or_create_my_active_rider_chat');
    if (error) {
      logSafeError('fetchMotoChatHistoryRPC', error);
      return;
    }

    if (data && data.success && data.ticket_id) {
      riderSupportState.currentTicketId = data.ticket_id;
      openRiderSupportChat(data.ticket_id);
    }
  } catch (e) {
    logSafeError('fetchMotoChatHistoryException', e);
  }
}

async function openRiderSupportChat(ticketId) {
  riderSupportState.currentTicketId = ticketId;
  const messagesContainer = document.getElementById('pwa-chat-messages-container');

  if (messagesContainer && !messagesContainer.children.length) {
    messagesContainer.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
        <div style="width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div>
      </div>
    `;
  }

  try {
    const { data, error } = await db.rpc('get_my_rider_support_ticket', {
      p_ticket_id: ticketId
    });

    if (error) throw error;

    if (data && data.success) {
      renderRiderSupportChat(data.ticket, data.messages || []);
      subscribeRiderSupportRealtime();
    } else {
      showPWAToast(data?.message || "Erro ao carregar mensagens do atendimento.");
    }
  } catch (err) {
    logSafeError("openRiderSupportChat", err);
  }
}

function closeRiderSupportChat() {
  riderSupportState.currentTicketId = null;
  const ticketsView = document.getElementById('pwa-support-tickets-view');
  const chatView = document.getElementById('pwa-support-chat-detail-view');
  if (chatView) chatView.classList.add('hidden');
  if (ticketsView) ticketsView.classList.remove('hidden');
}

function renderRiderSupportChat(ticket, messages) {
  const subjectEl = document.getElementById('pwa-chat-ticket-subject');
  const categoryEl = document.getElementById('pwa-chat-ticket-category');
  const badgeEl = document.getElementById('pwa-chat-ticket-status-badge');
  const messagesContainer = document.getElementById('pwa-chat-messages-container');
  const closedBanner = document.getElementById('pwa-chat-closed-banner');
  const replyForm = document.getElementById('pwa-ticket-reply-form');

  if (subjectEl) subjectEl.textContent = ticket.subject;
  if (categoryEl) categoryEl.textContent = getCategoryLabel(ticket.category);
  if (badgeEl) badgeEl.innerHTML = getStatusBadgeHtml(ticket.status);

  const isClosed = ticket.status === 'closed';
  if (closedBanner) {
    if (isClosed) closedBanner.classList.remove('hidden');
    else closedBanner.classList.add('hidden');
  }

  if (replyForm) {
    const input = document.getElementById('pwa-ticket-reply-input');
    const submitBtn = document.getElementById('pwa-ticket-reply-submit-btn');
    if (input) input.disabled = isClosed;
    if (submitBtn) submitBtn.disabled = isClosed;
  }

  if (!messagesContainer) return;

  if (messages.length === 0) {
    messagesContainer.innerHTML = `<p style="text-align: center; color: var(--muted); padding: 20px;">Nenhuma mensagem registrada.</p>`;
    return;
  }

  messagesContainer.innerHTML = messages.map(msg => {
    const isMe = msg.sender_type === 'rider';
    const alignStyle = isMe ? 'align-self: flex-end; align-items: flex-end;' : 'align-self: flex-start; align-items: flex-start;';
    const bubbleStyle = isMe 
      ? 'background: linear-gradient(135deg, var(--primary), #c2410c); color: #ffffff; border-radius: 16px 16px 2px 16px; box-shadow: 0 4px 12px rgba(255, 183, 0, 0.25);'
      : 'background: #272732; border: 1px solid var(--border); color: var(--text); border-radius: 16px 16px 16px 2px;';
    const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'Agora';
    const senderLabel = isMe ? 'Você' : (msg.sender_type === 'admin' ? 'Suporte Central' : 'Sistema');

    return `
      <div style="display: flex; flex-direction: column; max-width: 85%; ${alignStyle}">
        <span style="font-size: 0.7rem; color: var(--muted); margin-bottom: 3px; font-weight: 600;">${senderLabel}</span>
        <div style="padding: 10px 14px; font-size: 0.88rem; line-height: 1.45; word-break: break-word; ${bubbleStyle}">
          ${escapeHtml(msg.message)}
        </div>
        <span style="font-size: 0.65rem; color: var(--muted); margin-top: 3px;">${time}</span>
      </div>
    `;
  }).join('');

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function submitRiderTicketReply(event) {
  if (event) event.preventDefault();
  if (riderSupportState.isSubmitting || !riderSupportState.currentTicketId) return;

  const input = document.getElementById('pwa-ticket-reply-input');
  const submitBtn = document.getElementById('pwa-ticket-reply-submit-btn');

  const val = input?.value.trim();
  if (!val || val.length < 1 || val.length > 4000) return;

  riderSupportState.isSubmitting = true;
  if (submitBtn) submitBtn.disabled = true;

  try {
    const { data, error } = await supabaseClient.rpc('reply_my_rider_support_ticket', {
      p_ticket_id: riderSupportState.currentTicketId,
      p_message: val
    });

    if (error) throw error;

    if (data && data.success) {
      if (input) input.value = '';
      openRiderSupportChat(riderSupportState.currentTicketId);
    } else {
      showPWAToast(data?.message || "Erro ao responder chamado.");
    }
  } catch (err) {
    console.error("Error replying rider support ticket:", err);
    showPWAToast("Erro ao enviar resposta.");
  } finally {
    riderSupportState.isSubmitting = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

function subscribeRiderSupportRealtime() {
  if (riderSupportState.realtimeChannel || !supabaseClient) return;

  riderSupportState.realtimeChannel = supabaseClient.channel('realtime:rider_support')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rider_support_tickets' }, () => {
      loadRiderSupportTickets();
      if (riderSupportState.currentTicketId) {
        openRiderSupportChat(riderSupportState.currentTicketId);
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rider_support_messages' }, (payload) => {
      loadRiderSupportTickets();
      if (riderSupportState.currentTicketId && payload.new && payload.new.ticket_id === riderSupportState.currentTicketId) {
        openRiderSupportChat(riderSupportState.currentTicketId);
      }
    })
    .subscribe();
}

// ─── PWA FINANCIAL REPORTS & STATEMENT (AUTHORITATIVE LEDGER) ────────────────

// ─── PWA FINANCIAL REPORTS & STATEMENT (AUTHORITATIVE LEDGER) ────────────────

let currentReportsFilterPeriod = 'week'; // 'today', 'week', 'month', 'custom'
let customReportsStartDate = null;
let customReportsEndDate = null;
let reportsStatementOffset = 0;
const REPORTS_STATEMENT_LIMIT = 30;
let reportsFetchToken = 0;
let realtimeFinancialSubscription = null;
let pwaStatementCachedItems = new Map();

function formatISOShortDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function setReportsFilterPeriod(period) {
  currentReportsFilterPeriod = period;

  ['today', 'week', 'month', 'custom'].forEach(p => {
    const pill = document.getElementById(`pwa-filter-${p}`);
    if (pill) {
      if (p === period) pill.classList.add('active');
      else pill.classList.remove('active');
    }
  });

  const customContainer = document.getElementById('pwa-custom-date-container');
  if (period === 'custom') {
    if (customContainer) customContainer.classList.remove('hidden');
    const startInput = document.getElementById('pwa-filter-start-date');
    const endInput = document.getElementById('pwa-filter-end-date');
    if (startInput && !startInput.value) {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      startInput.value = formatISOShortDate(d);
    }
    if (endInput && !endInput.value) {
      endInput.value = formatISOShortDate(new Date());
    }
    return;
  } else {
    if (customContainer) customContainer.classList.add('hidden');
    customReportsStartDate = null;
    customReportsEndDate = null;
    loadPWAFinancialReports();
  }
}

function applyCustomReportsDateFilter() {
  const startInput = document.getElementById('pwa-filter-start-date');
  const endInput = document.getElementById('pwa-filter-end-date');
  if (!startInput || !endInput || !startInput.value || !endInput.value) {
    showPWAToast('Por favor, selecione as datas inicial e final.');
    return;
  }
  if (startInput.value > endInput.value) {
    showPWAToast('A data inicial não pode ser posterior à data final.');
    return;
  }
  const diffTime = Math.abs(new Date(endInput.value) - new Date(startInput.value));
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  if (diffDays > 366) {
    showPWAToast('O período máximo de busca é de 366 dias.');
    return;
  }

  customReportsStartDate = startInput.value;
  customReportsEndDate = endInput.value;
  loadPWAFinancialReports();
}

function clearCustomReportsDateFilter() {
  const startInput = document.getElementById('pwa-filter-start-date');
  const endInput = document.getElementById('pwa-filter-end-date');
  if (startInput) startInput.value = '';
  if (endInput) endInput.value = '';
  setReportsFilterPeriod('week');
}

function loadReportsData() {
  loadPWAFinancialReports();
  initPWAFinancialRealtime();
}

async function loadPWAFinancialReports(isManualRefresh = false) {
  if (!supabaseClient) return;

  const currentToken = ++reportsFetchToken;
  reportsStatementOffset = 0;

  let startDate = null;
  let endDate = null;
  let labelText = 'Semana Operacional';

  if (currentReportsFilterPeriod === 'today') {
    const todayStr = formatISOShortDate(new Date());
    startDate = todayStr;
    endDate = todayStr;
    labelText = 'Hoje';
  } else if (currentReportsFilterPeriod === 'month') {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    startDate = formatISOShortDate(firstDay);
    endDate = formatISOShortDate(now);
    labelText = 'Mês Atual';
  } else if (currentReportsFilterPeriod === 'custom' && customReportsStartDate && customReportsEndDate) {
    startDate = customReportsStartDate;
    endDate = customReportsEndDate;
    labelText = 'Período Personalizado';
  } else {
    startDate = null;
    endDate = null;
    labelText = 'Semana Operacional';
  }

  const listContainer = document.getElementById('pwa-reports-list-container');
  if (listContainer) {
    listContainer.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--muted); font-size: 0.85rem;">
        <span class="pwa-spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 8px;"></span>
        Carregando extrato financeiro...
      </div>
    `;
  }

  try {
    // Fonte Única e Autoritativa Sanitizada: public.get_my_rider_financial_statement_v2
    const { data: res, error: stmtErr } = await supabaseClient.rpc('get_my_rider_financial_statement_v2', {
      p_period_start: null,
      p_history_limit: 12
    });

    if (currentToken !== reportsFetchToken) return;

    if (stmtErr) throw stmtErr;

    if (res && res.success) {
      const heroNetEl = document.getElementById('pwa-hero-net-balance');
      const settlementBadgeEl = document.getElementById('pwa-settlement-status-badge');
      
      const countEl = document.getElementById('reports-deliveries-count');
      const earnEl = document.getElementById('reports-deliveries-earnings');
      const credEl = document.getElementById('reports-credits-total');
      const dedEl = document.getElementById('reports-deductions-total');
      const netEl = document.getElementById('reports-period-net-total');

      if (res.has_settlement && res.settlement) {
        const s = res.settlement;
        
        if (heroNetEl) heroNetEl.textContent = formatMoneyBR(s.net_amount);

        if (settlementBadgeEl) {
          const st = s.status;
          const statusMap = {
            'open': { text: s.status_label || 'Ciclo em Andamento', bg: 'rgba(156,163,175,0.15)', color: '#9ca3af', border: 'rgba(156,163,175,0.3)' },
            'calculated': { text: s.status_label || 'Apurado', bg: 'rgba(59,130,246,0.15)', color: '#3b82f6', border: 'rgba(59,130,246,0.3)' },
            'pending': { text: s.status_label || 'Pendente de Pagamento', bg: 'rgba(234,179,8,0.15)', color: '#eab308', border: 'rgba(234,179,8,0.3)' },
            'partially_blocked': { text: s.status_label || 'Parcialmente Bloqueado', bg: 'rgba(249,115,22,0.15)', color: '#f97316', border: 'rgba(249,115,22,0.3)' },
            'paid': { text: s.status_label || 'Pago (Concluído)', bg: 'rgba(16,185,129,0.15)', color: '#10b981', border: 'rgba(16,185,129,0.3)' },
            'reopened': { text: s.status_label || 'Reaberto para Revisão', bg: 'rgba(168,85,247,0.15)', color: '#a855f7', border: 'rgba(168,85,247,0.3)' },
            'reversed': { text: s.status_label || 'Estornado', bg: 'rgba(239,68,68,0.15)', color: '#ef4444', border: 'rgba(239,68,68,0.3)' },
            'cancelled': { text: s.status_label || 'Cancelado', bg: 'rgba(239,68,68,0.15)', color: '#ef4444', border: 'rgba(239,68,68,0.3)' }
          };
          const info = statusMap[st] || { text: 'Status Indisponível', bg: 'rgba(255,255,255,0.1)', color: 'var(--text)', border: 'var(--border)' };
          settlementBadgeEl.innerHTML = `<span style="background: ${info.bg}; color: ${info.color}; border: 1px solid ${info.border}; padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; display: inline-block;">${info.text}</span>`;
        }

        if (countEl) countEl.textContent = (res.items || []).filter(i => i.source_type === 'rider_earning' || i.source_type === 'tele').length;
        if (earnEl) earnEl.textContent = formatMoneyBR(s.base_rider_amount);
        if (credEl) credEl.textContent = formatMoneyBR(s.credits_amount);
        if (dedEl) dedEl.textContent = `- ${formatMoneyBR(s.consumables_amount)}`;
        if (netEl) netEl.textContent = formatMoneyBR(s.net_amount);

        renderPWAFinancialStatementItems(res.items || [], false);
      } else {
        if (heroNetEl) heroNetEl.textContent = 'R$ 0,00';
        if (settlementBadgeEl) {
          settlementBadgeEl.innerHTML = `<span style="background: rgba(156,163,175,0.15); color: #9ca3af; border: 1px solid rgba(156,163,175,0.3); padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; display: inline-block;">Ciclo em Andamento</span>`;
        }
        if (countEl) countEl.textContent = '0';
        if (earnEl) earnEl.textContent = 'R$ 0,00';
        if (credEl) credEl.textContent = 'R$ 0,00';
        if (dedEl) dedEl.textContent = '- R$ 0,00';
        if (netEl) netEl.textContent = 'R$ 0,00';

        renderPWAFinancialStatementItems([], false);
      }
    }

    if (isManualRefresh) {
      showPWAToast('Dados financeiros atualizados.');
    }
  } catch (err) {
    console.error('Erro ao carregar extrato sanitizado:', err);
    if (currentToken === reportsFetchToken && listContainer) {
      listContainer.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #ef4444; font-size: 0.82rem; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); border-radius: 12px;">
          Falha ao carregar extrato financeiro. <br>
          <button onclick="loadPWAFinancialReports()" style="margin-top: 8px; background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 4px 12px; border-radius: 6px; font-size: 0.75rem; cursor: pointer;">Tentar Novamente</button>
        </div>
      `;
    }
  }
}

async function loadMorePWAFinancialStatement() {
  // Paginação simplificada e autoritativa
}

function renderPWAFinancialStatementItems(items, isAppend) {
  const container = document.getElementById('pwa-reports-list-container');
  if (!container) return;

  if (!isAppend) {
    container.innerHTML = '';
    pwaStatementCachedItems.clear();
  }

  if (items.length === 0 && !isAppend) {
    container.innerHTML = `
      <div style="text-align: center; padding: 32px 16px; color: var(--muted); font-size: 0.85rem; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;">
        <div style="font-size: 1.8rem; margin-bottom: 6px;">📊</div>
        <strong>Nenhum lançamento financeiro</strong><br>
        <span style="font-size: 0.75rem;">Não há registros no período selecionado.</span>
      </div>
    `;
    return;
  }

  items.forEach(item => {
    const id = item.id || item.transaction_id;
    pwaStatementCachedItems.set(id, item);

    const isCredit = item.direction === 'credit';
    const amountSign = isCredit ? '+' : '-';
    const amountColor = isCredit ? '#10b981' : '#ef4444';
    const iconBg = isCredit ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)';
    const iconSymbol = (item.source_type === 'rider_earning' || item.source_type === 'tele') ? '🛵' : (isCredit ? '💵' : '🎒');

    let titleText = item.description || 'Lançamento Financeiro';

    const txDate = new Date(item.occurred_at || item.transaction_at || item.created_at);
    const dateFmt = txDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    const cardHtml = `
      <div class="pwa-statement-card" onclick="openPWATransactionDetailModal('${id}')" style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; transition: background 0.15s ease;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 38px; height: 38px; border-radius: 10px; background: ${iconBg}; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; flex-shrink: 0;">
            ${iconSymbol}
          </div>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <strong style="font-size: 0.85rem; color: var(--text); font-weight: 700;">${escapeHtml(titleText)}</strong>
            <span style="font-size: 0.7rem; color: var(--muted);">${dateFmt}</span>
          </div>
        </div>
        <div style="text-align: right; flex-shrink: 0;">
          <strong style="font-size: 0.95rem; color: ${amountColor}; font-weight: 800; font-family: var(--font-display);">${amountSign} ${formatMoneyBR(item.amount)}</strong>
          <span style="font-size: 0.65rem; color: var(--muted); display: block; text-transform: uppercase;">Detalhes ›</span>
        </div>
      </div>
    `;
    container.insertAdjacentHTML('beforeend', cardHtml);
  });
}

function openPWATransactionDetailModal(transactionId) {
  const item = pwaStatementCachedItems.get(transactionId);
  if (!item) return;

  const modal = document.getElementById('pwa-transaction-detail-modal');
  if (!modal) return;

  const categoryEl = document.getElementById('pwa-tx-detail-category');
  const amountEl = document.getElementById('pwa-tx-detail-amount');
  const dateEl = document.getElementById('pwa-tx-detail-date');
  const typeEl = document.getElementById('pwa-tx-detail-type');
  const teleRow = document.getElementById('pwa-tx-detail-tele-row');
  const teleCodeEl = document.getElementById('pwa-tx-detail-tele-code');
  const addrRow = document.getElementById('pwa-tx-detail-address-row');
  const descEl = document.getElementById('pwa-tx-detail-description');

  const isCredit = item.direction === 'credit';

  if (categoryEl) categoryEl.textContent = item.description || 'Lançamento Financeiro';
  if (amountEl) {
    amountEl.textContent = `${isCredit ? '+' : '-'} ${formatMoneyBR(item.amount)}`;
    amountEl.style.color = isCredit ? '#10b981' : '#ef4444';
  }

  const txDate = new Date(item.occurred_at || item.created_at);
  if (dateEl) dateEl.textContent = txDate.toLocaleString('pt-BR');
  if (typeEl) typeEl.textContent = isCredit ? 'Crédito (Entrada)' : 'Débito (Saída / Desconto)';

  if (item.tele_id) {
    if (teleRow) teleRow.classList.remove('hidden');
    if (teleCodeEl) teleCodeEl.textContent = item.tele_id.slice(0, 8);
  } else {
    if (teleRow) teleRow.classList.add('hidden');
  }

  if (addrRow) addrRow.classList.add('hidden');
  if (descEl) descEl.textContent = item.description || 'Nenhuma observação registrada.';

  modal.classList.remove('hidden');
}

function closePWATransactionDetailModal() {
  const modal = document.getElementById('pwa-transaction-detail-modal');
  if (modal) modal.classList.add('hidden');
}

function initPWAFinancialRealtime() {
  if (!supabaseClient || realtimeFinancialSubscription) return;

  const fleetId = currentRider ? currentRider.id : null;
  if (!fleetId) return;

  let debounceTimer = null;
  const debouncedFetch = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      loadPWAFinancialReports(false);
    }, 300);
  };

  try {
    realtimeFinancialSubscription = supabaseClient
      .channel(`rider-financial-${fleetId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rider_weekly_settlements',
          filter: `rider_id=eq.${fleetId}`
        },
        debouncedFetch
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rider_financial_transactions',
          filter: `rider_id=eq.${fleetId}`
        },
        debouncedFetch
      )
      .subscribe((status) => {
        console.log('[Realtime Financial Channel Status]:', status);
      });
  } catch (err) {
    console.warn('Erro ao inicializar subscrição realtime financeira:', err);
  }
}

// Handlers de visibilidade e conexão para re-fetch autoritativo
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentPWATab === 'reports') {
    loadPWAFinancialReports(false);
  }
});

window.addEventListener('online', () => {
  if (currentPWATab === 'reports') {
    loadPWAFinancialReports(false);
  }
});

