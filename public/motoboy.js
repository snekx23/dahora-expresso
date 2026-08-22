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
        detectSessionInUrl: false,
        storageKey: 'dahora-rider-auth'
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
let currentPWATab = 'map';
let activeOpenTeleId = null;

function formatMoneyBR(value) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(amount);
}

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

// ─── PREFERÊNCIAS DE ALERTAS E SONS ──────────────────────────────────────────
const ALERT_PREFERENCES_STORAGE_KEY = 'dahora_rider_alert_preferences_v1';

function getRiderAlertPreferences() {
  try {
    const raw = safeGetStorage(ALERT_PREFERENCES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        soundEnabled: parsed.soundEnabled !== false,
        vibrationEnabled: parsed.vibrationEnabled !== false
      };
    }
  } catch (e) {}
  return { soundEnabled: true, vibrationEnabled: true };
}

function saveRiderAlertPreferences(prefs) {
  try {
    safeSetStorage(ALERT_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
    updateAlertPreferencesUI();
  } catch (e) {}
}

function toggleSoundPreference() {
  const prefs = getRiderAlertPreferences();
  prefs.soundEnabled = !prefs.soundEnabled;
  saveRiderAlertPreferences(prefs);
}

function toggleVibrationPreference() {
  const prefs = getRiderAlertPreferences();
  prefs.vibrationEnabled = !prefs.vibrationEnabled;
  saveRiderAlertPreferences(prefs);
}

function updateAlertPreferencesUI() {
  if (typeof document === 'undefined') return;
  const prefs = getRiderAlertPreferences();
  const soundBtn = document.getElementById('pwa-setting-sound-btn');
  if (soundBtn) {
    soundBtn.innerText = prefs.soundEnabled ? 'Ativado' : 'Desativado';
    soundBtn.style.color = prefs.soundEnabled ? '#10b981' : '#ef4444';
  }
  const vibBtn = document.getElementById('pwa-setting-vibration-btn');
  if (vibBtn) {
    vibBtn.innerText = prefs.vibrationEnabled ? 'Ativada' : 'Desativada';
    vibBtn.style.color = prefs.vibrationEnabled ? '#10b981' : '#ef4444';
  }
}

// ─── CONTROLADOR DE ÁUDIO ───────────────────────────────────────────────────
const AudioController = {
  unlocked: false,
  audioCtx: null,
  newTeleAudio: null,
  teleRemovedAudio: null,

  getAudioContext() {
    if (this.audioCtx) return this.audioCtx;
    if (typeof window === 'undefined') return null;
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    } catch (e) {
      console.warn('[AUDIO] Falha ao instanciar AudioContext:', e.message);
    }
    return this.audioCtx;
  },

  unlock() {
    if (typeof window === 'undefined') return;

    try {
      if (!this.newTeleAudio && typeof Audio !== 'undefined') {
        this.newTeleAudio = new Audio('/audio/nova-tele.mp3');
        this.newTeleAudio.preload = 'auto';
      }
      if (!this.teleRemovedAudio && typeof Audio !== 'undefined') {
        this.teleRemovedAudio = new Audio('/audio/tele-retirada.mp3');
        this.teleRemovedAudio.preload = 'auto';
      }
    } catch (e) {
      console.warn('[AUDIO] Falha ao instanciar elementos de áudio:', e.message);
    }

    if (this.unlocked && this.audioCtx && this.audioCtx.state === 'running') return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      this.unlocked = true;
    } catch (e) {
      console.warn('[AUDIO] Unlock falhou:', e.message);
    }
  },

  playFallbackNewTeleTone() {
    try {
      const ctx = this.getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const now = ctx.currentTime;
        for (let i = 0; i < 3; i++) {
          const startTime = now + (i * 0.75);
          const duration = 0.55;
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gainNode = ctx.createGain();
          osc1.type = 'sine';
          osc1.frequency.setValueAtTime(587.33, startTime);
          osc2.type = 'sine';
          osc2.frequency.setValueAtTime(880, startTime);
          gainNode.gain.setValueAtTime(0, startTime);
          gainNode.gain.linearRampToValueAtTime(0.6, startTime + 0.04);
          gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
          osc1.connect(gainNode);
          osc2.connect(gainNode);
          gainNode.connect(ctx.destination);
          osc1.start(startTime);
          osc1.stop(startTime + duration);
          osc2.start(startTime);
          osc2.stop(startTime + duration);
        }
      }
    } catch (err) {
      console.warn('[AUDIO] playFallbackNewTeleTone error:', err.message);
    }
  },

  playFallbackTeleRemovedTone() {
    try {
      const ctx = this.getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(260, now + 0.28);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.3);
      }
    } catch (err) {
      console.warn('[AUDIO] playFallbackTeleRemovedTone error:', err.message);
    }
  },

  playNewTeleAlert() {
    this.unlock();
    const prefs = getRiderAlertPreferences();

    if (prefs.soundEnabled) {
      let playedMp3 = false;
      try {
        if (this.newTeleAudio) {
          this.newTeleAudio.currentTime = 0;
          const promise = this.newTeleAudio.play();
          if (promise !== undefined) {
            promise.then(() => { playedMp3 = true; }).catch((err) => {
              console.warn('[AUDIO] newTeleAudio play falhou, acionando fallback:', err.message);
              this.playFallbackNewTeleTone();
            });
            playedMp3 = true;
          }
        }
      } catch (e) {
        console.warn('[AUDIO] newTeleAudio erro síncrono:', e.message);
      }

      if (!playedMp3) {
        this.playFallbackNewTeleTone();
      }
    }

    if (prefs.vibrationEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate([600, 250, 600, 250, 900]); } catch (e) {}
    }
  },

  playTeleAlert() {
    this.playNewTeleAlert();
  },

  playTeleRemovedAlert() {
    this.unlock();
    const prefs = getRiderAlertPreferences();

    if (prefs.soundEnabled) {
      let playedMp3 = false;
      try {
        if (this.teleRemovedAudio) {
          this.teleRemovedAudio.currentTime = 0;
          const promise = this.teleRemovedAudio.play();
          if (promise !== undefined) {
            promise.then(() => { playedMp3 = true; }).catch((err) => {
              console.warn('[AUDIO] teleRemovedAudio play falhou, acionando fallback:', err.message);
              this.playFallbackTeleRemovedTone();
            });
            playedMp3 = true;
          }
        }
      } catch (e) {
        console.warn('[AUDIO] teleRemovedAudio erro síncrono:', e.message);
      }

      if (!playedMp3) {
        this.playFallbackTeleRemovedTone();
      }
    }

    if (prefs.vibrationEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate([300, 150, 300]); } catch (e) {}
    }
  },

  testNewTeleSound() {
    this.unlock();
    try {
      if (this.newTeleAudio) {
        this.newTeleAudio.currentTime = 0;
        this.newTeleAudio.play().catch(() => this.playFallbackNewTeleTone());
      } else {
        this.playFallbackNewTeleTone();
      }
    } catch (e) {
      this.playFallbackNewTeleTone();
    }
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate([600, 250, 600]); } catch (e) {}
    }
  },

  testTeleRemovedSound() {
    this.unlock();
    try {
      if (this.teleRemovedAudio) {
        this.teleRemovedAudio.currentTime = 0;
        this.teleRemovedAudio.play().catch(() => this.playFallbackTeleRemovedTone());
      } else {
        this.playFallbackTeleRemovedTone();
      }
    } catch (e) {
      this.playFallbackTeleRemovedTone();
    }
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate([300, 150, 300]); } catch (e) {}
    }
  },

  playMessageAlert() {
    this.unlock();
    const prefs = getRiderAlertPreferences();
    if (prefs.soundEnabled) {
      try {
        const ctx = this.getAudioContext();
        if (ctx) {
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          const now = ctx.currentTime;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(659.25, now);
          osc.frequency.setValueAtTime(880, now + 0.1);
          gain.gain.setValueAtTime(0.4, now);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.3);
        }
      } catch (e) {}
    }
    if (prefs.vibrationEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate([250, 120, 250]); } catch (e) {}
    }
  }
};

if (typeof document !== 'undefined') {
  document.addEventListener('click', () => AudioController.unlock(), { passive: true });
  document.addEventListener('touchstart', () => AudioController.unlock(), { passive: true });
}

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
  safeRemoveStorage('speedMotoSession');
  if (!db) return null;
  try {
    const { data: { session }, error: sessionErr } = await db.auth.getSession();
    if (sessionErr) {
      logSafeError('getSessionIgnored', sessionErr);
    }

    if (session?.user?.id) {
      const { data: fleetRow, error: fleetErr } = await db
        .from('fleet')
        .select('*')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (!fleetErr && fleetRow) {
        currentRider = fleetRow;
        currentRiderId = fleetRow.id;
        return fleetRow;
      }
      // Se a sessão Auth não tiver vínculo em fleet, encerra a sessão inválida do PWA
      await db.auth.signOut().catch(() => null);
    }
  } catch (e) {
    logSafeError('resolveCurrentRiderException', e);
  }

  currentRider = null;
  currentRiderId = null;
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
    const isLocalhost = Boolean(
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]'
    );

    if (isLocalhost) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        for (const registration of registrations) {
          registration.unregister();
        }
      }).catch(() => {});

      if ('caches' in window) {
        caches.keys().then(cacheNames => {
          return Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)));
        }).catch(() => {});
      }
    } else {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => {
          reg.update();
        })
        .catch(() => {});
    }
  }
}

function urlBase64ToUint8Array(base64String) {
  if (!base64String || typeof base64String !== 'string') {
    return new Uint8Array(0);
  }
  const cleanStr = String(base64String).trim().replace(/^["']|["']$/g, '');
  if (!cleanStr) return new Uint8Array(0);
  const padding = '='.repeat((4 - (cleanStr.length % 4)) % 4);
  const base64 = (cleanStr + padding).replace(/-/g, '+').replace(/_/g, '/');
  try {
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
  } catch (e) {
    console.warn("⚠️ urlBase64ToUint8Array failed to decode base64 string:", e.message);
    return new Uint8Array(0);
  }
}

function updatePushAlertCardUI(statusText, buttonText, buttonState = 'normal') {
  const badge = document.getElementById('pwa-push-status-badge');
  const btn = document.getElementById('pwa-push-toggle-btn') || document.querySelector('#pwa-push-alert-card button');
  const pushCard = document.getElementById('pwa-push-alert-card');

  if (badge && statusText) {
    badge.innerText = statusText;
  }

  if (buttonState === 'active') {
    if (pushCard) pushCard.style.display = 'none';
    if (riderMap && typeof window.google !== 'undefined' && window.google?.maps) {
      try { window.google.maps.event.trigger(riderMap, 'resize'); } catch (e) {}
    }
  } else {
    if (pushCard) pushCard.style.display = '';
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
      updatePushAlertCardUI('Status: Este navegador não oferece suporte a notificações Push.', 'Sem suporte a Push', 'error');
      throw new Error('Este navegador não oferece suporte a notificações Push.');
    }

    AudioController.unlock();

    const vapidPublicKey = (
      window.SUPABASE_CONFIG?.vapidPublicKey ||
      window.__ENV_VAPID_PUBLIC_KEY ||
      ''
    ).trim();

    if (!vapidPublicKey) {
      updatePushAlertCardUI('Status: Servidor de notificações não configurado', 'Servidor de notificações não configurado', 'error');
      throw new Error('Servidor de notificações não configurado.');
    }

    const cleanKey = String(vapidPublicKey || '').trim().replace(/^["']|["']$/g, '');
    const applicationServerKey = urlBase64ToUint8Array(cleanKey);

    if (
      !(applicationServerKey instanceof Uint8Array) ||
      applicationServerKey.byteLength !== 65 ||
      applicationServerKey[0] !== 0x04
    ) {
      const len = applicationServerKey ? applicationServerKey.byteLength : 0;
      const firstByte = (applicationServerKey && applicationServerKey.length > 0) ? applicationServerKey[0] : 'N/A';
      console.warn(`VAPID public key validation failed: length=${len} firstByte=${firstByte}`);
      updatePushAlertCardUI('Status: Chave pública de notificações inválida. Contate o administrador.', 'Tentar novamente', 'error');
      throw new Error('Chave pública de notificações inválida. Contate o administrador.');
    }

    const permission = await Notification.requestPermission();
    if (permission === 'denied') {
      updatePushAlertCardUI('Status: Notificações bloqueadas nas configurações do navegador.', 'Permissão negada no navegador', 'error');
      throw new Error('Notificações bloqueadas nas configurações do navegador.');
    }

    if (permission !== 'granted') {
      updatePushAlertCardUI('Status: Permissão não concedida', 'Ativar alertas de novas Teles', 'normal');
      return { success: false, error: 'Permissão não concedida pelo usuário.' };
    }

    const registration = await navigator.serviceWorker.ready;

    // Criar ou obter subscription
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });
    }

    if (!subscription) {
      updatePushAlertCardUI('Status: Não foi possível registrar este aparelho', 'Tentar novamente', 'error');
      throw new Error('Não foi possível criar a subscrição no navegador.');
    }

    // Registrar no backend Supabase via RPC autoritativa
    const subObj = subscription.toJSON();
    const p256dh = subObj.keys?.p256dh || '';
    const auth = subObj.keys?.auth || '';

    if (db) {
      const { error: rpcErr } = await db.rpc('register_my_push_subscription', {
        p_endpoint: subscription.endpoint,
        p_p256dh: p256dh,
        p_auth: auth,
        p_user_agent: navigator.userAgent
      });

      if (rpcErr && (currentRiderId || (currentRider && currentRider.id))) {
        const riderId = currentRiderId || currentRider.id;
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

    updatePushAlertCardUI('Status: Alertas de novas Teles ativados', 'Alertas de novas Teles ativados', 'active');

    const pushCard = document.getElementById('pwa-push-alert-card');
    if (pushCard) {
      pushCard.style.display = 'none';
    }
    if (riderMap && typeof window.google !== 'undefined' && window.google.maps) {
      window.google.maps.event.trigger(riderMap, 'resize');
    }

    showPWAToast('Alertas de novas Teles ativados com sucesso.');
    return { success: true };

  } catch (err) {
    console.warn("⚠️ Erro no fluxo de notificações:", err.message);
    const friendlyMsg = err.message.includes('inválida') || err.message.includes('não configurado')
      ? err.message
      : 'Não foi possível ativar as notificações.';
    updatePushAlertCardUI(`Status: ${friendlyMsg}`, 'Tentar novamente', 'error');
    showPWAToast(err.message, 'error');
    return { success: false, error: err.message };
  }
}

async function checkExistingPushSubscription() {
  if (typeof window === 'undefined') return;

  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    updatePushAlertCardUI('Status: Este navegador não oferece suporte a notificações Push.', 'Sem suporte a Push', 'error');
    return;
  }

  const vapidPublicKey = (
    window.SUPABASE_CONFIG?.vapidPublicKey ||
    window.__ENV_VAPID_PUBLIC_KEY ||
    ''
  ).trim();

  if (!vapidPublicKey) {
    updatePushAlertCardUI('Status: Servidor de notificações não configurado', 'Servidor de notificações não configurado', 'error');
    return;
  }

  if (Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        updatePushAlertCardUI('Status: Alertas de novas Teles ativados', 'Alertas de novas Teles ativados', 'active');
      } else {
        updatePushAlertCardUI('Status: Não ativado neste aparelho', 'Ativar alertas de novas Teles', 'normal');
      }
    } catch (e) {
      updatePushAlertCardUI('Status: Não ativado', 'Ativar alertas de novas Teles', 'normal');
    }
  } else if (Notification.permission === 'denied') {
    updatePushAlertCardUI('Status: Notificações bloqueadas nas configurações do navegador.', 'Permissão negada no navegador', 'error');
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


const alertedNewTeleIds = new Set();

function showHighPriorityNewTeleModal(tele) {
  if (!tele || !tele.id) return;
  if (alertedNewTeleIds.has(tele.id)) return;
  alertedNewTeleIds.add(tele.id);

  AudioController.playTeleAlert();

  const clientEl = document.getElementById('high-priority-client');
  const pickupEl = document.getElementById('high-priority-pickup');
  const addrEl   = document.getElementById('high-priority-address');
  const priceEl  = document.getElementById('high-priority-price');

  if (clientEl) clientEl.innerText = tele.pickup_establishment_name || tele.client || 'Cliente Comercial';
  if (pickupEl) pickupEl.innerText = tele.pickup_address || 'Endereço de Coleta';
  if (addrEl)   addrEl.innerText   = tele.delivery_address || tele.address || 'Endereço de Entrega';
  if (priceEl)  priceEl.innerText  = tele.price || (tele.delivery_charge ? `R$ ${parseFloat(tele.delivery_charge).toFixed(2).replace('.', ',')}` : 'R$ 8,00');

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
  if (digits.length < 4 || !/^\d{4}$/.test(pin)) {
    showLoginError('Informe o Código de Acesso e o PIN de 4 números.');
    if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
    return;
  }

  const code4 = digits.slice(-4);

  // ETAPA 3: AUTENTICAÇÃO AUTORITATIVA VIA EDGE FUNCTION RIDER-AUTH & VERIFYOTP
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), 15000)
    );

    const publicAnonKey = (typeof window !== 'undefined' && window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.key) ? window.SUPABASE_CONFIG.key : '';
    const fnOptions = {
      body: { access_code: code4, pin: pin }
    };
    if (publicAnonKey) {
      fnOptions.headers = { Authorization: `Bearer ${publicAnonKey}` };
    }

    const fnPromise = db.functions.invoke('rider-auth', fnOptions);

    const { data: resData, error: fnErr } = await Promise.race([fnPromise, timeoutPromise]);

    let errorMsg = resData?.error;
    if (!errorMsg && fnErr) {
      if (fnErr.context) {
        try {
          const errBody = await fnErr.context.json();
          if (errBody && errBody.error) errorMsg = errBody.error;
        } catch (_) {}
      }
      if (!errorMsg && fnErr.message && fnErr.message !== 'Edge Function returned a non-2xx status code') {
        errorMsg = fnErr.message;
      }
    }

    if (fnErr || !resData || !resData.success || !resData.token_hash) {
      if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
      showLoginError(errorMsg || 'Código ou PIN inválido, ou acesso indisponível.');
      return;
    }

    const tokenHash = resData.token_hash;
    if (pinEl) pinEl.value = '';

    // Trocar token_hash por sessão oficial no Supabase Auth via verifyOtp
    const { data: verifyRes, error: verifyErr } = await db.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'email'
    });

    if (verifyErr || !verifyRes || !verifyRes.session || !verifyRes.user) {
      if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
      showLoginError('Falha ao concluir a autenticação oficial. Tente novamente.');
      return;
    }

    // Confirmar identidade oficial e vincular com public.fleet pelo user_id
    const { data: { user }, error: userErr } = await db.auth.getUser();
    if (userErr || !user) {
      if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
      await db.auth.signOut().catch(() => null);
      showLoginError('Falha ao obter dados da sessão autenticada.');
      return;
    }

    const { data: fleetRow, error: fleetErr } = await db
      .from('fleet')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (fleetErr || !fleetRow) {
      if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
      await db.auth.signOut().catch(() => null);
      showLoginError('Motoboy sem cadastro ativo ou vínculo válido.');
      return;
    }

    currentRider = fleetRow;
    currentRiderId = fleetRow.id;
    safeRemoveStorage('speedMotoSession');

    if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }

    // Renderizar aplicação PWA
    showApp();

    // Inicializações de segundo plano não-bloqueantes
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
  stopForegroundSafetyPolling();
  if (db) {
    try { await db.auth.signOut(); } catch (e) {}
  }
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
  activeDeliveriesList = [];
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
  try { startForegroundSafetyPolling(); } catch (e) { logSafeError('showApp:startForegroundSafetyPolling', e); }

  // Execução independente de dados secundários
  try { loadLocalProfile(); } catch (e) {}
  try { loadWeeklyBalance(); } catch (e) {}
  try { loadConsumablesData(); } catch (e) {}
  try { checkExistingPushSubscription(); } catch (e) {}
  try { if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons(); } catch (e) {}
}


function updateRiderUIStatus(rawStatus) {
  const status = rawStatus || (currentRider ? currentRider.status : 'Indisponível');
  const isConnected = (status === 'Disponível' || status === 'Ativo' || status === 'Em Rota');

  // 1. Cabeçalho / Badge
  const badgeEl = document.getElementById('pwa-rider-status');
  if (badgeEl) {
    badgeEl.innerText = isConnected ? 'Disponível' : (status === 'Em Descanso' ? 'Em Descanso' : 'Indisponível');
    badgeEl.className = 'pwa-status-badge';
    if (isConnected) {
      badgeEl.classList.add('badge-available');
    } else if (status === 'Em Descanso') {
      badgeEl.classList.add('badge-rest');
    } else {
      badgeEl.classList.add('badge-busy');
    }
  }

  // 2. Indicador no Mapa (ONLINE / OFFLINE)
  const mapStatusVal = document.getElementById('map-status-val');
  if (mapStatusVal) {
    mapStatusVal.innerText = isConnected ? 'ONLINE' : 'OFFLINE';
    mapStatusVal.className = isConnected ? 'status-val online' : 'status-val offline';
  }

  // 3. Botão Principal no Mapa (pwa-map-connect-btn)
  const mapBtn = document.getElementById('pwa-map-connect-btn');
  const mapTextEl = document.getElementById('pwa-map-connect-btn-text');
  const mapIconEl = document.getElementById('pwa-map-connect-btn-icon');

  if (mapBtn) {
    mapBtn.className = isConnected ? 'pwa-map-connect-btn main-connect-btn online' : 'pwa-map-connect-btn main-connect-btn offline';
  }
  if (mapTextEl) {
    mapTextEl.innerText = isConnected ? 'Desconectar' : 'Conectar';
  }
  if (mapIconEl) {
    mapIconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`;
  }

  // 4. Botão no Drawer (pwa-connect-btn)
  const drawerBtn = document.getElementById('pwa-connect-btn');
  const drawerTextEl = document.getElementById('pwa-connect-btn-text') || drawerBtn;
  if (drawerTextEl) {
    drawerTextEl.innerText = isConnected ? 'Desconectar' : 'Conectar';
  }
}

function setRiderStatusBadge(status) {
  updateRiderUIStatus(status);
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
      updateRiderUIStatus(data.status);
    }
  } catch (e) {
    logSafeError('fetchAndUpdateRiderStatusFromDBException', e);
  }
}

function updateConnectionButtonState(status) {
  updateRiderUIStatus(status);
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

  const isCurrentlyConnected = (currentStatus === 'Disponível' || currentStatus === 'Ativo' || currentStatus === 'Em Rota');

  if (!isCurrentlyConnected) {
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
      .update({ status: 'Indisponível' })
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
  currentPWATab = tab;
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
    updateAlertPreferencesUI();
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
let selectedTeleId = null;
let selectedTeleMarker = null;

function selectTeleAndFocusMap(teleId) {
  selectedTeleId = teleId;
  closeTeleDetailsModal();
  switchPWATab('map');
  if (activeDeliveriesList) {
    updateMapOverlays(activeDeliveriesList);
  }
}

let isDeliveriesLoading = false;
let hasPendingDeliveriesRefresh = false;
const locallyCompletedTeleIds = new Set();

async function loadMyDeliveries() {
  if (isDeliveriesLoading) {
    hasPendingDeliveriesRefresh = true;
    return;
  }
  isDeliveriesLoading = true;

  const container = document.getElementById('pwa-teles-container');
  // Só exibe spinner de carregamento no primeiro load da sessão ou se container estiver vazio
  if (container && knownActiveTeleIds === null && container.children.length === 0) {
    container.innerHTML = `
      <div class="pwa-loading">
        <div class="pwa-spinner"></div>
        <p>Carregando teles...</p>
      </div>
    `;
  }

  try {
    const riderId = currentRiderId || currentRider?.id;
    if (!db || !riderId) {
      knownActiveTeleIds = [];
      activeDeliveriesList = [];
      if (container) renderEmptyStateCard();
      return;
    }

    const { data: telesData, error } = await db
      .from('teles')
      .select('id, tele_code, client_id, motoboy_id, status, version, pickup_address, pickup_latitude, pickup_longitude, pickup_place_id, pickup_establishment_name, delivery_address, delivery_reference, delivery_latitude, delivery_longitude, delivery_number, delivery_complement, delivery_neighborhood, delivery_city, delivery_state, delivery_postal_code, recipient_name, recipient_phone, notes, total_order_amount, delivery_charge, payment_method, created_at, updated_at, completed_at')
      .eq('motoboy_id', riderId)
      .in('status', ['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega'])
      .order('created_at', { ascending: true });

    if (error) {
      logSafeError('loadMyDeliveries', error);
      if (container && (!activeDeliveriesList || activeDeliveriesList.length === 0)) {
        container.innerHTML = `<p class="pwa-empty-msg">Erro ao carregar teles. Tente novamente.</p>`;
      }
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
        establishment_name: item.pickup_establishment_name || clientInfo?.establishment_name || 'Cliente Comercial',
        client_phone: clientInfo?.phone || null,
        rider_earning: riderEarning,
        rider_earning_display: (riderEarning !== null && !isNaN(riderEarning))
          ? `R$ ${riderEarning.toFixed(2).replace('.', ',')}`
          : 'Valor do motoboy ainda não calculado'
      };

      activeTeleDetailsMap.set(String(item.id), formattedTele);
      return formattedTele;
    }));

    // Ordenação estrita: 1. Não coletadas -> 2. Coletadas -> 3. Em entrega -> 4. Mais antigas primeiro
    activeDeliveries.sort((a, b) => {
      const getStageWeight = (st) => {
        if (st === 'motoboy_designado' || st === 'indo_coletar' || st === 'aguardando_coleta') return 1;
        if (st === 'coletada') return 2;
        if (st === 'em_entrega') return 3;
        return 4;
      };
      const wA = getStageWeight(a.status);
      const wB = getStageWeight(b.status);
      if (wA !== wB) return wA - wB;
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });

    const previousIds = knownActiveTeleIds !== null ? [...knownActiveTeleIds] : null;
    const currentIds = activeDeliveries.map(t => t.id);

    console.log(`[RIDER REFRESH] [LAST REFRESH: ${new Date().toISOString()}] Total ativas: ${currentIds.length}`);

    if (previousIds !== null) {
      // Nova tele atribuída durante a sessão ativa
      const newTeles = currentIds.filter(id => !previousIds.includes(id) && !alertedNewTeleIds.has(id));
      if (newTeles.length > 0) {
        newTeles.forEach(id => alertedNewTeleIds.add(id));
        const newestTele = activeDeliveries.find(t => t.id === newTeles[0]);
        if (newestTele) {
          showHighPriorityNewTeleModal(newestTele);
          sendWebNotification("Nova Tele Atribuída! 🏍️", `A tele ${newestTele.tele_code || newestTele.id} foi atribuída a você.`);
        }
        AudioController.playNewTeleAlert();
      }

      // Remoção durante a sessão ativa
      const removedIds = previousIds.filter(id => !currentIds.includes(id));
      if (removedIds.length > 0) {
        let hasAdminRemoval = false;
        removedIds.forEach(id => {
          alertedNewTeleIds.delete(id);
          if (locallyCompletedTeleIds.has(id)) {
            locallyCompletedTeleIds.delete(id);
          } else {
            hasAdminRemoval = true;
          }
        });

        const modal = document.getElementById('modal-high-priority-tele');
        if (modal && !modal.classList.contains('hidden')) {
          closeHighPriorityModal();
        }

        if (hasAdminRemoval) {
          AudioController.playTeleRemovedAlert();
        }
      }
    } else {
      // Primeiro load: registrar IDs conhecidos sem disparar som de alerta
      currentIds.forEach(id => alertedNewTeleIds.add(id));
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
  } catch (err) {
    logSafeError('loadMyDeliveriesCatch', err);
    if (container && (!activeDeliveriesList || activeDeliveriesList.length === 0)) {
      container.innerHTML = `<p class="pwa-empty-msg">Erro ao carregar teles. Tente novamente.</p>`;
    }
  } finally {
    isDeliveriesLoading = false;
    if (hasPendingDeliveriesRefresh) {
      hasPendingDeliveriesRefresh = false;
      setTimeout(() => loadMyDeliveries(), 50);
    }
  }
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

function toggleTeleAccordion(teleId) {
  const targetId = String(teleId);
  if (activeOpenTeleId === targetId) {
    activeOpenTeleId = null;
  } else {
    activeOpenTeleId = targetId;
  }
  if (activeDeliveriesList) {
    renderTeleCards(activeDeliveriesList);
  }
}

function openPWARoute(teleId, targetType = 'delivery') {
  const tele = activeTeleDetailsMap.get(String(teleId));
  if (!tele) return;

  if (targetType === 'pickup') {
    if (tele.pickup_latitude !== null && tele.pickup_longitude !== null && !isNaN(parseFloat(tele.pickup_latitude)) && !isNaN(parseFloat(tele.pickup_longitude))) {
      const routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${tele.pickup_latitude},${tele.pickup_longitude}&travelmode=driving`;
      window.open(routeUrl, '_blank');
    } else {
      showPWAToast('Coordenadas de coleta não cadastradas para esta Tele antiga.');
    }
  } else {
    let routeUrl = '';
    const fullDeliveryAddress = [
      tele.delivery_address,
      tele.delivery_number ? `nº ${tele.delivery_number}` : '',
      tele.delivery_neighborhood ? `- ${tele.delivery_neighborhood}` : '',
      tele.delivery_city ? `/ ${tele.delivery_city}` : ''
    ].filter(Boolean).join(' ');

    if (tele.delivery_latitude !== null && tele.delivery_longitude !== null && !isNaN(parseFloat(tele.delivery_latitude)) && !isNaN(parseFloat(tele.delivery_longitude))) {
      routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${tele.delivery_latitude},${tele.delivery_longitude}&travelmode=driving`;
    } else {
      routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullDeliveryAddress || 'Endereço de Entrega')}&travelmode=driving`;
    }
    window.open(routeUrl, '_blank');
  }
}

function renderTeleCards(deliveries) {
  initTelesContainerDelegation();
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

function renderWhatsAppButtonHtml(order) {
  const teleCode = order.tele_code || 'TEL-000000';
  const rawPhone = String(order.recipient_phone || '').trim();
  const digitsOnly = rawPhone.replace(/\D/g, '');

  let finalPhone = digitsOnly;
  if (finalPhone && !finalPhone.startsWith('55') && (finalPhone.length === 10 || finalPhone.length === 11)) {
    finalPhone = '55' + finalPhone;
  }

  const isValidPhone = (finalPhone.length >= 12 && finalPhone.startsWith('55'));

  if (isValidPhone) {
    const msg = encodeURIComponent(`Olá, sou o entregador da Tele ${teleCode}.`);
    const waUrl = `https://wa.me/${finalPhone}?text=${msg}`;
    return `
      <button class="pwa-btn" onclick="event.stopPropagation(); window.open('${waUrl}', '_blank')" style="width: 100%; padding: 10px; font-weight: 700; font-size: 0.85rem; background: #25d366; color: #fff; border: none; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 6px;">
        💬 Chamar cliente
      </button>
    `;
  } else {
    return `
      <button class="pwa-btn" disabled style="width: 100%; padding: 10px; font-weight: 600; font-size: 0.85rem; background: #3f3f46; color: #a1a1aa; border: none; border-radius: 8px; cursor: not-allowed; opacity: 0.6; display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 6px;">
        WhatsApp indisponível
      </button>
    `;
  }
}

function createSingleTeleCard(order, isMain) {
  const isOpen = (activeOpenTeleId === String(order.id));
  const isCollected = order.status === 'coletada';
  const isInTransit = order.status === 'em_entrega';
  const isAssigned = order.status === 'motoboy_designado' || order.status === 'indo_coletar' || order.status === 'aguardando_coleta';

  let statusBadgeStyle = 'background: #334155; color: #94a3b8;';
  let statusText = 'Não coletada';

  if (isAssigned) {
    statusBadgeStyle = 'background: #334155; color: #94a3b8;';
    statusText = 'Não coletada';
  } else if (isCollected) {
    statusBadgeStyle = 'background: rgba(16, 185, 129, 0.15); color: #10b981;';
    statusText = 'Coletada';
  } else if (isInTransit) {
    statusBadgeStyle = 'background: rgba(16, 185, 129, 0.15); color: #3b82f6;';
    statusText = 'Em entrega';
  }

  const orderCode = order.tele_code || 'TELE';
  const pickupAddress = order.pickup_address || 'Endereço de Coleta';
  const recipientName = order.recipient_name || 'Destinatário informado';
  const orderAmount = parseFloat(order.total_order_amount) || 0;
  const deliveryCharge = parseFloat(order.delivery_charge) || 0;

  const fullDeliveryAddress = [
    order.delivery_address,
    order.delivery_number ? `nº ${order.delivery_number}` : '',
    order.delivery_neighborhood ? `- ${order.delivery_neighborhood}` : '',
    order.delivery_city ? `/ ${order.delivery_city}` : ''
  ].filter(Boolean).join(' ') || 'Endereço não informado';

  const detailsTxt = [
    order.delivery_complement ? `Comp: ${order.delivery_complement}` : '',
    order.delivery_reference ? `Ref: ${order.delivery_reference}` : ''
  ].filter(Boolean).join(' | ');

  const card = document.createElement('div');
  card.className = 'pwa-tele-card';
  card.style.cssText = `
    background: var(--bg-card);
    border: 1px solid ${isMain ? 'var(--primary)' : 'var(--border)'};
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: all 0.2s ease-in-out;
  `;

  // 1. HEADER (SEMPRE VISÍVEL - ESTADO FECHADO)
  // Contém somente: tele_code, endereço da COLETA, nome do destinatário, Valor do Pedido, status e seta ▼
  const headerHtml = `
    <div onclick="toggleTeleAccordion('${order.id}')" style="display: flex; flex-direction: column; gap: 8px; cursor: pointer;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <strong style="font-family: var(--font-display); font-size: 1.05rem; color: var(--text);">${escapeHtml(orderCode)}</strong>
          <span class="pwa-tele-status" style="padding: 4px 10px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; ${statusBadgeStyle}">${statusText}</span>
        </div>
        <span style="font-size: 0.85rem; color: var(--muted); transform: ${isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}; transition: transform 0.2s ease;">▼</span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 4px; font-size: 0.83rem;">
        <div><span style="color: var(--muted);">Endereço Coleta:</span> <strong style="color: var(--text);">${escapeHtml(pickupAddress)}</strong></div>
        <div><span style="color: var(--muted);">Destinatário:</span> <strong style="color: var(--text);">${escapeHtml(recipientName)}</strong></div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
          <div><span style="color: var(--muted);">Valor do Pedido:</span> <strong style="color: #10b981; font-weight: 700;">${formatMoney(orderAmount)}</strong></div>
          <span style="color: var(--muted); font-size: 0.76rem;">${formatOrderDateForPWA(null, order.created_at)}</span>
        </div>
      </div>
    </div>
  `;

  // 2. DRAWER (ESTADO ABERTO)
  let drawerHtml = '';
  if (isOpen) {
    let actionButtonsHtml = '';
    if (isAssigned) {
      actionButtonsHtml = `
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
          <button class="pwa-btn pwa-btn-primary" data-tele-action="collect" data-tele-id="${order.id}" style="width: 100%; padding: 11px; font-weight: 700; font-size: 0.9rem; background: var(--primary); color: #000; border: none; border-radius: 8px; cursor: pointer;">
            Marcar como coletada
          </button>
          <button class="pwa-btn" onclick="event.stopPropagation(); openPWARoute('${order.id}', 'pickup')" style="width: 100%; padding: 10px; font-weight: 600; font-size: 0.85rem; background: #272732; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 8px; cursor: pointer;">
            🗺️ Rota para Coleta
          </button>
        </div>
      `;
    } else if (isCollected) {
      actionButtonsHtml = `
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
          <button class="pwa-btn pwa-btn-primary" onclick="event.stopPropagation(); requestActionConfirmation('${order.id}', 'start', this)" style="width: 100%; padding: 11px; font-weight: 700; font-size: 0.9rem; background: #10b981; color: #fff; border: none; border-radius: 8px; cursor: pointer;">
            Iniciar entrega
          </button>
          <button class="pwa-btn" onclick="event.stopPropagation(); openPWARoute('${order.id}', 'delivery')" style="width: 100%; padding: 10px; font-weight: 600; font-size: 0.85rem; background: #272732; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 8px; cursor: pointer;">
            🗺️ Rota para Entrega
          </button>
        </div>
      `;
    } else if (isInTransit) {
      actionButtonsHtml = `
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
          <button class="pwa-btn pwa-btn-success" onclick="event.stopPropagation(); requestActionConfirmation('${order.id}', 'complete', this)" style="width: 100%; padding: 11px; font-weight: 700; font-size: 0.9rem; background: #10b981; color: #fff; border: none; border-radius: 8px; cursor: pointer;">
            Finalizar entrega
          </button>
          <button class="pwa-btn" onclick="event.stopPropagation(); openPWARoute('${order.id}', 'delivery')" style="width: 100%; padding: 10px; font-weight: 600; font-size: 0.85rem; background: #272732; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 8px; cursor: pointer;">
            🗺️ Rota para Entrega
          </button>
        </div>
      `;
    }

    const whatsAppButtonHtml = renderWhatsAppButtonHtml(order);

    drawerHtml = `
      <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 4px; display: flex; flex-direction: column; gap: 8px; font-size: 0.82rem;">
        <div><span style="color: var(--muted);">Estabelecimento:</span> <strong style="color: var(--text);">${escapeHtml(order.establishment_name || 'Cliente Comercial')}</strong></div>
        <div><span style="color: var(--muted);">Endereço Coleta:</span> <strong style="color: var(--text);">${escapeHtml(pickupAddress)}</strong></div>
        <div><span style="color: var(--muted);">Destinatário:</span> <strong style="color: var(--text);">${escapeHtml(recipientName)}</strong> ${order.recipient_phone ? `<span style="color: var(--muted);">(${escapeHtml(order.recipient_phone)})</span>` : ''}</div>
        <div><span style="color: var(--muted);">Endereço Entrega:</span> <strong style="color: var(--text);">${escapeHtml(fullDeliveryAddress)}</strong></div>
        ${detailsTxt ? `<div><span style="color: var(--muted);">Detalhamento:</span> <strong style="color: var(--text);">${escapeHtml(detailsTxt)}</strong></div>` : ''}

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; background: rgba(0,0,0,0.25); padding: 10px; border-radius: 8px; margin-top: 4px; border: 1px solid rgba(255,255,255,0.05);">
          <div><span style="color: var(--muted);">Valor da Tele:</span> <strong style="color: var(--text);">${formatMoney(deliveryCharge)}</strong></div>
          <div><span style="color: var(--muted);">Valor do Pedido:</span> <strong style="color: var(--text);">${formatMoney(orderAmount)}</strong></div>
          <div><span style="color: var(--muted);">Pagamento:</span> <strong style="color: var(--text);">${escapeHtml(order.payment_method || 'Faturado')}</strong></div>
          <div><span style="color: var(--muted);">Repasse Motoboy:</span> <strong style="color: #10b981;">${order.rider_earning_display}</strong></div>
        </div>

        ${order.notes ? `<div style="color: #fbbf24; font-size: 0.8rem; background: rgba(251,191,36,0.1); padding: 8px; border-radius: 6px; border: 1px solid rgba(251,191,36,0.2);"><strong>Obs / Mercadoria:</strong> ${escapeHtml(order.notes)}</div>` : ''}

        ${whatsAppButtonHtml}
        ${actionButtonsHtml}
      </div>
    `;
  }

  card.innerHTML = headerHtml + drawerHtml;
  return card;
}

// ─── TELE DETAILS MODAL ───────────────────────────────────────────────────────

function showTeleDetailsModal(teleId) {
  const tele = activeTeleDetailsMap.get(String(teleId));
  if (!tele) return;

  selectedTeleId = tele.id;
  if (activeDeliveriesList) updateMapOverlays(activeDeliveriesList);

  const modal = document.getElementById('pwa-tele-details-modal');
  if (!modal) return;

  const orderCode = tele.tele_code;
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

  // Botão WhatsApp (Normalizado com TEL-XXXXXX)
  const whatsappBtn = document.getElementById('pwa-detail-whatsapp-btn');
  if (whatsappBtn) {
    const rawPhone = tele.recipient_phone || '';
    const normPhone = rawPhone.replace(/\D/g, '');
    let finalPhone = normPhone;
    if (finalPhone && !finalPhone.startsWith('55')) {
      finalPhone = '55' + finalPhone;
    }

    if (finalPhone.length >= 12 && finalPhone.startsWith('55')) {
      const msg = encodeURIComponent(`Olá, sou o entregador da Tele ${tele.tele_code}.`);
      whatsappBtn.disabled = false;
      whatsappBtn.style.opacity = '1';
      whatsappBtn.style.cursor = 'pointer';
      whatsappBtn.innerText = '💬 WhatsApp Cliente';
      whatsappBtn.onclick = (e) => {
        e.stopPropagation();
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

  // Botão Rota Google Maps / Abrir no mapa
  const routeBtn = document.getElementById('pwa-detail-route-btn');
  if (routeBtn) {
    const isAssigned = (tele.status === 'motoboy_designado' || tele.status === 'indo_coletar' || tele.status === 'aguardando_coleta');
    if (isAssigned) {
      routeBtn.innerText = '🗺️ Rota para Coleta (Google Maps)';
      routeBtn.onclick = (e) => {
        e.stopPropagation();
        openPWARoute(tele.id, 'pickup');
      };
    } else {
      routeBtn.innerText = '🗺️ Rota para Entrega (Google Maps)';
      routeBtn.onclick = (e) => {
        e.stopPropagation();
        openPWARoute(tele.id, 'delivery');
      };
    }
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
        <button class="pwa-btn pwa-btn-primary" onclick="requestActionConfirmation('${tele.id}', 'start')" style="width: 100%; padding: 12px; font-weight: 700; font-size: 0.95rem; background: #10b981; color: #fff; border: none; border-radius: 8px; cursor: pointer;">
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

// ─── ACTION CONFIRMATION MODAL & DELEGATION ────────────────────────────────────

let isTelesContainerDelegationAttached = false;

function resetActionConfirmButton() {
  const submitBtn = document.getElementById('pwa-confirm-submit-btn');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.removeAttribute('aria-busy');
    submitBtn.innerText = 'Confirmar';
    submitBtn.onclick = null;
  }
}

function initTelesContainerDelegation() {
  if (isTelesContainerDelegationAttached) return;
  const container = document.getElementById('pwa-teles-container') || document.body;
  if (!container) return;

  container.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-tele-action="collect"]');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    console.log('[COLLECT] CLICK RECEIVED', { target: event.target, button });

    const teleId = button.dataset.teleId;
    if (!teleId) {
      console.error('[COLLECT] error: dataset.teleId missing on button', button);
      showPWAToast('Erro ao identificar ID da Tele.');
      return;
    }

    const tele = activeTeleDetailsMap.get(String(teleId));
    if (!tele) {
      console.error('[COLLECT] error: Tele not found in activeTeleDetailsMap for teleId:', teleId);
      showPWAToast('Tele não encontrada nos dados ativos.');
      return;
    }

    console.log('[COLLECT] TELE FOUND', { teleId: tele.id, version: tele.version, status: tele.status });

    if (tele.version === null || tele.version === undefined || isNaN(Number(tele.version))) {
      console.error('[COLLECT] error: tele.version missing/invalid', tele);
      showPWAToast('Não foi possível obter a versão atual desta Tele.');
      return;
    }

    currentModalActionTele = tele;
    currentModalActionType = 'collect';

    resetActionConfirmButton();

    const modal = document.getElementById('pwa-action-confirm-modal');
    const titleEl = document.getElementById('pwa-confirm-title');
    const msgEl = document.getElementById('pwa-confirm-message');
    const submitBtn = document.getElementById('pwa-confirm-submit-btn');

    if (!modal || !submitBtn) {
      console.error('[COLLECT] error: #pwa-action-confirm-modal or submitBtn missing in DOM');
      showPWAToast('Não foi possível abrir a confirmação da coleta.');
      return;
    }

    titleEl.innerText = 'Confirmar Coleta';
    msgEl.innerText = 'Confirma que o pedido foi coletado?';
    submitBtn.style.background = 'var(--primary)';
    submitBtn.style.color = '#000';
    submitBtn.innerText = 'Confirmar';
    submitBtn.disabled = false;

    console.log('[COLLECT] CONFIRMED', { teleId: tele.id, version: tele.version });

    submitBtn.onclick = async () => {
      await processCollectRpc(tele, button, submitBtn);
    };

    modal.classList.remove('hidden');
  });

  isTelesContainerDelegationAttached = true;
}

async function processCollectRpc(tele, button, modalSubmitBtn) {
  if (!tele || !db) {
    console.error('[COLLECT] error: tele or db missing');
    showPWAToast('Dados da entrega indisponíveis.');
    return;
  }

  const originalBtnText = button ? button.innerText : '';
  if (button) {
    button.disabled = true;
    button.innerText = 'Marcando como coletada...';
  }

  if (modalSubmitBtn) {
    modalSubmitBtn.disabled = true;
    modalSubmitBtn.innerText = 'Marcando como coletada...';
  }

  try {
    const expectedVersion = parseInt(tele.version, 10);
    const riderLat = lastPosition?.lat ?? currentRider?.lat ?? null;
    const riderLng = lastPosition?.lng ?? currentRider?.lng ?? null;

    const rpcParams = {
      p_tele_id: tele.id,
      p_expected_version: expectedVersion,
      p_rider_lat: riderLat,
      p_rider_lng: riderLng
    };

    console.log('[COLLECT] CALLING RPC', { rpcName: 'mark_my_tele_collected', rpcParams });

    const { data: res, error: rpcErr } = await db.rpc('mark_my_tele_collected', rpcParams);

    console.log('[COLLECT] RPC RESPONSE', { data: res, error: rpcErr });

    if (rpcErr) {
      console.error('[COLLECT] rpc error:', rpcErr);
      showPWAToast(rpcErr.message || 'Erro ao processar ação no banco.');
      if (button) {
        button.disabled = false;
        button.innerText = originalBtnText;
      }
      return;
    }

    if (res && res.success === false) {
      console.error('[COLLECT] rpc business rejection:', res);
      if (res.error_code === 'TELE_VERSION_CONFLICT') {
        showPWAToast('Esta Tele foi alterada em outro dispositivo. Atualizando...');
        closeActionConfirmModal();
        closeTeleDetailsModal();
        loadMyDeliveries();
      } else {
        showPWAToast(res.message || 'Erro operacional na transição.');
        if (button) {
          button.disabled = false;
          button.innerText = originalBtnText;
        }
      }
      return;
    }

    closeActionConfirmModal();
    closeTeleDetailsModal();

    if (res && res.success === true) {
      showPWAToast('Pedido marcado como coletado.');
      await loadMyDeliveries();
    }
  } catch (e) {
    console.error('[COLLECT] exception in processCollectRpc:', e);
    showPWAToast(e.message || 'Falha de comunicação com o servidor.');
    if (button) {
      button.disabled = false;
      button.innerText = originalBtnText;
    }
  } finally {
    resetActionConfirmButton();
  }
}

function requestActionConfirmation(teleId, actionType, btnEl) {
  resetActionConfirmButton();
  console.log(`[ACTION:${actionType}] click`, { teleId, actionType });

  const tele = activeTeleDetailsMap.get(String(teleId));
  if (!tele) {
    console.error(`[ACTION:${actionType}] error: Tele not found in activeTeleDetailsMap for teleId:`, teleId);
    showPWAToast('Tele não encontrada nos dados ativos.');
    return;
  }

  currentModalActionTele = tele;
  currentModalActionType = actionType;

  const modal = document.getElementById('pwa-action-confirm-modal');
  const titleEl = document.getElementById('pwa-confirm-title');
  const msgEl = document.getElementById('pwa-confirm-message');
  const submitBtn = document.getElementById('pwa-confirm-submit-btn');

  if (!modal || !submitBtn) {
    console.log(`[ACTION:${actionType}] modal missing, executing directly`);
    executeTeleAction(teleId, actionType, btnEl);
    return;
  }

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

  submitBtn.disabled = false;
  submitBtn.innerText = 'Confirmar';

  console.log(`[ACTION:${actionType}] confirmation opened`, { teleId, version: tele.version });

  submitBtn.onclick = () => {
    console.log(`[ACTION:${actionType}] confirmed`, { teleId, actionType });
    executeTeleAction(teleId, actionType, btnEl);
  };
  modal.classList.remove('hidden');
}

function closeActionConfirmModal() {
  const modal = document.getElementById('pwa-action-confirm-modal');
  if (modal) modal.classList.add('hidden');
  currentModalActionTele = null;
  currentModalActionType = null;
  resetActionConfirmButton();
}

async function executeTeleAction(teleId, actionType, btnEl) {
  const tele = activeTeleDetailsMap.get(String(teleId)) || currentModalActionTele;
  if (!tele || !db) {
    console.error('[ACTION] error: Tele or db missing', { tele, db: !!db });
    showPWAToast('Dados da entrega indisponíveis.');
    return;
  }

  const targetAction = actionType || currentModalActionType;
  const originalText = btnEl ? btnEl.innerText : '';

  if (btnEl) {
    btnEl.disabled = true;
    if (targetAction === 'collect') btnEl.innerText = 'Marcando como coletada...';
    else if (targetAction === 'start') btnEl.innerText = 'Iniciando entrega...';
    else if (targetAction === 'complete') btnEl.innerText = 'Finalizando entrega...';
    else btnEl.innerText = 'Processando...';
  }

  const modalSubmitBtn = document.getElementById('pwa-confirm-submit-btn');
  if (modalSubmitBtn) {
    modalSubmitBtn.disabled = true;
    modalSubmitBtn.innerText = targetAction === 'collect' ? 'Marcando como coletada...' : (targetAction === 'start' ? 'Iniciando entrega...' : 'Finalizando entrega...');
  }

  try {
    let rpcName = '';
    if (targetAction === 'collect') rpcName = 'mark_my_tele_collected';
    else if (targetAction === 'start') rpcName = 'start_my_tele_delivery';
    else if (targetAction === 'complete') rpcName = 'complete_my_tele';

    const expectedVersion = (tele && tele.version !== null && tele.version !== undefined && !isNaN(Number(tele.version)))
      ? parseInt(tele.version, 10)
      : null;

    const riderLat = lastPosition?.lat ?? currentRider?.lat ?? null;
    const riderLng = lastPosition?.lng ?? currentRider?.lng ?? null;

    const rpcParams = {
      p_tele_id: tele.id,
      p_expected_version: expectedVersion
    };

    if (targetAction === 'collect') {
      rpcParams.p_rider_lat = riderLat;
      rpcParams.p_rider_lng = riderLng;
    }

    console.log(`[ACTION:${targetAction}] rpc calling ${rpcName}`, { rpcParams });

    const { data: res, error: rpcErr } = await db.rpc(rpcName, rpcParams);

    console.log(`[ACTION:${targetAction}] rpc result`, { data: res, error: rpcErr });

    if (rpcErr) {
      console.error(`[ACTION:${targetAction}] rpc error:`, rpcErr);
      showPWAToast(rpcErr.message || 'Erro ao processar ação no banco.');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerText = originalText;
      }
      return;
    }

    if (res && res.success === false) {
      console.error(`[ACTION:${targetAction}] rpc business failure:`, res);
      if (res.error_code === 'TELE_VERSION_CONFLICT') {
        showPWAToast('Esta Tele foi alterada em outro dispositivo. Atualizando...');
        closeActionConfirmModal();
        closeTeleDetailsModal();
        loadMyDeliveries();
      } else {
        showPWAToast(res.message || 'Erro operacional na transição.');
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.innerText = originalText;
        }
      }
      return;
    }

    closeActionConfirmModal();
    closeTeleDetailsModal();

    if (res && res.success === true) {
      if (targetAction === 'complete') {
        if (selectedTeleId === tele.id) selectedTeleId = null;
        locallyCompletedTeleIds.add(tele.id);
        showPWAToast('Entrega concluída com sucesso! 🏍️');
      } else if (targetAction === 'collect') {
        showPWAToast('Pedido marcado como coletado.');
      } else if (targetAction === 'start') {
        showPWAToast('Entrega iniciada com sucesso.');
      }
      await loadMyDeliveries();
    }
  } catch (e) {
    console.error(`[ACTION:${targetAction}] exception:`, e);
    showPWAToast(e.message || 'Falha de comunicação com o servidor.');
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerText = originalText;
    }
  } finally {
    resetActionConfirmButton();
  }
}

// ─── REALTIME SUBSCRIPTION, RECONNECTION & FOREGROUND POLLING ─────────────────

let riderRealtimeStatus = 'DISCONNECTED';
let foregroundSafetyPollingInterval = null;

function startForegroundSafetyPolling() {
  stopForegroundSafetyPolling();
  foregroundSafetyPollingInterval = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && (currentRiderId || currentRider?.id)) {
      loadMyDeliveries();
    }
  }, 5000);
}

function stopForegroundSafetyPolling() {
  if (foregroundSafetyPollingInterval) {
    clearInterval(foregroundSafetyPollingInterval);
    foregroundSafetyPollingInterval = null;
  }
}

function subscribeRealtime() {
  const activeRiderId = currentRiderId || currentRider?.id;
  if (!db || !activeRiderId) {
    riderRealtimeStatus = 'DISCONNECTED';
    return;
  }

  if (realtimeChannel) {
    try {
      db.removeChannel(realtimeChannel);
    } catch (e) {
      console.warn('[RIDER REALTIME] Erro ao remover canal anterior:', e.message);
    }
    realtimeChannel = null;
  }

  riderRealtimeStatus = 'CONNECTING';
  const channelName = 'moto-realtime-' + activeRiderId;

  realtimeChannel = db.channel(channelName)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'teles'
    }, async (payload) => {
      console.log('[RIDER REALTIME EVENT]', {
        eventType: payload.eventType,
        id: payload.new?.id || payload.old?.id,
        old_motoboy_id: payload.old?.motoboy_id,
        new_motoboy_id: payload.new?.motoboy_id,
        currentRiderId: activeRiderId,
        timestamp: new Date().toISOString()
      });

      // Executar imediatamente o refresh autoritativo de teles
      await loadMyDeliveries();
      loadReportsData();
      loadWeeklyBalance();
    })
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'support_messages'
    }, (payload) => {

      const newMsg = payload.new;
      const activeId = currentRiderId || currentRider?.id;
      if (newMsg.client_email === activeId) {
        if (newMsg.sender_role !== 'rider') {
          AudioController.playMessageAlert();
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
      const activeId = currentRiderId || currentRider?.id;
      if (!activeId) return;
      
      const isInsert = payload.eventType === 'INSERT';
      const isDelete = payload.eventType === 'DELETE';
      const isUpdate = payload.eventType === 'UPDATE';
      
      let belongsToMe = false;
      
      if (isInsert && payload.new && payload.new.rider_id === activeId) {
        belongsToMe = true;
        sendWebNotification("Novo Consumível Lançado! 🍔", `Um novo consumível de tipo ${payload.new.item_type} (${formatMoney(parseFloat(payload.new.amount))}) foi lançado para você.`);
        AudioController.playMessageAlert();
      } else if (isDelete) {
        belongsToMe = true;
      } else if (isUpdate && (payload.new.rider_id === activeId || (payload.old && payload.old.rider_id === activeId))) {
        belongsToMe = true;
      }
      
      if (belongsToMe) {
        loadConsumablesData();
        loadWeeklyClosures();
      }
    });

  realtimeChannel.subscribe((status, err) => {
    riderRealtimeStatus = status;
    if (status === 'SUBSCRIBED') {
      console.log('[RIDER REALTIME] SUBSCRIBED');
    } else if (err || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      console.warn('[RIDER REALTIME] Status:', status, err);
    }
  });
}

let reconnectDebounceTimer = null;
function handleForegroundAndNetworkRecovery() {
  const activeId = currentRiderId || currentRider?.id;
  if (!activeId) return;
  if (reconnectDebounceTimer) clearTimeout(reconnectDebounceTimer);
  reconnectDebounceTimer = setTimeout(async () => {
    console.log('[RIDER REALTIME] RECONNECT check (status:', riderRealtimeStatus, ')');
    if (riderRealtimeStatus !== 'SUBSCRIBED') {
      subscribeRealtime();
    }
    await loadMyDeliveries();
  }, 300);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleForegroundAndNetworkRecovery();
      startForegroundSafetyPolling();
    } else {
      stopForegroundSafetyPolling();
    }
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', () => {
    handleForegroundAndNetworkRecovery();
    startForegroundSafetyPolling();
  });
  window.addEventListener('online', () => {
    handleForegroundAndNetworkRecovery();
    startForegroundSafetyPolling();
  });
  window.addEventListener('focus', () => {
    handleForegroundAndNetworkRecovery();
    startForegroundSafetyPolling();
  });
}

// ─── MAP (SINGLETON LOADER & REUSABLE INSTANCE) ──────────────────────────────

let googleMapsLoaderPromise = null;

async function ensureGoogleMapsLoaded() {
  if (window.google?.maps?.Map) {
    return true;
  }
  if (window._googleMapsLoaderPromise) {
    await window._googleMapsLoaderPromise;
    if (window.google?.maps?.importLibrary && !window.google?.maps?.Map) {
      try {
        await window.google.maps.importLibrary('maps');
      } catch (e) {}
    }
    return Boolean(window.google?.maps?.Map);
  }

  const apiKey = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.googleMapsApiKey) ||
                 (window.LOCAL_SUPABASE_CONFIG && window.LOCAL_SUPABASE_CONFIG.googleMapsApiKey) || '';

  if (!apiKey) {
    console.warn("⚠️ Google Maps API Key não configurada.");
    return false;
  }

  const existingScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
  if (existingScript) {
    window._googleMapsLoaderPromise = new Promise((resolve) => {
      let checks = 0;
      const interval = setInterval(async () => {
        checks++;
        if (window.google?.maps?.Map) {
          clearInterval(interval);
          resolve(true);
        } else if (window.google?.maps?.importLibrary) {
          try {
            await window.google.maps.importLibrary('maps');
            if (window.google?.maps?.Map) {
              clearInterval(interval);
              resolve(true);
              return;
            }
          } catch (e) {}
        }
        if (checks > 100) {
          clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });
    return await window._googleMapsLoaderPromise;
  }

  window._googleMapsLoaderPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker`;
    script.async = true;
    script.defer = true;
    script.onload = async () => {
      if (window.google?.maps?.importLibrary && !window.google?.maps?.Map) {
        try {
          await window.google.maps.importLibrary('maps');
        } catch (e) {}
      }
      resolve(Boolean(window.google?.maps?.Map));
    };
    script.onerror = (err) => {
      console.error("Erro ao carregar script do Google Maps:", err);
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return await window._googleMapsLoaderPromise;
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

  if (lastPosition) {
    placeRiderMarker(lastPosition.lat, lastPosition.lng);
  }
}

let riderMarker = null;

function placeRiderMarker(lat, lng) {
  if (!riderMap || typeof window.google === 'undefined' || typeof window.google.maps === 'undefined') return;

  const pos = { lat, lng };

  // Ícone de bolinha verde moderna (18px) com borda branca e sombra discreta
  const riderIcon = {
    path: window.google.maps.SymbolPath.CIRCLE,
    fillColor: '#22c55e',
    fillOpacity: 1.0,
    scale: 9, // Diâmetro de 18px
    strokeColor: '#ffffff',
    strokeWeight: 3
  };

  if (riderMarker) {
    riderMarker.setPosition(pos);
    riderMarker.setIcon(riderIcon);
  } else {
    riderMarker = new window.google.maps.Marker({
      position: pos,
      map: riderMap,
      icon: riderIcon,
      title: 'Você está aqui',
      zIndex: 9999
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

function playNotificationSound() {
  AudioController.playTeleAlert();
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
  const badge = document.getElementById('map-teles-badge');
  if (badge) {
    if (deliveries && deliveries.length > 0) {
      badge.innerText = deliveries.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (!riderMap || typeof window.google === 'undefined' || typeof window.google.maps === 'undefined') return;

  // Se a Tele selecionada não existe mais nas entregas ativas, limpa a seleção
  if (selectedTeleId && (!deliveries || !deliveries.some(d => d.id === selectedTeleId))) {
    selectedTeleId = null;
  }

  // Se não houver selectedTeleId mas existirem entregas ativas, seleciona a primeira da lista por padrão
  if (!selectedTeleId && deliveries && deliveries.length > 0) {
    selectedTeleId = deliveries[0].id;
  }

  const selectedTele = selectedTeleId ? activeTeleDetailsMap.get(String(selectedTeleId)) : null;

  if (!selectedTele) {
    if (selectedTeleMarker) {
      selectedTeleMarker.setMap(null);
      selectedTeleMarker = null;
    }
    return;
  }

  const isCollectedOrDelivering = (selectedTele.status === 'coletada' || selectedTele.status === 'em_entrega');
  
  let targetLat = null;
  let targetLng = null;
  let targetTitle = '';

  if (!isCollectedOrDelivering) {
    // Antes da Coleta -> Aponta para o Estabelecimento / Coleta
    targetLat = selectedTele.pickup_latitude !== null ? parseFloat(selectedTele.pickup_latitude) : null;
    targetLng = selectedTele.pickup_longitude !== null ? parseFloat(selectedTele.pickup_longitude) : null;
    targetTitle = `Coleta: ${selectedTele.establishment_name || 'Estabelecimento'}`;
  } else {
    // Após a Coleta -> Aponta para o Cliente / Entrega
    targetLat = selectedTele.delivery_latitude !== null ? parseFloat(selectedTele.delivery_latitude) : null;
    targetLng = selectedTele.delivery_longitude !== null ? parseFloat(selectedTele.delivery_longitude) : null;
    targetTitle = `Entrega: ${selectedTele.recipient_name || 'Cliente'}`;
  }

  if (targetLat !== null && targetLng !== null && !isNaN(targetLat) && !isNaN(targetLng)) {
    const pos = { lat: targetLat, lng: targetLng };
    if (selectedTeleMarker) {
      selectedTeleMarker.setPosition(pos);
      selectedTeleMarker.setTitle(targetTitle);
      selectedTeleMarker.setMap(riderMap);
    } else {
      selectedTeleMarker = new window.google.maps.Marker({
        position: pos,
        map: riderMap,
        title: targetTitle
      });
    }

    const bounds = new window.google.maps.LatLngBounds();
    if (lastPosition && lastPosition.lat && lastPosition.lng) {
      bounds.extend(new window.google.maps.LatLng(lastPosition.lat, lastPosition.lng));
    }
    bounds.extend(new window.google.maps.LatLng(targetLat, targetLng));
    riderMap.fitBounds(bounds, { padding: 60, maxZoom: 16 });
  } else {
    if (selectedTeleMarker) {
      selectedTeleMarker.setMap(null);
      selectedTeleMarker = null;
    }
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

function getOperationalWeekStartAndEnd(nowDate = new Date()) {
  const d = new Date(nowDate);
  const day = d.getDay(); // 0: Sun, 1: Mon, ..., 6: Sat
  const diffToMonday = (day === 0 ? -6 : 1 - day);

  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    startDate: formatISOShortDate(monday),
    endDate: formatISOShortDate(sunday)
  };
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
    const weekDates = getOperationalWeekStartAndEnd();
    startDate = weekDates.startDate;
    endDate = weekDates.endDate;
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

  initPWAFinancialRealtime();

  // 1. Carregar resumo (saldo hero + contadores) de forma isolada
  try {
    const { data: summary, error: sumErr } = await supabaseClient.rpc('get_my_rider_financial_summary', {
      p_start_date: startDate,
      p_end_date: endDate
    });

    if (currentToken === reportsFetchToken && summary && summary.success) {
      const heroNetEl = document.getElementById('pwa-hero-net-balance');
      const settlementBadgeEl = document.getElementById('pwa-settlement-status-badge');
      
      const countEl = document.getElementById('reports-deliveries-count');
      const earnEl = document.getElementById('reports-deliveries-earnings');
      const credEl = document.getElementById('reports-credits-total');
      const dedEl = document.getElementById('reports-deductions-total');
      const netEl = document.getElementById('reports-period-net-total');
      const periodLabelEl = document.getElementById('pwa-statement-period-label');

      if (periodLabelEl) periodLabelEl.textContent = summary.period_label || labelText;
      if (heroNetEl) heroNetEl.textContent = formatMoneyBR(summary.net_total);

      if (settlementBadgeEl) {
        settlementBadgeEl.innerHTML = `<span style="background: rgba(156,163,175,0.15); color: #9ca3af; border: 1px solid rgba(156,163,175,0.3); padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; display: inline-block;">Ciclo em Andamento</span>`;
      }

      if (countEl) countEl.textContent = summary.completed_deliveries_count || 0;
      if (earnEl) earnEl.textContent = formatMoneyBR(summary.delivery_earnings);
      if (credEl) credEl.textContent = formatMoneyBR(summary.credits_display_total ?? summary.credits_total);
      if (dedEl) dedEl.textContent = `- ${formatMoneyBR(summary.deductions_display_total ?? summary.deductions_total)}`;
      if (netEl) netEl.textContent = formatMoneyBR(summary.net_total);
    }
  } catch (err) {
    console.error('Erro ao carregar resumo financeiro:', err);
  }

  // 2. Carregar extrato de lançamentos de forma isolada
  try {
    const { data: stmt, error: stmtErr } = await supabaseClient.rpc('get_my_rider_financial_statement', {
      p_start_date: startDate,
      p_end_date: endDate,
      p_limit: REPORTS_STATEMENT_LIMIT,
      p_offset: 0
    });

    if (currentToken === reportsFetchToken) {
      if (stmtErr) throw stmtErr;
      if (stmt && stmt.success) {
        renderPWAFinancialStatementItems(stmt.items || [], false);
      }
    }
  } catch (err) {
    console.error('Erro ao carregar extrato financeiro:', err);
    if (currentToken === reportsFetchToken && listContainer) {
      listContainer.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #ef4444; font-size: 0.82rem; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); border-radius: 12px;">
          Falha ao carregar extrato financeiro. <br>
          <button onclick="loadPWAFinancialReports()" style="margin-top: 8px; background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 4px 12px; border-radius: 6px; font-size: 0.75rem; cursor: pointer;">Tentar Novamente</button>
        </div>
      `;
    }
  }

  // 3. Carregar histórico de repasses semanais de forma isolada
  try {
    await loadPWAWeeklySettlementsHistory();
  } catch (err) {
    console.error('Erro ao carregar histórico de repasses:', err);
  }

  if (isManualRefresh) {
    showPWAToast('Dados financeiros atualizados.');
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

    const isCredit = (item.direction || '').toLowerCase() === 'credit';
    const amountSign = isCredit ? '+' : '-';
    const amountColor = isCredit ? '#10b981' : '#ef4444';
    const iconBg = isCredit ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)';
    const isDelivery = item.transaction_category === 'delivery_earning' || (item.type || '').toLowerCase().includes('entrega') || item.source_type === 'rider_earning' || item.source_type === 'tele';
    const iconSymbol = isDelivery ? '🛵' : (isCredit ? '💵' : '🎒');

    let titleText = item.tele_code || item.title;
    if (!titleText || /^[0-9a-fA-F-]{36}$/.test(titleText)) {
      titleText = isDelivery ? 'Entrega' : 'Lançamento Financeiro';
    }

    let subTitleText = item.sanitized_description;
    if (!subTitleText || subTitleText === 'undefined' || /^[0-9a-fA-F-]{36}$/.test(subTitleText)) {
      subTitleText = isDelivery ? 'Entrega concluída' : (item.description || '');
      if (/^[0-9a-fA-F-]{36}$/.test(subTitleText) || subTitleText === 'undefined') {
        subTitleText = '';
      }
    }

    const txDate = new Date(item.occurred_at || item.created_at);
    const dateFmt = txDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    const cardHtml = `
      <div class="pwa-statement-card" onclick="openPWATransactionDetailModal('${id}')" style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; transition: background 0.15s ease;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 38px; height: 38px; border-radius: 10px; background: ${iconBg}; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; flex-shrink: 0;">
            ${iconSymbol}
          </div>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <strong style="font-size: 0.85rem; color: var(--text); font-weight: 700;">${escapeHtml(titleText)}</strong>
            <span style="font-size: 0.7rem; color: var(--muted);">${subTitleText ? escapeHtml(subTitleText) + ' • ' : ''}${dateFmt}</span>
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

  const isCredit = (item.direction || '').toLowerCase() === 'credit';
  const isDelivery = item.transaction_category === 'delivery_earning' || (item.type || '').toLowerCase().includes('entrega') || item.source_type === 'rider_earning' || item.source_type === 'tele';

  let titleText = item.tele_code || item.title;
  if (!titleText || /^[0-9a-fA-F-]{36}$/.test(titleText)) {
    titleText = isDelivery ? 'Entrega' : 'Lançamento Financeiro';
  }
  if (categoryEl) categoryEl.textContent = titleText;

  if (amountEl) {
    amountEl.textContent = `${isCredit ? '+' : '-'} ${formatMoneyBR(item.amount)}`;
    amountEl.style.color = isCredit ? '#10b981' : '#ef4444';
  }

  const txDate = new Date(item.occurred_at || item.created_at);
  if (dateEl) dateEl.textContent = txDate.toLocaleString('pt-BR');
  if (typeEl) typeEl.textContent = isCredit ? 'Crédito (Entrada)' : 'Débito (Saída / Desconto)';

  if (item.tele_code) {
    if (teleRow) teleRow.classList.remove('hidden');
    if (teleCodeEl) teleCodeEl.textContent = item.tele_code;
  } else if (isDelivery) {
    if (teleRow) teleRow.classList.remove('hidden');
    if (teleCodeEl) teleCodeEl.textContent = 'Entrega';
  } else {
    if (teleRow) teleRow.classList.add('hidden');
  }

  if (addrRow) addrRow.classList.add('hidden');

  let descText = item.sanitized_description;
  if (!descText || descText === 'undefined' || /^[0-9a-fA-F-]{36}$/.test(descText)) {
    descText = isDelivery ? 'Entrega concluída' : (item.description || 'Nenhuma observação registrada.');
    if (/^[0-9a-fA-F-]{36}$/.test(descText) || descText === 'undefined') {
      descText = 'Nenhuma observação registrada.';
    }
  }
  if (descEl) descEl.textContent = descText;

  modal.classList.remove('hidden');
}

function closePWATransactionDetailModal() {
  const modal = document.getElementById('pwa-transaction-detail-modal');
  if (modal) modal.classList.add('hidden');
}

async function loadPWAWeeklySettlementsHistory() {
  const container = document.getElementById('pwa-weekly-settlements-container');
  if (!container || !supabaseClient) return;

  try {
    const { data: res, error } = await supabaseClient.rpc('get_my_rider_weekly_settlements_history');
    if (error || !res || !res.success) {
      console.warn('Erro ao carregar histórico de repasses semanais:', error);
      return;
    }

    const items = res.history || [];
    if (items.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 18px 12px; color: var(--muted); font-size: 0.8rem; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;">
          Nenhum repasse de semana anterior registrado.
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    items.forEach(item => {
      const isPaid = item.status === 'paid';
      const statusText = item.status_label || (isPaid ? 'Pago' : 'Pendente');

      const badgeBg = isPaid ? 'rgba(16,185,129,0.15)' : 'rgba(234,179,8,0.15)';
      const badgeColor = isPaid ? '#10b981' : '#eab308';
      const badgeBorder = isPaid ? 'rgba(16,185,129,0.3)' : 'rgba(234,179,8,0.3)';

      let paidAtFormatted = '';
      if (isPaid && item.paid_at) {
        const d = new Date(item.paid_at);
        paidAtFormatted = `Pago em ${d.toLocaleDateString('pt-BR')}`;
      } else if (!isPaid) {
        paidAtFormatted = 'Aguardando pagamento';
      }

      let periodStr = item.period_label;
      if (!periodStr && item.period_start && item.period_end) {
        const sD = new Date(item.period_start + 'T00:00:00');
        const eD = new Date(item.period_end + 'T00:00:00');
        const sFmt = sD.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const eFmt = eD.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        periodStr = `${sFmt} – ${eFmt}`;
      }

      const cardHtml = `
        <div class="pwa-settlement-history-card" style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <strong style="font-size: 0.9rem; color: var(--text); font-weight: 700;">${escapeHtml(periodStr || 'Semana Encerrada')}</strong>
            <span style="font-size: 0.72rem; color: var(--muted); font-weight: 500;">${paidAtFormatted ? escapeHtml(paidAtFormatted) : ''}</span>
          </div>
          <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
            <strong style="font-size: 1.05rem; color: var(--text); font-weight: 800; font-family: var(--font-display);">${formatMoneyBR(item.net_amount)}</strong>
            <span style="background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder}; padding: 3px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: 700; display: inline-block;">${escapeHtml(statusText)}</span>
          </div>
        </div>
      `;
      container.insertAdjacentHTML('beforeend', cardHtml);
    });
  } catch (e) {
    console.error('Erro ao renderizar histórico de repasses:', e);
  }
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

