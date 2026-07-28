// Dahora Expresso — Motoboy PWA Logic
const SUPABASE_URL = (typeof window !== 'undefined' && window.SUPABASE_CONFIG) ? window.SUPABASE_CONFIG.url : 'https://fajkqyapnycnnumpdwrr.supabase.co';
const SUPABASE_KEY = (typeof window !== 'undefined' && window.SUPABASE_CONFIG) ? window.SUPABASE_CONFIG.key : 'sb_publishable_zkb7DUOrpx9fiF6Af0cH8A_V8LrSb1a';

let db = null;
if (typeof window !== 'undefined' && window.supabase) {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

if (typeof mapboxgl !== 'undefined') {
  mapboxgl.accessToken = ['pk', 'eyJ1Ijoic25la3giLCJhIjoiY21xc3g5eXEzMGQweTJzb2xoemg1YzQwZCJ9', 'SyNFqkGgDnkuvY2wRpFDhg'].join('.');
}

let currentRider = null;  // fleet row of logged-in motoboy
let riderMap = null;      // Mapbox map instance
let realtimeChannel = null;
let watchId = null;       // geolocation watch ID
let lastPosition = null;  // { lat, lng }
let currentBatteryLevel = null;
let hasCenteredOnce = false;
let knownActiveTeleIds = null; // IDs of active deliveries to play chime on new arrivals
let activeRiderDeliveryMarkers = {}; // Cache active markers by order ID to avoid recreating them and closing popups
let activeDeliveriesList = [];  // Cache list of active deliveries
let lastActiveTeleId = null;    // Track changes to fit map bounds once

// ─── INIT ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (window.supabase) {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }

  lucide.createIcons();
  registerSW();

  // Check for persisted session
  const saved = localStorage.getItem('speedMotoSession');
  if (saved) {
    try {
      currentRider = JSON.parse(saved);
      showApp();
      loadMyDeliveries();
      startGeolocation();
    } catch {
      localStorage.removeItem('speedMotoSession');
    }
  }
});

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        reg.update();
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (sw) sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              sw.postMessage?.('skip-waiting');
            }
          });
        });
      })
      .catch(() => {});
  }
}

function requestNotificationPermission() {
  if (!('Notification' in window)) {
    console.log('Notification API not supported by browser.');
    return;
  }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        showPWAToast('Notificações ativadas! 🔔');
      }
    });
  }
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
  e.preventDefault();

  const rawId  = document.getElementById('moto-id').value.trim().toUpperCase();
  const pin    = document.getElementById('moto-pin').value.trim();
  const btn    = document.getElementById('login-btn');
  const errEl  = document.getElementById('login-error');

  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.innerText = 'Verificando...';

  if (!db) {
    showLoginError('Serviço indisponível. Tente novamente.');
    btn.disabled = false;
    btn.innerText = 'Entrar';
    return;
  }

  // The ID stored in Supabase is like "#MB-5123" — extract only digits and format
  const digits = rawId.replace(/\D/g, '');
  const motoboyId = `#MB-${digits}`;

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), 5000)
    );

    const queryPromise = db
      .from('fleet')
      .select('*')
      .eq('id', motoboyId)
      .eq('pin', pin)
      .maybeSingle();

    const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

    btn.disabled = false;
    btn.innerText = 'Entrar';

    if (error) {
      console.error("Database query error during login:", error);
      console.error("FULL LOGIN ERROR DETAILS (PostgreSQL/Supabase):", error);
      alert("Erro Supabase/Query: " + JSON.stringify(error));
      showLoginError('Erro de conexão ou sistema. Verifique a internet.');
      return;
    }

    if (!data) {
      showLoginError('ID ou PIN incorreto. Contate o administrador.');
      return;
    }

    currentRider = data;
    localStorage.setItem('speedMotoSession', JSON.stringify(data));
    showApp();
    loadMyDeliveries();
    startGeolocation();
  } catch (err) {
    console.error("Unhandled login exception:", err);
    console.error("FULL LOGIN ERROR DETAILS (exception):", err);
    alert("Exceção de Login: " + (err.message || String(err)) + "\n" + JSON.stringify(err));
    showLoginError('Erro na conexão ou dados inválidos. Tente novamente.');
    btn.disabled = false;
    btn.innerText = 'Entrar';
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.innerText = msg;
  el.classList.remove('hidden');
}

function handleMotoLogout() {
  if (!confirm('Sair do aplicativo?')) return;
  localStorage.removeItem('speedMotoSession');
  localStorage.removeItem('activePWATab');
  if (realtimeChannel) db.removeChannel(realtimeChannel);
  if (watchId) navigator.geolocation.clearWatch(watchId);
  currentRider = null;
  knownActiveTeleIds = null;
  hasCenteredOnce = false;
  document.getElementById('pwa-app').classList.add('hidden');
  document.getElementById('pwa-login').classList.remove('hidden');
  document.getElementById('moto-id').value = '';
  document.getElementById('moto-pin').value = '';
  // Close drawer if open
  togglePWADrawer(false);
  lucide.createIcons();
}

// ─── SCREEN TRANSITIONS ───────────────────────────────────────────────────────

function showApp() {
  document.getElementById('pwa-login').classList.add('hidden');
  document.getElementById('pwa-app').classList.remove('hidden');

  // Fill header info
  document.getElementById('pwa-rider-name').innerText = currentRider.name || 'Motoboy';
  setRiderStatusBadge(currentRider.status || 'Disponível');

  // Fill drawer info
  const drawerName = document.getElementById('drawer-rider-name');
  const drawerId = document.getElementById('drawer-rider-id');
  if (drawerName) drawerName.innerText = currentRider.name || 'Motoboy';
  if (drawerId) drawerId.innerText = currentRider.id || '#MB-0000';

  // Initialize connection button state
  updateConnectionButtonState(currentRider.status || 'Disponível');

  // Load profile details (email and photo), weekly earnings balance and consumables
  loadLocalProfile();
  loadWeeklyBalance();
  loadConsumablesData();

  // Request notification permissions
  requestNotificationPermission();

  // Switch to saved tab or fallback to map
  const savedTab = localStorage.getItem('activePWATab');
  const targetTab = savedTab ? savedTab : 'map';
  hasCenteredOnce = false;
  switchPWATab(targetTab);
  subscribeRealtime();
  lucide.createIcons();
}

function setRiderStatusBadge(status) {
  const el = document.getElementById('pwa-rider-status');
  el.innerText = status;
  el.className = 'pwa-status-badge';
  if (status === 'Disponível') el.classList.add('badge-available');
  else if (status.includes('Descanso')) el.classList.add('badge-rest');
  else el.classList.add('badge-busy');
}

// ─── CONNECTION / STATUS TOGGLING ───────────────────────────────────────────

function updateConnectionButtonState(status) {
  const btn = document.getElementById('pwa-connect-btn');
  const statusVal = document.getElementById('map-status-val');
  
  if (!btn) return;

  if (status === 'Em Descanso') {
    btn.innerText = 'Conectar';
    btn.className = 'pwa-btn-connect-pill offline';
    if (statusVal) {
      statusVal.innerText = 'OFFLINE';
      statusVal.className = 'status-val offline';
    }
  } else {
    btn.innerText = 'Desconectar';
    btn.className = 'pwa-btn-connect-pill online';
    if (statusVal) {
      statusVal.innerText = 'ONLINE';
      statusVal.className = 'status-val online';
    }
  }
}

async function toggleConnectionState() {
  if (!db || !currentRider) return;
  const btn = document.getElementById('pwa-connect-btn');
  if (!btn) return;

  const currentStatus = currentRider.status || 'Disponível';
  
  if (currentStatus === 'Em Descanso') {
    // Connect -> change status to 'Disponível'
    btn.disabled = true;
    btn.innerText = 'Conectando...';
    
    const { error } = await db
      .from('fleet')
      .update({ status: 'Disponível', status_class: 'status-success' })
      .eq('id', currentRider.id);

    btn.disabled = false;
    if (error) {
      alert('Erro ao conectar. Tente novamente.');
      updateConnectionButtonState(currentStatus);
      return;
    }

    currentRider.status = 'Disponível';
    localStorage.setItem('speedMotoSession', JSON.stringify(currentRider));
    setRiderStatusBadge('Disponível');
    updateConnectionButtonState('Disponível');
    showPWAToast('Você está online!');
    requestNotificationPermission();
  } else {
    // Disconnect -> check if there are active deliveries
    btn.disabled = true;
    btn.innerText = 'Desconectando...';
    
    // Check if there are active deliveries for this motoboy
    const { data, error: countError } = await db
      .from('teles')
      .select('id')
      .eq('rider', currentRider.name)
      .neq('status', 'Entregue');

    if (countError) {
      alert('Erro ao verificar status de corridas. Tente novamente.');
      btn.disabled = false;
      updateConnectionButtonState(currentStatus);
      return;
    }

    if (data && data.length > 0) {
      alert('Você tem uma entrega em andamento! Conclua-a antes de se desconectar.');
      btn.disabled = false;
      updateConnectionButtonState(currentStatus);
      return;
    }

    // Disconnect -> change status to 'Em Descanso'
    const { error } = await db
      .from('fleet')
      .update({ status: 'Em Descanso', status_class: 'status-warning' })
      .eq('id', currentRider.id);

    btn.disabled = false;
    if (error) {
      alert('Erro ao desconectar. Tente novamente.');
      updateConnectionButtonState(currentStatus);
      return;
    }

    currentRider.status = 'Em Descanso';
    localStorage.setItem('speedMotoSession', JSON.stringify(currentRider));
    setRiderStatusBadge('Em Descanso');
    updateConnectionButtonState('Em Descanso');
    showPWAToast('Você está offline.');
  }
}

// ─── TAB NAVIGATION ──────────────────────────────────────────────────────────

function switchPWATab(tab) {
  localStorage.setItem('activePWATab', tab);
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
      if (!riderMap) initRiderMap();
      else riderMap.invalidateSize();
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
  lucide.createIcons();
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

async function loadMyDeliveries() {
  const container = document.getElementById('pwa-teles-container');
  container.innerHTML = `
    <div class="pwa-loading">
      <div class="pwa-spinner"></div>
      <p>Carregando teles...</p>
    </div>
  `;

  if (!db || !currentRider) return;

  const { data, error } = await db
    .from('teles')
    .select('*')
    .eq('rider', currentRider.name)
    .neq('status', 'Entregue')
    .order('id', { ascending: false });

  if (error) {
    container.innerHTML = `<p class="pwa-empty-msg">Erro ao carregar teles. Tente novamente.</p>`;
    return;
  }

  const activeDeliveries = (data || []).map(item => {
    const fixedPrice = getFixedPriceByAddress(item.address);
    return {
      ...item,
      price: `R$ ${fixedPrice.toFixed(2).replace('.', ',')}`
    };
  });
  const currentIds = activeDeliveries.map(t => t.id);

  // If this is not the first check and we have newly assigned teles, play sound notification
  if (knownActiveTeleIds !== null) {
    const newTeles = currentIds.filter(id => !knownActiveTeleIds.includes(id));
    if (newTeles.length > 0) {
      playNotificationSound();
    }
  }
  knownActiveTeleIds = currentIds;
  activeDeliveriesList = activeDeliveries;

  // Update map floating badges and action buttons
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

function renderTeleCards(deliveries) {
  const container = document.getElementById('pwa-teles-container');

  if (deliveries.length === 0) {
    container.innerHTML = `
      <div class="pwa-empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        <p>Nenhuma tele ativa no momento.</p>
        <span>Aguardando despacho do administrador.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  deliveries.forEach(order => {
    const isPickup   = order.status === 'A caminho da coleta';
    const isTransit  = order.status === 'Em rota de entrega';

    const fixedPrice = getFixedPriceByAddress(order.address);
    const valorRepasseLiquido = fixedPrice * 0.90;

    // Rule 2: Address Flow on UI
    const displayAddress = isPickup 
      ? 'Rua Ana Rosa 221, Ipiranga - Sapucaia' 
      : (order.address || 'Sem endereço');

    let mapsUrl = '';
    if (isPickup) {
      const isCentral = order.pickup_lat !== null && order.pickup_lng !== null &&
        Math.abs(order.pickup_lat - (-29.842173)) < 0.005 &&
        Math.abs(order.pickup_lng - (-51.126764)) < 0.005;

      if (isCentral) {
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent('Rua Ana Rosa 221, Ipiranga, Sapucaia do Sul')}&travelmode=driving`;
      } else if (order.pickup_lat !== null && order.pickup_lng !== null && !isNaN(order.pickup_lat) && !isNaN(order.pickup_lng)) {
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${order.pickup_lat},${order.pickup_lng}&travelmode=driving`;
      } else {
        mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.client || 'Cliente Comercial')}`;
      }
    } else {
      if (order.address) {
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(order.address)}&travelmode=driving`;
      } else if (order.dest_lat !== null && order.dest_lng !== null && !isNaN(order.dest_lat) && !isNaN(order.dest_lng)) {
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${order.dest_lat},${order.dest_lng}&travelmode=driving`;
      } else {
        mapsUrl = `https://www.google.com/maps/search/?api=1&query=Entregador`;
      }
    }

    const paymentMethod = getPaymentMethod(order);
    const isIntegration = false;
    
    // Formatos Comerciais Padronizados (Dinheiro, PIX, Cartão, Faturado)
    const isOnline = paymentMethod.toLowerCase().includes('pago') || paymentMethod.toLowerCase().includes('faturado');
    let paymentBadge = 'Faturado';
    if (paymentMethod.toLowerCase().includes('dinheiro')) paymentBadge = 'Dinheiro';
    else if (paymentMethod.toLowerCase().includes('cartão') || paymentMethod.toLowerCase().includes('cartao')) paymentBadge = 'Cartão';
    else if (paymentMethod.toLowerCase().includes('pix')) paymentBadge = 'PIX';

    const cleanDist = getCleanDistance(order.dist);
    const cleanTotalAmount = order.total_order_amount || order.price || 'R$ 0,00';
    
    const paymentText = isOnline
      ? `${paymentBadge} - ${order.client || 'Plataforma'} Pago: ${cleanTotalAmount}`
      : `${paymentBadge} - Cobrar na Entrega: ${cleanTotalAmount}`;

    // Parse items count from cargo
    let itemsCount = 1;
    if (order.cargo) {
      const cargoClean = order.cargo.replace(/🍔 Itens:\s*/g, '');
      const parts = cargoClean.split('+').map(p => p.trim()).filter(Boolean);
      let count = 0;
      for (const part of parts) {
        const match = part.match(/^(\d+)x?/i);
        if (match) {
          count += parseInt(match[1]) || 1;
        } else {
          count += 1;
        }
      }
      if (count > 0) itemsCount = count;
    }

    const card = document.createElement('div');
    card.className = 'pwa-tele-card';
    card.innerHTML = `
      <div class="pwa-tele-header">
        <strong class="pwa-tele-id">${order.id}</strong>
        <span class="pwa-tele-status ${order.status_class || 'status-progress'}">${order.status}</span>
      </div>
      <div class="pwa-tele-body" style="display: flex; flex-direction: column; gap: 8px; font-size: 0.85rem;">
        
        <!-- Customer Details -->
        <div>
          <span style="color: var(--muted); font-size: 0.8rem;">Nome do Cliente</span>
          <div style="font-weight: 600; color: var(--text); margin-top: 2px;">Nome: ${order.destName || order.dest_name || 'Cliente'}</div>
        </div>

        <!-- Destination Address (Bold Highlighted) -->
        <div style="margin-top: 4px;">
          <span style="color: var(--muted); font-size: 0.8rem;">Endereço de Entrega</span>
          <div style="font-weight: 700; color: #fff; font-size: 0.95rem; line-height: 1.4; margin-top: 2px; display: flex; align-items: flex-start; gap: 6px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; margin-top: 2px;"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
            <span>${displayAddress}</span>
          </div>
        </div>

        <!-- Order Metadata -->
        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--muted);">Horário do Pedido:</span>
            <span style="color: var(--text); font-weight: 500;">Pedido feito em: ${formatOrderDateForPWA(order.date, order.created_at)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--muted);">Quantidade de Itens:</span>
            <span style="color: var(--text); font-weight: 500;">Itens: ${itemsCount} itens</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--muted);">Distância da Rota:</span>
            <span style="color: var(--text); font-weight: 600;">${cleanDist}</span>
          </div>
        </div>

        <!-- Financial Summary -->
        <div class="pwa-tele-financials" style="margin: 10px 0; padding: 12px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); border-radius: var(--radius); display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-direction: column; gap: 4px;">
            <span style="color: var(--muted); font-size: 0.8rem;">Forma de Pagamento</span>
            <strong style="font-size: 0.9rem;">${paymentText}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 8px;">
            <span style="color: var(--muted);">Valor total do pedido:</span>
            <strong style="color: var(--text); font-size: 1rem;">${cleanTotalAmount}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 8px;">
            <span style="color: var(--success); font-weight: 600;">Recebido da Tele:</span>
            <strong style="font-size: 1.15rem; color: var(--primary); font-family: var(--font-display);">${formatMoney(valorRepasseLiquido)}</strong>
          </div>
        </div>

        <!-- Google Maps Link -->
        <div style="margin-top: 4px;">
          <a href="${mapsUrl}" target="_blank" class="pwa-btn pwa-btn-secondary" style="display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; font-size: 0.8rem; padding: 8px 12px; background: rgba(255, 255, 255, 0.05); color: #fff; border: 1px solid var(--border); border-radius: var(--radius); font-weight: 600; cursor: pointer;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffb700" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>
            Abrir no Google Maps
          </a>
        </div>
        
        <!-- PWA Code Verification Trava -->
        ${isTransit && isIntegration ? `
          <div class="pwa-code-verification-container" style="margin-top: 10px; padding: 12px; background: rgba(255, 183, 0, 0.04); border: 1px solid rgba(255, 183, 0, 0.15); border-radius: var(--radius); width: 100%;">
            <label style="display: block; font-size: 0.8rem; font-weight: 700; color: var(--primary); margin-bottom: 8px; text-align: center; text-transform: uppercase; letter-spacing: 0.5px;">
              Código de confirmação do cliente (4 dígitos)
            </label>
            <input type="number" id="confirmation_code" placeholder="Insira o código de confirmação do cliente" style="width: 100%; height: 42px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius); color: #fff; text-align: center; font-size: 1.1rem; font-weight: 800; outline: none; transition: border-color 0.2s;" oninput="if(this.value.length > 4) this.value = this.value.slice(0, 4);" />
          </div>
        ` : ''}
      </div>
      <div class="pwa-tele-footer">
        ${isPickup ? `
          <button class="pwa-btn pwa-btn-primary" onclick="confirmPickup('${order.id}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7H4a2 2 0 0 0-2 2v6c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            Confirmar Coleta
          </button>
        ` : ''}
        ${isTransit ? `
          <button class="pwa-btn pwa-btn-success" onclick="confirmDelivery('${order.id}')">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>
            Confirmar Entrega
          </button>
        ` : ''}
        ${!isPickup && !isTransit ? `
          <span class="pwa-tele-waiting">Aguardando início...</span>
        ` : ''}
      </div>
    `;
    container.appendChild(card);
  });
}

// ─── DELIVERY ACTIONS ─────────────────────────────────────────────────────────

async function confirmPickup(deliveryId) {
  if (!db) return;
  const btn = event.target.closest('button');
  if (btn) { btn.disabled = true; btn.innerText = 'Confirmando...'; }

  try {
    const { data: fleetRider, error: fleetErr } = await db
      .from('fleet')
      .select('bypass_distance_limit')
      .eq('name', currentRider.name)
      .single();

    if (fleetErr) throw fleetErr;

    const bypass = fleetRider ? !!fleetRider.bypass_distance_limit : false;

    if (!bypass) {
      const { data: order, error: orderErr } = await db
        .from('teles')
        .select('pickup_lat, pickup_lng')
        .eq('id', deliveryId)
        .single();

      if (orderErr) throw orderErr;

      if (!order || order.pickup_lat === null || order.pickup_lng === null) {
        alert('Coordenadas de coleta não encontradas para validação.');
        if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Coleta'; }
        return;
      }

      if (!lastPosition || lastPosition.lat === null || lastPosition.lng === null) {
        alert('Aguardando sua localização GPS atual. Certifique-se de que a localização está ativa.');
        if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Coleta'; }
        return;
      }

      const distance = calculateHaversineDistance(
        lastPosition.lat, lastPosition.lng,
        parseFloat(order.pickup_lat), parseFloat(order.pickup_lng)
      );

      if (distance > 3.0) {
        alert(`Você está a ${distance.toFixed(2)} km do local de coleta. A coleta só pode ser confirmada se você estiver a menos de 3 km do local.`);
        if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Coleta'; }
        return;
      }
    }
  } catch (err) {
    console.error("Erro na validação de distância:", err);
    alert('Erro ao validar distância de segurança. Tente novamente.');
    if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Coleta'; }
    return;
  }

  const { error } = await db
    .from('teles')
    .update({ status: 'Em rota de entrega', status_class: 'status-progress' })
    .eq('id', deliveryId);

  if (error) {
    alert('Erro ao confirmar coleta. Tente novamente.');
    if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Coleta'; }
    return;
  }

  // Update fleet rider status
  await db
    .from('fleet')
    .update({ status: 'Em rota de entrega', status_class: 'status-progress' })
    .eq('name', currentRider.name);

  currentRider.status = 'Em rota de entrega';
  localStorage.setItem('speedMotoSession', JSON.stringify(currentRider));
  setRiderStatusBadge('Em rota de entrega');
  showPWAToast('Coleta confirmada! Boa entrega.');
  loadMyDeliveries();
}

async function confirmDelivery(deliveryId) {
  if (!db) return;
  const btn = event.target.closest('button');
  if (btn) { btn.disabled = true; btn.innerText = 'Finalizando...'; }

  const order = activeDeliveriesList.find(d => d.id === deliveryId);
  const paymentMethod = getPaymentMethod(order || {});
  const isIntegration = false;

  if (isIntegration) {
    const cardElement = btn ? btn.closest('.pwa-tele-card') : null;
    const codeInput = cardElement ? cardElement.querySelector('#confirmation_code') : document.getElementById('confirmation_code');
    const codeValue = codeInput ? codeInput.value.trim() : '';

    const correctCode = String(order?.confirmation_code || '').trim() || '1234';

    if (!codeValue || codeValue !== correctCode) {
      alert("Código incorreto! Solicite os 4 dígitos corretos ao cliente.");
      if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Entrega'; }
      return;
    }
  }

  try {
    const { data: fleetRider, error: fleetErr } = await db
      .from('fleet')
      .select('bypass_distance_limit')
      .eq('name', currentRider.name)
      .single();

    if (fleetErr) throw fleetErr;

    const bypass = fleetRider ? !!fleetRider.bypass_distance_limit : false;

    if (!bypass) {
      const { data: order, error: orderErr } = await db
        .from('teles')
        .select('dest_lat, dest_lng')
        .eq('id', deliveryId)
        .single();

      if (orderErr) throw orderErr;

      if (!order || order.dest_lat === null || order.dest_lng === null) {
        alert('Coordenadas de entrega não encontradas para validação.');
        if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Entrega'; }
        return;
      }

      if (!lastPosition || lastPosition.lat === null || lastPosition.lng === null) {
        alert('Aguardando sua localização GPS atual. Certifique-se de que a localização está ativa.');
        if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Entrega'; }
        return;
      }

      const distance = calculateHaversineDistance(
        lastPosition.lat, lastPosition.lng,
        parseFloat(order.dest_lat), parseFloat(order.dest_lng)
      );

      if (distance > 3.0) {
        alert(`Você está a ${distance.toFixed(2)} km do local de entrega. A entrega só pode ser finalizada se você estiver a menos de 3 km do local.`);
        if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Entrega'; }
        return;
      }
    }
  } catch (err) {
    console.error("Erro na validação de distância:", err);
    alert('Erro ao validar distância de segurança. Tente novamente.');
    if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Entrega'; }
    return;
  }

  const { error: histErr } = await db
    .from('teles')
    .update({ status: 'Entregue', status_class: 'status-success' })
    .eq('id', deliveryId);

  if (histErr) {
    alert('Erro ao finalizar entrega. Tente novamente.');
    if (btn) { btn.disabled = false; btn.innerText = 'Confirmar Entrega'; }
    return;
  }

  await db
    .from('fleet')
    .update({ status: 'Disponível', status_class: 'status-success', delivery: 'Nenhuma' })
    .eq('name', currentRider.name);

  currentRider.status = 'Disponível';
  localStorage.setItem('speedMotoSession', JSON.stringify(currentRider));
  setRiderStatusBadge('Disponível');
  showPWAToast(`Entrega ${deliveryId} concluída!`);
  loadMyDeliveries();
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
      const riderName = currentRider.name;
      
      if (payload.eventType === 'INSERT') {
        if (payload.new.rider === riderName) {
          sendWebNotification("Nova Tele Atribuída! 🏍️", `A tele ${payload.new.id} foi atribuída a você.`);
          playNotificationSound();
          loadMyDeliveries();
          loadReportsData();
          loadWeeklyBalance();
        }
      } else if (payload.eventType === 'DELETE') {
        const wasMine = payload.old && (payload.old.rider === riderName || (knownActiveTeleIds && knownActiveTeleIds.includes(payload.old.id)));
        if (wasMine) {
          sendWebNotification("Tele Removida! ❌", `A tele ${payload.old.id} foi removida de você.`);
          playNotificationSound();
          loadMyDeliveries();
          loadReportsData();
          loadWeeklyBalance();
        }
      } else if (payload.eventType === 'UPDATE') {
        const wasMine = payload.old && payload.old.rider === riderName;
        const isMine = payload.new && payload.new.rider === riderName;
        
        // Cache shield against Supabase payload.old column restrictions
        const isAlreadyKnown = knownActiveTeleIds && knownActiveTeleIds.includes(payload.new.id);
        const isNewAssignment = isMine && !isAlreadyKnown;
        const isRemoval = !isMine && isAlreadyKnown;

        if (isNewAssignment) {
          sendWebNotification("Nova Tele Atribuída! 🏍️", `A tele ${payload.new.id} foi atribuída a você.`);
          playNotificationSound();
          loadMyDeliveries();
          loadReportsData();
          loadWeeklyBalance();
        } else if (isRemoval) {
          sendWebNotification("Tele Removida! ❌", `A tele ${payload.new.id} foi removida de você.`);
          playNotificationSound();
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

// ─── MAP ─────────────────────────────────────────────────────────────────────

function initRiderMap() {
  const mapEl = document.getElementById('pwa-map');
  if (!mapEl) return;

  riderMap = new mapboxgl.Map({
    container: 'pwa-map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: lastPosition ? [lastPosition.lng, lastPosition.lat] : [-51.126764, -29.842173], // [lng, lat] (Sapucaia do Sul Central)
    zoom: 14
  });



  // Permanent Collection Central Marker (Rua Ana Rosa 221)
  const centralEl = document.createElement('div');
  centralEl.style.width = '24px';
  centralEl.style.height = '24px';
  centralEl.style.backgroundColor = '#ffffff';
  centralEl.style.borderRadius = '50%';
  centralEl.style.border = '3px solid #ffb700';
  centralEl.style.boxShadow = '0 0 15px rgba(255, 183, 0, 0.6)';
  centralEl.style.display = 'flex';
  centralEl.style.alignItems = 'center';
  centralEl.style.justifyContent = 'center';
  centralEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffb700" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`;

  const centralPopup = new mapboxgl.Popup({ offset: 15 })
    .setHTML(`<div style="font-family:var(--font);color:#fff;padding:2px;"><strong style="font-size:0.88rem;display:block;margin-bottom:2px;">Central de Coleta</strong><span style="font-size:0.78rem;color:var(--muted);">Rua Ana Rosa 221, Ipiranga</span></div>`);

  new mapboxgl.Marker(centralEl)
    .setLngLat([-51.126764, -29.842173])
    .setPopup(centralPopup)
    .addTo(riderMap);

  if (lastPosition) {
    placeRiderMarker(lastPosition.lat, lastPosition.lng);
  }
}

let riderMarker = null;

function placeRiderMarker(lat, lng) {
  if (!riderMap) return;

  const popupContent = `<strong>${currentRider ? currentRider.name : 'Você'}</strong><br>Sua localização atual`;

  if (riderMarker) {
    riderMarker.setLngLat([lng, lat]);
    riderMarker.getPopup().setHTML(popupContent);
  } else {
    const el = document.createElement('div');
    el.style.width = '22px';
    el.style.height = '22px';
    el.style.backgroundColor = '#ffb700';
    el.style.borderRadius = '50%';
    el.style.border = '3px solid #fff';
    el.style.boxShadow = '0 0 12px rgba(255,183,0,0.7)';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.innerHTML = `<div style="width:6px;height:6px;background:#fff;border-radius:50%;"></div>`;

    const popup = new mapboxgl.Popup({ offset: 15 }).setHTML(popupContent);

    riderMarker = new mapboxgl.Marker(el)
      .setLngLat([lng, lat])
      .setPopup(popup)
      .addTo(riderMap);
  }

  if (!hasCenteredOnce) {
    riderMap.setCenter([lng, lat]);
    riderMap.setZoom(15);
    hasCenteredOnce = true;
  }

  // Update delivery markers/lines with the new rider position
  updateMapOverlays(activeDeliveriesList || []);
}

function startGeolocation() {
  if (!navigator.geolocation) return;

  // Initialize battery API
  if (navigator.getBattery && currentBatteryLevel === null) {
    try {
      navigator.getBattery().then(battery => {
        currentBatteryLevel = Math.round(battery.level * 100);
        battery.addEventListener('levelchange', async () => {
          currentBatteryLevel = Math.round(battery.level * 100);
          if (db && currentRider) {
            try {
              await db
                .from('fleet')
                .update({ battery_level: currentBatteryLevel })
                .eq('id', currentRider.id);
            } catch (err) {
              console.error("Failed to update battery level in background:", err);
            }
          }
        });
      }).catch(err => {
        console.warn("navigator.getBattery rejected:", err);
      });
    } catch (err) {
      console.warn("navigator.getBattery exception:", err);
    }
  }

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      lastPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (riderMap) placeRiderMarker(lastPosition.lat, lastPosition.lng);

      // Update location and battery level in Supabase fleet table in real-time
      if (db && currentRider) {
        const updatePayload = { lat: lastPosition.lat, lng: lastPosition.lng };
        if (currentBatteryLevel !== null) {
          updatePayload.battery_level = currentBatteryLevel;
        }
        await db
          .from('fleet')
          .update(updatePayload)
          .eq('id', currentRider.id);
      }
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

// ─── TOAST ───────────────────────────────────────────────────────────────────

function showPWAToast(msg) {
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
    setTimeout(() => toast.remove(), 300);
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
  const localAvatar = localStorage.getItem(`speedRiderAvatar_${currentRider.id}`);
  const localEmail = localStorage.getItem(`speedRiderEmail_${currentRider.id}`) || 'motoboy@speedlog.com.br';
  
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
  localStorage.setItem(`speedRiderEmail_${currentRider.id}`, email);
  if (localProfileImage) {
    localStorage.setItem(`speedRiderAvatar_${currentRider.id}`, localProfileImage);
  } else {
    localStorage.removeItem(`speedRiderAvatar_${currentRider.id}`);
  }

  // Update session
  currentRider.pin = pin;
  localStorage.setItem('speedMotoSession', JSON.stringify(currentRider));

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
    .select('price, date, address')
    .eq('rider', currentRider.name)
    .eq('status', 'Entregue');

  if (error || !data) return;

  const { data: credits, error: creditsErr } = await db
    .from('rider_credits')
    .select('amount, target_date')
    .eq('rider_id', currentRider.id);

  let totalWeekly = 0;
  data.forEach(order => {
    const orderDate = parseOrderDate(order.date);
    if (isDateInCurrentWeek(orderDate)) {
      const fixedPrice = getFixedPriceByAddress(order.address);
      totalWeekly += fixedPrice * 0.90;
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

  const bounds = new mapboxgl.LngLatBounds();
  if (lastPosition && lastPosition.lat && lastPosition.lng) {
    bounds.extend([lastPosition.lng, lastPosition.lat]);
  }

  const currentActiveIds = new Set();

  deliveries.forEach(order => {
    let targetLat = null;
    let targetLng = null;
    let title = '';
    let addressInfo = order.address || '';

    if (order.status === 'Em rota de entrega') {
      targetLat = order.dest_lat !== null ? parseFloat(order.dest_lat) : null;
      targetLng = order.dest_lng !== null ? parseFloat(order.dest_lng) : null;
      title = `Entrega: ${order.destName || 'Cliente'}`;
    }

    if (targetLat !== null && targetLng !== null && !isNaN(targetLat) && !isNaN(targetLng)) {
      currentActiveIds.add(order.id);
      bounds.extend([targetLng, targetLat]);

      // Define style: Green for Delivery (entrega)
      const bgColor = '#10b981';
      const shadowColor = 'rgba(16,185,129,0.6)';
      const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;

      const iconHtml = `
        <div style="background: ${bgColor}; border: 2px solid #fff; border-radius: 50%; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 10px ${shadowColor};">
          ${iconSvg}
        </div>
      `;

      const mapsUrl = order.address 
        ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(order.address)}&travelmode=driving`
        : `https://www.google.com/maps/dir/?api=1&destination=${targetLat},${targetLng}&travelmode=driving`;
      
      const popupContent = `
        <div style="font-family: var(--font-sans); color: #fff; padding: 2px;">
          <strong style="font-size: 0.9rem; display: block; margin-bottom: 4px;">${title}</strong>
          <span style="font-size: 0.85rem; font-weight: 600; display: block; margin-bottom: 8px;">${addressInfo}</span>
          <a href="${mapsUrl}" target="_blank" style="display: inline-flex; align-items: center; gap: 6px; color: #ffb700; text-decoration: none; font-weight: 700; font-size: 0.8rem; background: rgba(255,183,0,0.1); padding: 6px 10px; border-radius: 4px; border: 1px solid #ffb700; cursor: pointer;">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffb700" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2px;"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>
            Navegar no Google Maps
          </a>
        </div>
      `;

      const sourceId = `route-source-${order.id}`;
      const layerId = `route-layer-${order.id}`;

      // If marker already exists, update position and polyline
      if (activeRiderDeliveryMarkers[order.id]) {
        const entry = activeRiderDeliveryMarkers[order.id];
        
        // Update marker latlng if changed
        if (entry.lat !== targetLat || entry.lng !== targetLng) {
          entry.marker.setLngLat([targetLng, targetLat]);
          entry.lat = targetLat;
          entry.lng = targetLng;
        }

        entry.marker.getPopup().setHTML(popupContent);

        if (lastPosition && lastPosition.lat && lastPosition.lng) {
          safeAddRouteLayer(riderMap, sourceId, layerId, [lastPosition.lat, lastPosition.lng], [targetLat, targetLng], bgColor);
        } else {
          safeRemoveRouteLayer(riderMap, sourceId, layerId);
        }
      } else {
        // Create new marker
        const el = document.createElement('div');
        el.innerHTML = iconHtml;

        const popup = new mapboxgl.Popup({ offset: 15, closeOnClick: false, autoClose: false }).setHTML(popupContent);
        
        const marker = new mapboxgl.Marker(el)
          .setLngLat([targetLng, targetLat])
          .setPopup(popup)
          .addTo(riderMap);

        marker.togglePopup(); // Open automatically by default

        if (lastPosition && lastPosition.lat && lastPosition.lng) {
          safeAddRouteLayer(riderMap, sourceId, layerId, [lastPosition.lat, lastPosition.lng], [targetLat, targetLng], bgColor);
        }

        activeRiderDeliveryMarkers[order.id] = { marker, lat: targetLat, lng: targetLng };
      }
    }
  });

  // Clean up any markers that are no longer active
  for (const id in activeRiderDeliveryMarkers) {
    if (!currentActiveIds.has(id)) {
      const entry = activeRiderDeliveryMarkers[id];
      if (entry.marker) entry.marker.remove();
      safeRemoveRouteLayer(riderMap, `route-source-${id}`, `route-layer-${id}`);
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
    .eq('rider', currentRider.name)
    .eq('status', 'Entregue')
    .order('id', { ascending: false });

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
      .select('*')
      .eq('rider', currentRider.name)
      .or('status.eq.Entregue,status.eq.Concluído');

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
      .from('rider_credits')
      .select('*')
      .eq('rider_id', currentRider.id);

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

// ─── SUPPORT CHAT LOGIC ──────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchMotoChatHistory() {
  const container = document.getElementById('pwa-chat-messages');
  if (!container) return;

  container.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
      <div style="width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div>
    </div>
  `;

  if (!db || !currentRider) {
    container.innerHTML = `<p style="text-align: center; color: var(--muted); padding: 20px;">Nenhuma mensagem.</p>`;
    return;
  }

  try {
    const { data, error } = await db
      .from('support_messages')
      .select('*')
      .eq('client_email', currentRider.id)
      .order('id', { ascending: true });

    if (error) throw error;

    renderMotoMessages(data || []);
  } catch (err) {
    console.error("Error loading chat history:", err);
    container.innerHTML = `<p style="text-align: center; color: var(--muted); padding: 20px;">Erro ao carregar mensagens.</p>`;
  }
}

function renderMotoMessages(messages) {
  const container = document.getElementById('pwa-chat-messages');
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--muted); gap: 12px; padding: 20px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round" style="color: var(--muted);"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <p style="font-size: 0.85rem; margin: 0;">Fale diretamente com o suporte.</p>
        <p style="font-size: 0.78rem; margin: 0; color: var(--muted);">Escreva uma mensagem abaixo para iniciar a conversa.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = messages.map(msg => {
    const isMe = msg.sender_role === 'rider';
    const alignStyle = isMe ? 'align-self: flex-end; align-items: flex-end;' : 'align-self: flex-start; align-items: flex-start;';
    const bubbleStyle = isMe 
      ? 'background: linear-gradient(135deg, var(--primary), #c2410c); color: #ffffff; border-radius: 16px 16px 2px 16px; box-shadow: 0 4px 12px rgba(255, 183, 0, 0.25);'
      : 'background: #272732; border: 1px solid var(--border); color: var(--text); border-radius: 16px 16px 16px 2px;';
    const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'Agora';

    return `
      <div style="display: flex; flex-direction: column; max-width: 80%; ${alignStyle}">
        <span style="font-size: 0.72rem; color: var(--muted); margin-bottom: 4px; font-weight: 500;">${msg.sender_name}</span>
        <div style="padding: 10px 14px; font-size: 0.88rem; line-height: 1.45; word-break: break-word; ${bubbleStyle}">
          ${escapeHtml(msg.message)}
        </div>
        <span style="font-size: 0.65rem; color: var(--muted); margin-top: 4px;">${time}</span>
      </div>
    `;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendMotoChatMessage(event) {
  if (event) event.preventDefault();

  const input = document.getElementById('pwa-chat-input');
  if (!input) return;

  const val = input.value.trim();
  if (!val) return;

  if (!db || !currentRider) return;

  input.value = ''; // clear input immediately

  try {
    const { error } = await db
      .from('support_messages')
      .insert([{
        client_email: currentRider.id,
        sender_role: 'rider',
        sender_name: currentRider.name,
        message: val
      }]);

    if (error) throw error;
  } catch (err) {
    console.error("Error sending rider chat message:", err);
    showPWAToast("Erro ao enviar mensagem.");
  }
}
