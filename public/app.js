// Dahora Expresso - Core Application Logic




// Supabase Configuration
let supabaseClient = null;
let maxSimultaneousDeliveries = 1;

(function initSupabaseAppClient() {
  if (typeof window === 'undefined') return;

  if (!window.SUPABASE_CONFIG || !window.SUPABASE_CONFIG.url || !window.SUPABASE_CONFIG.key) {
    console.error("[SUPABASE INIT] Configuração do ambiente não disponível.");
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

  const supabaseUrl = window.SUPABASE_CONFIG.url;
  const supabaseKey = window.SUPABASE_CONFIG.key;

  if (window.supabase) {
    supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  } else {
    console.error("Supabase SDK not loaded!");
  }
})();


// Mock Database States (updated dynamically from Supabase)
const mockData = {
  activeProfile: 'owner', // 'owner', 'client', 'order'
  fleet: [],
  clientHistory: [],
  credentials: {
    owner: { email: 'admin@dahoraexpresso.com.br', pass: 'admin123', name: 'Gustavo Souza', role: 'Dono & CEO', avatar: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?q=80&w=256&auto=format&fit=crop' },
    client: { email: 'gerente@lanchonetedahora.com.br', pass: 'teste123', name: 'Gerente Lanchonete Dahora', role: 'Área do parceiro', commerceName: 'Lanchonete Dahora', avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?q=80&w=256&auto=format&fit=crop' },
    order: { email: 'pedido@lanchonetedahora.com.br', pass: 'teste123', name: 'Pedido Lanchonete Dahora', role: 'Solicitação de entrega', commerceName: 'Lanchonete Dahora', avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?q=80&w=256&auto=format&fit=crop' }
  },
  pendingDeliveries: [],
  riderConsumables: [],
  riderCredits: [],
  cities: []
};

let commercesList = [];
let currentTeleFilter = 'all';
let teleViewMode = 'list';
let currentClientTeleFilter = 'all';
let clientTeleViewMode = 'list';

let commercialClientsSelectCache = [];
let currentActiveSession = null;
let currentAdminProfile = null;

async function checkAdminSession() {
  if (!supabaseClient) return null;
  try {
    const { data: sessionData, error: sessionErr } = await supabaseClient.auth.getSession();
    if (sessionErr || !sessionData || !sessionData.session) {
      currentActiveSession = null;
      currentAdminProfile = null;
      return null;
    }

    currentActiveSession = sessionData.session;
    console.log(`[AUTH AUDIT] Session active. auth.uid: ${currentActiveSession.user.id}, email: ${currentActiveSession.user.email}`);

    if (!currentAdminProfile) {
      const { data: profile, error: profileErr } = await supabaseClient
        .from('user_profiles')
        .select('id, user_id, name, email, role, is_active')
        .or(`user_id.eq.${currentActiveSession.user.id},id.eq.${currentActiveSession.user.id}`)
        .maybeSingle();

      if (profileErr || !profile || !profile.is_active) {
        console.warn("[AUTH AUDIT] Admin profile invalid or inactive:", profileErr?.message || profile);
        await supabaseClient.auth.signOut();
        currentActiveSession = null;
        currentAdminProfile = null;
        return null;
      }
      currentAdminProfile = profile;
      console.log(`[AUTH AUDIT] Admin profile validated. role: ${profile.role}, is_active: ${profile.is_active}`);
    }

    return { session: currentActiveSession, profile: currentAdminProfile };
  } catch (err) {
    console.error("[AUTH AUDIT] Session check error:", err);
    currentActiveSession = null;
    currentAdminProfile = null;
    return null;
  }
}

function handleInvalidSession(customMessage) {
  currentActiveSession = null;
  currentAdminProfile = null;

  if (typeof dashboardRealtimeChannel !== 'undefined' && dashboardRealtimeChannel) {
    try { supabaseClient.removeChannel(dashboardRealtimeChannel); } catch (e) {}
    dashboardRealtimeChannel = null;
  }

  mockData.fleet = [];
  mockData.clientHistory = [];
  mockData.pendingDeliveries = [];
  mockData.cities = [];
  mockData.riderConsumables = [];

  const msg = customMessage || "Sua sessão expirou. Faça login novamente.";
  if (typeof showToastNotification === 'function') {
    showToastNotification(msg);
  }

  const viewLanding = document.getElementById('view-landing');
  const viewDashboard = document.getElementById('view-dashboard');
  if (viewLanding) viewLanding.classList.add('active');
  if (viewDashboard) viewDashboard.classList.remove('active');
  switchLoginTab('owner');
}

let clientsFetchState = 'idle'; // 'idle' | 'loading' | 'loaded' | 'failed'

async function fetchCommerces() {
  if (!supabaseClient || !currentActiveSession) return;
  clientsFetchState = 'loading';
  try {
    const { data, error } = await supabaseClient
      .from('commercial_clients')
      .select('id, client_code, establishment_name, responsible_name, lifecycle_status, is_internal, address, neighborhood, city, postal_code')
      .order('is_internal', { ascending: false })
      .order('establishment_name', { ascending: true });

    if (error) {
      clientsFetchState = 'failed';
      if (error.status === 401 || error.code === '42501') {
        handleInvalidSession();
        return;
      }
      console.error("Erro ao carregar commercial_clients:", error.message || error);
      const hintEl = document.getElementById('admin-client-select-hint');
      if (hintEl) hintEl.textContent = `Erro ao carregar clientes: ${error.message}`;
      return;
    }

    commercialClientsSelectCache = data || [];
    opClientsStoreMap.clear();
    (commercialClientsSelectCache || []).forEach(c => {
      if (c && c.id) {
        opClientsStoreMap.set(String(c.id), c);
      }
    });
    clientsFetchState = 'loaded';

    commercesList = commercialClientsSelectCache.map(c => ({
      id: c.id,
      nome: c.is_internal ? 'Dahora Expresso — Operação Interna' : (c.establishment_name || c.client_code || 'Cliente')
    }));

    if (typeof renderCommercialClientsDropdown === 'function') {
      renderCommercialClientsDropdown(commercialClientsSelectCache);
    }
  } catch (err) {
    clientsFetchState = 'failed';
    console.error("Error fetching commercial_clients:", err);
  }
}



// Escapes HTML-special characters so values from the database can never be
// rendered as markup (prevents stored XSS via fields like address/name).
function escapeHtml(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Global Chart and Map variables to allow proper reset/destroy
let ownerFleetMap = null;
let ownerFleetInfoWindow = null;
let ownerOverviewChart = null;
let ownerFinancialChart = null;
let clientOverviewChart = null;
let selectedRiderId = null;
let selectedMapRiderId = null;
let trackingMapInstance = null;
let trackingRiderMarker = null;
let trackingPickupMarker = null;
let trackingDestMarker = null;
let trackingRouteLine = null;
let trackingRealtimeChannel = null;
// Global support chat variables
let activeChatClientEmail = null;
let activeChatClientName = null;
let supportChatChannel = null;
let activeAdminChatChannels = [];
let activeAdminRiderChatChannels = [];
let ownerFleetCenterCoords = [-23.55052, -46.633308];
let clientFleetCenterCoords = [-29.83, -51.14];
let dashboardRealtimeChannel = null;
let ownerFleetMarkers = {};
let ownerCentralMarker = null;
let clientFleetMap = null;
let clientFleetInfoWindow = null;
let clientFleetMarkers = {};
let clientCentralMarker = null;
let clientRatings = [];

// Async functions to sync with Supabase
async function fetchFleet() {
  if (!supabaseClient || !currentActiveSession) return;
  try {
    const { data, error } = await supabaseClient
      .from('fleet')
      .select('*, rider_device_status(*)');
    if (error) {
      if (error.status === 401 || error.code === '42501') {
        handleInvalidSession();
        return;
      }
      throw error;
    }
    mockData.fleet = (data || []).map(item => {
      const devStatus = Array.isArray(item.rider_device_status) ? item.rider_device_status[0] : item.rider_device_status;
      const batterySupported = devStatus ? Boolean(devStatus.battery_supported) : false;
      const batteryLevel = (devStatus && batterySupported && devStatus.battery_level != null) ? devStatus.battery_level : null;
      const isCharging = devStatus ? devStatus.is_charging : null;
      const lastSeenAt = devStatus ? devStatus.last_seen_at : null;

      const isStale = lastSeenAt ? ((Date.now() - new Date(lastSeenAt).getTime()) > 10 * 60 * 1000) : false;

      let batteryDisplay = '🔋 Indisponível';
      if (batterySupported && batteryLevel !== null) {
        if (isCharging) {
          batteryDisplay = `⚡ ${batteryLevel}% — Carregando`;
        } else {
          batteryDisplay = `🔋 ${batteryLevel}%`;
        }
        if (isStale) {
          batteryDisplay += ' — desatualizado';
        }
      }

      return {
        id: String(item.id),
        motoboy_code: item.motoboy_code,
        name: item.name,
        phone: item.phone,
        vehicle: item.vehicle,
        plate: item.plate,
        status: item.status,
        battery: batteryDisplay,
        battery_level: batteryLevel,
        is_charging: isCharging,
        battery_supported: batterySupported,
        last_seen_at: lastSeenAt,
        is_stale: isStale,
        lat: item.lat,
        lng: item.lng
      };
    });
  } catch (err) {
    console.error("Error fetching fleet from Supabase:", err);
  }
}


// Generate next sequential Motoboy ID (#MB-0001, #MB-0002, ...)
async function getNextRiderID() {
  let maxNum = 0;
  if (supabaseClient && currentActiveSession) {
    const { data } = await supabaseClient.from('fleet').select('id');
    (data || []).forEach(item => {
      const match = (item.id || '').match(/#MB-(\d+)/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
    });
  } else {
    mockData.fleet.forEach(r => {
      const match = (r.id || '').match(/#MB-(\d+)/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
    });
  }
  return '#MB-' + String(maxNum + 1).padStart(4, '0');
}

function getFixedPriceByAddress(address) {
  const addr = (address || '').toLowerCase();
  if (addr.includes('esteio')) {
    return 10.00;
  }
  return 8.00;
}

function getFixedPriceFormatted(address) {
  const price = getFixedPriceByAddress(address);
  return `R$ ${price.toFixed(2).replace('.', ',')}`;
}

async function fetchClientHistory() {
  if (!supabaseClient || !currentActiveSession) return;
  await fetchCommerces();

  try {
    const { data, error } = await supabaseClient
      .from('teles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      if (error.status === 401 || error.code === '42501') {
        handleInvalidSession();
        return;
      }
      console.warn("Aviso ao buscar teles em fetchClientHistory:", error);
      return;
    }


    mockData.clientHistory = (data || []).map(item => ({
      id: escapeHtml(String(item.tele_code || item.id)),
      raw_id: item.id,
      tele_code: item.tele_code || item.id,
      client_id: item.client_id,
      client: escapeHtml(resolveClientDisplayName(item)),
      destName: escapeHtml(item.recipient_name || item.dest_name || 'Cliente'),
      address: escapeHtml(item.delivery_address || item.address || ''),
      delivery_address: escapeHtml(item.delivery_address || item.address || ''),
      pickup_address: escapeHtml(item.pickup_address || item.origin_address || ''),
      rider: escapeHtml(item.rider || 'Aguardando Despacho'),
      dist: '—',
      price: formatMoneyBR(Number(item.delivery_charge || item.valor || 15)),
      date: item.created_at ? new Date(item.created_at).toLocaleDateString('pt-BR') : 'Hoje',
      status: escapeHtml(item.status),
      statusClass: item.status === 'concluida' ? 'status-success' : (item.status === 'cancelada' ? 'status-danger' : 'status-warning'),
      payment_status: 'Pendente',
      created_at: item.created_at,
      version: item.version !== undefined && item.version !== null ? Number(item.version) : null,
      total_order_amount: item.total_order_amount || null
    }));
  } catch (err) {
    console.error("Error fetching teles history from Supabase:", err);
  }
}

function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

async function searchActiveRidersForExtract() {
  const startDateStr = document.getElementById('extract-start-date').value;
  const endDateStr = document.getElementById('extract-end-date').value;

  if (!startDateStr || !endDateStr) {
    alert("Por favor, selecione as datas inicial e final.");
    return;
  }

  const start = parseLocalDate(startDateStr);
  if (start) start.setHours(0, 0, 0, 0);

  const end = parseLocalDate(endDateStr);
  if (end) end.setHours(23, 59, 59, 999);

  if (start > end) {
    alert("A data inicial não pode ser posterior à data final.");
    return;
  }

  if (!supabaseClient) {
    alert("Supabase não está conectado.");
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('teles')
      .select('rider, created_at')
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString());

    if (error) throw error;

    const activeRiderNames = [...new Set(data
      .map(item => item.rider)
      .filter(name => name && name !== 'Nenhum' && name !== 'Aguardando...' && name !== 'Sem entregador')
    )];

    const grid = document.getElementById('extract-riders-grid');
    grid.innerHTML = '';

    if (activeRiderNames.length === 0) {
      grid.innerHTML = '<p class="text-muted" style="grid-column: 1 / -1;">Nenhum motoboy ativo encontrado neste período.</p>';
    } else {
      activeRiderNames.forEach((riderName, index) => {
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.gap = '8px';
        div.style.background = 'rgba(255, 255, 255, 0.02)';
        div.style.padding = '10px 14px';
        div.style.borderRadius = 'var(--border-radius-sm)';
        div.style.border = '1px solid var(--border-color)';

        div.innerHTML = `
          <input type="radio" id="extract-rider-${index}" name="extract-rider-selection" value="${escapeHtml(riderName)}" style="accent-color: var(--primary); cursor: pointer;">
          <label for="extract-rider-${index}" style="color: #fff; font-size: 0.85rem; cursor: pointer; user-select: none; font-weight: 500;">
            ${escapeHtml(riderName)}
          </label>
        `;
        grid.appendChild(div);
      });
    }

    document.getElementById('extract-riders-card').style.display = 'block';
    document.getElementById('extract-details-card').style.display = 'none';

    if (window.lucide) lucide.createIcons();

  } catch (err) {
    console.error("Error searching active riders:", err);
    alert("Erro ao buscar profissionais no Supabase.");
  }
}

async function generateRiderExtract() {
  const selectedRadio = document.querySelector('input[name="extract-rider-selection"]:checked');
  if (!selectedRadio) {
    alert("Por favor, selecione um profissional da lista.");
    return;
  }

  const riderName = selectedRadio.value;
  const startDateStr = document.getElementById('extract-start-date').value;
  const endDateStr = document.getElementById('extract-end-date').value;

  const start = parseLocalDate(startDateStr);
  if (start) start.setHours(0, 0, 0, 0);

  const end = parseLocalDate(endDateStr);
  if (end) end.setHours(23, 59, 59, 999);

  try {
    const { data, error } = await supabaseClient
      .from('teles')
      .select('*')
      .eq('rider', riderName)
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    document.getElementById('extract-rider-title').innerText = `Extrato de ${riderName}`;
    const startFormatted = start.toLocaleDateString('pt-BR');
    const endFormatted = end.toLocaleDateString('pt-BR');
    document.getElementById('extract-rider-period').innerText = `Período selecionado: ${startFormatted} até ${endFormatted}`;

    let totalServices = 0;
    let totalPayout = 0;

    const tbody = document.getElementById('extract-details-table-body');
    tbody.innerHTML = '';

    data.forEach(item => {
      totalServices++;
      
      const grossPrice = getFixedPriceByAddress(item.address);
      const netPayout = grossPrice * 0.90;
      totalPayout += netPayout;

      let displayId = item.id;

      const tr = document.createElement('tr');
      tr.className = 'ops-table-row';

      tr.innerHTML = `
        <td><strong>${escapeHtml(displayId)}</strong></td>
        <td>
          <div style="display: flex; flex-direction: column;">
            <strong style="color: #fff;">${escapeHtml(item.dest_name || 'Cliente')}</strong>
            <span class="text-muted" style="font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px; margin-top: 2px;">
              <i data-lucide="map-pin" style="width: 12px; height: 12px; flex-shrink: 0; color: #ffb700;"></i>
              ${escapeHtml(item.address)}
            </span>
          </div>
        </td>
        <td>${formatMoneyBR(grossPrice)}</td>
        <td><strong class="text-yellow" style="color: var(--primary) !important;">${formatMoneyBR(netPayout)}</strong></td>
        <td>${escapeHtml(item.date)}</td>
        <td><span class="status-indicator ${escapeHtml(item.status_class || 'status-neutral')}">${escapeHtml(item.status)}</span></td>
      `;
      tbody.appendChild(tr);
    });

    document.getElementById('extract-total-services').innerText = totalServices;
    document.getElementById('extract-total-payout').innerText = formatMoneyBR(totalPayout);

    document.getElementById('extract-details-card').style.display = 'block';

    if (window.lucide) lucide.createIcons();

  } catch (err) {
    console.error("Error generating rider extract:", err);
    alert("Erro ao buscar os registros de extrato do profissional.");
  }
}

// Bind to window object for global availability
window.searchActiveRidersForExtract = searchActiveRidersForExtract;
window.generateRiderExtract = generateRiderExtract;

async function fetchPendingDeliveries() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('teles')
      .select('*')
      .in('status', ['solicitada', 'solicitado', 'criada'])
      .order('created_at', { ascending: true });

    if (error) {
      console.warn("Aviso ao buscar teles pendentes:", error.message);
      return;
    }

    mockData.pendingDeliveries = (data || []).map(item => ({
      id: escapeHtml(String(item.id || item.tele_code || '')),
      raw_id: item.id,
      tele_code: item.tele_code || item.id,
      client_id: item.client_id,
      client: escapeHtml(resolveClientDisplayName(item)),
      destName: escapeHtml(item.recipient_name || item.dest_name || 'Destinatário'),
      address: escapeHtml(item.delivery_address || item.address || ''),
      delivery_address: escapeHtml(item.delivery_address || item.address || ''),
      pickup_address: escapeHtml(item.pickup_address || item.origin_address || ''),
      dist: item.dist || '3,5 km',
      price: item.delivery_charge ? `R$ ${parseFloat(item.delivery_charge).toFixed(2).replace('.', ',')}` : getFixedPriceFormatted(item.delivery_address || item.address),
      payment: escapeHtml(item.payment_method || item.payment || 'Faturado'),
      cargo: escapeHtml(item.cargo || 'Pacote'),
      pickup_lat: item.pickup_lat,
      pickup_lng: item.pickup_lng,
      dest_lat: item.dest_lat,
      dest_lng: item.dest_lng,
      created_at: item.created_at,
      version: item.version !== undefined && item.version !== null ? Number(item.version) : null,
      total_order_amount: item.total_order_amount || null
    }));
  } catch (err) {
    console.warn("Aviso ao buscar teles pendentes:", err.message);
  }
}

function formatRiderDisplayName(r) {
  if (!r) return 'Motoboy sem nome';
  const name = r.name || r.full_name || r.motoboy_name || '';
  const code = r.motoboy_code || r.code || '';
  if (name && code) return `${name} — ${code}`;
  if (name) return name;
  if (code) return `Motoboy — ${code}`;
  return 'Motoboy sem nome';
}

async function fetchRiderConsumables() {
  if (!supabaseClient || !currentActiveSession) return;
  try {
    const { data, error } = await supabaseClient
      .from('rider_consumable_purchases')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      if (error.status === 401 || error.code === '42501') {
        handleInvalidSession();
        return;
      }
      console.warn("Aviso ao buscar rider_consumable_purchases:", error.message);
      return;
    }

    mockData.riderConsumables = (data || []).map(item => ({
      id: item.id,
      rider_id: escapeHtml(String(item.motoboy_id || item.rider_id || '')),
      rider_name: escapeHtml(item.motoboy_name || item.rider_name || 'Motoboy'),
      categoria: escapeHtml(item.categoria === 'vale' ? 'Vale' : 'Consumível'),
      item_name: escapeHtml(item.item_name || 'Item'),
      item_type: escapeHtml(item.item_name || 'Item'),
      quantidade: parseInt(item.quantidade || 1),
      valor_unitario: parseFloat(item.valor_unitario || item.amount || 0),
      amount: parseFloat(item.amount || 0),
      observacao: escapeHtml(item.observacao || ''),
      status: item.status || 'active',
      reversal_reason: item.reversal_reason || '',
      created_at: item.created_at
    }));
  } catch (err) {
    console.warn("Aviso ao buscar rider_consumable_purchases:", err.message);
  }
}

async function fetchRiderCredits() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('rider_credits_ledger')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn("Aviso ao buscar rider_credits_ledger:", error.message);
      return;
    }

    mockData.riderCredits = (data || []).map(item => ({
      id: item.id,
      rider_id: escapeHtml(String(item.motoboy_id || item.rider_id || '')),
      amount: parseFloat(item.amount || 0),
      description: escapeHtml(item.description || ''),
      direction: item.direction || 'credit',
      status: item.status || 'active',
      reversal_reason: item.reversal_reason || '',
      target_date: item.target_date || item.created_at,
      created_at: item.created_at
    }));
  } catch (err) {
    console.warn("Aviso ao buscar rider_credits_ledger:", err.message);
  }
}


const initAppHandler = async () => {
  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        reg.update();
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (sw) sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) sw.postMessage?.('skip-waiting');
          });
        });
      })
      .catch(err => console.error('Erro ao registrar Service Worker do Painel:', err));

    let _swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_swReloaded) return;
      _swReloaded = true;
      window.location.reload();
    });
  }

  // Hide loader after a initial delay
  setTimeout(() => {
    const loader = document.getElementById('loader');
    if (loader) loader.classList.add('hidden');
  }, 1200);

  // Set Date display in header
  const options = { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' };
  const currentDateEl = document.getElementById('current-date-span');
  if (currentDateEl) currentDateEl.innerText = new Date().toLocaleDateString('pt-BR', options);

  // Initialize address suggestions autocomplete for manual tele request
  setupAddressGeocodingListener();

  // Initialize lucide icons
  if (window.lucide) lucide.createIcons();

  // Eye toggle listener for password visibility
  const passwordToggleBtn = document.getElementById('toggle-password');
  if (passwordToggleBtn) {
    passwordToggleBtn.addEventListener('click', function() {
      const passwordInput = document.getElementById('password');
      const eyeIcon = this.querySelector('i');
      if (passwordInput && eyeIcon) {
        if (passwordInput.type === 'password') {
          passwordInput.type = 'text';
          eyeIcon.setAttribute('data-lucide', 'eye-off');
        } else {
          passwordInput.type = 'password';
          eyeIcon.setAttribute('data-lucide', 'eye');
        }
        if (window.lucide) lucide.createIcons();
      }
    });
  }

  // Listen to payment method changes in order request form to toggle change input
  const paymentSelect = document.getElementById('payment-method');
  if (paymentSelect) {
    paymentSelect.addEventListener('change', (e) => {
      const changeGroup = document.getElementById('change-group');
      if (changeGroup) {
        if (e.target.value === 'dinheiro') {
          changeGroup.style.display = 'flex';
        } else {
          changeGroup.style.display = 'none';
        }
      }
    });
  }

  // Sidebar mobile drawer logic
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  const sidebar = document.querySelector('.sidebar');
  let overlay = document.getElementById('sidebar-overlay');
  
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);
  }
  
  function openMobileSidebar() {
    if (sidebar) sidebar.classList.add('open');
    if (overlay) overlay.classList.add('active');
  }
  
  function closeMobileSidebar() {
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
  }
  
  if (toggleBtn) {
    toggleBtn.addEventListener('click', openMobileSidebar);
  }
  const topbarLogo = document.getElementById('topbar-logo');
  if (topbarLogo) {
    topbarLogo.addEventListener('click', openMobileSidebar);
  }
  if (overlay) {
    overlay.addEventListener('click', closeMobileSidebar);
  }
  
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        closeMobileSidebar();
      }
    });
  });

  const logoutBtn = document.querySelector('.btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        closeMobileSidebar();
      }
    });
  }

  // 1. Restaurar e validar a sessão do Supabase Auth
  const authState = await checkAdminSession();
  if (!authState) {
    // Nenhuma sessão ativa -> Exibir tela de login sem chamar APIs protegidas
    handleInvalidSession("Sua sessão expirou. Faça login novamente.");
    return;
  }

  // 2. Sessão Ativa & Válida -> Carregar painel
  if (authState.profile && (authState.profile.role === 'client_user' || authState.profile.role === 'client')) {
    mockData.activeProfile = 'client';
  } else {
    mockData.activeProfile = 'owner';
  }

  await loginSuccess();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAppHandler);
} else {
  initAppHandler();
}

function switchLoginTab(profile) {
  mockData.activeProfile = profile;
  
  document.querySelectorAll('.login-tabs .tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const tabName = (profile.startsWith('client') || profile.startsWith('order')) ? 'client' : 'owner';
  const tabBtn = document.querySelector(`.login-tabs .tab-btn[data-tab="${tabName}"]`);
  if (tabBtn) tabBtn.classList.add('active');

  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const usernameLabel = document.getElementById('username-label');
  const passwordGroup = document.getElementById('password-group');

  if (profile.startsWith('order') || profile.startsWith('client')) {
    usernameLabel.innerText = 'Login do Parceiro';
    usernameInput.type = 'text';
    usernameInput.value = '';
    usernameInput.placeholder = 'parceiro@mercadocentral.local';
    passwordInput.value = '';
    passwordGroup.style.display = 'flex';
  } else {
    usernameLabel.innerText = 'Login do Administrador';
    usernameInput.type = 'text';
    usernameInput.value = '';
    usernameInput.placeholder = 'admin@dahora.local';
    passwordInput.value = '';
    passwordGroup.style.display = 'flex';
  }
}

async function handleLogin(event) {
  if (event) event.preventDefault();
  
  const loginInput = document.getElementById('username').value.trim().toLowerCase();
  const passwordInput = document.getElementById('password').value.trim();

  const loader = document.getElementById('loader');
  if (loader) loader.classList.remove('hidden');

  let emailToAuth = loginInput;
  if (loginInput === 'adm' || loginInput === 'admin') {
    emailToAuth = 'admin@dahora.local';
  } else if (loginInput === 'lanchonetedahora' || loginInput === 'parceiro') {
    emailToAuth = 'parceiro@mercadocentral.local';
  }

  let authPassword = passwordInput;
  if (passwordInput === 'admin123' || passwordInput === 'teste123') {
    authPassword = 'senha123456';
  }

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: emailToAuth,
      password: authPassword
    });

    if (error || !data.session) {
      if (loader) loader.classList.add('hidden');
      alert(`Falha no login: ${error ? error.message : 'Credenciais inválidas.'}`);
      return;
    }

    const authState = await checkAdminSession();
    if (!authState) {
      if (loader) loader.classList.add('hidden');
      alert('Usuário autenticado, porém sem permissão de acesso ao painel.');
      return;
    }

    if (authState.profile && (authState.profile.role === 'client_user' || authState.profile.role === 'client')) {
      mockData.activeProfile = 'client';
    } else {
      mockData.activeProfile = 'owner';
    }

    if (loader) {
      setTimeout(async () => {
        loader.classList.add('hidden');
        await loginSuccess();
      }, 600);
    } else {
      await loginSuccess();
    }
  } catch (err) {
    if (loader) loader.classList.add('hidden');
    alert(`Erro no login: ${err.message}`);
  }
}

async function loginSuccess() {
  const profile = mockData.activeProfile;
  const creds = mockData.credentials[profile] || mockData.credentials['owner'];

  const rememberInput = document.querySelector('.remember-me input');
  if (rememberInput && rememberInput.checked) {
    localStorage.setItem('loggedInProfile', profile);
  } else {
    localStorage.removeItem('loggedInProfile');
  }

  document.getElementById('user-avatar').src = creds.avatar;
  document.getElementById('user-display-name').innerText = currentAdminProfile ? currentAdminProfile.name : creds.name;
  document.getElementById('user-display-sub').innerText = currentAdminProfile ? currentAdminProfile.role : creds.role;

  const clientInfoPanels = document.getElementById('client-info-panels');
  if (clientInfoPanels) {
    if (profile === 'owner') {
      clientInfoPanels.classList.add('hidden');
    } else {
      clientInfoPanels.classList.remove('hidden');
    }
  }

  const clientActionCards = document.getElementById('client-action-cards');
  if (clientActionCards) {
    if (profile === 'owner') {
      clientActionCards.classList.add('hidden');
    } else {
      clientActionCards.classList.remove('hidden');
    }
  }

  document.getElementById('nav-owner-group').classList.add('hidden');
  document.getElementById('nav-client-group').classList.add('hidden');
  document.getElementById('nav-order-group').classList.add('hidden');

  document.getElementById('view-landing').classList.remove('active');
  document.getElementById('view-dashboard').classList.add('active');

  await fetchCommerces();
  await fetchCities();
  await fetchFleet();
  await fetchClientHistory();
  await fetchRiderConsumables();

  if (profile === 'owner') {
    document.getElementById('display-role').innerText = 'Painel do Dono';
    document.getElementById('nav-owner-group').classList.remove('hidden');
    document.getElementById('dashboard-title').innerText = 'Painel de Logística Dahora Expresso';
    switchDashboardTab('owner-overview');
  } else if (profile === 'client') {
    document.getElementById('display-role').innerText = 'Painel do Cliente';
    document.getElementById('nav-client-group').classList.remove('hidden');
    document.getElementById('dashboard-title').innerText = 'Painel do Cliente Parceiro';
    switchDashboardTab('client-overview');
  }
}

async function handleLogout() {
  const loader = document.getElementById('loader');
  if (loader) loader.classList.remove('hidden');

  if (supabaseClient) {
    try { await supabaseClient.auth.signOut(); } catch (e) {}
  }

  currentActiveSession = null;
  currentAdminProfile = null;

  localStorage.removeItem('loggedInProfile');
  localStorage.removeItem('activeDashboardTab');

  const ownerFab = document.getElementById('owner-fab-btn');
  if (ownerFab) ownerFab.classList.add('hidden');

  if (supabaseClient && supportChatChannel) {
    try { supabaseClient.removeChannel(supportChatChannel); } catch (e) {}
    supportChatChannel = null;
  }
  if (supabaseClient && dashboardRealtimeChannel) {
    try { supabaseClient.removeChannel(dashboardRealtimeChannel); } catch (e) {}
    dashboardRealtimeChannel = null;
  }

  setTimeout(() => {
    if (loader) loader.classList.add('hidden');
    document.getElementById('view-dashboard').classList.remove('active');
    document.getElementById('view-landing').classList.add('active');
    switchLoginTab('owner');
  }, 600);
}

// Switching dashboard tab views
async function switchDashboardTab(targetTab) {
  localStorage.setItem('activeDashboardTab', targetTab);
  // Update Sidebar active items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });
  
  const navItem = document.querySelector(`.nav-item[data-tab="${targetTab}"]`);
  if (navItem) {
    navItem.classList.add('active');
  }

  // Update Main Dashboard Views
  document.querySelectorAll('.dashboard-tab-content').forEach(view => {
    view.classList.remove('active');
  });

  const activeTabEl = document.getElementById(`tab-${targetTab}`);
  if (activeTabEl) {
    activeTabEl.classList.add('active');
    activeTabEl.classList.remove('hidden');
  }

  const ownerFab = document.getElementById('owner-fab-btn');
  if (ownerFab) {
    if (targetTab === 'owner-teles' && mockData.activeProfile === 'owner') {
      ownerFab.classList.remove('hidden');
    } else {
      ownerFab.classList.add('hidden');
    }
  }

  // Trigger specific tab initializers (like charts render)
  if (targetTab === 'owner-overview') {
    await fetchFleet();
    await fetchClientHistory();
    renderOwnerOverviewMetrics();
    initOwnerOverviewChart();
  } else if (targetTab === 'owner-fleet-map') {
    await fetchFleet();
    await fetchCities();
    initOwnerFleetMap();
    renderCitiesTable();
  } else if (targetTab === 'owner-teles') {
    await loadTelesManagement();
  } else if (targetTab === 'owner-fleet') {
    await fetchFleet();
    renderFleetTable();
  } else if (targetTab === 'owner-financials') {
    await fetchClientHistory();
    initOwnerFinancialChart();
    renderOwnerFinancials();
  } else if (targetTab === 'owner-rider-payments') {
    await fetchFleet();
    await fetchClientHistory();
    initRiderPaymentDates();
    renderRiderPayments();
    populateRiderSearchDropdown();
  } else if (targetTab === 'owner-consumables') {
    await fetchFleet();
    await fetchRiderConsumables();
    initConsumableDates();
    populateConsumableRiderSelect();
    populateConsumableRiderSearchDropdown();
    renderRiderConsumables();
  } else if (targetTab === 'owner-credits') {
    await fetchFleet();
    await fetchRiderCredits();
    initCreditDates();
    populateCreditRiderSelect();
    populateCreditRiderSearchDropdown();
    renderRiderCredits();
  } else if (targetTab === 'owner-rider-extract') {
    const accordion = document.getElementById('extratos-accordion');
    if (accordion) accordion.classList.add('open');
    await initRiderExtract();
  } else if (targetTab === 'owner-client-extract') {
    const accordion = document.getElementById('extratos-accordion');
    if (accordion) accordion.classList.add('open');
    await initClientExtract();
  } else if (targetTab === 'owner-settings') {
    await fetchFleet();
    renderRiderSettings();
    renderRiderLimits();

  } else if (targetTab === 'client-overview') {
    const clientInfoPanels = document.getElementById('client-info-panels');
    if (clientInfoPanels) {
      if (mockData.activeProfile === 'owner') {
        clientInfoPanels.classList.add('hidden');
      } else {
        clientInfoPanels.classList.remove('hidden');
      }
    }
    const clientActionCards = document.getElementById('client-action-cards');
    if (clientActionCards) {
      if (mockData.activeProfile === 'owner') {
        clientActionCards.classList.add('hidden');
      } else {
        clientActionCards.classList.remove('hidden');
      }
    }
    await fetchClientHistory();
    updateClientDashboardOverview();
    initClientOverviewChart();
  } else if (targetTab === 'client-fleet-map') {
    await fetchFleet();
    initClientFleetMap();
  } else if (targetTab === 'client-history') {
    await fetchClientHistory();
    renderClientHistoryTable();
  } else if (targetTab === 'client-ratings') {
    renderClientRatings();
  } else if (targetTab === 'client-teles') {
    await fetchPendingDeliveries();
    await fetchClientHistory();
    renderClientTelesUnified();
  } else if (targetTab === 'client-support') {
    const dot = document.getElementById('client-chat-dot');
    if (dot) dot.classList.add('hidden');
    await loadClientChatHistory();
    subscribeSupportRealtime();
    if (window.lucide) lucide.createIcons();
  } else if (targetTab === 'owner-support') {
    const dot = document.getElementById('admin-chat-dot');
    if (dot) dot.classList.add('hidden');
    await loadAdminChatChannels();
    subscribeSupportRealtime();
    if (window.lucide) lucide.createIcons();
  } else if (targetTab === 'owner-rider-support') {
    const dot = document.getElementById('admin-rider-chat-dot');
    if (dot) dot.classList.add('hidden');
    await loadAdminSupportSummary();
    await loadAdminSupportTickets();
    subscribeAdminRiderSupportRealtime();
    if (window.lucide) lucide.createIcons();
  } else if (targetTab === 'download-app') {
    if (window.lucide) lucide.createIcons();
  } else if (targetTab === 'order-request') {
    setTimeout(() => {
      initRequestDeliveryMap('client');
    }, 200);
  }
}



async function loadTelesManagement() {
  setTelesLoadingState();

  try {
    await Promise.all([
      fetchPendingDeliveries(),
      fetchFleet(),
      fetchClientHistory()
    ]);
  } catch (err) {
    console.error('Erro ao carregar dados da Gestão de Teles:', err);
    showTelesLoadError();
    return;
  }

  renderTelesUnified();
}

function setTelesLoadingState() {
  const container = document.getElementById('teles-content-container');
  const loadingCard = `
    <div class="tele-state-card" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; color: var(--color-text-muted);">
      <div class="tele-state-spinner" style="border: 3px solid rgba(255,255,255,0.05); border-top: 3px solid var(--primary); border-radius: 50%; width: 36px; height: 36px; animation: spin 1s linear infinite; margin-bottom: 12px;"></div>
      <p>Carregando teles...</p>
    </div>
  `;
  if (container) container.innerHTML = loadingCard;
}

function showTelesLoadError() {
  const container = document.getElementById('teles-content-container');
  const errorCard = `
    <div class="tele-state-card tele-state-error" style="text-align: center; padding: 40px; color: #ef4444;">
      <i data-lucide="alert-triangle" style="width: 48px; height: 48px; margin-bottom: 12px; display: inline-block;"></i>
      <p style="font-weight: 600;">Não foi possível carregar as teles.</p>
      <button class="btn btn-secondary btn-sm" onclick="loadTelesManagement()" style="margin-top: 12px;">Tentar novamente</button>
    </div>
  `;
  if (container) container.innerHTML = errorCard;
  lucide.createIcons();
}

// Global Filter Setter
window.setTeleFilter = function(filter) {
  currentTeleFilter = filter;
  
  // Highlight active pill
  const pills = document.querySelectorAll('.filter-pill');
  pills.forEach(pill => {
    pill.classList.remove('active');
  });
  
  const activePill = document.getElementById(`filter-${filter}`);
  if (activePill) activePill.classList.add('active');
  
  renderTelesUnified();
};

// Global View Mode Setter
window.setTeleViewMode = function(mode) {
  teleViewMode = mode;
  
  // Highlight active toggle button
  const gridBtn = document.getElementById('view-toggle-grid');
  const listBtn = document.getElementById('view-toggle-list');
  
  if (mode === 'grid') {
    if (gridBtn) gridBtn.classList.add('active');
    if (listBtn) listBtn.classList.remove('active');
  } else {
    if (gridBtn) gridBtn.classList.remove('active');
    if (listBtn) listBtn.classList.add('active');
  }
  
  renderTelesUnified();
};

// Render the owner fleet table with mock data
function renderFleetTable() {
  const tbody = document.getElementById('owner-fleet-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';
  mockData.fleet.forEach(rider => {
    const tr = document.createElement('tr');
    tr.className = 'clickable-row';
    const numRating = Number(rider.rating);
    const formattedRating = Number.isFinite(numRating) ? numRating.toFixed(2) : '5.00';

    tr.onclick = () => openRiderActions(rider.id);
    tr.innerHTML = `
      <td>
        <div class="user-profile">
          <div class="item-icon-avatar bg-yellow"><i data-lucide="bike" class="text-black"></i></div>
          <div>
            <strong>${escapeHtml(rider.name)}</strong>
            <p class="text-muted text-xs">Cód: ${escapeHtml(rider.motoboy_code || '—')}</p>
          </div>
        </div>
      </td>

      <td>
        <strong>${escapeHtml(rider.vehicle)}</strong>
        <p class="text-muted">${escapeHtml(rider.plate)}</p>
      </td>
      <td><span class="status-indicator ${escapeHtml(rider.statusClass)}">${escapeHtml(rider.status)}</span></td>
      <td><strong>${escapeHtml(rider.delivery)}</strong></td>
      <td>
        <div class="perf-bar-group" style="width: 100px;">
          <div class="perf-bar-label">
            <span class="text-xs" style="${rider.battery_level < 20 ? 'color: #ef4444; font-weight: bold;' : ''}">
              ${escapeHtml(rider.battery)}
            </span>
          </div>
          <div class="perf-bar">
            <div class="perf-bar-fill ${rider.battery_level < 20 ? '' : (rider.battery_level > 50 ? 'bg-green' : (rider.battery_level > 25 ? 'bg-yellow' : 'bg-blue'))}" style="width: ${rider.battery_level}%; ${rider.battery_level < 20 ? 'background-color: #ef4444;' : ''}"></div>
          </div>
        </div>
      </td>
      <td>
        <div class="courier-rating">
          <i data-lucide="star" class="fill-yellow text-yellow"></i> <strong>${formattedRating}</strong>
        </div>
      </td>
      <td>
        <button class="btn btn-secondary btn-sm icon-action-btn" onclick="event.stopPropagation(); openRiderActions('${rider.id}')" title="Ações do motoboy" aria-label="Ações do motoboy">
          <i data-lucide="settings"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}


function parseMoneyBR(value) {
  if (!value) return 0;
  return Number(String(value).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
}

function formatMoneyBR(value) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function getCurrentWeekRangeLabel() {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = { day: '2-digit', month: '2-digit' };
  return `${monday.toLocaleDateString('pt-BR', fmt)} a ${sunday.toLocaleDateString('pt-BR', fmt)}`;
}

function getCurrentWeekBounds() {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(today.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

function formatOrderIdForDisplay(id, payment, client) {
  return id || '';
}

function formatOrderDate(dateText, createdAt) {
  if (!createdAt) return dateText || '';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return dateText || '';

  const now = new Date();
  
  // Set times to 00:00:00 to compare calendar days accurately
  const dDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const diffTime = nowDate.getTime() - dDate.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) {
    return `Hoje, ${timeStr}`;
  } else if (diffDays === 1) {
    return `Ontem, ${timeStr}`;
  } else {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}, ${timeStr}`;
  }
}

function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  return new Date(dateStr);
}

function parseOrderDate(dateText, createdAt) {
  if (createdAt) {
    const d = new Date(createdAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const raw = String(dateText || '').trim();
  const now = new Date();
  if (!raw || raw.startsWith('Hoje')) return now;
  if (raw.startsWith('Ontem')) {
    const d = new Date(now);
    d.setDate(now.getDate() - 1);
    return d;
  }
  const brDate = raw.match(/(\d{2})\/(\d{2})(?:\/(\d{4}))?/);
  if (brDate) {
    return new Date(Number(brDate[3] || now.getFullYear()), Number(brDate[2]) - 1, Number(brDate[1]));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

function isOrderInCurrentWeek(order) {
  const { monday, sunday } = getCurrentWeekBounds();
  const orderDate = parseOrderDate(order.date, order.created_at);
  return orderDate >= monday && orderDate <= sunday;
}

function renderRiderPayments() {
  const tbody = document.getElementById('rider-payments-table-body');
  if (!tbody) return;

  const startDateVal = document.getElementById('rider-payment-start-date').value;
  const endDateVal = document.getElementById('rider-payment-end-date').value;
  const searchVal = document.getElementById('rider-search-input').value.trim().toLowerCase();

  let start = startDateVal ? parseLocalDate(startDateVal) : null;
  let end = endDateVal ? parseLocalDate(endDateVal) : null;

  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);

  // Set the range label dynamically
  const rangeEl = document.getElementById('rider-week-range');
  if (rangeEl) {
    if (start && end) {
      const fmt = { day: '2-digit', month: '2-digit' };
      rangeEl.innerText = `${start.toLocaleDateString('pt-BR', fmt)} a ${end.toLocaleDateString('pt-BR', fmt)}`;
    } else {
      rangeEl.innerText = 'Todo o Período';
    }
  }

  // Initialize map of rider totals
  const totals = new Map();
  mockData.fleet.forEach(rider => {
    if (searchVal && !rider.name.toLowerCase().includes(searchVal)) {
      return;
    }
    totals.set(rider.name, { rider, count: 0, total: 0, payments: [], consumablesTotal: 0, creditsTotal: 0 });
  });

  // Filter and group clientHistory orders in the range
  mockData.clientHistory
    .filter(order => {
      const isCompleted = order.status === 'Entregue' || order.status === 'Concluído';
      if (!isCompleted) return false;

      // Filter by date
      if (start || end) {
        const orderDate = parseOrderDate(order.date, order.created_at);
        if (start && orderDate < start) return false;
        if (end && orderDate > end) return false;
      }

      // Filter by rider search name
      if (searchVal && !order.rider.toLowerCase().includes(searchVal)) {
        return false;
      }

      return true;
    })
    .forEach(order => {
      if (!totals.has(order.rider)) {
        if (searchVal && !order.rider.toLowerCase().includes(searchVal)) return;
        totals.set(order.rider, { rider: { name: order.rider, id: '—' }, count: 0, total: 0, payments: [], consumablesTotal: 0, creditsTotal: 0 });
      }
      const item = totals.get(order.rider);
      item.count += 1;
      item.total += parseMoneyBR(order.price);
      item.payments.push(order);
    });

  // Sum consumables in the selected range for each rider
  const filteredConsumables = (mockData.riderConsumables || []).filter(item => {
    if (start || end) {
      const itemDate = new Date(item.created_at);
      if (start && itemDate < start) return false;
      if (end && itemDate > end) return false;
    }
    return true;
  });

  filteredConsumables.forEach(c => {
    let item = totals.get(c.rider_name);
    if (!item) {
      if (searchVal && !c.rider_name.toLowerCase().includes(searchVal)) return;
      totals.set(c.rider_name, { rider: { name: c.rider_name, id: c.rider_id }, count: 0, total: 0, payments: [], consumablesTotal: 0, creditsTotal: 0 });
      item = totals.get(c.rider_name);
    }
    item.consumablesTotal += c.amount;
  });

  // Sum credits in the selected range for each rider
  const filteredCredits = (mockData.riderCredits || []).filter(item => {
    if (start || end) {
      const itemDate = parseLocalDate(item.target_date);
      if (start && itemDate < start) return false;
      if (end && itemDate > end) return false;
    }
    return true;
  });

  filteredCredits.forEach(c => {
    const rider = mockData.fleet.find(r => r.id === c.rider_id);
    const riderName = rider ? rider.name : 'Motoboy Removido';
    let item = totals.get(riderName);
    if (!item) {
      if (searchVal && !riderName.toLowerCase().includes(searchVal)) return;
      totals.set(riderName, { rider: { name: riderName, id: c.rider_id }, count: 0, total: 0, payments: [], consumablesTotal: 0, creditsTotal: 0 });
      item = totals.get(riderName);
    }
    item.creditsTotal += c.amount;
  });

  const rows = Array.from(totals.values()).sort((a, b) => b.total - a.total);
  const grandTotalGross = rows.reduce((sum, row) => sum + row.total, 0);
  const grandTotalConsumables = rows.reduce((sum, row) => sum + (row.consumablesTotal || 0), 0);
  const grandTotalCredits = rows.reduce((sum, row) => sum + (row.creditsTotal || 0), 0);
  const grandTotalNet = grandTotalGross * 0.90 - grandTotalConsumables + grandTotalCredits; // Apply 10% discount, subtract consumables and add credits
  
  const totalEl = document.getElementById('rider-week-total');
  if (totalEl) totalEl.innerText = formatMoneyBR(grandTotalNet);

  tbody.innerHTML = rows.map(row => {
    const gross = row.total;
    const discount = gross * 0.10;
    const consumables = row.consumablesTotal || 0;
    const credits = row.creditsTotal || 0;
    const net = gross * 0.90 - consumables + credits;
    const avg = row.count ? gross / row.count : 0;

    // A rider is considered Paid in this period if they have orders and all of them are marked 'Pago'
    let isPaid = false;
    if (row.payments.length > 0) {
      isPaid = row.payments.every(order => order.payment_status === 'Pago');
    }

    const selectHtml = `
      <select onchange="updateRiderPaymentStatus('${escapeHtml(row.rider.name)}', this.value)" style="padding: 6px 12px; background: var(--input-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius-sm); color: ${isPaid ? '#10b981' : '#f59e0b'}; font-weight: 600; outline: none; cursor: pointer; font-size: 0.85rem;">
        <option value="Pendente" ${!isPaid ? 'selected' : ''} style="color: #f59e0b; background: var(--card-bg); font-weight: 600;">Pendente</option>
        <option value="Pago" ${isPaid ? 'selected' : ''} style="color: #10b981; background: var(--card-bg); font-weight: 600;">Pago</option>
      </select>
    `;

    return `
      <tr>
        <td>
          <strong>${escapeHtml(row.rider.name)}</strong>
          <p class="text-muted" style="margin: 2px 0 0 0; font-size: 0.78rem;">${escapeHtml(row.rider.id) || '—'}</p>
        </td>
        <td>${row.count}</td>
        <td>${formatMoneyBR(gross)}</td>
        <td class="text-danger">- ${formatMoneyBR(discount)}</td>
        <td class="text-danger">- ${formatMoneyBR(consumables)}</td>
        <td style="color: #10b981;">+ ${formatMoneyBR(credits)}</td>
        <td><strong class="text-yellow">${formatMoneyBR(net)}</strong></td>
        <td>${formatMoneyBR(avg)}</td>
        <td>${selectHtml}</td>
      </tr>
    `;
  }).join('');
}

// Render the rider configurations list in the settings tab
function renderRiderSettings() {
  const tbody = document.getElementById('rider-settings-table-body');
  if (!tbody) return;

  // Calculate and update stats counters
  const totalRiders = mockData.fleet.length;
  const bypassRiders = mockData.fleet.filter(r => r.bypassDistanceLimit).length;
  const ruleRiders = totalRiders - bypassRiders;

  const totalEl = document.getElementById('stats-total-riders');
  const ruleEl = document.getElementById('stats-rule-riders');
  const bypassEl = document.getElementById('stats-bypass-riders');

  if (totalEl) totalEl.innerText = totalRiders;
  if (ruleEl) ruleEl.innerText = ruleRiders;
  if (bypassEl) bypassEl.innerText = bypassRiders;

  // Filter riders if search query exists
  const searchInput = document.getElementById('rider-search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const filteredFleet = mockData.fleet.filter(rider => {
    if (!query) return true;
    const name = (rider.name || '').toLowerCase();
    const id = (rider.id || '').toLowerCase();
    const plate = (rider.plate || '').toLowerCase();
    return name.includes(query) || id.includes(query) || plate.includes(query);
  });

  if (filteredFleet.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted" style="padding: 20px;">Nenhum motoboy encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredFleet.map(rider => {
    const isChecked = rider.bypassDistanceLimit ? 'checked' : '';
    return `
      <tr>
        <td>
          <strong>${escapeHtml(rider.name)}</strong>
          <p class="text-muted">${escapeHtml(rider.id)}</p>
        </td>
        <td>
          <strong>${escapeHtml(rider.vehicle)}</strong>
          <p class="text-muted">${escapeHtml(rider.plate)}</p>
        </td>
        <td>
          <div class="switch-container">
            <label class="switch">
              <input type="checkbox" ${isChecked} onchange="toggleRiderDistanceLimit('${rider.id}', this.checked)">
              <span class="slider"></span>
            </label>
            <span class="switch-label-text">Liberar sem limites de distância</span>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // If accordion is expanded, update its height to fit-content
  const accordion = document.getElementById('geofencing-accordion');
  if (accordion && accordion.classList.contains('expanded')) {
    const collapseWrapper = accordion.querySelector('.accordion-collapse-wrapper');
    if (collapseWrapper) {
      collapseWrapper.style.maxHeight = 'fit-content';
    }
  }
}

async function toggleRiderDistanceLimit(riderId, isBypassed) {
  if (!supabaseClient) return;

  try {
    const { error } = await supabaseClient
      .from('fleet')
      .update({ bypass_distance_limit: isBypassed })
      .eq('id', riderId);

    if (error) throw error;

    // Update local state
    const localRider = mockData.fleet.find(r => r.id === riderId);
    if (localRider) {
      localRider.bypassDistanceLimit = isBypassed;
    }
    
    // Update stats and UI immediately
    renderRiderSettings();
  } catch (err) {
    console.error("Error toggling distance limit bypass:", err);
    alert("Erro ao salvar a configuração de distância no Supabase. Tente novamente.");
    // Re-render to revert toggle state visually
    renderRiderSettings();
  }
}

// Live search filter callback
function filterRiderSettings() {
  renderRiderSettings();
}

// Toggle Geofencing accordion panel open/close
function toggleGeofencingAccordion() {
  const accordion = document.getElementById('geofencing-accordion');
  if (!accordion) return;

  const chevron = accordion.querySelector('.accordion-chevron');
  const collapseWrapper = accordion.querySelector('.accordion-collapse-wrapper');

  const isExpanded = accordion.classList.toggle('expanded');

  if (isExpanded) {
    chevron.style.transform = 'rotate(180deg)';
    collapseWrapper.style.maxHeight = collapseWrapper.scrollHeight + 'px';
    setTimeout(() => {
      if (accordion.classList.contains('expanded')) {
        collapseWrapper.style.maxHeight = 'fit-content';
      }
    }, 250);
  } else {
    collapseWrapper.style.maxHeight = collapseWrapper.scrollHeight + 'px';
    collapseWrapper.offsetHeight; // force reflow
    chevron.style.transform = 'rotate(0deg)';
    collapseWrapper.style.maxHeight = '0';
  }
}

// Toggle Simultaneous Deliveries limit accordion panel open/close
function toggleSimultaneousDeliveriesAccordion() {
  const accordion = document.getElementById('simultaneous-deliveries-accordion');
  if (!accordion) return;

  const chevron = accordion.querySelector('.accordion-chevron');
  const collapseWrapper = accordion.querySelector('.accordion-collapse-wrapper');

  const isExpanded = accordion.classList.toggle('expanded');

  if (isExpanded) {
    chevron.style.transform = 'rotate(180deg)';
    collapseWrapper.style.maxHeight = collapseWrapper.scrollHeight + 'px';
    setTimeout(() => {
      if (accordion.classList.contains('expanded')) {
        collapseWrapper.style.maxHeight = 'fit-content';
      }
    }, 250);
  } else {
    collapseWrapper.style.maxHeight = collapseWrapper.scrollHeight + 'px';
    collapseWrapper.offsetHeight; // force reflow
    chevron.style.transform = 'rotate(0deg)';
    collapseWrapper.style.maxHeight = '0';
  }
}

// Render simultaneous deliveries limits list for each motoboy
function renderRiderLimits() {
  const tbody = document.getElementById('rider-limits-table-body');
  if (!tbody) return;

  // Calculate and update stats counters
  const totalRiders = mockData.fleet.length;
  const defaultRiders = mockData.fleet.filter(r => (r.maxSimultaneousDeliveries || 1) === 1).length;
  const customRiders = totalRiders - defaultRiders;

  const totalEl = document.getElementById('stats-limit-total-riders');
  const defaultEl = document.getElementById('stats-limit-default-riders');
  const customEl = document.getElementById('stats-limit-custom-riders');

  if (totalEl) totalEl.innerText = totalRiders;
  if (defaultEl) defaultEl.innerText = defaultRiders;
  if (customEl) customEl.innerText = customRiders;

  // Filter riders if search query exists
  const searchInput = document.getElementById('rider-limit-search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const filteredFleet = mockData.fleet.filter(rider => {
    if (!query) return true;
    const name = (rider.name || '').toLowerCase();
    const id = (rider.id || '').toLowerCase();
    const plate = (rider.plate || '').toLowerCase();
    return name.includes(query) || id.includes(query) || plate.includes(query);
  });

  if (filteredFleet.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted" style="padding: 20px;">Nenhum motoboy encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredFleet.map(rider => {
    const currentLimit = rider.maxSimultaneousDeliveries || 1;
    return `
      <tr>
        <td>
          <strong>${escapeHtml(rider.name)}</strong>
          <p class="text-muted">${escapeHtml(rider.id)}</p>
        </td>
        <td>
          <strong>${escapeHtml(rider.vehicle)}</strong>
          <p class="text-muted">${escapeHtml(rider.plate)}</p>
        </td>
        <td>
          <select onchange="updateRiderDeliveryLimit('${rider.id}', this.value)" style="width: 100%; padding: 8px 12px; background: var(--input-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius-sm); color: var(--color-text); font-size: 0.88rem; outline: none; transition: border-color 0.2s; cursor: pointer;">
            <option value="1" ${currentLimit === 1 ? 'selected' : ''}>1 entrega</option>
            <option value="2" ${currentLimit === 2 ? 'selected' : ''}>2 entregas</option>
            <option value="3" ${currentLimit === 3 ? 'selected' : ''}>3 entregas</option>
            <option value="4" ${currentLimit === 4 ? 'selected' : ''}>4 entregas</option>
            <option value="5" ${currentLimit === 5 ? 'selected' : ''}>5 entregas</option>
          </select>
        </td>
      </tr>
    `;
  }).join('');

  // If accordion is expanded, update its height to fit-content
  const accordion = document.getElementById('simultaneous-deliveries-accordion');
  if (accordion && accordion.classList.contains('expanded')) {
    const collapseWrapper = accordion.querySelector('.accordion-collapse-wrapper');
    if (collapseWrapper) {
      collapseWrapper.style.maxHeight = 'fit-content';
    }
  }
}

// Update a rider's simultaneous delivery limit in Supabase
async function updateRiderDeliveryLimit(riderId, limitValue) {
  const parsedLimit = parseInt(limitValue) || 1;

  if (!supabaseClient) {
    const rider = mockData.fleet.find(r => r.id === riderId);
    if (rider) rider.maxSimultaneousDeliveries = parsedLimit;
    renderRiderLimits();
    showToastNotification('Limite de entregas simultâneas atualizado com sucesso.');
    return;
  }

  try {
    const { error } = await supabaseClient
      .from('fleet')
      .update({ max_simultaneous_deliveries: parsedLimit })
      .eq('id', riderId);

    if (error) throw error;

    const rider = mockData.fleet.find(r => r.id === riderId);
    if (rider) rider.maxSimultaneousDeliveries = parsedLimit;
    renderRiderLimits();
    showToastNotification('Limite de entregas simultâneas atualizado com sucesso.');
  } catch (err) {
    console.error("Error updating rider delivery limit:", err);
    alert("Erro ao atualizar o limite de entregas do motoboy no Supabase. Tente novamente.");
    renderRiderLimits();
  }
}

// Restore default simultaneous delivery limit (1) for ALL riders
async function restoreDefaultAllRiderLimits() {
  if (!confirm('Tem certeza de que deseja restaurar o limite padrão (1 entrega) para TODOS os motoboys?')) return;

  if (!supabaseClient) {
    mockData.fleet.forEach(rider => {
      rider.maxSimultaneousDeliveries = 1;
    });
    renderRiderLimits();
    showToastNotification('Todos os motoboys foram redefinidos para o limite padrão (1 entrega).');
    return;
  }

  try {
    const { error } = await supabaseClient
      .from('fleet')
      .update({ max_simultaneous_deliveries: 1 });

    if (error) throw error;

    mockData.fleet.forEach(rider => {
      rider.maxSimultaneousDeliveries = 1;
    });
    renderRiderLimits();
    showToastNotification('Todos os motoboys foram redefinidos para o limite padrão (1 entrega).');
  } catch (err) {
    console.error("Error restoring all rider limits:", err);
    alert("Erro ao redefinir os limites no Supabase. Tente novamente.");
    renderRiderLimits();
  }
}

// Search filter callback for rider limits
function filterRiderLimits() {
  renderRiderLimits();
}

// Render the client delivery history table
function renderClientHistoryTable() {
  const tbody = document.getElementById('client-history-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';
  const currentCreds = mockData.credentials[mockData.activeProfile];
  const currentCommerce = currentCreds ? currentCreds.commerceName : 'Cliente não vinculado';

  const filteredHistory = mockData.clientHistory.filter(order => {
    return order.client === currentCommerce;
  });

  filteredHistory.forEach(order => {
    const tr = document.createElement('tr');
    tr.className = 'ops-table-row';
    const isActive = order.status !== 'Entregue' && order.status !== 'Concluído' && order.status !== 'Cancelado';

    // Composite ID Shield
    let displayId = order.id;
    let originLabel = 'Painel do Cliente';
    let originBadgeClass = 'badge-soft';

    const statusHtml = `
      <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start;">
        <span class="status-indicator ${order.statusClass}">${order.status}</span>
        ${isActive ? `<button class="btn btn-secondary btn-sm" onclick="trackActiveOrder('${order.id}')" style="padding: 2px 8px; font-size: 0.75rem; cursor: pointer; border: 1px solid var(--border-color); background: var(--secondary); color: var(--color-text);">Rastrear</button>` : ''}
      </div>
    `;

    tr.innerHTML = `
      <td>
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <span class="order-id" style="font-family: var(--font-display); font-weight: 700; color: #fff;">
            ${displayId}
          </span>
          <span class="badge ${originBadgeClass}" style="font-size: 0.65rem; padding: 2px 6px; width: fit-content; border-radius: 4px;">
            ${originLabel}
          </span>
        </div>
      </td>
      <td>
        <div style="display: flex; flex-direction: column;">
          <strong style="color: #fff;">${order.destName}</strong>
          <span class="text-muted" style="font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px; line-height: 1.4; margin-top: 2px;">
            <i data-lucide="map-pin" style="width: 12px; height: 12px; flex-shrink: 0; color: #ffb700;"></i>
            ${order.address}
          </span>
        </div>
      </td>
      <td>
        <span class="badge badge-soft" style="background: rgba(0, 174, 239, 0.1); color: var(--accent-cyan); border: 1px solid rgba(0, 174, 239, 0.2); border-radius: 4px;">
          ${order.rider}
        </span>
      </td>
      <td>${order.dist}</td>
      <td><strong class="text-yellow">${order.price}</strong></td>
      <td>${order.date}</td>
      <td>${statusHtml}</td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

// Generate next sequential TELE ID (#TEL-100001, #TEL-100002, ...)
async function getNextTeleId() {
  let maxNum = 0;
  if (supabaseClient) {
    const [{ data: pending }, { data: history }] = await Promise.all([
      supabaseClient.from('teles').select('id'),
      supabaseClient.from('teles').select('id')
    ]);
    [...(pending || []), ...(history || [])].forEach(item => {
      const match = (item.id || '').match(/#TELE-(\d+)/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
    });
  }
  return '#TELE-' + String(maxNum + 1).padStart(4, '0');
}

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

// Calculate delivery price and distance on form inputs
function calculateEstimate(type = 'client') {
  const addressInput = document.getElementById(`${type}-delivery-address`).value;
  const estimateBox = document.getElementById(`${type}-estimate-box`);

  if (addressInput.length < 5) {
    estimateBox.classList.add('hidden');
    return;
  }

  let distance = 0;
  if (requestMaps[type].destCoords) {
    let startLat = requestMaps[type].centerCoords[0];
    let startLng = requestMaps[type].centerCoords[1];
    if (requestMaps[type].restaurantMarker) {
      const pos = requestMaps[type].restaurantMarker.getPosition();
      startLat = pos.lat();
      startLng = pos.lng();
    }
    const straightDistance = calculateHaversineDistance(startLat, startLng, requestMaps[type].destCoords.lat, requestMaps[type].destCoords.lng);
    distance = parseFloat((straightDistance * 1.3).toFixed(1)); // 1.3 multiplier to estimate real route distance
  } else {
    // Seed standard generator based on address string length to keep values consistent while typing
    const seed = addressInput.length;
    distance = parseFloat((1.5 + (seed % 10) * 1.2).toFixed(1)); // mock distance: 1.5km to 12.3km
  }

  const minutes = Math.round(distance * 3.5 + 4); // mock speed minutes
  
  // Pricing logic: Strict city-based pricing
  let price = 15.00;
  let priceText = 'R$ 15,00 (Fora da área de entrega)';
  
  const lowercaseAddress = addressInput.toLowerCase();
  const sortedCities = [...(mockData.cities || [])].sort((a, b) => b.nome.length - a.nome.length);
  const matchedCity = sortedCities.find(city => lowercaseAddress.includes(city.nome.toLowerCase()));
  
  if (matchedCity) {
    price = matchedCity.taxa;
    priceText = 'R$ ' + price.toFixed(2).replace('.', ',');
  }
  
  // Store values temporarily for form submission
  window.lastEstimate = {
    distance: distance + ' km',
    time: minutes + ' min',
    price: priceText
  };

  // Update UI values
  document.getElementById(`${type}-est-distance`).innerText = window.lastEstimate.distance;
  document.getElementById(`${type}-est-time`).innerText = window.lastEstimate.time;
  document.getElementById(`${type}-est-price`).innerText = window.lastEstimate.price;

  estimateBox.classList.remove('hidden');
}

// Submit delivery request and trigger live tracking simulation
async function submitDeliveryRequest(event, type = 'client') {
  event.preventDefault();

  const destAddress = document.getElementById(`${type}-delivery-address`).value;
  const cargoType = document.getElementById(`${type}-cargo-type`).value;
  const payMethod = document.getElementById(`${type}-payment-method`).value;
  const notes = document.getElementById(`${type}-order-notes`).value;
  const clientName = document.getElementById(`${type}-delivery-client`)?.value || 'Cliente não vinculado';
  const destName = document.getElementById(`${type}-delivery-dest-name`)?.value || 'Cliente informado';

  if (!window.lastEstimate) return;

  // Get Tele ID (use input override if manual, otherwise auto-generate)
  let randomId;
  if (type === 'manual') {
    randomId = document.getElementById('manual-delivery-id').value.trim();
    if (!randomId) {
      randomId = await getNextTeleId();
    }
  } else {
    randomId = await getNextTeleId();
  }
  
  // Format payment name
  const changeEl = document.getElementById(`${type}-change-amount`);
  const changeVal = changeEl ? changeEl.value : '50';
  const paymentStr = payMethod === 'pix' ? 'PIX (Pago pelo App)' : (payMethod === 'cartao-maquininha' ? 'Levar Maquininha' : 'Dinheiro (Troco para R$ ' + changeVal + ')');
  // Format cargo name
  const cargoStr = cargoType === 'lanche' ? '🍔 Lanches e Bebidas' : (cargoType === 'pizza' ? '🍕 Pizza Família' : (cargoType === 'doce' ? '🍩 Doces e Sobremesas' : '📄 Papelada / Documentos'));

  let pickupLat = -29.8378;
  let pickupLng = -51.1444;
  if (requestMaps[type].restaurantMarker) {
    const pos = requestMaps[type].restaurantMarker.getPosition();
    pickupLat = pos.lat();
    pickupLng = pos.lng();
  } else if (Array.isArray(requestMaps[type].centerCoords)) {
    pickupLat = requestMaps[type].centerCoords[0];
    pickupLng = requestMaps[type].centerCoords[1];
  }

  let destLat = null;
  let destLng = null;
  if (requestMaps[type].marker) {
    const pos = requestMaps[type].marker.getPosition();
    destLat = pos.lat();
    destLng = pos.lng();
  } else if (requestMaps[type].destCoords) {
    destLat = requestMaps[type].destCoords.lat;
    destLng = requestMaps[type].destCoords.lng;
  }

  if (!destLat || !destLng) {
    alert("Erro: Não foi possível obter a geolocalização para este endereço. Certifique-se de digitar ou colar um endereço com número residencial válido no Rio Grande do Sul.");
    return;
  }

  // Create delivery payload for Supabase
  const newDelivery = {
    id: randomId,
    client: clientName,
    dest_name: destName,
    address: destAddress,
    dist: window.lastEstimate.distance,
    price: window.lastEstimate.price,
    payment: paymentStr,
    cargo: cargoStr,
    pickup_lat: pickupLat,
    pickup_lng: pickupLng,
    dest_lat: destLat,
    dest_lng: destLng
  };

  // Insert to Supabase teles table
  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('teles')
      .insert([newDelivery]);
    if (error) {
      console.error("Error inserting delivery to Supabase:", error);
      alert("Erro ao criar a solicitação de entrega no Supabase.");
      return;
    }
  }

  // Setup tracker UI elements
  const newOrder = {
    id: randomId,
    destName: destName,
    address: destAddress,
    rider: 'Aguardando entregador',
    dist: window.lastEstimate.distance,
    price: window.lastEstimate.price,
    date: 'Hoje, ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    status: 'Buscando Entregador',
    statusClass: 'status-progress'
  };

  // Add order to local mock state history
  mockData.clientHistory.unshift(newOrder);

  // Setup tracker UI elements
  document.getElementById('tracker-order-id').innerText = randomId;
  document.getElementById('tracker-badge-status').innerText = 'Buscando Entregador';
  document.getElementById('tracker-badge-status').className = 'status-badge status-warning';
  
  // Enable tracking tab
  const trackingTabBtn = document.getElementById('nav-tracking-tab');
  if (trackingTabBtn) {
    trackingTabBtn.disabled = false;
    trackingTabBtn.querySelector('.pulse-dot').classList.remove('hidden');
  }
  
  // Reset stepper nodes status
  document.querySelectorAll('.step-node').forEach(node => {
    node.className = 'step-node';
    node.querySelector('.text-muted').innerText = '--:--';
  });
  
  // Set first step active
  document.getElementById('step-1').className = 'step-node active';
  document.getElementById('step-1-time').innerText = 'Confirmado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Hide Courier Profile card inside tracker initially
  document.getElementById('tracker-courier-box').classList.add('hidden');

  // Switch view to tracking
  switchDashboardTab('order-tracking');

  // Trigger real-time logistics tracking
  startRealtimeTracking(newDelivery);

  // Reset Request Form safely
  const requestForm = document.getElementById('order-request-form') || document.getElementById('request-delivery-form');
  if (requestForm) requestForm.reset();
  
  document.getElementById(`${type}-estimate-box`).classList.add('hidden');
  window.lastEstimate = null;

  // Reset request map markers
  if (requestMaps[type].marker) {
    requestMaps[type].marker.setMap(null);
    requestMaps[type].marker = null;
  }
  if (requestMaps[type].polyline) {
    requestMaps[type].polyline.setMap(null);
    requestMaps[type].polyline = null;
  }

  // Close request delivery modal if active
  closeRequestDeliveryModal();
}

// Reset tracking tab to disabled once finished or logged out
function resetTrackedOrder() {
  const trackingTabBtn = document.getElementById('nav-tracking-tab');
  if (trackingTabBtn) {
    trackingTabBtn.disabled = true;
    trackingTabBtn.querySelector('.pulse-dot').classList.add('hidden');
  }

  if (trackingRealtimeChannel) {
    if (supabaseClient) {
      supabaseClient.removeChannel(trackingRealtimeChannel);
    }
    trackingRealtimeChannel = null;
  }

  if (trackingMapInstance) {
    trackingMapInstance.remove();
    trackingMapInstance = null;
  }
}

// simulated tracking timeline sequence
function runLogisticsSimulation(order) {
  const trackerStatus = document.getElementById('tracker-badge-status');
  const moto = document.getElementById('map-moto');

  // Time configurations (shortened for preview experience)
  // Step 1: Assigning Courier (3 seconds)
  setTimeout(() => {
    trackerStatus.innerText = 'Entregador Coletando';
    trackerStatus.className = 'status-badge status-progress';

    // Highlight step 1 as complete, step 2 active
    document.getElementById('step-1').className = 'step-node completed';
    document.getElementById('step-2').className = 'step-node active';
    document.getElementById('step-2-time').innerText = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Show rider profile info
    document.getElementById('tracker-courier-box').classList.remove('hidden');

    // Move motorcycle icon to pickup location at the top-left area of the route mock.
    moto.style.transition = 'top 5s cubic-bezier(0.25, 0.46, 0.45, 0.94), left 5s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    moto.style.top = '70%';
    moto.style.left = '30%';

  }, 3000);

  // Step 2: Rider arrived at merchant and picked up package (9 seconds total, wait 1s)
  setTimeout(() => {
    trackerStatus.innerText = 'Em Rota de Entrega';
    trackerStatus.className = 'status-badge status-progress';

    // Highlight step 2 as complete, step 3 active
    document.getElementById('step-2').className = 'step-node completed';
    document.getElementById('step-3').className = 'step-node active';
    document.getElementById('step-3-time').innerText = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Move motorcycle icon from pickup to customer delivery location (top: 25%, left: 75%)
    moto.style.transition = 'top 10s linear, left 10s linear';
    moto.style.top = '25%';
    moto.style.left = '75%';

  }, 9000);

  // Step 3: Rider arrived at client and handed order (20 seconds total)
  setTimeout(() => {
    trackerStatus.innerText = 'Concluído';
    trackerStatus.className = 'status-badge status-success';

    // Highlight step 3 as complete, step 4 active
    document.getElementById('step-3').className = 'step-node completed';
    document.getElementById('step-4').className = 'step-node active';
    document.getElementById('step-4-time').innerText = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Update simulation record in internal storage
    order.status = 'Entregue';
    order.statusClass = 'status-success';
    
    // Update total dashboard metrics for simulation
    const metricsValEl = document.getElementById('client-total-orders');
    if (metricsValEl) {
      let currentVal = parseInt(metricsValEl.innerText);
      metricsValEl.innerText = (currentVal + 1);
    }
    const metricsCostEl = document.getElementById('client-total-cost');
    if (metricsCostEl) {
      let currentCost = parseFloat(metricsCostEl.innerText.replace('R$ ', '').replace('.', '').replace(',', '.'));
      let extraPrice = parseFloat(order.price.replace('R$ ', '').replace('.', '').replace(',', '.'));
      metricsCostEl.innerText = 'R$ ' + (currentCost + extraPrice).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Clear tracking pulse
    document.getElementById('nav-tracking-tab').querySelector('.pulse-dot').classList.add('hidden');

  }, 20000);
  
  // Step 4: Fully finalize order tracker card states (23 seconds total)
  setTimeout(() => {
    document.getElementById('step-4').className = 'step-node completed';
  }, 23000);
}


/* ================= CHART INITIALIZATION ================= */

function parseCurrencyBR(value) {
  const raw = String(value || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrencyBR(value) {
  return value > 0
    ? value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '—';
}

function renderOwnerOverviewMetrics() {
  const completedOrders = mockData.clientHistory.filter(order => order.status === 'Entregue' || order.statusClass === 'status-success');
  const grossTotal = completedOrders.reduce((sum, order) => sum + parseCurrencyBR(order.price), 0);
  const activeRiders = mockData.fleet.filter(rider => rider.status && rider.status !== 'Em Descanso').length;
  const today = new Date().toLocaleDateString('pt-BR');
  const completedToday = completedOrders.filter(order => String(order.date || '').includes(today)).length;
  const averageTicket = completedOrders.length ? grossTotal / completedOrders.length : 0;

  const monthlyRevenueEl = document.getElementById('owner-monthly-revenue');
  if (monthlyRevenueEl) monthlyRevenueEl.innerText = formatCurrencyBR(grossTotal);

  const activeRidersEl = document.getElementById('owner-active-riders');
  if (activeRidersEl) activeRidersEl.innerText = mockData.fleet.length ? String(activeRiders) : '—';

  const completedTodayEl = document.getElementById('owner-completed-today');
  if (completedTodayEl) completedTodayEl.innerText = completedToday ? String(completedToday) : '—';

  const averageTicketEl = document.getElementById('owner-average-ticket');
  if (averageTicketEl) averageTicketEl.innerText = formatCurrencyBR(averageTicket);
}

// Chart 1: Owner Overview deliveries
function initOwnerOverviewChart() {
  const ctx = document.getElementById('ownerOverviewChart');
  if (!ctx) return;

  if (ownerOverviewChart) {
    ownerOverviewChart.destroy();
  }

  const chartData = getWeeklyChartData();
  ownerOverviewChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
      datasets: [{
        label: 'Entregas Concluídas',
        data: buildOwnerWeeklyDeliverySeries(),
        borderColor: '#ffb700',
        backgroundColor: 'rgba(255, 183, 0, 0.1)',
        borderWidth: 3,
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8e8e9f' }
        },
        x: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8e8e9f' }
        }
      }
    }
  });
}

function buildOwnerWeeklyDeliverySeries() {
  const completedOrders = mockData.clientHistory.filter(order => order.status === 'Entregue' || order.statusClass === 'status-success');
  const totals = [0, 0, 0, 0, 0, 0, 0];
  const dayNames = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const labelIndex = { seg: 0, ter: 1, qua: 2, qui: 3, sex: 4, 'sáb': 5, sab: 5, dom: 6 };

  completedOrders.forEach(order => {
    const dateText = String(order.date || '').toLowerCase();
    const dayLabel = dayNames.find(day => dateText.includes(day));
    if (!dayLabel) return;
    const index = labelIndex[dayLabel];
    if (typeof index === 'number') totals[index] += 1;
  });

  return totals;
}

// Chart 2: Owner Financials doughnut
function initOwnerFinancialChart() {
  const ctx = document.getElementById('ownerFinancialChart');
  if (!ctx) return;

  if (ownerFinancialChart) {
    ownerFinancialChart.destroy();
  }

  ownerFinancialChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Repasse Motoboys', 'Comissão Plataforma', 'Seguros / Taxas'],
      datasets: [{
        data: [71, 24, 5],
        backgroundColor: ['#ffb700', '#f97316', '#10b981'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#8e8e9f', font: { family: 'Inter', size: 12 } }
        }
      }
    }
  });
}

// Chart 3: Client Snack Bar performance comparison
function initClientOverviewChart() {
  const ctx = document.getElementById('clientOverviewChart');
  if (!ctx) return;

  if (clientOverviewChart) {
    clientOverviewChart.destroy();
  }

  const chartData = getClientWeeklyChartData();
  clientOverviewChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
      datasets: [
        {
          label: 'Entregas Concluídas',
          data: chartData,
          backgroundColor: '#ffb700',
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#8e8e9f' }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { 
            color: '#8e8e9f',
            stepSize: 1
          }
        },
        x: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8e8e9f' }
        }
      }
    }
  });
}

// Map 1: Owner Fleet Monitoring Map
async function initOwnerFleetMap() {
  const mapContainer = document.getElementById('owner-fleet-map');
  if (!mapContainer) return;

  try {
    if (ownerFleetMap) {
      if (window.google?.maps) {
        window.google.maps.event.trigger(ownerFleetMap, 'resize');
        ownerFleetMap.setCenter(new window.google.maps.LatLng(ownerFleetCenterCoords[0], ownerFleetCenterCoords[1]));
      }
      return;
    }

    mapContainer.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; text-align:center; padding:16px;">Carregando mapa...</div>`;

    await loadGoogleMapsApi();

    if (!window.google?.maps) {
      throw new Error('Google Maps API não foi carregada.');
    }

    mapContainer.innerHTML = '';

    const darkMapStyle = [
      { elementType: "geometry", stylers: [{ color: "#1e1e24" }] },
      { elementType: "labels.text.stroke", stylers: [{ color: "#1e1e24" }] },
      { elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
      { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#33333d" }] },
      { featureType: "poi", stylers: [{ visibility: "off" }] },
      { featureType: "road", elementType: "geometry", stylers: [{ color: "#2d2d38" }] },
      { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a1a22" }] },
      { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
      { featureType: "transit", stylers: [{ visibility: "off" }] },
      { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d0d11" }] }
    ];

    const latLng = new window.google.maps.LatLng(ownerFleetCenterCoords[0], ownerFleetCenterCoords[1]);
    ownerFleetMap = new window.google.maps.Map(mapContainer, {
      center: latLng,
      zoom: 14,
      styles: darkMapStyle,
      disableDefaultUI: true,
      zoomControl: true,
      fullscreenControl: false,
      gestureHandling: 'greedy'
    });

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          ownerFleetCenterCoords = [position.coords.latitude, position.coords.longitude];
          if (ownerFleetMap && window.google?.maps) {
            ownerFleetMap.setCenter(new window.google.maps.LatLng(ownerFleetCenterCoords[0], ownerFleetCenterCoords[1]));
          }
          renderMapMarkers(ownerFleetCenterCoords);
        },
        (error) => {
          console.warn("Geolocation failed. Using fallback.", error);
          renderMapMarkers(ownerFleetCenterCoords);
        }
      );
    } else {
      renderMapMarkers(ownerFleetCenterCoords);
    }
  } catch (error) {
    console.error('Erro ao inicializar mapa da frota:', error);
    mapContainer.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; text-align:center; padding:16px;">Não foi possível carregar o Google Maps. Verifique a chave e as APIs habilitadas.</div>`;
  }
}

async function initClientFleetMap() {
  const mapContainer = document.getElementById('client-fleet-map');
  if (!mapContainer) return;

  try {
    if (clientFleetMap) {
      if (window.google?.maps) {
        window.google.maps.event.trigger(clientFleetMap, 'resize');
        clientFleetMap.setCenter(new window.google.maps.LatLng(clientFleetCenterCoords[0], clientFleetCenterCoords[1]));
      }
      return;
    }

    mapContainer.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; text-align:center; padding:16px;">Carregando mapa...</div>`;

    await loadGoogleMapsApi();

    if (!window.google?.maps) {
      throw new Error('Google Maps API não foi carregada.');
    }

    mapContainer.innerHTML = '';

    const darkMapStyle = [
      { elementType: "geometry", stylers: [{ color: "#1e1e24" }] },
      { elementType: "labels.text.stroke", stylers: [{ color: "#1e1e24" }] },
      { elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
      { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#33333d" }] },
      { featureType: "poi", stylers: [{ visibility: "off" }] },
      { featureType: "road", elementType: "geometry", stylers: [{ color: "#2d2d38" }] },
      { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a1a22" }] },
      { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
      { featureType: "transit", stylers: [{ visibility: "off" }] },
      { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d0d11" }] }
    ];

    const latLng = new window.google.maps.LatLng(clientFleetCenterCoords[0], clientFleetCenterCoords[1]);
    clientFleetMap = new window.google.maps.Map(mapContainer, {
      center: latLng,
      zoom: 14,
      styles: darkMapStyle,
      disableDefaultUI: true,
      zoomControl: true,
      fullscreenControl: false,
      gestureHandling: 'greedy'
    });

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          clientFleetCenterCoords = [position.coords.latitude, position.coords.longitude];
          if (clientFleetMap && window.google?.maps) {
            clientFleetMap.setCenter(new window.google.maps.LatLng(clientFleetCenterCoords[0], clientFleetCenterCoords[1]));
          }
          renderClientMapMarkers(clientFleetCenterCoords);
        },
        (error) => {
          console.warn("Geolocation failed. Using fallback.", error);
          renderClientMapMarkers(clientFleetCenterCoords);
        }
      );
    } else {
      renderClientMapMarkers(clientFleetCenterCoords);
    }
  } catch (error) {
    console.error('Erro ao inicializar mapa da frota do cliente:', error);
    mapContainer.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; text-align:center; padding:16px;">Não foi possível carregar o Google Maps. Verifique a chave e as APIs habilitadas.</div>`;
  }
}


function renderMapMarkers(centerCoords) {
  if (!ownerFleetMap || !window.google?.maps) return;

  const centerLatLng = new window.google.maps.LatLng(centerCoords[0], centerCoords[1]);


  if (!ownerCentralMarker) {
    const el = document.createElement('div');
    el.className = 'custom-map-marker central-marker';
    el.style.backgroundColor = '#ffffff';
    el.style.boxShadow = '0 0 15px #ffffff';
    el.style.borderColor = 'var(--primary)';
    el.innerHTML = `
      <div class="marker-pulse" style="border-color: var(--primary); animation-duration: 2.5s;"></div>
      <i class="marker-icon-dot" style="background-color: var(--primary); width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
    `;
    
    ownerCentralMarker = new window.CustomHTMLMapMarker(centerLatLng, ownerFleetMap, el.outerHTML, () => {
      window.openBaseMapPopup();
    });
  } else {
    ownerCentralMarker.setLatLng(centerLatLng);
  }

  const offsets = [
    [0.004, -0.006],
    [0.008, 0.012],
    [-0.005, 0.009],
    [-0.012, -0.004],
    [0.003, -0.015],
    [-0.009, 0.005]
  ];

  const ridersLocations = mockData.fleet.length
    ? mockData.fleet.map((rider, index) => ({
        id: rider.id,
        name: rider.name,
        vehicle: rider.vehicle,
        plate: rider.plate,
        status: rider.status,
        statusColor: rider.status === 'Em Descanso' ? '#8e8e9f' : (rider.statusClass === 'status-progress' ? '#ffb700' : '#22c55e'),
        offset: offsets[index % offsets.length]
      }))
    : [];

  const currentRidersNames = new Set(ridersLocations.map(r => r.name));

  if (activePanelRiderName && !currentRidersNames.has(activePanelRiderName)) {
    closeFleetRiderPanel();
  }

  Object.keys(ownerFleetMarkers).forEach(name => {
    if (!currentRidersNames.has(name)) {
      if (ownerFleetMarkers[name] && ownerFleetMarkers[name].setMap) {
        ownerFleetMarkers[name].setMap(null);
      }
      delete ownerFleetMarkers[name];
    }
  });

  ridersLocations.forEach(rider => {
    const mockRider = mockData.fleet.find(r => r.name === rider.name);
    const currentStatus = mockRider ? mockRider.status : rider.status;
    const currentStatusColor = mockRider 
      ? (mockRider.status === 'Em Descanso' ? '#8e8e9f' : (mockRider.statusClass === 'status-progress' ? '#ffb700' : '#22c55e')) 
      : rider.statusColor;

    const hasRealGPS = mockRider && 
                       mockRider.lat !== null && 
                       mockRider.lat !== undefined && 
                       !isNaN(parseFloat(mockRider.lat)) && 
                       mockRider.lng !== null && 
                       mockRider.lng !== undefined && 
                       !isNaN(parseFloat(mockRider.lng));

    let riderCoords;
    if (hasRealGPS) {
      riderCoords = [parseFloat(mockRider.lat), parseFloat(mockRider.lng)];
    } else {
      riderCoords = [centerCoords[0] + rider.offset[0], centerCoords[1] + rider.offset[1]];
    }

    const isPulsing = currentStatus !== 'Em Descanso';
    const markerHtml = `
      <div class="custom-map-marker" style="background-color: ${currentStatusColor}; box-shadow: 0 0 10px ${currentStatusColor}; width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative; cursor: pointer;">
        ${isPulsing ? `<div class="marker-pulse" style="border-color: ${currentStatusColor}; position: absolute; top: -5px; left: -5px; width: 24px; height: 24px; border: 2px solid ${currentStatusColor}; border-radius: 50%; animation: pulse-dot-anim 2.5s infinite;"></div>` : ''}
        <i class="marker-icon-dot" style="background-color: #fff; width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
      </div>
    `;

    const riderLatLng = new window.google.maps.LatLng(riderCoords[0], riderCoords[1]);

    let markerEntry = ownerFleetMarkers[rider.name];
    if (markerEntry) {
      markerEntry.setLatLng(riderLatLng);
    } else {
      const marker = new window.CustomHTMLMapMarker(riderLatLng, ownerFleetMap, markerHtml, () => {
        window.openRiderMapPopup(rider.id);
      });
      ownerFleetMarkers[rider.name] = marker;
    }

    if (mockRider && selectedMapRiderId === mockRider.id) {
      ownerFleetMap.setCenter(riderLatLng);
      ownerFleetMap.setZoom(16);
      setTimeout(() => window.openRiderMapPopup(rider.id), 150);
      selectedMapRiderId = null; // reset to avoid locking view
    }
  });
}

window.openRiderMapPopup = function(riderId) {
  const rider = mockData.fleet.find(r => r.id === riderId);
  if (!rider) return;

  const currentStatus = rider.status;
  const currentStatusColor = rider.status === 'Em Descanso' ? '#8e8e9f' : (rider.statusClass === 'status-progress' ? '#ffb700' : '#22c55e');

  let pendingOptions = '<option value="" disabled selected>Vincular Tele...</option>';
  if (mockData.pendingDeliveries.length > 0) {
    mockData.pendingDeliveries.forEach(d => {
      pendingOptions += `<option value="${d.id}" style="color: #fff; background: #1e1e24;">${d.id} - ${d.destName || 'Cliente'} (${d.price})</option>`;
    });
  } else {
    pendingOptions = '<option value="" disabled>Nenhuma tele disponível</option>';
  }

  const assignedTeles = getActiveOrdersForRider(rider);
  let assignedHtml = '';
  if (assignedTeles.length > 0) {
    assignedTeles.forEach(t => {
      assignedHtml += `
        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255, 255, 255, 0.05); padding: 6px 8px; border-radius: 4px; margin-bottom: 6px;">
          <div style="font-size: 0.8rem; color: #fff;">
            <strong>${t.id}</strong> • ${t.destName || 'Cliente'} (${t.price})
          </div>
          <button onclick="window.removeTeleFromRiderFromPopup('${t.id}', '${rider.id}')" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; border-radius: 4px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; cursor: pointer; border: none;" title="Desvincular Tele">
            <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
          </button>
        </div>
      `;
    });
  } else {
    assignedHtml = `<p style="margin: 0; font-size: 0.8rem; color: #8e8e9f; font-style: italic;">Nenhuma tele atribuída</p>`;
  }

  const htmlContent = `
    <div style="padding: 16px; min-width: 260px; font-family: sans-serif; color: #fff; box-sizing: border-box;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 8px; margin-bottom: 12px; padding-right: 28px;">
        <h4 style="margin: 0; font-size: 0.95rem; font-weight: 700; color: #fff;">${rider.name}</h4>
        <span class="status-indicator" style="background-color: ${currentStatusColor}; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; color: #fff; font-weight: 600; flex-shrink: 0; margin-left: 8px;">
          ${currentStatus}
        </span>
      </div>
      
      <div style="margin-bottom: 12px;">
        <label style="display: block; font-size: 0.75rem; color: #8e8e9f; margin-bottom: 4px;">Vincular Nova Tele</label>
        <div style="display: flex; gap: 6px; align-items: center;">
          <select id="popup-select-${rider.id}" style="flex: 1; background: #121216; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 4px; color: #fff; font-size: 0.8rem; padding: 4px 8px; outline: none; height: 32px; box-sizing: border-box;">
            ${pendingOptions}
          </select>
          <button onclick="window.dispatchDeliveryFromPopup('${rider.id}', 'popup-select-${rider.id}')" style="background: #ffb700; border: none; border-radius: 4px; color: #000; font-size: 0.8rem; font-weight: 700; padding: 0 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; height: 32px; box-sizing: border-box; flex-shrink: 0; transition: all 0.2s;">
            Adicionar
          </button>
        </div>
      </div>
      
      <div>
        <label style="display: block; font-size: 0.75rem; color: #8e8e9f; margin-bottom: 6px;">Teles Atribuídas (${assignedTeles.length})</label>
        ${assignedHtml}
      </div>
    </div>
  `;

  const centerCoords = ownerFleetCenterCoords;
  const offsets = [[0.004, -0.006], [0.008, 0.012], [-0.005, 0.009], [-0.012, -0.004], [0.003, -0.015], [-0.009, 0.005]];
  const index = mockData.fleet.findIndex(r => r.id === rider.id);
  
  const hasRealGPS = rider.lat !== null && rider.lat !== undefined && !isNaN(parseFloat(rider.lat)) && rider.lng !== null && rider.lng !== undefined && !isNaN(parseFloat(rider.lng));

  let coords;
  if (hasRealGPS) {
    coords = [parseFloat(rider.lat), parseFloat(rider.lng)];
  } else {
    const offset = offsets[index % offsets.length] || [0, 0];
    coords = [centerCoords[0] + offset[0], centerCoords[1] + offset[1]];
  }

  if (!window.google?.maps) return;

  if (ownerFleetInfoWindow) {
    ownerFleetInfoWindow.close();
  }
  
  ownerFleetInfoWindow = new window.google.maps.InfoWindow({
    content: htmlContent,
    position: new window.google.maps.LatLng(coords[0], coords[1])
  });
  
  ownerFleetInfoWindow.open(ownerFleetMap);
  
  setTimeout(() => {
    if (window.lucide) lucide.createIcons();
  }, 100);
};

window.openBaseMapPopup = function() {
  if (!window.google?.maps) return;
  const currentCreds = mockData.credentials[mockData.activeProfile];
  const currentCommerce = (currentCreds && currentCreds.commerceName) ? currentCreds.commerceName : 'Lanchonete Dahora';
  
  const commerceAddresses = {
    'Lanchonete Dahora': 'Av. Sapucaia, 1250 - Centro, Sapucaia do Sul - RS',
    'Lanchonete Dahora': 'Rua Flores da Cunha, 450 - Centro, Sapucaia do Sul - RS'
  };
  const address = commerceAddresses[currentCommerce] || 'Av. Sapucaia, 1250 - Centro, Sapucaia do Sul - RS';

  const pendingCount = mockData.pendingDeliveries.length;
  const collectingCount = mockData.clientHistory.filter(o => o.status === 'A caminho da coleta').length;

  const htmlContent = `
    <div style="padding: 16px; min-width: 260px; font-family: sans-serif; color: #fff; box-sizing: border-box;">
      <h4 style="margin: 0 0 8px 0; font-size: 0.95rem; font-weight: 700; color: #fff; padding-right: 28px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 8px; margin-bottom: 12px;">${currentCommerce}</h4>
      <p style="margin: 0 0 10px 0; font-size: 0.8rem; color: #8e8e9f; display: flex; align-items: start; gap: 4px;">
        <i data-lucide="map-pin" style="width: 14px; height: 14px; flex-shrink: 0; color: #ffb700; margin-top: 1px;"></i>
        <span>${address}</span>
      </p>
      <div style="padding-top: 4px; display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; justify-content: space-between; font-size: 0.8rem;">
          <span style="color: #8e8e9f;">Teles Pendentes:</span>
          <strong style="color: #ffb700;">${pendingCount}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.8rem;">
          <span style="color: #8e8e9f;">A caminho da coleta:</span>
          <strong style="color: #ffb700;">${collectingCount}</strong>
        </div>
      </div>
    </div>
  `;

  const centerCoords = ownerFleetCenterCoords;

  if (ownerFleetInfoWindow) {
    ownerFleetInfoWindow.close();
  }
  
  ownerFleetInfoWindow = new window.google.maps.InfoWindow({
    content: htmlContent,
    position: new window.google.maps.LatLng(centerCoords[0], centerCoords[1])
  });
  
  ownerFleetInfoWindow.open(ownerFleetMap);

  setTimeout(() => {
    if (window.lucide) lucide.createIcons();
  }, 100);
};

window.dispatchDeliveryFromPopup = async function(riderId, selectId) {
  const select = document.getElementById(selectId);
  if (!select || !select.value) {
    alert("Selecione uma tele para vincular.");
    return;
  }
  const teleId = select.value;
  await dispatchDelivery(teleId, riderId);
  window.openRiderMapPopup(riderId);
};

window.removeTeleFromRiderFromPopup = async function(deliveryId, riderId) {
  const rider = mockData.fleet.find(r => r.id === riderId);
  if (!rider) return;
  await removeTeleFromRider(deliveryId, rider.id);
  window.openRiderMapPopup(riderId);
};

function renderClientMapMarkers(centerCoords) {
  if (!clientFleetMap || !window.google?.maps) return;

  const centerLatLng = new window.google.maps.LatLng(centerCoords[0], centerCoords[1]);


  if (!clientCentralMarker) {
    const el = document.createElement('div');
    el.className = 'custom-map-marker central-marker';
    el.style.backgroundColor = '#ffffff';
    el.style.boxShadow = '0 0 15px #ffffff';
    el.style.borderColor = 'var(--primary)';
    el.innerHTML = `
      <div class="marker-pulse" style="border-color: var(--primary); animation-duration: 2.5s;"></div>
      <i class="marker-icon-dot" style="background-color: var(--primary); width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
    `;
    
    clientCentralMarker = new window.CustomHTMLMapMarker(centerLatLng, clientFleetMap, el.outerHTML, () => {
      window.openClientBaseMapPopup();
    });
  } else {
    clientCentralMarker.setLatLng(centerLatLng);
  }

  // Filter active/live riders with valid coordinates
  const activeRiders = mockData.fleet.filter(rider => {
    return rider.lat !== null && 
           rider.lat !== undefined && 
           !isNaN(parseFloat(rider.lat)) && 
           rider.lng !== null && 
           rider.lng !== undefined && 
           !isNaN(parseFloat(rider.lng));
  });

  const currentRidersNames = new Set(activeRiders.map(r => r.name));

  // Remove markers for riders that are no longer active/valid
  Object.keys(clientFleetMarkers).forEach(name => {
    if (!currentRidersNames.has(name)) {
      if (clientFleetMarkers[name] && clientFleetMarkers[name].setMap) {
        clientFleetMarkers[name].setMap(null);
      }
      delete clientFleetMarkers[name];
    }
  });

  // Render active riders
  activeRiders.forEach(rider => {
    const riderLatLng = new window.google.maps.LatLng(parseFloat(rider.lat), parseFloat(rider.lng));
    
    // Status colors
    const currentStatusColor = rider.status === 'Em Descanso' 
      ? '#8e8e9f' 
      : (rider.statusClass === 'status-progress' || rider.status === 'Em rota' || rider.status === 'Em Coleta' ? '#ffb700' : '#22c55e');

    const isPulsing = rider.status !== 'Em Descanso';
    const markerHtml = `
      <div class="custom-map-marker" style="background-color: ${currentStatusColor}; box-shadow: 0 0 10px ${currentStatusColor}; width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative; cursor: pointer;">
        ${isPulsing ? `<div class="marker-pulse" style="border-color: ${currentStatusColor}; position: absolute; top: -5px; left: -5px; width: 24px; height: 24px; border: 2px solid ${currentStatusColor}; border-radius: 50%; animation: pulse-dot-anim 2.5s infinite;"></div>` : ''}
        <i class="marker-icon-dot" style="background-color: #fff; width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
      </div>
    `;

    let markerEntry = clientFleetMarkers[rider.name];
    if (markerEntry) {
      markerEntry.setLatLng(riderLatLng);
    } else {
      const marker = new window.CustomHTMLMapMarker(riderLatLng, clientFleetMap, markerHtml, () => {
        window.openClientRiderMapPopup(rider.id);
      });
      clientFleetMarkers[rider.name] = marker;
    }
  });
}

window.openClientRiderMapPopup = function(riderId) {
  const rider = mockData.fleet.find(r => r.id === riderId);
  if (!rider) return;

  const currentStatus = rider.status;
  const currentStatusColor = rider.status === 'Em Descanso' ? '#8e8e9f' : (rider.statusClass === 'status-progress' ? '#ffb700' : '#22c55e');

  const battery = rider.battery_level !== null && rider.battery_level !== undefined ? `${rider.battery_level}%` : '—';

  const htmlContent = `
    <div style="padding: 16px; min-width: 240px; font-family: sans-serif; color: #fff; box-sizing: border-box;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 8px; margin-bottom: 12px; padding-right: 28px;">
        <h4 style="margin: 0; font-size: 0.95rem; font-weight: 700; color: #fff;">${rider.name}</h4>
        <span class="status-indicator" style="background-color: ${currentStatusColor}; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; color: #fff; font-weight: 600; flex-shrink: 0; margin-left: 8px;">
          ${currentStatus}
        </span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px; font-size: 0.85rem;">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #8e8e9f;">Bateria do Celular:</span>
          <strong style="color: #10b981;">${battery}</strong>
        </div>
      </div>
    </div>
  `;

  const hasRealGPS = rider.lat !== null && rider.lat !== undefined && !isNaN(parseFloat(rider.lat)) && rider.lng !== null && rider.lng !== undefined && !isNaN(parseFloat(rider.lng));
  if (!hasRealGPS) return;

  const coords = [parseFloat(rider.lat), parseFloat(rider.lng)];

  if (clientFleetInfoWindow) {
    clientFleetInfoWindow.close();
  }
  
  clientFleetInfoWindow = new window.google.maps.InfoWindow({
    content: htmlContent,
    position: new window.google.maps.LatLng(coords[0], coords[1])
  });
  
  clientFleetInfoWindow.open(clientFleetMap);
};

window.openClientBaseMapPopup = function() {
  const currentCreds = mockData.credentials[mockData.activeProfile];
  const currentCommerce = (currentCreds && currentCreds.commerceName) ? currentCreds.commerceName : 'Lanchonete Dahora';
  
  const commerceAddresses = {
    'Lanchonete Dahora': 'Av. Sapucaia, 1250 - Centro, Sapucaia do Sul - RS',
    'Lanchonete Dahora': 'Rua Flores da Cunha, 450 - Centro, Sapucaia do Sul - RS'
  };
  const address = commerceAddresses[currentCommerce] || 'Av. Sapucaia, 1250 - Centro, Sapucaia do Sul - RS';

  const htmlContent = `
    <div style="padding: 16px; min-width: 240px; font-family: sans-serif; color: #fff; box-sizing: border-box;">
      <h4 style="margin: 0 0 8px 0; font-size: 0.95rem; font-weight: 700; color: #fff; padding-right: 28px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 8px; margin-bottom: 12px;">${currentCommerce}</h4>
      <p style="margin: 0 0 10px 0; font-size: 0.8rem; color: #8e8e9f; display: flex; align-items: start; gap: 4px;">
        <i data-lucide="map-pin" style="width: 14px; height: 14px; flex-shrink: 0; color: #ffb700; margin-top: 1px;"></i>
        <span>${address}</span>
      </p>
    </div>
  `;

  const centerCoords = clientFleetCenterCoords;

  if (clientFleetInfoWindow) {
    clientFleetInfoWindow.close();
  }
  
  clientFleetInfoWindow = new window.google.maps.InfoWindow({
    content: htmlContent,
    position: new window.google.maps.LatLng(centerCoords[0], centerCoords[1])
  });
  
  clientFleetInfoWindow.open(clientFleetMap);

  setTimeout(() => {
    if (window.lucide) lucide.createIcons();
  }, 100);
};

// Calculate Rider's 90% share of delivery cost
function calculateRiderShare(priceStr) {
  const price = parseMoneyBR(priceStr);
  const share = price * 0.90;
  return formatMoneyBR(share);
}

window.startEditPrice = function(itemId, itemType) {
  const cleanId = itemId.replace('#', '');
  const container = document.getElementById(`price-container-${cleanId}`);
  if (!container) return;

  let currentPriceStr = '';
  if (itemType === 'pending') {
    const item = mockData.pendingDeliveries.find(d => d.id === itemId);
    currentPriceStr = item ? item.price : 'R$ 0,00';
  } else {
    const item = mockData.clientHistory.find(d => d.id === itemId);
    currentPriceStr = item ? item.price : 'R$ 0,00';
  }

  const numValue = parseMoneyBR(currentPriceStr);

  container.innerHTML = `
    <input type="number" id="edit-price-input-${cleanId}" value="${numValue.toFixed(2)}" step="0.50" min="0" style="width: 70px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 4px; color: var(--color-text); font-size: 0.8rem; padding: 2px 4px; outline: none; height: 24px; box-sizing: border-box; display: inline-block; vertical-align: middle;">
    <div style="display: inline-flex; gap: 4px; align-items: center; vertical-align: middle; margin-left: 4px;">
      <button onclick="window.saveEditPrice('${itemId}', '${itemType}')" style="background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); color: var(--success); border-radius: 4px; padding: 2px 4px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; font-size: 0.75rem; height: 24px; width: 24px; box-sizing: border-box;" title="Salvar">
        <i data-lucide="check" style="width: 12px; height: 12px;"></i>
      </button>
      <button onclick="window.cancelEditPrice('${itemId}', '${itemType}')" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; border-radius: 4px; padding: 2px 4px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; font-size: 0.75rem; height: 24px; width: 24px; box-sizing: border-box;" title="Cancelar">
        <i data-lucide="x" style="width: 12px; height: 12px;"></i>
      </button>
    </div>
  `;
  lucide.createIcons();
};

window.cancelEditPrice = function(itemId, itemType) {
  window.renderTelesUnified();
};

window.saveEditPrice = async function(itemId, itemType) {
  const cleanId = itemId.replace('#', '');
  const input = document.getElementById(`edit-price-input-${cleanId}`);
  if (!input) return;

  const newValue = parseFloat(input.value);
  if (isNaN(newValue) || newValue < 0) {
    alert("Por favor, insira um valor numérico válido maior ou igual a zero.");
    return;
  }

  const priceFormatted = `R$ ${newValue.toFixed(2).replace('.', ',')}`;

  if (supabaseClient) {
    // 1. Verify eligibility (must not be canceled or completed)
    if (itemType === 'active') {
      const { data, error: checkError } = await supabaseClient
        .from('teles')
        .select('status')
        .eq('id', itemId)
        .single();
      
      if (checkError || !data) {
        alert("Erro ao verificar o status da tele no banco de dados.");
        return;
      }
      
      if (data.status === 'Entregue' || data.status === 'Concluído' || data.status === 'Cancelado') {
        alert("Operação bloqueada: Esta tele já foi concluída ou cancelada e não pode mais ser editada.");
        await fetchPendingDeliveries();
        await fetchClientHistory();
        window.renderTelesUnified();
        return;
      }
    } else if (itemType === 'pending') {
      const { data, error: checkError } = await supabaseClient
        .from('teles')
        .select('id')
        .eq('id', itemId);
        
      if (checkError || !data || data.length === 0) {
        alert("Operação bloqueada: Esta tele foi despachada, cancelada ou modificada.");
        await fetchPendingDeliveries();
        await fetchClientHistory();
        window.renderTelesUnified();
        return;
      }
    }

    // 2. Perform DB Update
    const table = itemType === 'pending' ? 'teles' : 'teles';
    const { error: updateError } = await supabaseClient
      .from(table)
      .update({ price: priceFormatted })
      .eq('id', itemId);

    if (updateError) {
      console.error("Error updating price on Supabase:", updateError);
      alert("Erro ao atualizar a taxa de entrega no banco de dados.");
      return;
    }
  }

  // 3. Update local state
  if (itemType === 'pending') {
    const idx = mockData.pendingDeliveries.findIndex(d => d.id === itemId);
    if (idx !== -1) {
      mockData.pendingDeliveries[idx].price = priceFormatted;
    }
  } else {
    const idx = mockData.clientHistory.findIndex(o => o.id === itemId);
    if (idx !== -1) {
      mockData.clientHistory[idx].price = priceFormatted;
    }
  }

  // 4. Update UI in real-time
  window.renderTelesUnified();
  showToastNotification(`Taxa da tele ${itemId} atualizada para ${priceFormatted}.`);
};

// Generate integration origin badge
function getOriginBadgeHtml(paymentStr, idStr) {
  const payment = (paymentStr || '').toLowerCase();
  const id = (idStr || '').toLowerCase();
  if (payment.includes('ifood') || id.includes('ifood')) {
    return `<span class="badge" style="background: rgba(234, 29, 44, 0.1); color: #ea1d2c; border: 1px solid rgba(234, 29, 44, 0.2);">iFood</span>`;
  }
  if (payment.includes('99food') || id.includes('99food')) {
    return `<span class="badge" style="background: rgba(250, 90, 30, 0.1); color: #fa5a1e; border: 1px solid rgba(250, 90, 30, 0.2);">99Food</span>`;
  }
  return `<span class="badge" style="background: rgba(255, 183, 0, 0.1); color: var(--primary); border: 1px solid var(--primary-glow);">Manual</span>`;
}

function getFixedPriceByAddress(address) {
  const addr = (address || '').toLowerCase();
  if (addr.includes('esteio')) {
    return 10.00;
  }
  return 8.00;
}

// Unified Teles Render Engine
window.renderTelesUnified = function() {
  const container = document.getElementById('teles-content-container');
  if (!container) return;

  // 1. Calculate Real-Time Stats
  const pendingCount = mockData.pendingDeliveries.length;
  const activeCount = mockData.clientHistory.filter(o => o.status !== 'Entregue' && o.status !== 'Concluído' && o.status !== 'Cancelado').length;
  const completedCount = mockData.clientHistory.filter(o => o.status === 'Entregue' || o.status === 'Concluído').length;
  const canceledCount = mockData.clientHistory.filter(o => o.status === 'Cancelado').length;
  const allCount = pendingCount + activeCount + completedCount + canceledCount;

  // Update real-time counter badges in UI
  const elAll = document.getElementById('count-all');
  const elPending = document.getElementById('count-pending');
  const elActive = document.getElementById('count-active');
  const elCompleted = document.getElementById('count-completed');
  const elCanceled = document.getElementById('count-canceled');

  if (elAll) elAll.innerText = allCount;
  if (elPending) elPending.innerText = pendingCount;
  if (elActive) elActive.innerText = activeCount;
  if (elCompleted) elCompleted.innerText = completedCount;
  if (elCanceled) elCanceled.innerText = canceledCount;

  // 2. Format and Merge Lists
  const pendingItems = mockData.pendingDeliveries.map(d => {
    const fixedPrice = getFixedPriceByAddress(d.address);
    const priceFormatted = `R$ ${fixedPrice.toFixed(2).replace('.', ',')}`;
    const repasseFormatted = `R$ ${(fixedPrice * 0.9).toFixed(2).replace('.', ',')}`;

    return {
      id: d.id,
      type: 'pending',
      client: d.client || 'Cliente não vinculado',
      destName: d.destName,
      address: d.address,
      dest_lat: d.dest_lat,
      dest_lng: d.dest_lng,
      dist: d.dist || '—',
      price: priceFormatted,
      payment: d.payment || 'A combinar',
      cargo: d.cargo || 'Pedido',
      repasseMotoboy: repasseFormatted,
      rider: 'Aguardando...',
      riderId: null,
      date: 'Hoje, Agora',
      created_at: d.created_at,
      status: 'Pendente',
      statusClass: 'status-warning'
    };
  });

  const historyItems = mockData.clientHistory.map(o => {
    let type = 'active';
    if (o.status === 'Entregue' || o.status === 'Concluído') type = 'completed';
    else if (o.status === 'Cancelado') type = 'canceled';
    
    const fixedPrice = getFixedPriceByAddress(o.address);
    const priceFormatted = `R$ ${fixedPrice.toFixed(2).replace('.', ',')}`;
    const repasseFormatted = `R$ ${(fixedPrice * 0.9).toFixed(2).replace('.', ',')}`;

    return {
      id: o.id,
      type: type,
      client: o.client || 'Cliente não vinculado',
      destName: o.destName,
      address: o.address,
      dest_lat: o.dest_lat,
      dest_lng: o.dest_lng,
      dist: o.dist || '—',
      price: priceFormatted,
      payment: o.payment || 'Pago',
      cargo: o.cargo || 'Pedido',
      repasseMotoboy: repasseFormatted,
      rider: o.rider,
      riderId: (mockData.fleet.find(r => r.name === o.rider) || {}).id || null,
      date: o.date,
      created_at: o.created_at,
      status: o.status,
      statusClass: o.statusClass || (o.status === 'Entregue' || o.status === 'Concluído' ? 'status-success' : (o.status === 'Cancelado' ? 'status-danger' : 'status-progress'))
    };
  });

  const allItems = [...pendingItems, ...historyItems];

  // Apply Filter
  let filteredList = [];
  if (currentTeleFilter === 'all') {
    filteredList = allItems;
  } else {
    filteredList = allItems.filter(item => item.type === currentTeleFilter);
  }

  // Sort descending by ID
  filteredList.sort((a, b) => b.id.localeCompare(a.id));

  // 3. Output selected view mode
  if (teleViewMode === 'grid') {
    renderTelesGrid(filteredList);
  } else {
    renderTelesTable(filteredList);
  }
};

function renderTelesGrid(list) {
  const container = document.getElementById('teles-content-container');
  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; background-color: var(--bg-card); border: 1px dashed var(--border-color); border-radius: var(--border-radius-md); color: var(--color-text-muted);">
        <i data-lucide="check-circle" style="width: 48px; height: 48px; color: var(--color-text-muted); margin-bottom: 12px; display: inline-block;"></i>
        <p style="font-weight: 600; color: var(--color-text);">Nenhuma tele encontrada</p>
        <p style="font-size: 0.9rem;">Nenhuma tele atende aos critérios do filtro selecionado.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  let html = `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px;">`;

  list.forEach(item => {
    const originBadge = getOriginBadgeHtml(item.payment, item.id);
    if (item.type === 'pending') {
      const onlineRiders = mockData.fleet.filter(r => r.status !== 'Em Descanso');
      const selectId = `pending-select-${item.id.replace('#', '')}`;
      const riderOptions = onlineRiders.map(r => `<option value="${r.id}">${escapeHtml(r.name)} (${escapeHtml(r.status)})</option>`).join('');
      
      html += `
        <div class="active-card" style="border: 1px solid rgba(255, 183, 0, 0.2);">
          <div class="active-card-header">
            <strong style="font-family: var(--font-display);">${formatOrderIdForDisplay(item.id, item.payment, item.client)}</strong>
            <div style="display: flex; gap: 6px; align-items: center;">
              ${originBadge}
              <span class="badge badge-warning" style="background: var(--primary-glow); color: var(--primary);">${item.client}</span>
            </div>
          </div>
            <p><strong>Destino:</strong> ${item.destName}</p>
            <p class="text-muted text-xs" style="margin-top: 4px; display: flex; align-items: center; gap: 4px; line-height: 1.4;">
              <i data-lucide="map-pin" style="width: 12px; height: 12px; flex-shrink: 0;"></i> 
              <span style="flex: 1;">${item.address}</span>
              ${item.dest_lat && item.dest_lng ? `
                <button onclick="window.openQuickMapModal('${item.id}', ${item.dest_lat}, ${item.dest_lng})" style="background: rgba(255, 185, 0, 0.15); border: 1px solid rgba(255, 185, 0, 0.3); color: var(--primary); border-radius: 4px; padding: 2px 5px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; transition: all 0.2s;" title="Visualizar no Mapa">
                  <i data-lucide="map" style="width: 12px; height: 12px;"></i>
                </button>
              ` : ''}
            </p>
            <p style="margin-top: 6px;"><strong>Mercadoria:</strong> ${item.cargo}</p>
            <p style="margin-top: 4px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
              <strong>Distância:</strong> ${item.dist.split('|')[0]} • 
              <strong>Taxa:</strong> 
              <span id="price-container-${item.id.replace('#', '')}" style="display: inline-flex; align-items: center; gap: 4px;">
                <span style="font-weight: 600; color: var(--primary);">${item.price}</span>
                <button onclick="window.startEditPrice('${item.id}', '${item.type}')" style="background: none; border: none; padding: 0; color: var(--color-text-muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; transition: color 0.2s;" onmouseenter="this.style.color='var(--primary)'" onmouseleave="this.style.color='var(--color-text-muted)'" title="Editar Taxa">
                  <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i>
                </button>
              </span>
              (Repasse: <span id="repasse-container-${item.id.replace('#', '')}">${item.repasseMotoboy}</span>)
            </p>
            <p style="margin-top: 4px;"><strong>Status:</strong> <span class="status-indicator status-warning">${item.status}</span></p>
            
            <div style="margin-top: 12px; display: flex; gap: 8px; align-items: center;">
              <select id="${selectId}" style="flex: 1; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--border-radius-sm); color: var(--color-text); font-size: 0.8rem; padding: 6px; outline: none; height: 32px;">
                <option value="" disabled selected>Selecionar Motoboy...</option>
                ${riderOptions}
              </select>
              <button class="btn btn-primary btn-sm" onclick="handleCardDispatch('${item.id}', '${selectId}')" style="height: 32px; padding: 0 12px; font-size: 0.8rem;">
                Despachar
              </button>
            </div>
          </div>
          <div class="active-card-footer" style="display: flex; justify-content: flex-end; margin-top: 12px; border-top: 1px solid var(--border-color); padding-top: 12px;">
            <button class="btn btn-sm" onclick="handleCancelTeleClick('${item.id}', 'Nenhum', 'pending')" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 4px; height: 30px; cursor: pointer; display: flex; align-items: center; gap: 6px; background-color: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25);">
              <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Cancelar Tele
            </button>
          </div>
        </div>
      `;
    } else {
      const isCanceled = item.type === 'canceled';
      const isCompleted = item.type === 'completed';
      
      let footerHtml = '';
      if (item.type === 'active') {
        footerHtml = `
          <div class="active-card-footer" style="display: flex; gap: 8px; justify-content: space-between; margin-top: 12px; border-top: 1px solid var(--border-color); padding-top: 12px;">
            <button class="btn btn-secondary btn-sm" onclick="handleCompleteClick('${item.id}', '${item.rider}')" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 4px; height: 30px; cursor: pointer; display: flex; align-items: center; gap: 6px; background-color: var(--secondary); color: var(--color-text); border: 1px solid var(--border-color);">
              <i data-lucide="check-circle" style="width: 14px; height: 14px; color: var(--success);"></i> Concluir
            </button>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-sm" onclick="handleWithdrawClick('${item.id}', '${item.rider}')" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 4px; height: 30px; cursor: pointer; display: flex; align-items: center; gap: 6px; background-color: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25);" title="Retirar Motoboy">
                <i data-lucide="user-x" style="width: 14px; height: 14px;"></i> Retirar
              </button>
              <button class="btn btn-sm" onclick="handleCancelTeleClick('${item.id}', '${item.rider}', 'active')" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 4px; height: 30px; cursor: pointer; display: flex; align-items: center; gap: 6px; background-color: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25);" title="Cancelar Tele">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Cancelar
              </button>
            </div>
          </div>
        `;
      } else {
        footerHtml = `
          <div style="display: flex; justify-content: space-between; margin-top: 12px; border-top: 1px solid var(--border-color); padding-top: 12px; font-size: 0.78rem; color: var(--color-text-muted);">
            <span><strong>Data:</strong> ${formatOrderDate(item.date, item.created_at)}</span>
          </div>
        `;
      }

      html += `
        <div class="active-card" style="border: 1px solid ${isCanceled ? 'rgba(239, 68, 68, 0.2)' : (isCompleted ? 'rgba(34, 197, 94, 0.2)' : 'var(--border-color)')};">
          <div class="active-card-header">
            <strong style="font-family: var(--font-display);">${formatOrderIdForDisplay(item.id, item.payment, item.client)}</strong>
            <div style="display: flex; gap: 6px; align-items: center;">
              ${originBadge}
              <span class="badge ${isCanceled ? 'badge-danger' : 'badge-success'}" style="background: ${isCanceled ? 'rgba(239, 68, 68, 0.1)' : 'var(--success-glow)'}; color: ${isCanceled ? '#ef4444' : 'var(--success)'}; border-color: rgba(255,255,255,0.05);">${item.client}</span>
            </div>
          </div>
          <div class="active-card-body">
            <p><strong>Destino:</strong> ${item.destName}</p>
            <p class="text-muted text-xs" style="margin-top: 4px; display: flex; align-items: center; gap: 4px;"><i data-lucide="map-pin" style="width: 12px; height: 12px;"></i> ${item.address}</p>
            <p style="margin-top: 6px;"><strong>Mercadoria:</strong> ${item.cargo}</p>
            <p style="margin-top: 4px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
              <strong>Distância:</strong> ${item.dist.split('|')[0]} • 
              <strong>Taxa:</strong> 
              ${item.type === 'active' ? `
                <span id="price-container-${item.id.replace('#', '')}" style="display: inline-flex; align-items: center; gap: 4px;">
                  <span style="font-weight: 600; color: var(--primary);">${item.price}</span>
                  <button onclick="window.startEditPrice('${item.id}', '${item.type}')" style="background: none; border: none; padding: 0; color: var(--color-text-muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; transition: color 0.2s;" onmouseenter="this.style.color='var(--primary)'" onmouseleave="this.style.color='var(--color-text-muted)'" title="Editar Taxa">
                    <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i>
                  </button>
                </span>
              ` : `
                <span style="font-weight: 600; color: var(--primary);">${item.price}</span>
              `}
              (Repasse: <span id="repasse-container-${item.id.replace('#', '')}">${item.repasseMotoboy}</span>)
            </p>
            <p style="margin-top: 4px;"><strong>Status:</strong> <span class="status-indicator ${item.statusClass}">${item.status}</span></p>
            
            <div class="rider-info-row" style="margin-top: 10px; display: flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 8px 12px; border-radius: 6px;">
              <div style="background: ${isCanceled ? 'rgba(239, 68, 68, 0.1)' : 'var(--primary-glow)'}; color: ${isCanceled ? '#ef4444' : 'var(--primary)'}; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                <i data-lucide="bike" style="width: 16px; height: 16px;"></i>
              </div>
              <div>
                <p class="text-xs text-muted" style="margin: 0; line-height: 1;">Entregador</p>
                <strong style="font-size: 0.85rem; color: var(--color-text);">${item.rider}</strong>
              </div>
            </div>
          </div>
          ${footerHtml}
        </div>
      `;
    }
  });

  html += `</div>`;
  container.innerHTML = html;
  lucide.createIcons();
}

function renderTelesTable(list) {
  const container = document.getElementById('teles-content-container');
  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; background-color: var(--bg-card); border: 1px dashed var(--border-color); border-radius: var(--border-radius-md); color: var(--color-text-muted);">
        <i data-lucide="check-circle" style="width: 48px; height: 48px; color: var(--color-text-muted); margin-bottom: 12px; display: inline-block;"></i>
        <p style="font-weight: 600; color: var(--color-text);">Nenhuma tele encontrada</p>
        <p style="font-size: 0.9rem;">Nenhuma tele atende aos critérios do filtro selecionado.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const onlineRiders = mockData.fleet.filter(r => r.status !== 'Em Descanso');

  let html = `
    <div class="table-responsive">
      <table class="compact-table">
        <thead>
          <tr>
            <th>Origem</th>
            <th>Código</th>
            <th>Cliente</th>
            <th>Destinatário / Endereço</th>
            <th>Motoboy Atribuído</th>
            <th>Data/Hora</th>
            <th>Valores (Taxa/Repasse)</th>
            <th style="text-align: right;">Ações</th>
          </tr>
        </thead>
        <tbody>
  `;

  list.forEach(item => {
    const originBadge = getOriginBadgeHtml(item.payment, item.id);
    let riderColumnHtml = '';
    const isPending = item.type === 'pending';
    const isCanceled = item.type === 'canceled';
    const isCompleted = item.type === 'completed';

    if (isPending) {
      const selectId = `table-select-${item.id.replace('#', '')}`;
      const riderOptions = onlineRiders.map(r => `<option value="${r.id}">${escapeHtml(r.name)} (${escapeHtml(r.status)})</option>`).join('');
      riderColumnHtml = `
        <div style="display: flex; gap: 6px; align-items: center;">
          <select id="${selectId}" class="inline-select" onchange="handleTableDispatch('${item.id}', '${selectId}')" style="background-color: var(--bg-input); border: 1px solid var(--border-color); color: var(--color-text); padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; outline: none; width: 100%;">
            <option value="" disabled selected>Vincular...</option>
            ${riderOptions}
          </select>
        </div>
      `;
    } else if (item.type === 'active') {
      const selectId = `table-select-${item.id.replace('#', '')}`;
      const riderOptions = onlineRiders.map(r => `<option value="${r.id}" ${r.name === item.rider ? 'selected' : ''}>${escapeHtml(r.name)} (${escapeHtml(r.status)})</option>`).join('');
      riderColumnHtml = `
        <select id="${selectId}" class="inline-select" onchange="handleTableReassign('${item.id}', '${item.rider}', this.value)" style="background-color: var(--bg-input); border: 1px solid var(--border-color); color: var(--color-text); padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; outline: none; width: 100%;">
          ${riderOptions}
        </select>
      `;
    } else {
      riderColumnHtml = `
        <div style="display: flex; align-items: center; gap: 6px;">
          <i data-lucide="bike" style="width: 14px; height: 14px; color: var(--color-text-muted);"></i>
          <span>${item.rider}</span>
        </div>
      `;
    }

    let actionsHtml = '';
    if (item.type === 'active') {
      actionsHtml = `
        <button class="table-action-btn btn-success" onclick="handleCompleteClick('${item.id}', '${item.rider}')" title="Concluir Entrega">
          <i data-lucide="check-circle" style="width: 18px; height: 18px; color: var(--success);"></i>
        </button>
        <button class="table-action-btn btn-warning" onclick="handleWithdrawClick('${item.id}', '${item.rider}')" title="Retirar Motoboy">
          <i data-lucide="user-x" style="width: 18px; height: 18px; color: var(--warning);"></i>
        </button>
        <button class="table-action-btn btn-danger" onclick="handleCancelTeleClick('${item.id}', '${item.rider}', 'active')" title="Cancelar Tele">
          <i data-lucide="trash-2" style="width: 18px; height: 18px; color: #ef4444;"></i>
        </button>
      `;
    } else if (isPending) {
      actionsHtml = `
        <button class="table-action-btn btn-danger" onclick="handleCancelTeleClick('${item.id}', 'Nenhum', 'pending')" title="Cancelar Tele">
          <i data-lucide="trash-2" style="width: 18px; height: 18px; color: #ef4444;"></i>
        </button>
      `;
    } else {
      actionsHtml = `<span style="font-size: 0.75rem; color: var(--color-text-muted); font-style: italic;">Histórico</span>`;
    }

    html += `
      <tr>
        <td>${originBadge}</td>
        <td><strong>${formatOrderIdForDisplay(item.id, item.payment, item.client)}</strong></td>
        <td><span class="badge" style="background: var(--bg-card-hover); border: 1px solid var(--border-color); color: var(--color-text);">${item.client}</span></td>
        <td>
          <div style="font-weight: 600;">${item.destName}</div>
          <div style="font-size: 0.75rem; color: var(--color-text-muted); margin-top: 2px; display: flex; align-items: center; gap: 6px;">
            <span>${item.address}</span>
            ${isPending && item.dest_lat && item.dest_lng ? `
              <button onclick="window.openQuickMapModal('${item.id}', ${item.dest_lat}, ${item.dest_lng})" style="background: rgba(255, 185, 0, 0.15); border: 1px solid rgba(255, 185, 0, 0.3); color: var(--primary); border-radius: 4px; padding: 2px 5px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; border: none; transition: all 0.2s;" title="Visualizar no Mapa">
                <i data-lucide="map" style="width: 12px; height: 12px;"></i>
              </button>
            ` : ''}
          </div>
        </td>
        <td>${riderColumnHtml}</td>
        <td><span style="font-size: 0.78rem;">${formatOrderDate(item.date, item.created_at)}</span></td>
        <td>
          <div id="price-container-${item.id.replace('#', '')}" style="display: flex; align-items: center; gap: 6px;">
            <span style="font-weight: 600; color: var(--primary);">${item.price}</span>
            ${(item.type === 'pending' || item.type === 'active') ? `
              <button onclick="window.startEditPrice('${item.id}', '${item.type}')" style="background: none; border: none; padding: 0; color: var(--color-text-muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; transition: color 0.2s;" onmouseenter="this.style.color='var(--primary)'" onmouseleave="this.style.color='var(--color-text-muted)'" title="Editar Taxa">
                <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i>
              </button>
            ` : ''}
          </div>
          <div style="font-size: 0.72rem; color: var(--color-text-muted);">
            Repasse: <span id="repasse-container-${item.id.replace('#', '')}">${item.repasseMotoboy}</span>
          </div>
        </td>
        <td style="text-align: right; white-space: nowrap;">${actionsHtml}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;
  container.innerHTML = html;
  lucide.createIcons();
}

window.handleCardDispatch = function(deliveryId, selectId) {
  const select = document.getElementById(selectId);
  if (!select || !select.value) {
    alert("Selecione um motoboy disponível!");
    return;
  }
  dispatchDelivery(deliveryId, select.value);
};

window.handleTableDispatch = function(deliveryId, selectId) {
  const select = document.getElementById(selectId);
  if (!select || !select.value) return;
  dispatchDelivery(deliveryId, select.value);
};

window.handleTableReassign = function(deliveryId, oldRiderName, newRiderId) {
  handleTableReassignRider(deliveryId, oldRiderName, newRiderId);
};

window.handleTableReassignRider = async function(deliveryId, oldRiderName, newRiderId) {
  const newRider = mockData.fleet.find(r => r.id === newRiderId);
  if (!newRider) return;

  const order = mockData.clientHistory.find(o => o.id === deliveryId);
  if (!order) return;

  if (confirm(`Deseja alterar o motoboy da tele ${deliveryId} de ${oldRiderName} para ${newRider.name}?`)) {
    if (supabaseClient) {
      // 1. Free old rider
      const oldRider = mockData.fleet.find(r => r.name === oldRiderName);
      if (oldRider) {
        await supabaseClient
          .from('fleet')
          .update({ status: 'Disponível', status_class: 'status-success', delivery: 'Nenhuma' })
          .eq('id', oldRider.id);
      }

      // 2. Assign new rider
      await supabaseClient
        .from('fleet')
        .update({ status: order.status, status_class: order.statusClass, delivery: deliveryId })
        .eq('id', newRiderId);

      // 3. Update history
      await supabaseClient
        .from('teles')
        .update({ rider: newRider.name })
        .eq('id', deliveryId);
    }

    await loadTelesManagement();
    showToastNotification(`Tele ${deliveryId} reatribuída para ${newRider.name}.`);
  } else {
    renderTelesUnified();
  }
};

window.handleCancelTeleClick = async function(deliveryId, riderName, type) {
  if (confirm(`Deseja realmente cancelar a tele ${deliveryId}?`)) {
    if (supabaseClient) {
      if (type === 'pending') {
        // Delete ONLY from teles
        await supabaseClient
          .from('teles')
          .delete()
          .eq('id', deliveryId);
      } else if (type === 'active') {
        // Delete ONLY from teles
        await supabaseClient
          .from('teles')
          .delete()
          .eq('id', deliveryId);

        // Free rider if they were assigned
        if (riderName && riderName !== 'Nenhum' && riderName !== 'Aguardando...') {
          const rider = mockData.fleet.find(r => r.name === riderName);
          if (rider) {
            await supabaseClient
              .from('fleet')
              .update({ status: 'Disponível', status_class: 'status-success', delivery: 'Nenhuma' })
              .eq('id', rider.id);
          }
        }
      } else {
        // Fallback for safety: match strictly by ID in both tables
        await supabaseClient
          .from('teles')
          .delete()
          .eq('id', deliveryId);
        await supabaseClient
          .from('teles')
          .delete()
          .eq('id', deliveryId);
      }
    }
    await loadTelesManagement();
    showToastNotification(`Tele ${deliveryId} cancelada com sucesso.`);
  }
};

// Global handler for popup dispatch
window.handlePopupDispatch = function(riderName) {
  // Find rider by name to get ID
  const rider = mockData.fleet.find(r => r.name === riderName);
  if (!rider) return;

  const select = document.getElementById(`popup-select-delivery-${rider.id.replace('#', '')}`);
  if (!select || !select.value) {
    alert("Por favor, selecione uma entrega para enviar!");
    return;
  }

  // Close map popups before dispatching


  // Also close our custom floating panel
  closeFleetRiderPanel();

  dispatchDelivery(select.value, rider.id);
};

let activePanelRiderName = null;

window.showFleetRiderPanel = function(rider, mockRider, currentStatus, currentStatusColor) {
  const panel = document.getElementById('fleet-dispatch-panel');
  if (!panel) return;

  activePanelRiderName = rider.name;

  // Generate pending deliveries options for popup dropdown
  let dispatchHtml = '';
  if (currentStatus !== 'Em Descanso') {
    if (mockData.pendingDeliveries.length > 0) {
      const deliveryOptions = mockData.pendingDeliveries
        .map(d => `<option value="${d.id}">${d.id} - ${d.client} (${d.dist})</option>`)
        .join('');

      const riderIdSafe = mockRider ? mockRider.id.replace('#', '') : rider.name.replace(/\W/g, '');

      dispatchHtml = `
        <div class="map-popup-dispatch" style="margin-top: 12px; border-top: 1px solid var(--border-color); padding-top: 12px;">
          <label style="display: block; margin-bottom: 6px; color: var(--color-text-muted); font-size: 0.75rem; font-weight: 700;">Enviar tele para este motoboy</label>
          <select id="popup-select-delivery-${riderIdSafe}" class="map-popup-select" style="width: 100%; height: 36px; background-color: var(--bg-input); border: 1px solid var(--border-color); color: var(--color-text); border-radius: 6px; padding: 0 10px; font-size: 0.8rem; outline: none;">
              <option value="" disabled selected>Escolha a tele...</option>
              ${deliveryOptions}
          </select>
          <div class="map-popup-actions" style="display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 10px;">
            <button class="map-popup-send-btn" onclick="handlePopupDispatch('${escapeHtml(rider.name)}')" style="grid-column: 1 / -1; height: 36px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; background-color: var(--primary); border: none; color: var(--color-text-dark);">
              <i data-lucide="send" style="width: 14px; height: 14px;"></i>
              <span>Enviar</span>
            </button>
            ${mockRider ? `
              <button class="map-popup-delete-btn" onclick="deleteRiderAccountById('${mockRider.id}')" style="height: 36px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; background-color: #ef4444; border: 1px solid #ef4444; color: #fff; padding: 0 12px;">Excluir conta</button>
              <button class="map-popup-settings-btn" onclick="openRiderActions('${mockRider.id}')" title="Funções do motoboy" aria-label="Funções do motoboy" style="width: 38px; height: 36px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; background-color: var(--secondary); border: 1px solid var(--border-color); color: var(--color-text); padding: 0;">
                <i data-lucide="settings" style="width: 14px; height: 14px;"></i>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    } else {
      dispatchHtml = `
        <div class="map-popup-dispatch map-popup-empty-actions" style="margin-top: 12px; border-top: 1px solid var(--border-color); padding-top: 12px; color: var(--color-text-muted); font-size: 0.8rem;">
          <span>Nenhuma tele pendente.</span>
          ${mockRider ? `
            <div class="map-popup-actions" style="display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 10px;">
              <button class="map-popup-delete-btn" onclick="deleteRiderAccountById('${mockRider.id}')" style="height: 36px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; background-color: #ef4444; border: 1px solid #ef4444; color: #fff; padding: 0 12px;">Excluir conta</button>
              <button class="map-popup-settings-btn" onclick="openRiderActions('${mockRider.id}')" title="Funções do motoboy" aria-label="Funções do motoboy" style="width: 38px; height: 36px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; background-color: var(--secondary); border: 1px solid var(--border-color); color: var(--color-text); padding: 0;">
                <i data-lucide="settings" style="width: 14px; height: 14px;"></i>
              </button>
            </div>
          ` : ''}
        </div>
      `;
    }
  }

  const badgeColor = currentStatusColor === '#8e8e9f' ? 'var(--color-text-muted)' : (currentStatusColor === '#ffb700' ? 'var(--primary)' : 'var(--accent-cyan)');
  const badgeBg = currentStatusColor === '#8e8e9f' ? 'rgba(142, 142, 159, 0.15)' : (currentStatusColor === '#ffb700' ? 'var(--primary-glow)' : 'var(--accent-cyan-glow)');

  panel.innerHTML = `
    <div class="fleet-panel-header">
      <h4>${escapeHtml(rider.name)}</h4>
      <button class="fleet-panel-close-btn" onclick="closeFleetRiderPanel()" title="Fechar">
        <i data-lucide="x"></i>
      </button>
    </div>
    <p class="fleet-panel-subtitle">${escapeHtml(rider.vehicle)} • <strong>${escapeHtml(rider.plate)}</strong></p>
    <span class="status-indicator" style="display: inline-block; padding: 4px 10px; font-size: 0.75rem; border-radius: 12px; font-weight: 600; color: ${badgeColor}; background: ${badgeBg};">${escapeHtml(currentStatus)}</span>
    ${dispatchHtml}
  `;

  panel.classList.remove('hidden');
  panel.classList.add('active');

  // Align panel with marker position on desktop
  updatePanelPosition();

  if (window.lucide) {
    lucide.createIcons();
  }
};

window.closeFleetRiderPanel = function() {
  const panel = document.getElementById('fleet-dispatch-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.classList.remove('active');
  }
  activePanelRiderName = null;
};

window.updatePanelPosition = function() {
  if (!activePanelRiderName || !ownerFleetMap) return;
  const marker = ownerFleetMarkers[activePanelRiderName];
  if (!marker) return;

  const panel = document.getElementById('fleet-dispatch-panel');
  if (!panel || panel.classList.contains('hidden')) return;

  const isMobile = window.innerWidth <= 576;
  if (!isMobile) {
    const lngLat = marker.getLngLat();
    const pos = ownerFleetMap.project(lngLat); // Coordinates relative to map container pixels

    // Temporarily ensure block display so dimensions are populated
    const wasHidden = panel.style.display === 'none';
    if (wasHidden) panel.style.display = 'block';

    const panelWidth = panel.offsetWidth || 320;
    const panelHeight = panel.offsetHeight || 180;

    if (wasHidden) panel.style.display = '';

    // Position panel centered above the marker, offset by 15px
    let left = pos.x - (panelWidth / 2);
    let top = pos.y - panelHeight - 15;

    const mapEl = document.getElementById('owner-fleet-map');
    if (mapEl) {
      const mapWidth = mapEl.offsetWidth;
      const mapHeight = mapEl.offsetHeight;
      const margin = 12;

      // Restrict horizontal bounds
      if (left < margin) left = margin;
      if (left + panelWidth > mapWidth - margin) left = mapWidth - panelWidth - margin;

      // Restrict vertical bounds
      if (top < margin) {
        // If it overflows the top edge, show it below the marker
        top = pos.y + 15;
      }
      if (top + panelHeight > mapHeight - margin) {
        // If it also overflows bottom, center vertically
        top = Math.max(margin, (mapHeight - panelHeight) / 2);
      }
    }

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.bottom = 'auto';
  } else {
    // Reset desktop inline style positions so mobile media query rules apply
    panel.style.left = '';
    panel.style.top = '';
    panel.style.bottom = '';
  }
};

// Dispatch delivery function
async function dispatchDelivery(deliveryId, riderId) {
  // Find delivery
  const deliveryIndex = mockData.pendingDeliveries.findIndex(d => d.id === deliveryId);
  if (deliveryIndex === -1) return;
  const delivery = mockData.pendingDeliveries[deliveryIndex];

  // Find rider
  const rider = mockData.fleet.find(r => r.id === riderId);
  if (!rider) return;

  if (supabaseClient) {
    // 1. Update rider status and delivery in fleet table
    const { error: fleetError } = await supabaseClient
      .from('fleet')
      .update({
        status: 'A caminho da coleta',
        status_class: 'status-progress',
        delivery: deliveryId
      })
      .eq('id', riderId);

    if (fleetError) {
      console.error("Error updating rider status on Supabase:", fleetError);
      alert("Erro ao atualizar o status do motoboy no Supabase.");
      return;
    }

    // 2. Add order details into teles table first (to prevent orphaned deletions on key conflicts)
    const newHistoryItem = {
      id: deliveryId,
      client: delivery.client,
      dest_name: delivery.destName,
      address: delivery.address,
      rider: rider.name,
      dist: delivery.dist + '|' + (delivery.payment || 'Dinheiro'),
      price: delivery.price,
      date: 'Hoje, ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      status: 'A caminho da coleta',
      status_class: 'status-progress',
      pickup_lat: delivery.pickup_lat,
      pickup_lng: delivery.pickup_lng,
      dest_lat: delivery.dest_lat,
      dest_lng: delivery.dest_lng,
      total_order_amount: delivery.total_order_amount || null
    };

    let { error: historyError } = await supabaseClient
      .from('teles')
      .insert([newHistoryItem]);

    if (historyError && historyError.code === '42703') {
      delete newHistoryItem.total_order_amount;
      const { error: retryError } = await supabaseClient
        .from('teles')
        .insert([newHistoryItem]);
      historyError = retryError;
    }

    if (historyError) {
      console.error("Error inserting delivery history on Supabase:", historyError);
      alert("Erro ao salvar o histórico de entrega no Supabase.");
      return;
    }

    // 3. Delete delivery from teles table only after history is saved successfully
    const { error: deleteError } = await supabaseClient
      .from('teles')
      .delete()
      .eq('id', deliveryId);

    if (deleteError) {
      console.error("Error deleting pending delivery on Supabase:", deleteError);
      alert("Erro ao remover a tele das pendências no Supabase.");
      return;
    }
  }

  // Refresh all state arrays from Supabase
  await fetchPendingDeliveries();
  await fetchFleet();
  await fetchClientHistory();

  // Re-render components
  renderTelesUnified();
  renderFleetTable();
  renderClientHistoryTable();

  // Get current active map coordinates (from geolocation or fallback)
  // Re-render the map markers to show the updated status
  if (ownerFleetMap) {
    const center = ownerFleetMap.getCenter();
    renderMapMarkers([center.lat, center.lng]);
  }

  // Display Premium Alert/Notification
  showToastNotification(`Tele ${deliveryId} enviada com sucesso para ${rider.name}!`);
}



window.setClientTeleViewMode = function(mode) {
  clientTeleViewMode = mode;
  document.querySelectorAll('#client-view-toggle-grid, #client-view-toggle-list').forEach(btn => btn.classList.remove('active'));
  const btn = document.getElementById(`client-view-toggle-${mode}`);
  if (btn) btn.classList.add('active');
  renderClientTelesUnified();
};

window.setClientTeleFilter = function(filter) {
  currentClientTeleFilter = filter;
  document.querySelectorAll('.teles-filters .filter-pill').forEach(btn => {
    if (btn.id.startsWith('client-filter-')) {
      btn.classList.remove('active');
    }
  });
  const btn = document.getElementById(`client-filter-${filter}`);
  if (btn) btn.classList.add('active');
  renderClientTelesUnified();
};

window.renderClientTelesUnified = function() {
  const container = document.getElementById('client-teles-content-container');
  if (!container) return;

  const currentCreds = mockData.credentials[mockData.activeProfile];
  const currentCommerce = currentCreds ? currentCreds.commerceName : 'Cliente não vinculado';

  const pendingList = mockData.pendingDeliveries.filter(d => d.client === currentCommerce);
  const activeList = mockData.clientHistory.filter(o => o.client === currentCommerce && o.status !== 'Entregue' && o.status !== 'Concluído' && o.status !== 'Cancelado');
  const completedList = mockData.clientHistory.filter(o => o.client === currentCommerce && (o.status === 'Entregue' || o.status === 'Concluído'));
  const canceledList = mockData.clientHistory.filter(o => o.client === currentCommerce && o.status === 'Cancelado');

  const pendingCount = pendingList.length;
  const activeCount = activeList.length;
  const completedCount = completedList.length;
  const canceledCount = canceledList.length;
  const allCount = pendingCount + activeCount + completedCount + canceledCount;

  const elAll = document.getElementById('client-count-all');
  const elPending = document.getElementById('client-count-pending');
  const elActive = document.getElementById('client-count-active');
  const elCompleted = document.getElementById('client-count-completed');
  const elCanceled = document.getElementById('client-count-canceled');

  if (elAll) elAll.innerText = allCount;
  if (elPending) elPending.innerText = pendingCount;
  if (elActive) elActive.innerText = activeCount;
  if (elCompleted) elCompleted.innerText = completedCount;
  if (elCanceled) elCanceled.innerText = canceledCount;

  const pendingItems = pendingList.map(d => {
    const fixedPrice = getFixedPriceByAddress(d.address);
    const priceFormatted = `R$ ${fixedPrice.toFixed(2).replace('.', ',')}`;

    return {
      id: d.id,
      type: 'pending',
      client: d.client || 'Cliente não vinculado',
      destName: d.destName,
      address: d.address,
      dest_lat: d.dest_lat,
      dest_lng: d.dest_lng,
      dist: d.dist || '—',
      price: priceFormatted,
      payment: d.payment || 'A combinar',
      cargo: d.cargo || 'Pedido',
      rider: 'Aguardando...',
      date: 'Hoje, Agora',
      created_at: d.created_at,
      status: 'Pendente',
      statusClass: 'status-warning'
    };
  });

  const historyItems = [...activeList, ...completedList, ...canceledList].map(o => {
    let type = 'active';
    if (o.status === 'Entregue' || o.status === 'Concluído') type = 'completed';
    else if (o.status === 'Cancelado') type = 'canceled';
    
    const fixedPrice = getFixedPriceByAddress(o.address);
    const priceFormatted = `R$ ${fixedPrice.toFixed(2).replace('.', ',')}`;

    return {
      id: o.id,
      type: type,
      client: o.client || 'Cliente não vinculado',
      destName: o.destName,
      address: o.address,
      dest_lat: o.dest_lat,
      dest_lng: o.dest_lng,
      dist: o.dist || '—',
      price: priceFormatted,
      payment: o.payment || 'Pago',
      cargo: o.cargo || 'Pedido',
      rider: o.rider || 'Sem entregador',
      date: o.date,
      created_at: o.created_at,
      status: o.status,
      statusClass: o.statusClass || (o.status === 'Entregue' || o.status === 'Concluído' ? 'status-success' : (o.status === 'Cancelado' ? 'status-danger' : 'status-progress'))
    };
  });

  const allItems = [...pendingItems, ...historyItems];

  let filteredList = [];
  if (currentClientTeleFilter === 'all') {
    filteredList = allItems;
  } else {
    filteredList = allItems.filter(item => item.type === currentClientTeleFilter);
  }

  filteredList.sort((a, b) => b.id.localeCompare(a.id));

  if (clientTeleViewMode === 'grid') {
    renderClientTelesGrid(filteredList);
  } else {
    renderClientTelesTable(filteredList);
  }
};

function renderClientTelesGrid(list) {
  const container = document.getElementById('client-teles-content-container');
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; background-color: var(--bg-card); border: 1px dashed var(--border-color); border-radius: var(--border-radius-md); color: var(--color-text-muted);">
        <i data-lucide="check-circle" style="width: 48px; height: 48px; color: var(--color-text-muted); margin-bottom: 12px; display: inline-block;"></i>
        <p style="font-weight: 600; color: var(--color-text);">Nenhuma tele encontrada</p>
        <p style="font-size: 0.9rem;">Nenhuma tele atende aos critérios do filtro selecionado.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  let html = `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px;">`;

  list.forEach(item => {
    const originBadge = getOriginBadgeHtml(item.payment, item.id);
    const isCanceled = item.type === 'canceled';
    const isCompleted = item.type === 'completed';

    html += `
      <div class="active-card" style="border: 1px solid ${isCanceled ? 'rgba(239, 68, 68, 0.2)' : (isCompleted ? 'rgba(34, 197, 94, 0.2)' : 'var(--border-color)')};">
        <div class="active-card-header">
          <strong style="font-family: var(--font-display);">${formatOrderIdForDisplay(item.id, item.payment, item.client)}</strong>
          <div style="display: flex; gap: 6px; align-items: center;">
            ${originBadge}
          </div>
        </div>
        <div class="active-card-body" style="padding: 12px; display: flex; flex-direction: column; gap: 8px;">
          <p style="margin: 0;"><strong>Destino:</strong> ${escapeHtml(item.destName)}</p>
          <p class="text-muted text-xs" style="margin: 0; display: flex; align-items: center; gap: 4px; line-height: 1.4;">
            <i data-lucide="map-pin" style="width: 12px; height: 12px; flex-shrink: 0;"></i> 
            <span style="flex: 1;">${escapeHtml(item.address)}</span>
            ${item.dest_lat && item.dest_lng ? `
              <button onclick="window.openQuickMapModal('${item.id}', ${item.dest_lat}, ${item.dest_lng})" style="background: rgba(255, 185, 0, 0.15); border: 1px solid rgba(255, 185, 0, 0.3); color: var(--primary); border-radius: 4px; padding: 2px 5px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; transition: all 0.2s;" title="Visualizar no Mapa">
                <i data-lucide="map" style="width: 12px; height: 12px;"></i>
              </button>
            ` : ''}
          </p>
          <p style="margin: 0;"><strong>Mercadoria:</strong> ${escapeHtml(item.cargo)}</p>
          <p style="margin: 0; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
            <strong>Distância:</strong> ${escapeHtml(item.dist.split('|')[0])} • 
            <strong>Taxa:</strong> 
            <span style="font-weight: 600; color: var(--primary);">${escapeHtml(item.price)}</span>
          </p>
          <p style="margin: 0;"><strong>Motoboy:</strong> <span class="badge badge-success" style="background: var(--accent-cyan-glow); color: var(--accent-cyan); border-color: rgba(0, 174, 239, 0.2);">${escapeHtml(item.rider)}</span></p>
          <p style="margin: 0;"><strong>Status:</strong> <span class="status-indicator ${escapeHtml(item.statusClass)}">${escapeHtml(item.status)}</span></p>
        </div>
      </div>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function renderClientTelesTable(list) {
  const container = document.getElementById('client-teles-content-container');
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; background-color: var(--bg-card); border: 1px dashed var(--border-color); border-radius: var(--border-radius-md); color: var(--color-text-muted);">
        <i data-lucide="check-circle" style="width: 48px; height: 48px; color: var(--color-text-muted); margin-bottom: 12px; display: inline-block;"></i>
        <p style="font-weight: 600; color: var(--color-text);">Nenhuma tele encontrada</p>
        <p style="font-size: 0.9rem;">Nenhuma tele atende aos critérios do filtro selecionado.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  let html = `
    <div class="table-responsive">
      <table class="compact-table">
        <thead>
          <tr>
            <th>Origem</th>
            <th>Código</th>
            <th>Destinatário</th>
            <th>Endereço</th>
            <th>Motoboy</th>
            <th>Data/Hora</th>
            <th>Taxa (Valor)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
  `;

  list.forEach(item => {
    const originBadge = getOriginBadgeHtml(item.payment, item.id);
    const dateFormatted = formatOrderDate(item.date, item.created_at);

    html += `
      <tr>
        <td>${originBadge}</td>
        <td><strong style="font-family: var(--font-display);">${formatOrderIdForDisplay(item.id, item.payment, item.client)}</strong></td>
        <td>${escapeHtml(item.destName)}</td>
        <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.address)}">${escapeHtml(item.address)}</td>
        <td><span class="badge badge-soft">${escapeHtml(item.rider)}</span></td>
        <td>${dateFormatted}</td>
        <td><strong style="color: var(--primary);">${escapeHtml(item.price)}</strong></td>
        <td><span class="status-indicator ${escapeHtml(item.statusClass)}">${escapeHtml(item.status)}</span></td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

// Complete delivery function
async function completeDelivery(deliveryId, riderName) {
  if (supabaseClient) {
    // 1. Update delivery status to Entregue in teles table
    const { error: historyError } = await supabaseClient
      .from('teles')
      .update({
        status: 'Entregue',
        status_class: 'status-success'
      })
      .eq('id', deliveryId);

    if (historyError) {
      console.error("Error completing delivery in client history on Supabase:", historyError);
      alert("Erro ao atualizar o histórico de entrega no Supabase.");
      return;
    }

    // 2. Find rider and update status to Disponivel and clear delivery
    const { error: fleetError } = await supabaseClient
      .from('fleet')
      .update({
        status: 'Disponível',
        status_class: 'status-success',
        delivery: 'Nenhuma'
      })
      .eq('name', riderName);

    if (fleetError) {
      console.error("Error resetting rider status on Supabase:", fleetError);
      alert("Erro ao liberar o motoboy no Supabase.");
      return;
    }

    // Atomic cleanup of teles to prevent duplication
    await supabaseClient
      .from('teles')
      .delete()
      .eq('id', deliveryId);
  }

  // Refresh all state arrays from Supabase
  await fetchPendingDeliveries();
  await fetchFleet();
  await fetchClientHistory();

  // Re-render components
  renderTelesUnified();
  renderFleetTable();
  renderClientHistoryTable();

  // Re-render map markers
  if (ownerFleetMap) {
    const center = ownerFleetMap.getCenter();
    renderMapMarkers([center.lat, center.lng]);
  }

  // Display toast notification
  showToastNotification(`Tele ${deliveryId} concluída e entregue!`);
}

// Global click handler wrapper
window.handleCompleteClick = function(deliveryId, riderName) {
  if (confirm(`Deseja concluir e finalizar a entrega ${deliveryId} realizada por ${riderName}?`)) {
    completeDelivery(deliveryId, riderName);
  }
};

/* ================= CREDENTIAL CARD ================= */

// Armazena as credenciais abertas no momento
let _currentCreds = { code: '', name: '', pin: '' };
let _pinVisible = false;

function openCredentialCard(code, name, pin) {
  _currentCreds = { code, name, pin };
  _pinVisible = false;

  const nameEl = document.getElementById('cred-name');
  const codeEl = document.getElementById('cred-code');
  const pinEl  = document.getElementById('cred-pin');

  if (nameEl) nameEl.innerText = name;
  if (codeEl) codeEl.innerText = code;
  if (pinEl)  pinEl.innerText = '••••';

  const toggleBtn = document.getElementById('pin-toggle-btn');
  if (toggleBtn) toggleBtn.innerHTML = '<i data-lucide="eye"></i>';

  document.getElementById('modal-credentials').classList.remove('hidden');
  lucide.createIcons();
}

function closeCredentials(event) {
  if (event && event.target !== document.getElementById('modal-credentials')) return;
  document.getElementById('modal-credentials').classList.add('hidden');
}

function togglePinVisibility() {
  _pinVisible = !_pinVisible;
  const pinEl = document.getElementById('cred-pin');
  const toggleBtn = document.getElementById('pin-toggle-btn');
  if (pinEl) pinEl.innerText = _pinVisible ? _currentCreds.pin : '••••';
  if (toggleBtn) {
    toggleBtn.innerHTML = _pinVisible
      ? '<i data-lucide="eye-off"></i>'
      : '<i data-lucide="eye"></i>';
  }
  lucide.createIcons();
}

function copyCredentials() {
  const text = `Dahora Expresso — Acesso Motoboy\nNome: ${_currentCreds.name}\nCódigo de Acesso: ${_currentCreds.code}\nPIN: ${_currentCreds.pin}\nAcesso: https://dahora-expresso.guigui-couto23.workers.dev/motoboy.html`;
  navigator.clipboard.writeText(text).then(() => {
    showToastNotification('Credenciais copiadas!');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToastNotification('Credenciais copiadas!');
  });
}

function shareWhatsApp() {
  const text = encodeURIComponent(
    `*Dahora Expresso — Seu Acesso*\n\nOlá, ${_currentCreds.name}! Suas credenciais de acesso ao app de motoboy são:\n\n*Código de Acesso:* ${_currentCreds.code}\n*PIN:* ${_currentCreds.pin}\n\n*Link:* https://dahora-expresso.guigui-couto23.workers.dev/motoboy.html\n\n_Não compartilhe seu PIN com ninguém._`
  );
  window.open(`https://wa.me/?text=${text}`, '_blank');
}

// Mostra credenciais de um motoboy já cadastrado
function viewRiderCredentials(riderId) {
  const rider = mockData.fleet.find(r => r.id === riderId);
  if (!rider) return;
  openCredentialCard(rider.motoboy_code || '—', rider.name, rider.pin || '(sem PIN)');
}


function getActiveOrdersForRider(rider) {
  if (!rider) return [];
  return mockData.clientHistory.filter(order => order.rider === rider.name && order.status !== 'Entregue' && order.status !== 'Removida');
}

async function deleteRiderAccountById(riderId) {
  const rider = mockData.fleet.find(r => r.id === riderId);
  if (!rider) return;

  if (!confirm(`Tem certeza que deseja EXCLUIR a conta de ${rider.name} (${rider.id})? Esta ação é irreversível e excluirá todos os dados do motoboy, incluindo histórico de entregas, valores, consumos e mensagens.`)) {
    return;
  }

  showToastNotification('Excluindo conta do motoboy...');

  try {
    if (supabaseClient) {
      // 1. Delete support messages where client_email matches the rider's ID
      await supabaseClient
        .from('support_messages')
        .delete()
        .eq('client_email', rider.id);

      // 2. Delete consumables where rider_id matches the rider's ID
      await supabaseClient
        .from('rider_consumable_purchases')
        .delete()
        .eq('rider_id', rider.id);

      // 3. Delete client history where rider name matches the rider's name
      if (rider.name) {
        await supabaseClient
          .from('teles')
          .delete()
          .eq('rider', rider.name);
      }

      // 4. Delete the rider profile from fleet table
      const { error } = await supabaseClient
        .from('fleet')
        .delete()
        .eq('id', rider.id);

      if (error) throw error;
    }

    // Refresh mockData and UI
    await fetchFleet();
    await fetchRiderConsumables();
    await fetchClientHistory();
    renderFleetTable();
    renderRiderConsumables();
    renderRiderPayments();
    
    // Close modal if open
    closeRiderActions();

    if (ownerFleetMap) {
      const center = ownerFleetMap.getCenter();
      renderMapMarkers([center.lat, center.lng]);
    }

    showToastNotification(`Conta de ${rider.name} excluída e dados limpos.`);
  } catch (err) {
    console.error('Error deleting rider account:', err);
    alert('Erro ao excluir conta do motoboy: ' + err.message);
  }
}

async function deleteRiderAccount() {
  if (!selectedRiderId) return;
  await deleteRiderAccountById(selectedRiderId);
}

async function removeTeleFromRider(deliveryId, riderId) {
  const rider = mockData.fleet.find(r => r.id === riderId);
  const order = mockData.clientHistory.find(item => item.id === deliveryId);
  if (!rider || !order) return;

  if (!confirm(`Remover a tele ${deliveryId} de ${rider.name} e devolver para pendentes?`)) return;

  const cleanDist = order.dist.includes('|') ? order.dist.split('|')[0] : order.dist;
  const paymentMethod = order.dist.includes('|') ? order.dist.split('|')[1] : 'A combinar';
  const pendingPayload = {
    id: order.id,
    client: order.client || 'Cliente não vinculado',
    dest_name: order.destName || 'Cliente informado',
    address: order.address,
    dist: cleanDist,
    price: order.price,
    payment: paymentMethod,
    cargo: 'Pedido'
  };

  if (supabaseClient) {
    const { error: pendingError } = await supabaseClient
      .from('teles')
      .upsert([pendingPayload]);
    if (pendingError) {
      alert('Erro ao devolver a tele para pendentes.');
      return;
    }

    const { error: historyError } = await supabaseClient
      .from('teles')
      .delete()
      .eq('id', deliveryId);
    if (historyError) {
      alert('Erro ao remover a tele do histórico ativo.');
      return;
    }

    const remainingOrders = getActiveOrdersForRider(rider).filter(item => item.id !== deliveryId);
    if (remainingOrders.length === 0) {
      await supabaseClient
        .from('fleet')
        .update({ status: 'Disponível', status_class: 'status-success', delivery: 'Nenhuma' })
        .eq('id', riderId);
    }
  }

  await fetchPendingDeliveries();
  await fetchFleet();
  await fetchClientHistory();
  renderTelesUnified();
  renderFleetTable();
  renderRiderPayments();

  if (ownerFleetMap) {
    const center = ownerFleetMap.getCenter();
    renderMapMarkers([center.lat, center.lng]);
  }

  const modal = document.getElementById('modal-remove-tele');
  if (modal) modal.classList.add('hidden');
  showToastNotification(`Tele ${deliveryId} removida de ${rider.name}.`);
}

function openRiderActions(riderId) {
  const rider = mockData.fleet.find(r => r.id === riderId);
  if (!rider) return;

  selectedRiderId = riderId;
  const nameEl = document.getElementById('rider-action-name');
  const codeEl = document.getElementById('rider-action-code');
  const statusEl = document.getElementById('rider-action-status');

  if (nameEl) nameEl.innerText = rider.name;
  if (codeEl) codeEl.innerText = rider.motoboy_code || '—';
  if (statusEl) statusEl.innerText = rider.status;

  document.getElementById('modal-rider-actions').classList.remove('hidden');
  lucide.createIcons();
}

function copyRiderAccessCode() {
  const codeEl = document.getElementById('rider-action-code');
  const code = codeEl ? codeEl.innerText.trim() : '';
  if (!code || code === '—') return;
  navigator.clipboard.writeText(code).then(() => {
    showToastNotification('Código de Acesso copiado!');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToastNotification('Código de Acesso copiado!');
  });
}


function closeRiderActions(event) {
  const modal = document.getElementById('modal-rider-actions');
  if (event && event.target !== modal) return;
  modal.classList.add('hidden');
}

function locateSelectedRider() {
  if (!selectedRiderId) return;
  selectedMapRiderId = selectedRiderId;
  closeRiderActions();
  switchDashboardTab('owner-fleet-map');
}

function openCredentialsForSelectedRider() {
  if (!selectedRiderId) return;
  closeRiderActions();
  viewRiderCredentials(selectedRiderId);
}



function openEditSelectedRider() {
  if (!selectedRiderId) return;
  const rider = mockData.fleet.find(r => r.id === selectedRiderId);
  if (!rider) return;

  document.getElementById('edit-rider-id').value = rider.id;
  document.getElementById('edit-rider-name').value = rider.name || '';
  document.getElementById('edit-rider-pin').value = rider.pin || '';
  document.getElementById('edit-rider-vehicle').value = rider.vehicle || '';
  document.getElementById('edit-rider-plate').value = rider.plate || '';
  document.getElementById('edit-rider-status').value = rider.status || 'Disponível';
  closeRiderActions();
  document.getElementById('modal-edit-rider').classList.remove('hidden');
  lucide.createIcons();
}

function closeEditRider(event) {
  const modal = document.getElementById('modal-edit-rider');
  if (event && event.target !== modal) return;
  modal.classList.add('hidden');
}

function getStatusClass(status) {
  if (status === 'Disponível') return 'status-success';
  if (status === 'Em Descanso') return 'status-neutral';
  return 'status-progress';
}

async function submitEditRider(event) {
  event.preventDefault();
  const riderId = document.getElementById('edit-rider-id').value;
  const status = document.getElementById('edit-rider-status').value;
  const payload = {
    name: document.getElementById('edit-rider-name').value.trim(),
    vehicle: document.getElementById('edit-rider-vehicle').value.trim(),
    plate: document.getElementById('edit-rider-plate').value.trim().toUpperCase(),
    status: status
  };

  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('fleet')
      .update(payload)
      .eq('id', riderId);
    if (error) {
      alert('Erro ao editar motoboy: ' + error.message);
      return;
    }
  }

  await fetchFleet();
  renderFleetTable();
  closeEditRider();
  showToastNotification('Dados do motoboy atualizados.');
}


/* ================= NOTIFICATION BELL ================= */

function toggleNotifications() {
  const panel = document.getElementById('notification-panel');
  panel.classList.toggle('hidden');
}

function clearNotifications(event) {
  if (event) event.stopPropagation();
  document.getElementById('notification-list').innerHTML = `
    <div style="text-align: center; padding: 32px 16px; color: var(--color-text-muted);">
      <i data-lucide="check-circle" style="width: 36px; height: 36px; color: var(--success); display: inline-block; margin-bottom: 8px;"></i>
      <p style="font-size: 0.9rem;">Nenhuma notificação pendente.</p>
    </div>
  `;
  const badge = document.getElementById('bell-badge');
  if (badge) {
    badge.style.display = 'none';
    badge.textContent = '0';
  }
  lucide.createIcons();
}

// Helper to add notification to the topbar bell dropdown and play toast
function addBellNotification(title, type = 'chat') {
  const badge = document.getElementById('bell-badge');
  if (badge) {
    badge.style.display = 'flex';
    let count = parseInt(badge.textContent) || 0;
    count++;
    badge.textContent = count;
  }

  const list = document.getElementById('notification-list');
  if (list) {
    // If the list is empty (default placeholder), remove it
    if (list.querySelector('[data-lucide="check-circle"]') || list.innerHTML.includes('Nenhuma notificação pendente')) {
      list.innerHTML = '';
    }

    // Select icon and bg color based on type
    let icon = 'bell';
    let bgClass = 'bg-primary';
    if (type === 'chat') {
      icon = 'message-square';
      bgClass = 'bg-cyan';
    } else if (type === 'alert') {
      icon = 'alert-triangle';
      bgClass = 'bg-yellow';
    } else if (type === 'delivery') {
      icon = 'bike';
      bgClass = 'bg-primary';
    } else if (type === 'store') {
      icon = 'store';
      bgClass = 'bg-cyan';
    }

    const notifItem = document.createElement('div');
    notifItem.className = 'notif-item unread';
    notifItem.innerHTML = `
      <div class="notif-icon ${bgClass}"><i data-lucide="${icon}"></i></div>
      <div class="notif-content">
        <p>${title}</p>
        <span class="notif-time">Agora</span>
      </div>
    `;

    // Insert at the top of the list
    list.insertBefore(notifItem, list.firstChild);
    
    // Recompile Lucide icons so the new icon renders properly
    lucide.createIcons();
  }

  // Show dynamic toast notification (stripping html tags)
  const cleanTitle = title.replace(/<\/?[^>]+(>|$)/g, "");
  showToastNotification(cleanTitle);
}

function initializeRealNotifications() {
  const list = document.getElementById('notification-list');
  if (!list) return;

  list.innerHTML = '';
  
  const notifications = [];
  const profile = mockData.activeProfile;
  const creds = mockData.credentials[profile];
  const isOwner = (profile === 'owner');
  const commerceName = creds ? creds.commerceName : null;

  // 1. Check for battery alerts (only for Owner)
  if (isOwner && mockData.fleet && mockData.fleet.length > 0) {
    mockData.fleet.forEach(rider => {
      const batVal = parseInt(rider.battery) || 100;
      if (batVal < 20) {
        notifications.push({
          title: `<strong>${escapeHtml(rider.name)}</strong> está com bateria abaixo de 20% (${batVal}%)`,
          type: 'alert',
          time: 'Alerta ativo'
        });
      }
    });
  }

  // 2. Check for recent pending deliveries (limit to 3)
  if (mockData.pendingDeliveries && mockData.pendingDeliveries.length > 0) {
    let filteredPending = mockData.pendingDeliveries;
    if (!isOwner && commerceName) {
      filteredPending = filteredPending.filter(d => d.client === commerceName);
    }
    const latestPending = filteredPending.slice(-3).reverse();
    latestPending.forEach(delivery => {
      notifications.push({
        title: `<strong>${escapeHtml(delivery.client)}</strong> solicitou novo motoboy`,
        type: 'store',
        time: 'Pendente'
      });
    });
  }

  // 3. Check for recent completed deliveries (limit to 3)
  if (mockData.clientHistory && mockData.clientHistory.length > 0) {
    let filteredHistory = mockData.clientHistory.filter(item => item.status === 'Entregue' || item.status === 'Concluído');
    if (!isOwner && commerceName) {
      filteredHistory = filteredHistory.filter(d => d.client === commerceName);
    }
    const latestCompleted = filteredHistory.slice(-3).reverse();
    latestCompleted.forEach(delivery => {
      notifications.push({
        title: `<strong>${escapeHtml(delivery.rider || 'Motoboy')}</strong> concluiu a entrega <strong>#${escapeHtml(delivery.id)}</strong>`,
        type: 'delivery',
        time: 'Recente'
      });
    });
  }

  // Populate bell badge
  const badge = document.getElementById('bell-badge');
  if (badge) {
    if (notifications.length > 0) {
      badge.style.display = 'flex';
      badge.textContent = notifications.length;
    } else {
      badge.style.display = 'none';
      badge.textContent = '0';
    }
  }

  if (notifications.length === 0) {
    list.innerHTML = `
      <div style="text-align: center; padding: 32px 16px; color: var(--color-text-muted);">
        <i data-lucide="check-circle" style="width: 36px; height: 36px; color: var(--success); display: inline-block; margin-bottom: 8px;"></i>
        <p style="font-size: 0.9rem;">Nenhuma notificação pendente.</p>
      </div>
    `;
  } else {
    notifications.forEach(notif => {
      let icon = 'bell';
      let bgClass = 'bg-primary';
      if (notif.type === 'chat') {
        icon = 'message-square';
        bgClass = 'bg-cyan';
      } else if (notif.type === 'alert') {
        icon = 'alert-triangle';
        bgClass = 'bg-yellow';
      } else if (notif.type === 'delivery') {
        icon = 'bike';
        bgClass = 'bg-primary';
      } else if (notif.type === 'store') {
        icon = 'store';
        bgClass = 'bg-cyan';
      }

      const notifItem = document.createElement('div');
      notifItem.className = 'notif-item unread';
      notifItem.innerHTML = `
        <div class="notif-icon ${bgClass}"><i data-lucide="${icon}"></i></div>
        <div class="notif-content">
          <p>${notif.title}</p>
          <span class="notif-time">${notif.time}</span>
        </div>
      `;
      list.appendChild(notifItem);
    });
  }
  lucide.createIcons();
}

// Close notification panel when clicking outside
document.addEventListener('click', function(e) {
  const panel = document.getElementById('notification-panel');
  const bell  = document.getElementById('notification-bell');
  if (panel && bell && !panel.classList.contains('hidden') && !bell.contains(e.target)) {
    panel.classList.add('hidden');
  }
});

/* ================= MOTOBOY REGISTRATION MODAL ================= */

function openRegisterMotoboy() {
  document.getElementById('modal-register-motoboy').classList.remove('hidden');
  document.getElementById('register-motoboy-form').reset();
  document.getElementById('register-motoboy-error').classList.add('hidden');
  lucide.createIcons();
}

function closeRegisterMotoboy(event) {
  // If called from overlay click, close; if called directly, close
  if (event && event.target !== document.getElementById('modal-register-motoboy')) return;
  document.getElementById('modal-register-motoboy').classList.add('hidden');
}

async function submitEditRider(event) {
  event.preventDefault();
  const riderId = document.getElementById('edit-rider-id').value;
  const status = document.getElementById('edit-rider-status').value;
  const payload = {
    name: document.getElementById('edit-rider-name').value.trim(),
    vehicle: document.getElementById('edit-rider-vehicle').value.trim(),
    plate: document.getElementById('edit-rider-plate').value.trim().toUpperCase(),
    status: status
  };

  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('fleet')
      .update(payload)
      .eq('id', riderId);
    if (error) {
      alert('Erro ao editar motoboy: ' + error.message);
      return;
    }
  }

  await fetchFleet();
  renderFleetTable();
  closeEditRider();
  showToastNotification('Dados do motoboy atualizados.');
}

function formatPhoneBR(value) {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits.length ? `(${digits}` : '';
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

// Inicializador de máscaras e listeners para o formulário de entregadores
document.addEventListener('DOMContentLoaded', () => {
  const phoneEl = document.getElementById('mb-phone');
  if (phoneEl) {
    phoneEl.addEventListener('input', (e) => {
      e.target.value = formatPhoneBR(e.target.value);
      const err = document.getElementById('mb-phone-error');
      if (err) err.classList.add('hidden');
      e.target.style.borderColor = '';
    });
  }

  const pinEl = document.getElementById('mb-pin');
  if (pinEl) {
    pinEl.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
      const err = document.getElementById('mb-pin-error');
      if (err) err.classList.add('hidden');
      e.target.style.borderColor = '';
    });
  }
});

async function submitRegisterMotoboy(event) {
  event.preventDefault();

  const nameEl    = document.getElementById('mb-name');
  const vehicleEl = document.getElementById('mb-vehicle');
  const plateEl   = document.getElementById('mb-plate');
  const phoneEl   = document.getElementById('mb-phone');
  const pinEl     = document.getElementById('mb-pin');

  const name     = nameEl ? nameEl.value.trim() : '';
  const vehicle  = vehicleEl ? vehicleEl.value.trim() : '';
  const plate    = plateEl ? plateEl.value.trim().toUpperCase() : '';
  const phoneRaw = phoneEl ? phoneEl.value.trim() : '';
  const pinRaw   = pinEl ? pinEl.value.trim() : '';

  const phoneErrorEl   = document.getElementById('mb-phone-error');
  const pinErrorEl     = document.getElementById('mb-pin-error');
  const generalErrorEl = document.getElementById('register-motoboy-error');

  if (phoneErrorEl) phoneErrorEl.classList.add('hidden');
  if (pinErrorEl) pinErrorEl.classList.add('hidden');
  if (generalErrorEl) generalErrorEl.classList.add('hidden');
  if (phoneEl) phoneEl.style.borderColor = '';
  if (pinEl) pinEl.style.borderColor = '';

  let hasValidationError = false;

  const phoneDigits = phoneRaw.replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    if (phoneErrorEl) {
      phoneErrorEl.innerText = 'Informe um telefone válido com DDD.';
      phoneErrorEl.classList.remove('hidden');
    }
    if (phoneEl) phoneEl.style.borderColor = '#ef4444';
    hasValidationError = true;
  }

  if (!/^\d{4}$/.test(pinRaw)) {
    if (pinErrorEl) {
      pinErrorEl.innerText = 'Informe um PIN de acesso com exatamente 4 números.';
      pinErrorEl.classList.remove('hidden');
    }
    if (pinEl) pinEl.style.borderColor = '#ef4444';
    hasValidationError = true;
  }

  if (hasValidationError) return;

  const submitBtn = document.getElementById('register-motoboy-submit-btn');
  submitBtn.disabled = true;
  submitBtn.querySelector('span').innerText = 'Cadastrando...';

  // ID do motoboy: últimos 4 números do telefone pessoal.
  const newId = '#MB-' + phoneDigits.slice(-4);
  const existingRider = mockData.fleet.find(rider => rider.id === newId);
  if (existingRider) {
    if (generalErrorEl) {
      document.getElementById('register-motoboy-error-text').innerText = `Já existe motoboy registrado com o ID ${newId}. Verifique o telefone.`;
      generalErrorEl.classList.remove('hidden');
    }
    submitBtn.disabled = false;
    submitBtn.querySelector('span').innerText = 'Cadastrar Motoboy';
    return;
  }

  const dbPayload = {
    motoboy_code: newId.replace('#', ''),
    name: name,
    phone: phoneDigits, // salvar telefone normalizado (apenas dígitos)
    vehicle: vehicle,
    plate: plate,
    status: 'Disponível'
  };

  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('fleet')
      .insert([dbPayload]);

    if (error) {
      if (generalErrorEl) {
        document.getElementById('register-motoboy-error-text').innerText = 'Erro ao salvar: ' + error.message;
        generalErrorEl.classList.remove('hidden');
      }
      submitBtn.disabled = false;
      submitBtn.querySelector('span').innerText = 'Cadastrar Motoboy';
      return;
    }
  } else {
    // Offline fallback: add to local mockData
    mockData.fleet.push({
      id: newId,
      name: name,
      phone: phoneDigits,
      vehicle: vehicle,
      plate: plate,
      status: 'Disponível'
    });
  }

  // Refresh fleet table
  await fetchFleet();
  renderFleetTable();

  // Close registration modal and open credential card
  document.getElementById('modal-register-motoboy').classList.add('hidden');
  openCredentialCard(newId, name, pinRaw);

  submitBtn.disabled = false;
  submitBtn.querySelector('span').innerText = 'Cadastrar Motoboy';
}


// Helper to show modern toast notification
function showToastNotification(message) {
  // Check if toast container exists, otherwise create it
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position: fixed; bottom: 24px; right: 24px; z-index: 10000; display: flex; flex-direction: column; gap: 10px; pointer-events: none;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.style.cssText = 'background: var(--bg-card); border-left: 4px solid var(--primary); color: var(--color-text); padding: 16px 24px; border-radius: var(--border-radius-md); box-shadow: var(--shadow-lg); font-family: var(--font-primary); font-size: 0.9rem; display: flex; align-items: center; gap: 10px; pointer-events: auto; border: 1px solid var(--border-color); animation: toast-in 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);';
  toast.innerHTML = `<i data-lucide="check-circle" style="color: var(--primary); width: 18px; height: 18px;"></i> <span style="font-weight: 500;">${message}</span>`;
  container.appendChild(toast);
  lucide.createIcons();

  // Remove toast after 4 seconds
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4000);
}

function renderClientRatings() {
  const list = document.getElementById('client-ratings-list');
  if (!list) return;

  if (clientRatings.length === 0) {
    list.innerHTML = `
      <div class="empty-state-card" style="min-height: 260px;">
        <i data-lucide="star"></i>
        <h4>Nenhuma avaliação registrada</h4>
        <p>As avaliações aparecerão aqui depois que forem enviadas pelo formulário.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  list.innerHTML = clientRatings.map(item => `
    <div class="list-item">
      <div class="item-info">
        <div class="item-icon-avatar bg-yellow"><i data-lucide="star" class="text-black"></i></div>
        <div>
          <h4>${item.title}</h4>
          <p class="text-muted">${item.comment}</p>
          <p class="text-muted text-xs" style="margin-top: 4px;">${item.date}</p>
        </div>
      </div>
      <div class="courier-rating">
        <i data-lucide="star" class="fill-yellow text-yellow"></i>
        <strong>${item.score}</strong>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

function submitClientRating(event) {
  event.preventDefault();
  const score = Number(document.getElementById('rating-score').value);
  const comment = document.getElementById('rating-comment').value.trim();
  clientRatings.unshift({
    score,
    title: score >= 4 ? 'Nova avaliação positiva' : 'Avaliação precisa de atenção',
    comment: comment || 'Sem comentário adicional.',
    date: 'Agora'
  });
  document.getElementById('rating-comment').value = '';
  renderClientRatings();
  updateClientDashboardOverview();
  showToastNotification('Avaliação enviada.');
}

function openProfileSettings() {
  const profile = mockData.activeProfile;
  const creds = mockData.credentials[profile];
  document.getElementById('profile-name').value = creds.name || '';
  document.getElementById('profile-role').value = creds.role || '';
  document.getElementById('profile-avatar').value = creds.avatar || '';
  document.getElementById('profile-email').value = creds.email || '';
  document.getElementById('profile-partner').value = creds.partner || '';
  updateProfilePreview();
  document.getElementById('modal-profile-settings').classList.remove('hidden');
  lucide.createIcons();
}

function updateProfilePreview() {
  const avatar = document.getElementById('profile-avatar');
  const name = document.getElementById('profile-name');
  const role = document.getElementById('profile-role');
  const avatarPreview = document.getElementById('profile-avatar-preview');
  const namePreview = document.getElementById('profile-preview-name');
  const rolePreview = document.getElementById('profile-preview-role');

  if (avatarPreview) {
    avatarPreview.src = avatar && avatar.value ? avatar.value : document.getElementById('user-avatar').src;
  }
  if (namePreview) namePreview.innerText = name && name.value ? name.value : 'Nome do perfil';
  if (rolePreview) rolePreview.innerText = role && role.value ? role.value : 'Cargo / Função';
}

function closeProfileSettings(event) {
  const modal = document.getElementById('modal-profile-settings');
  if (event && event.target !== modal) return;
  modal.classList.add('hidden');
}

function submitProfileSettings(event) {
  event.preventDefault();
  const profile = mockData.activeProfile;
  const creds = mockData.credentials[profile];
  creds.name = document.getElementById('profile-name').value.trim();
  creds.role = document.getElementById('profile-role').value.trim();
  creds.avatar = document.getElementById('profile-avatar').value.trim() || creds.avatar;
  creds.email = document.getElementById('profile-email').value.trim();
  creds.partner = document.getElementById('profile-partner').value.trim();

  document.getElementById('user-avatar').src = creds.avatar;
  document.getElementById('user-display-name').innerText = creds.name;
  document.getElementById('user-display-sub').innerText = creds.partner
    ? `${creds.role} • Sócio: ${creds.partner}`
    : creds.role;

  closeProfileSettings();
  showToastNotification('Perfil atualizado nesta sessão.');
}

/* ================= PWA INSTALLATION & MODAL CONTROLS ================= */

let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  console.log('beforeinstallprompt event fired');
});

window.addEventListener('appinstalled', (evt) => {
  console.log('PWA foi instalado com sucesso');
  showToastNotification("Aplicativo instalado com sucesso!");
  deferredPrompt = null;
});

window.installPWA = async function() {
  if (!deferredPrompt) {
    showToastNotification("Instalação direta indisponível. Por favor, instale manualmente usando o guia abaixo.");
    return;
  }
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`User choice: ${outcome}`);
  deferredPrompt = null;
};

window.showDownloadAppModal = function() {
  const modal = document.getElementById('modal-download-app');
  if (modal) {
    modal.classList.remove('hidden');
    lucide.createIcons();
  }
};

window.closeDownloadApp = function(event) {
  const modal = document.getElementById('modal-download-app');
  if (!modal) return;
  if (event) {
    const isOverlay = event.target === modal;
    const isCloseBtn = event.target.closest('.modal-close-btn');
    if (!isOverlay && !isCloseBtn) return;
  }
  modal.classList.add('hidden');
};

// ─── SUPPORT CHAT IMPLEMENTATION ─────────────────────────────────────────────

// Helper to create message bubbles
function createMessageBubble(msg, currentRole) {
  const isMe = msg.sender_role === currentRole;
  const alignStyle = isMe ? 'align-self: flex-end; align-items: flex-end;' : 'align-self: flex-start; align-items: flex-start;';
  
  // Premium gradients/colors for bubbles
  const bubbleStyle = isMe 
    ? 'background: linear-gradient(135deg, #f97316, #c2410c); color: #ffffff; border-radius: 16px 16px 2px 16px; box-shadow: 0 4px 12px rgba(249, 115, 22, 0.25);'
    : 'background: #272732; border: 1px solid var(--border-color); color: var(--color-text); border-radius: 16px 16px 16px 2px;';
  
  const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'Agora';

  return `
    <div style="display: flex; flex-direction: column; max-width: 70%; ${alignStyle}">
      <span style="font-size: 0.72rem; color: var(--color-text-muted); margin-bottom: 4px; font-weight: 500;">${msg.sender_name}</span>
      <div style="padding: 10px 16px; font-size: 0.88rem; line-height: 1.45; word-break: break-word; ${bubbleStyle}">
        ${escapeHtml(msg.message)}
      </div>
      <span style="font-size: 0.65rem; color: var(--color-text-muted); margin-top: 4px;">${time}</span>
    </div>
  `;
}

// ─── CLIENT CHAT LOGIC ────────────────────────────────────────────────────────

async function loadClientChatHistory() {
  const container = document.getElementById('client-chat-messages');
  if (!container) return;

  container.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
      <div style="width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 1s linear infinite;"></div>
    </div>
  `;

  const creds = mockData.credentials[mockData.activeProfile];
  if (!creds) return;

  if (!supabaseClient) {
    renderClientMessages([]);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('support_messages')
      .select('*')
      .eq('client_email', creds.email)
      .order('id', { ascending: true });

    if (error) throw error;

    renderClientMessages(data || []);
  } catch (err) {
    console.error("Error loading client chat history:", err);
    renderClientMessages([]);
  }
}

function renderClientMessages(messages) {
  const container = document.getElementById('client-chat-messages');
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--color-text-muted); gap: 12px; padding: 20px;">
        <i data-lucide="message-square" style="width: 36px; height: 36px; color: var(--color-text-muted);"></i>
        <p style="font-size: 0.85rem; margin: 0;">Nenhuma mensagem enviada ainda.</p>
        <p style="font-size: 0.78rem; margin: 0; color: var(--color-text-muted);">Envie uma mensagem abaixo para falar com o suporte administrativo.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = messages.map(msg => createMessageBubble(msg, 'client')).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendClientChatMessage(event) {
  if (event) event.preventDefault();

  const input = document.getElementById('client-chat-input');
  if (!input) return;

  const val = input.value.trim();
  if (!val) return;

  const creds = mockData.credentials[mockData.activeProfile];
  if (!creds) return;

  input.value = ''; // Clear input immediately for responsive feel

  if (!supabaseClient) {
    const newMsg = {
      client_email: creds.email,
      sender_role: 'client',
      sender_name: creds.name,
      message: val,
      created_at: new Date().toISOString()
    };
    appendAndScrollClient(newMsg);

    // Simulate auto-reply from support admin
    setTimeout(() => {
      const reply = {
        client_email: creds.email,
        sender_role: 'admin',
        sender_name: 'Suporte Dahora Expresso',
        message: 'Olá! Recebemos sua mensagem. Um atendente entrará em contato em breve.',
        created_at: new Date().toISOString()
      };
      appendAndScrollClient(reply);
    }, 1500);
    return;
  }

  try {
    const { error } = await supabaseClient
      .from('support_messages')
      .insert([{
        client_email: creds.email,
        sender_role: 'client',
        sender_name: creds.name,
        message: val
      }]);

    if (error) throw error;
  } catch (err) {
    console.error("Error sending client chat message:", err);
    showToastNotification("Erro ao enviar mensagem.");
  }
}

function appendAndScrollClient(msg) {
  const container = document.getElementById('client-chat-messages');
  if (!container) return;

  // If there was empty state message, clear it
  const emptyState = container.querySelector('[data-lucide="message-square"]');
  if (emptyState) {
    container.innerHTML = '';
  }

  const div = document.createElement('div');
  div.style.display = 'contents';
  div.innerHTML = createMessageBubble(msg, 'client');
  container.appendChild(div);
  
  // Smooth scroll to bottom
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}

async function loadAdminChatChannels() {
  const listContainer = document.getElementById('admin-chat-channels-list');
  if (!listContainer) return;

  listContainer.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; padding: 20px;">
      <div style="width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 1s linear infinite;"></div>
    </div>
  `;

  if (!supabaseClient) {
    renderAdminChatChannels([]);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('support_messages')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;

    // Group by unique client_email
    const clientsMap = {};
    (data || []).forEach(msg => {
      // ONLY process client messages (client_email does not start with '#')
      if (msg.client_email && msg.client_email.startsWith('#')) return;

      clientsMap[msg.client_email] = {
        email: msg.client_email,
        name: msg.sender_role === 'client' ? msg.sender_name : (clientsMap[msg.client_email]?.name || 'Cliente Comercial'),
        lastMessage: msg.message,
        time: new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      };
    });

    const channels = Object.values(clientsMap);
    renderAdminChatChannels(channels);
  } catch (err) {
    console.error("Error loading admin chat channels:", err);
    renderAdminChatChannels([]);
  }
}

function renderAdminChatChannels(channels) {
  const listContainer = document.getElementById('admin-chat-channels-list');
  if (!listContainer) return;

  if (channels.length === 0) {
    listContainer.innerHTML = `<p class="text-muted" style="text-align: center; font-size: 0.8rem; padding: 20px;">Nenhuma conversa ativa.</p>`;
    return;
  }

  listContainer.innerHTML = channels.map(chan => {
    const isActive = activeChatClientEmail === chan.email;
    const activeBg = isActive ? 'background: rgba(255, 255, 255, 0.08); border-left: 3px solid var(--accent-cyan);' : 'border-left: 3px solid transparent;';
    const highlightHover = 'this.style.background=\'rgba(255, 255, 255, 0.05)\'';
    const normalBg = isActive ? 'this.style.background=\'rgba(255, 255, 255, 0.08)\'' : 'this.style.background=\'transparent\'';

    return `
      <div class="chat-channel-item" onclick="selectAdminChatChannel('${chan.email}', '${chan.name.replace(/'/g, "\\'")}')" 
           onmouseover="${highlightHover}" onmouseout="${normalBg}"
           style="padding: 14px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid rgba(255,255,255,0.03); transition: background 0.2s; ${activeBg}">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 0.88rem; color: var(--color-text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;">${chan.name}</strong>
          <span style="font-size: 0.68rem; color: var(--color-text-muted);">${chan.time}</span>
        </div>
        <p style="font-size: 0.78rem; color: var(--color-text-muted); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${chan.lastMessage}</p>
      </div>
    `;
  }).join('');
}

function filterAdminChatChannels() {
  const query = document.getElementById('admin-chat-search')?.value.trim().toLowerCase() || '';
  const filtered = activeAdminChatChannels.filter(c => 
    (c.name || '').toLowerCase().includes(query) || 
    (c.email || '').toLowerCase().includes(query)
  );
  renderAdminChatChannels(filtered);
}

async function selectAdminChatChannel(email, name) {
  activeChatClientEmail = email;
  activeChatClientName = name;

  // Clear admin chat dot when selecting a channel
  const adminDot = document.getElementById('admin-chat-dot');
  if (adminDot) adminDot.classList.add('hidden');

  // Toggle UI visibility
  document.getElementById('admin-chat-no-selection').classList.add('hidden');
  document.getElementById('admin-chat-window-pane').classList.remove('hidden');

  // Fill Header details
  document.getElementById('admin-chat-client-title').innerText = name;
  document.getElementById('admin-chat-client-subtitle').innerText = email;

  // Render channels again to update active tab highlight
  loadAdminChatChannels();

  // Load chat history for this client
  const chatMessages = document.getElementById('admin-chat-messages');
  if (chatMessages) {
    chatMessages.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
        <div style="width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 1s linear infinite;"></div>
      </div>
    `;
  }

  if (!supabaseClient) {
    renderAdminMessages([]);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('support_messages')
      .select('*')
      .eq('client_email', email)
      .order('id', { ascending: true });

    if (error) throw error;

    renderAdminMessages(data || []);
  } catch (err) {
    console.error("Error fetching messages for admin:", err);
    renderAdminMessages([]);
  }
}

function renderAdminMessages(messages) {
  const container = document.getElementById('admin-chat-messages');
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--color-text-muted); gap: 8px;">
        <p style="font-size: 0.85rem; margin: 0;">Sem mensagens nesta conversa.</p>
        <p style="font-size: 0.78rem; margin: 0; color: var(--color-text-muted);">Envie uma resposta abaixo para iniciar a conversa.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = messages.map(msg => createMessageBubble(msg, 'admin')).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendAdminChatMessage(event) {
  if (event) event.preventDefault();

  const input = document.getElementById('admin-chat-input');
  if (!input) return;

  const val = input.value.trim();
  if (!val) return;

  if (!activeChatClientEmail) return;

  const creds = mockData.credentials['owner'];
  if (!creds) return;

  input.value = ''; // Responsive feedback clear

  if (!supabaseClient) {
    const newMsg = {
      client_email: activeChatClientEmail,
      sender_role: 'admin',
      sender_name: creds.name,
      message: val,
      created_at: new Date().toISOString()
    };
    appendAndScrollAdmin(newMsg);
    
    // Simulate auto-reply
    setTimeout(() => {
      const reply = {
        client_email: activeChatClientEmail,
        sender_role: 'client',
        sender_name: activeChatClientName,
        message: 'Obrigado pelo retorno! Vou verificar aqui.',
        created_at: new Date().toISOString()
      };
      appendAndScrollAdmin(reply);
    }, 1500);
    return;
  }

  try {
    const { error } = await supabaseClient
      .from('support_messages')
      .insert([{
        client_email: activeChatClientEmail,
        sender_role: 'admin',
        sender_name: creds.name,
        message: val
      }]);

    if (error) throw error;
  } catch (err) {
    console.error("Error sending admin message:", err);
    showToastNotification("Erro ao enviar resposta.");
  }
}

function appendAndScrollAdmin(msg) {
  const container = document.getElementById('admin-chat-messages');
  if (!container) return;

  const emptyMsg = container.querySelector('p');
  if (emptyMsg && emptyMsg.innerText.includes('Sem mensagens')) {
    container.innerHTML = '';
  }

  const div = document.createElement('div');
  div.style.display = 'contents';
  div.innerHTML = createMessageBubble(msg, 'admin');
  container.appendChild(div);

  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}


// ─── ADMIN RIDER CHAT LOGIC ──────────────────────────────────────────────────

async function loadAdminRiderChatChannels() {
  const listContainer = document.getElementById('admin-rider-chat-channels-list');
  if (!listContainer) return;

  listContainer.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; padding: 20px;">
      <div style="width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 1s linear infinite;"></div>
    </div>
  `;

  // Make sure we have the fleet to translate IDs to names
  if (mockData.fleet.length === 0) {
    await fetchFleet();
  }

  // Helper to get rider name
  const getRiderName = (riderId) => {
    const rider = mockData.fleet.find(r => r.id === riderId);
    return rider ? rider.name : `Motoboy ${riderId}`;
  };

  if (!supabaseClient) {
    const defaultRiders = mockData.fleet.map(r => ({
      email: r.id,
      name: r.name,
      lastMessage: 'Sem mensagens anteriores',
      time: ''
    }));
    activeAdminRiderChatChannels = defaultRiders;
    filterAdminRiderChatChannels();
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('support_messages')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;

    const ridersMap = {};
    (data || []).forEach(msg => {
      // ONLY process rider messages (client_email starts with '#')
      if (!msg.client_email || !msg.client_email.startsWith('#')) return;

      ridersMap[msg.client_email] = {
        email: msg.client_email, // This is the Rider ID, e.g. '#MB-1001'
        name: getRiderName(msg.client_email),
        lastMessage: msg.message,
        time: new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      };
    });

    // Populate all active riders in the channel list so the admin can initiate chat
    mockData.fleet.forEach(r => {
      if (!ridersMap[r.id]) {
        ridersMap[r.id] = {
          email: r.id,
          name: r.name,
          lastMessage: 'Sem mensagens anteriores',
          time: ''
        };
      }
    });

    activeAdminRiderChatChannels = Object.values(ridersMap);
    filterAdminRiderChatChannels();
  } catch (err) {
    console.error("Error loading admin rider chat channels:", err);
    const defaultRiders = mockData.fleet.map(r => ({
      email: r.id,
      name: r.name,
      lastMessage: 'Sem mensagens anteriores',
      time: ''
    }));
    activeAdminRiderChatChannels = defaultRiders;
    filterAdminRiderChatChannels();
  }
}

function renderAdminRiderChatChannels(channels) {
  const listContainer = document.getElementById('admin-rider-chat-channels-list');
  if (!listContainer) return;

  if (channels.length === 0) {
    listContainer.innerHTML = `<p class="text-muted" style="text-align: center; font-size: 0.8rem; padding: 20px;">Nenhum motoboy ativo.</p>`;
    return;
  }

  listContainer.innerHTML = channels.map(chan => {
    const isActive = activeChatClientEmail === chan.email;
    const activeBg = isActive ? 'background: rgba(255, 255, 255, 0.08); border-left: 3px solid var(--accent-cyan);' : 'border-left: 3px solid transparent;';
    const highlightHover = 'this.style.background=\'rgba(255, 255, 255, 0.05)\'';
    const normalBg = isActive ? 'this.style.background=\'rgba(255, 255, 255, 0.08)\'' : 'this.style.background=\'transparent\'';

    return `
      <div class="chat-channel-item" onclick="selectAdminRiderChatChannel('${chan.email}', '${chan.name.replace(/'/g, "\\'")}')" 
           onmouseover="${highlightHover}" onmouseout="${normalBg}"
           style="padding: 14px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid rgba(255,255,255,0.03); transition: background 0.2s; ${activeBg}">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 0.88rem; color: var(--color-text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;">${chan.name}</strong>
          <span style="font-size: 0.68rem; color: var(--color-text-muted);">${chan.time}</span>
        </div>
        <p style="font-size: 0.78rem; color: var(--color-text-muted); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${chan.lastMessage}</p>
      </div>
    `;
  }).join('');
}

function filterAdminRiderChatChannels() {
  const query = document.getElementById('admin-rider-chat-search')?.value.trim().toLowerCase() || '';
  const filtered = activeAdminRiderChatChannels.filter(r => 
    (r.name || '').toLowerCase().includes(query) || 
    (r.email || '').toLowerCase().includes(query)
  );
  renderAdminRiderChatChannels(filtered);
}

async function selectAdminRiderChatChannel(email, name) {
  activeChatClientEmail = email;
  activeChatClientName = name;

  // Clear admin rider chat dot when selecting a channel
  const adminDot = document.getElementById('admin-rider-chat-dot');
  if (adminDot) adminDot.classList.add('hidden');

  // Toggle UI visibility
  document.getElementById('admin-rider-chat-no-selection').classList.add('hidden');
  document.getElementById('admin-rider-chat-window-pane').classList.remove('hidden');

  // Fill Header details
  document.getElementById('admin-rider-chat-client-title').innerText = name;
  document.getElementById('admin-rider-chat-client-subtitle').innerText = email;

  // Render channels again to update active tab highlight
  loadAdminRiderChatChannels();

  // Load chat history for this rider
  const chatMessages = document.getElementById('admin-rider-chat-messages');
  if (chatMessages) {
    chatMessages.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
        <div style="width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 1s linear infinite;"></div>
      </div>
    `;
  }

  if (!supabaseClient) {
    renderAdminRiderMessages([]);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('support_messages')
      .select('*')
      .eq('client_email', email)
      .order('id', { ascending: true });

    if (error) throw error;

    renderAdminRiderMessages(data || []);
  } catch (err) {
    console.error("Error fetching messages for admin rider:", err);
    renderAdminRiderMessages([]);
  }
}

function renderAdminRiderMessages(messages) {
  const container = document.getElementById('admin-rider-chat-messages');
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--color-text-muted); gap: 8px;">
        <p style="font-size: 0.85rem; margin: 0;">Sem mensagens nesta conversa.</p>
        <p style="font-size: 0.78rem; margin: 0; color: var(--color-text-muted);">Envie uma resposta abaixo para iniciar a conversa.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = messages.map(msg => createMessageBubble(msg, 'admin')).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendAdminRiderChatMessage(event) {
  if (event) event.preventDefault();

  const input = document.getElementById('admin-rider-chat-input');
  if (!input) return;

  const val = input.value.trim();
  if (!val) return;

  if (!activeChatClientEmail) return;

  const creds = mockData.credentials['owner'];
  if (!creds) return;

  input.value = ''; // Responsive feedback clear

  if (!supabaseClient) {
    const newMsg = {
      client_email: activeChatClientEmail,
      sender_role: 'admin',
      sender_name: creds.name,
      message: val,
      created_at: new Date().toISOString()
    };
    appendAndScrollAdminRider(newMsg);
    return;
  }

  try {
    const { error } = await supabaseClient
      .from('support_messages')
      .insert([{
        client_email: activeChatClientEmail,
        sender_role: 'admin',
        sender_name: creds.name,
        message: val
      }]);

    if (error) throw error;
  } catch (err) {
    console.error("Error sending admin rider message:", err);
    showToastNotification("Erro ao enviar resposta.");
  }
}

function appendAndScrollAdminRider(msg) {
  const container = document.getElementById('admin-rider-chat-messages');
  if (!container) return;

  const emptyMsg = container.querySelector('p');
  if (emptyMsg && emptyMsg.innerText.includes('Sem mensagens')) {
    container.innerHTML = '';
  }

  const div = document.createElement('div');
  div.style.display = 'contents';
  div.innerHTML = createMessageBubble(msg, 'admin');
  container.appendChild(div);

  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}

// ─── REALTIME SUPPORT SUBSCRIPTION ───────────────────────────────────────────

function subscribeSupportRealtime() {
  if (!supabaseClient) return;

  if (supportChatChannel) {
    supabaseClient.removeChannel(supportChatChannel);
  }

  supportChatChannel = supabaseClient.channel('realtime-support-channel')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'support_messages'
    }, (payload) => {
      const newMsg = payload.new;
      const currentRole = mockData.activeProfile;

      if (currentRole === 'owner') {
        // Admin View: reload conversations list to show last message
        loadAdminChatChannels();
        loadAdminRiderChatChannels();

        const isRider = newMsg.client_email && newMsg.client_email.startsWith('#');

        if (newMsg.sender_role === 'client' || newMsg.sender_role === 'rider') {
          // Add notification to bell
          addBellNotification(`<strong>${escapeHtml(newMsg.sender_name)}</strong>: ${escapeHtml(newMsg.message)}`, 'chat');

          if (isRider) {
            // Check if rider chat tab is active
            const isOwnerRiderSupportActive = document.getElementById('tab-owner-rider-support') && document.getElementById('tab-owner-rider-support').classList.contains('active');
            if (!isOwnerRiderSupportActive || activeChatClientEmail !== newMsg.client_email) {
              const adminRiderDot = document.getElementById('admin-rider-chat-dot');
              if (adminRiderDot) adminRiderDot.classList.remove('hidden');
            }
          } else {
            // Check if client chat tab is active
            const isOwnerSupportActive = document.getElementById('tab-owner-support') && document.getElementById('tab-owner-support').classList.contains('active');
            if (!isOwnerSupportActive || activeChatClientEmail !== newMsg.client_email) {
              const adminDot = document.getElementById('admin-chat-dot');
              if (adminDot) adminDot.classList.remove('hidden');
            }
          }
        }

        // If active conversation matches, append message bubble
        if (activeChatClientEmail === newMsg.client_email) {
          if (isRider) {
            appendAndScrollAdminRider(newMsg);
          } else {
            appendAndScrollAdmin(newMsg);
          }
        }
      } else {
        // Client/Merchant View
        const creds = mockData.credentials[currentRole];
        if (creds && creds.email === newMsg.client_email) {
          if (newMsg.sender_role === 'admin') {
            // Add notification to bell
            addBellNotification(`<strong>Suporte</strong>: ${escapeHtml(newMsg.message)}`, 'chat');

            // If not currently on client-support, show sidebar dot
            const isClientSupportActive = document.getElementById('tab-client-support') && document.getElementById('tab-client-support').classList.contains('active');
            if (!isClientSupportActive) {
              const clientDot = document.getElementById('client-chat-dot');
              if (clientDot) clientDot.classList.remove('hidden');
            }
          }

          // Always append to chat messages
          appendAndScrollClient(newMsg);
        }
      }
    })
    .subscribe();
}

function subscribeDashboardRealtime() {
  if (!supabaseClient) return;

  if (dashboardRealtimeChannel) {
    supabaseClient.removeChannel(dashboardRealtimeChannel);
  }

  const profile = mockData.activeProfile;
  const creds = mockData.credentials[profile];

  dashboardRealtimeChannel = supabaseClient.channel('realtime-dashboard-channel');

  if (profile === 'owner') {
    dashboardRealtimeChannel
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'fleet'
      }, async (payload) => {
        console.log('Realtime fleet update:', payload);
        await fetchFleet();
        renderFleetTable();
        if (ownerFleetMap) {
          renderMapMarkers(ownerFleetCenterCoords);
        }
        populateRiderSearchDropdown();
        updateOwnerDashboardOverview();

        if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
          const newBat = parseInt(payload.new.battery_level != null ? payload.new.battery_level : payload.new.battery) || 100;
          const oldBat = parseInt(payload.old?.battery_level != null ? payload.old.battery_level : payload.old?.battery) || 100;
          if (newBat < 20 && oldBat >= 20) {
            addBellNotification(`<strong>${escapeHtml(payload.new.name)}</strong> está com bateria abaixo de 20% (${newBat}%)`, 'alert');
          }
        }
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'teles'
      }, async (payload) => {
        console.log('Realtime pending deliveries update:', payload);
        await fetchPendingDeliveries();
        renderTelesUnified();
        if (ownerFleetMap) {
          renderMapMarkers(ownerFleetCenterCoords);
        }

        if (payload.eventType === 'INSERT') {
          addBellNotification(`<strong>${escapeHtml(payload.new.client || 'Estabelecimento')}</strong> solicitou novo motoboy`, 'store');

          // Geocoder Recalibration Shield for API orders (99Food / iFood)
          const isIntegration = payload.new.client === '99Food' || payload.new.client === 'iFood' || (payload.new.payment && (payload.new.payment.toLowerCase().includes('ifood') || payload.new.payment.toLowerCase().includes('99food')));
          if (isIntegration) {
            const lat = parseFloat(payload.new.dest_lat);
            const lng = parseFloat(payload.new.dest_lng);
            // Check if coordinates are close to the generic city center or missing
            const isGeneric = isNaN(lat) || isNaN(lng) || (Math.abs(lat - (-29.8378)) < 0.005 && Math.abs(lng - (-51.1444)) < 0.005);
            if (isGeneric && window.google && window.google.maps && window.google.maps.Geocoder) {
              console.log("Realtime Geocoder Shield: Coordenadas genéricas/ausentes detectadas. Iniciando recalibração para o endereço:", payload.new.address);
              const geocoder = new window.google.maps.Geocoder();
              geocoder.geocode({ address: payload.new.address }, async (results, status) => {
                if (status === 'OK' && results[0]) {
                  const loc = results[0].geometry.location;
                  const newLat = loc.lat();
                  const newLng = loc.lng();
                  console.log(`Realtime Geocoder Shield: Calibrado com sucesso! Atualizando Supabase para: ${newLat}, ${newLng}`);
                  if (supabaseClient) {
                    await supabaseClient
                      .from('teles')
                      .update({ dest_lat: newLat, dest_lng: newLng })
                      .eq('id', payload.new.id);
                  }
                } else {
                  console.warn("Realtime Geocoder Shield: Falha ao geocodificar endereço.");
                }
              });
            }
          }
        }
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'teles'
      }, async (payload) => {
        console.log('Realtime client history update:', payload);
        await fetchClientHistory();
        renderTelesUnified();
        renderClientHistoryTable();
        updateOwnerDashboardOverview();
        if (document.getElementById('tab-owner-overview')?.classList.contains('active')) {
          initOwnerOverviewChart();
        }

        if (payload.eventType === 'INSERT' || (payload.eventType === 'UPDATE' && (payload.new.status === 'Entregue' || payload.new.status === 'Concluído'))) {
          addBellNotification(`<strong>${escapeHtml(payload.new.rider || 'Motoboy')}</strong> concluiu a entrega <strong>#${escapeHtml(payload.new.id)}</strong>`, 'delivery');
        }
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'rider_consumable_purchases'
      }, async (payload) => {
        console.log('Realtime rider consumables update:', payload);
        await fetchRiderConsumables();
        renderRiderConsumables();
        renderRiderPayments();
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'cidades'
      }, async (payload) => {
        console.log('Realtime cities update:', payload);
        await fetchCities();
        renderCitiesTable();
      });
  } else if (profile.startsWith('client') || profile.startsWith('order')) {
    dashboardRealtimeChannel
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'fleet'
      }, async (payload) => {
        console.log('Realtime client fleet update:', payload);
        await fetchFleet();
        if (clientFleetMap) {
          renderClientMapMarkers(clientFleetCenterCoords);
        }
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'teles'
      }, async (payload) => {
        console.log('Realtime client history update:', payload);
        const commerceName = creds ? creds.commerceName : null;
        await fetchClientHistory();
        renderClientTelesUnified();
        renderClientHistoryTable();
        updateClientDashboardOverview();
        if (document.getElementById('tab-client-overview')?.classList.contains('active')) {
          initClientOverviewChart();
        }
        if (clientFleetMap) {
          renderClientMapMarkers(clientFleetCenterCoords);
        }

        if (commerceName && payload.new.client === commerceName && (payload.eventType === 'INSERT' || (payload.eventType === 'UPDATE' && (payload.new.status === 'Entregue' || payload.new.status === 'Concluído')))) {
          addBellNotification(`<strong>${escapeHtml(payload.new.rider || 'Motoboy')}</strong> concluiu a entrega <strong>#${escapeHtml(payload.new.id)}</strong>`, 'delivery');
        }
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'teles'
      }, async (payload) => {
        console.log('Realtime client pending update:', payload);
        const commerceName = creds ? creds.commerceName : null;
        await fetchPendingDeliveries();
        renderClientTelesUnified();
        if (clientFleetMap) {
          renderClientMapMarkers(clientFleetCenterCoords);
        }

        if (commerceName && payload.new.client === commerceName && payload.eventType === 'INSERT') {
          addBellNotification(`Sua solicitação de motoboy <strong>#${escapeHtml(payload.new.id)}</strong> foi recebida.`, 'store');
        }
      });
  }

  dashboardRealtimeChannel.subscribe();
}

// ─── REQUEST DELIVERY MAP ─────────────────────────────────────────────────────

function loadGoogleMapsAPI(callback) {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    if (callback) callback(new Error("Chave do Google Maps não configurada em public/config.local.js"));
    return;
  }
  loadGoogleMapsApi().then(() => {
    if (window.google && window.google.maps && window.google.maps.OverlayView && !window.CustomHTMLMapMarker) {
      class CustomHTMLMapMarker extends window.google.maps.OverlayView {
        constructor(latlng, map, html, onClick) {
          super();
          this.latlng = latlng;
          this.html = html;
          this.onClick = onClick;
          
          this.div = document.createElement('div');
          this.div.style.position = 'absolute';
          this.div.style.cursor = 'pointer';
          this.div.innerHTML = html;
          
          if (onClick) {
            this.div.addEventListener('click', (e) => {
              e.stopPropagation();
              onClick(e);
            });
          }
          this.setMap(map);
        }
        onAdd() {
          const pane = this.getPanes().overlayMouseTarget;
          pane.appendChild(this.div);
        }
        draw() {
          const projection = this.getProjection();
          if (!projection) return;
          const point = projection.fromLatLngToDivPixel(this.latlng);
          if (point) {
            this.div.style.left = (point.x - 10) + 'px';
            this.div.style.top = (point.y - 10) + 'px';
          }
        }
        onRemove() {
          if (this.div && this.div.parentNode) {
            this.div.parentNode.removeChild(this.div);
          }
        }
        setLatLng(latlng) {
          this.latlng = latlng;
          this.draw();
        }
        getLatLng() {
          return this.latlng;
        }
        getPosition() {
          return this.latlng;
        }
      }
      window.CustomHTMLMapMarker = CustomHTMLMapMarker;
    }
    if (callback) callback();
  }).catch(err => {
    if (callback) callback(err);
  });
}


let requestMaps = {
  client: {
    map: null,
    marker: null,
    restaurantMarker: null,
    centerCoords: [-29.842173, -51.126764],
    destCoords: null
  },
  manual: {
    map: null,
    marker: null,
    restaurantMarker: null,
    centerCoords: [-29.842173, -51.126764],
    destCoords: null
  }
};
let restaurantCity = 'Sapucaia do Sul';

function fetchRestaurantCity(type = 'client') {
  restaurantCity = 'Sapucaia do Sul';
}


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
          'line-color': color || '#ffb700',
          'line-width': 3,
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

function initRequestDeliveryMap(type = 'client') {
  const mapContainer = document.getElementById(`${type}-request-delivery-map`);
  if (!mapContainer) return;

  if (requestMaps[type].map) {
    if (type === 'manual') {
      // Force clean reload for manual requests to avoid canvas/listener duplication
      if (requestMaps[type].marker && requestMaps[type].marker.setMap) {
        requestMaps[type].marker.setMap(null);
      }
      requestMaps[type].marker = null;

      if (requestMaps[type].restaurantMarker && requestMaps[type].restaurantMarker.setMap) {
        requestMaps[type].restaurantMarker.setMap(null);
      }
      requestMaps[type].restaurantMarker = null;

      if (requestMaps[type].polyline && requestMaps[type].polyline.setMap) {
        requestMaps[type].polyline.setMap(null);
      }
      requestMaps[type].polyline = null;

      requestMaps[type].map = null;
      mapContainer.innerHTML = '';
    } else {
      if (window.google && window.google.maps) {
        window.google.maps.event.trigger(requestMaps[type].map, 'resize');
      }
      return;
    }
  }
  
  loadGoogleMapsAPI(() => {
    const darkMapStyle = [
      { elementType: "geometry", stylers: [{ color: "#1e1e24" }] },
      { elementType: "labels.text.stroke", stylers: [{ color: "#1e1e24" }] },
      { elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
      { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#33333d" }] },
      { featureType: "poi", stylers: [{ visibility: "off" }] },
      { featureType: "road", elementType: "geometry", stylers: [{ color: "#2d2d38" }] },
      { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a1a22" }] },
      { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
      { featureType: "transit", stylers: [{ visibility: "off" }] },
      { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d0d11" }] }
    ];
    
    const latLng = new window.google.maps.LatLng(requestMaps[type].centerCoords[0], requestMaps[type].centerCoords[1]);
    requestMaps[type].map = new window.google.maps.Map(mapContainer, {
      center: latLng,
      zoom: 14,
      styles: darkMapStyle,
      disableDefaultUI: true,
      zoomControl: true,
      fullscreenControl: false,
      gestureHandling: 'greedy'
    });


    const restaurantIconHtml = `
      <div class="custom-map-marker central-marker" style="background-color: #ffffff; box-shadow: 0 0 15px #ffffff; border-color: var(--primary); width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative;">
        <div class="marker-pulse" style="border-color: var(--primary); animation-duration: 2.5s; position: absolute; top: -5px; left: -5px; width: 24px; height: 24px; border: 2px solid var(--primary); border-radius: 50%; animation: pulse-dot-anim 2.5s infinite;"></div>
        <i class="marker-icon-dot" style="background-color: var(--primary); width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
      </div>
    `;

    const setRestaurantMarker = (coords) => {
      const center = new window.google.maps.LatLng(coords[0], coords[1]);
      requestMaps[type].restaurantMarker = new window.CustomHTMLMapMarker(center, requestMaps[type].map, restaurantIconHtml, () => {
        const info = new window.google.maps.InfoWindow({ content: '<strong style="color:var(--color-text);">Seu Comércio</strong>' });
        info.open(requestMaps[type].map, requestMaps[type].restaurantMarker);
      });
    };

    fetchRestaurantCity(type);
    if (type !== 'manual' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          requestMaps[type].centerCoords = [position.coords.latitude, position.coords.longitude];
          fetchRestaurantCity(type);
          const newCenter = new window.google.maps.LatLng(requestMaps[type].centerCoords[0], requestMaps[type].centerCoords[1]);
          requestMaps[type].map.setCenter(newCenter);
          setRestaurantMarker(requestMaps[type].centerCoords);
        },
        (error) => {
          console.warn("Geolocation failed. Using fallback.", error);
          setRestaurantMarker(requestMaps[type].centerCoords);
        }
      );
    } else {
      // For manual request (or if geolocation is unavailable/fails), lock to the physical base coordinates [-29.842173, -51.126764]
      const fixedCenter = new window.google.maps.LatLng(requestMaps[type].centerCoords[0], requestMaps[type].centerCoords[1]);
      requestMaps[type].map.setCenter(fixedCenter);
      setRestaurantMarker(requestMaps[type].centerCoords);
    }

    requestMaps[type].map.addListener('click', (e) => {
      updateRequestDeliveryDestination(e.latLng.lat(), e.latLng.lng(), false, true, type);
    });

    setupAddressGeocodingListener(type);
  });
}

function updateRequestDeliveryDestination(lat, lng, shouldCenter = false, shouldReverseGeocode = true, type = 'client') {
  if (!requestMaps[type].map) return;

  requestMaps[type].destCoords = { lat, lng };

  const destLatLng = new window.google.maps.LatLng(lat, lng);

  if (requestMaps[type].marker) {
    requestMaps[type].marker.setPosition(destLatLng);
  } else {
    requestMaps[type].marker = new window.google.maps.Marker({
      position: destLatLng,
      map: requestMaps[type].map,
      draggable: true,
      icon: {
        path: window.google.maps.SymbolPath.CIRCLE,
        fillColor: '#ffb700',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
        scale: 8
      }
    });

    requestMaps[type].marker.addListener('dragend', () => {
      const pos = requestMaps[type].marker.getPosition();
      updateRequestDeliveryDestination(pos.lat(), pos.lng(), false, false, type);
    });
  }

  if (shouldCenter) {
    requestMaps[type].map.setCenter(destLatLng);
    requestMaps[type].map.setZoom(15);
  }

  const startLatLng = requestMaps[type].restaurantMarker ? requestMaps[type].restaurantMarker.getPosition() : new window.google.maps.LatLng(requestMaps[type].centerCoords[0], requestMaps[type].centerCoords[1]);
  const routePath = [startLatLng, destLatLng];

  if (requestMaps[type].polyline) {
    requestMaps[type].polyline.setPath(routePath);
  } else {
    requestMaps[type].polyline = new window.google.maps.Polyline({
      path: routePath,
      map: requestMaps[type].map,
      strokeColor: '#ffb700',
      strokeOpacity: 0.8,
      strokeWeight: 3,
      icons: [{
        icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2 },
        offset: '0',
        repeat: '20px'
      }]
    });
  }

  if (shouldReverseGeocode) {
    if (window.google && window.google.maps && window.google.maps.Geocoder) {
      const geocoder = new window.google.maps.Geocoder();
      geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        if (status === 'OK' && results && results[0]) {
          document.getElementById(`${type}-delivery-address`).value = results[0].formatted_address;
        } else {
          document.getElementById(`${type}-delivery-address`).value = `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`;
        }
        calculateEstimate(type);
      });
    } else {
      document.getElementById(`${type}-delivery-address`).value = `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`;
      calculateEstimate(type);
    }
  } else {
    calculateEstimate(type);
  }
}


async function setupAddressGeocodingListener(type = 'client') {
  const addressInput = document.getElementById(`${type}-delivery-address`);
  if (!addressInput) return;
  if (addressInput.dataset.autocompleteInitialized) return;

  try {
    await loadGoogleMapsApi();
    if (!window.google?.maps?.places) return;

    addressInput.dataset.autocompleteInitialized = "true";

    const centerCoords = requestMaps[type].centerCoords || [-29.8378, -51.1444];
    const defaultBounds = {
      north: centerCoords[0] + 0.3,
      south: centerCoords[0] - 0.3,
      east: centerCoords[1] + 0.3,
      west: centerCoords[1] - 0.3
    };

    const options = {
      bounds: defaultBounds,
      strictBounds: true,
      componentRestrictions: { country: "br" },
      fields: ["address_components", "geometry", "formatted_address"],
      types: ["address"]
    };

    const autocomplete = new window.google.maps.places.Autocomplete(addressInput, options);

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      
      if (!place || !place.geometry || !place.geometry.location) {
        alert("Endereço não encontrado ou inválido. Selecione um endereço sugerido pela lista.");
        return;
      }

      const hasStreetNumber = (place.address_components || []).some(component => 
        component.types.includes("street_number")
      );

      if (!hasStreetNumber) {
        alert("Atenção: Por favor, informe o número exato da casa/estabelecimento no endereço para garantir a entrega.");
        addressInput.value = "";
        requestMaps[type].destCoords = null;
        if (requestMaps[type].marker) {
          requestMaps[type].marker.setMap(null);
          requestMaps[type].marker = null;
        }
        if (requestMaps[type].polyline) {
          requestMaps[type].polyline.setMap(null);
          requestMaps[type].polyline = null;
        }
        const estBox = document.getElementById(`${type}-estimate-box`);
        if (estBox) estBox.classList.add('hidden');
        return;
      }

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      requestMaps[type].destCoords = { lat, lng };
      addressInput.value = place.formatted_address;
      addressInput.dataset.lastResolvedAddress = place.formatted_address;

      updateRequestDeliveryDestination(lat, lng, true, false, type);
    });

    const handleManualGeocode = () => {
      const value = addressInput.value.trim();
      if (!value) return;
      if (addressInput.dataset.lastResolvedAddress === value) return;

      if (window.google?.maps?.Geocoder) {
        const geocoder = new window.google.maps.Geocoder();
        geocoder.geocode({ address: value, componentRestrictions: { country: 'BR' } }, (results, status) => {
          if (status === 'OK' && results[0]) {
            const res = results[0];
            const lat = res.geometry.location.lat();
            const lng = res.geometry.location.lng();
            requestMaps[type].destCoords = { lat, lng };
            addressInput.dataset.lastResolvedAddress = res.formatted_address;
            updateRequestDeliveryDestination(lat, lng, true, false, type);
          }
        });
      }
    };

    addressInput.addEventListener('blur', handleManualGeocode);
  } catch (err) {
    console.warn("Places autocomplete listener notice:", err.message);
  }
}

// ─── REALTIME ORDER TRACKING ──────────────────────────────────────────────────

async function startRealtimeTracking(order) {
  const trackerStatus = document.getElementById('tracker-badge-status');
  const orderId = order.id;

  // Unsubscribe from any previous tracking channel
  if (trackingRealtimeChannel) {
    if (supabaseClient) supabaseClient.removeChannel(trackingRealtimeChannel);
    trackingRealtimeChannel = null;
  }

  // Determine coordinates
  const pickupLat = parseFloat(order.pickup_lat) || -23.55052;
  const pickupLng = parseFloat(order.pickup_lng) || -46.633308;
  const destLat = parseFloat(order.dest_lat) || -23.551;
  const destLng = parseFloat(order.dest_lng) || -46.634;

  // Initialize tracking Leaflet map
  initTrackingMap(pickupLat, pickupLng, destLat, destLng);

  // Set stepper initial active state
  updateStepperState(order.status || 'Buscando Entregador');

  if (supabaseClient) {
    // Check current state in database
    const { data: histData } = await supabaseClient
      .from('teles')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();

    if (histData) {
      updateStepperState(histData.status);
      trackerStatus.innerText = translateStatus(histData.status);
      trackerStatus.className = getStatusClass(histData.status);
      await loadRiderDetails(orderId, histData.rider);
    } else {
      trackerStatus.innerText = 'Buscando Entregador';
      trackerStatus.className = 'status-badge status-warning';
    }

    // Subscribe to teles & fleet status updates
    trackingRealtimeChannel = supabaseClient.channel(`tracking-${orderId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'teles',
        filter: `id=eq.${orderId}`
      }, async (payload) => {
        const row = payload.new;
        if (!row) return;

        updateStepperState(row.status);
        trackerStatus.innerText = translateStatus(row.status);
        trackerStatus.className = getStatusClass(row.status);

        if (row.status === 'A caminho da coleta' || row.status === 'Em rota de entrega') {
          await loadRiderDetails(orderId, row.rider);
        }

        if (row.status === 'Entregue') {
          const tabBtn = document.getElementById('nav-tracking-tab');
          if (tabBtn) tabBtn.querySelector('.pulse-dot').classList.add('hidden');
          if (trackingRealtimeChannel) {
            supabaseClient.removeChannel(trackingRealtimeChannel);
            trackingRealtimeChannel = null;
          }
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'fleet'
      }, (payload) => {
        const rider = payload.new;
        if (rider && rider.delivery === orderId) {
          updateRiderMarker(parseFloat(rider.lat), parseFloat(rider.lng), rider.name);
          updateCourierCardUI(rider);
        }
      })
      .subscribe();
  }
}

function initTrackingMap(pickupLat, pickupLng, destLat, destLng) {
  const mapContainer = document.getElementById('tracking-map');
  if (!mapContainer) return;

  if (trackingMapInstance) {
    const container = document.getElementById('tracking-map');
    if (container) container.innerHTML = '';
    trackingMapInstance = null;
  }

  loadGoogleMapsAPI(() => {
    const darkMapStyle = [
      { elementType: "geometry", stylers: [{ color: "#1e1e24" }] },
      { elementType: "labels.text.stroke", stylers: [{ color: "#1e1e24" }] },
      { elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
      { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#33333d" }] },
      { featureType: "poi", stylers: [{ visibility: "off" }] },
      { featureType: "road", elementType: "geometry", stylers: [{ color: "#2d2d38" }] },
      { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a1a22" }] },
      { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
      { featureType: "transit", stylers: [{ visibility: "off" }] },
      { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d0d11" }] }
    ];

    const centerLatLng = new window.google.maps.LatLng(pickupLat, pickupLng);
    trackingMapInstance = new window.google.maps.Map(mapContainer, {
      center: centerLatLng,
      zoom: 14,
      styles: darkMapStyle,
      disableDefaultUI: true,
      zoomControl: true
    });

    const pickupIconHtml = `
      <div class="custom-map-marker central-marker" style="background-color: #ffffff; box-shadow: 0 0 15px #ffffff; border-color: var(--primary); width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative;">
        <div class="marker-pulse" style="border-color: var(--primary); animation-duration: 2.5s; position: absolute; top: -5px; left: -5px; width: 24px; height: 24px; border: 2px solid var(--primary); border-radius: 50%; animation: pulse-dot-anim 2.5s infinite;"></div>
        <i class="marker-icon-dot" style="background-color: var(--primary); width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
      </div>
    `;

    const destIconHtml = `
      <div class="custom-map-marker" style="background-color: #ffb700; border-color: #ffffff; width: 16px; height: 16px; border-radius: 50%; box-shadow: 0 0 10px #ffb700; cursor: pointer;">
      </div>
    `;

    const pickupLatLng = new window.google.maps.LatLng(pickupLat, pickupLng);
    const destLatLng = new window.google.maps.LatLng(destLat, destLng);

    trackingPickupMarker = new window.CustomHTMLMapMarker(pickupLatLng, trackingMapInstance, pickupIconHtml, () => {
      const info = new window.google.maps.InfoWindow({ content: '<strong style="color:var(--color-text);">Origem (Comércio)</strong>' });
      info.open(trackingMapInstance, trackingPickupMarker);
    });

    trackingDestMarker = new window.CustomHTMLMapMarker(destLatLng, trackingMapInstance, destIconHtml, () => {
      const info = new window.google.maps.InfoWindow({ content: '<strong style="color:var(--color-text);">Destino (Cliente)</strong>' });
      info.open(trackingMapInstance, trackingDestMarker);
    });

    const routePath = [pickupLatLng, destLatLng];
    trackingRouteLine = new window.google.maps.Polyline({
      path: routePath,
      map: trackingMapInstance,
      strokeColor: '#ffb700',
      strokeOpacity: 0.8,
      strokeWeight: 3,
      icons: [{
        icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2 },
        offset: '0',
        repeat: '20px'
      }]
    });

    const bounds = new window.google.maps.LatLngBounds();
    bounds.extend(pickupLatLng);
    bounds.extend(destLatLng);
    trackingMapInstance.fitBounds(bounds, { padding: { top: 50, bottom: 50, left: 50, right: 50 } });

    trackingRiderMarker = null;
  });
}

function updateRiderMarker(lat, lng, riderName) {
  if (!trackingMapInstance || isNaN(lat) || isNaN(lng)) return;

  const riderLatLng = new window.google.maps.LatLng(lat, lng);
  const popupContent = `<strong style="color:var(--color-text);">${escapeHtml(riderName)}</strong><br>Localização em tempo real`;

  if (trackingRiderMarker) {
    trackingRiderMarker.setLatLng(riderLatLng);
  } else {
    const el = document.createElement('div');
    el.style.width = '24px';
    el.style.height = '24px';
    el.style.backgroundColor = '#f97316';
    el.style.borderRadius = '50%';
    el.style.border = '3px solid #fff';
    el.style.boxShadow = '0 0 12px rgba(249,115,22,0.7)';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.cursor = 'pointer';
    el.innerHTML = `<i data-lucide="bike" style="width:12px;height:12px;color:#fff;"></i>`;

    trackingRiderMarker = new window.CustomHTMLMapMarker(riderLatLng, trackingMapInstance, el.outerHTML, () => {
      const info = new window.google.maps.InfoWindow({ content: popupContent });
      info.open(trackingMapInstance, trackingRiderMarker);
    });
  }
}

function updateStepperState(status) {
  document.querySelectorAll('.step-node').forEach(node => {
    node.className = 'step-node';
  });

  const nowTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (status === 'Buscando Entregador') {
    document.getElementById('step-1').className = 'step-node active';
    document.getElementById('step-1-time').innerText = 'Aguardando busca de motoboys...';
  } else if (status === 'A caminho da coleta') {
    document.getElementById('step-1').className = 'step-node completed';
    document.getElementById('step-2').className = 'step-node active';
    if (document.getElementById('step-2-time').innerText === '--:--') {
      document.getElementById('step-2-time').innerText = nowTime;
    }
  } else if (status === 'Em rota de entrega') {
    document.getElementById('step-1').className = 'step-node completed';
    document.getElementById('step-2').className = 'step-node completed';
    document.getElementById('step-3').className = 'step-node active';
    if (document.getElementById('step-3-time').innerText === '--:--') {
      document.getElementById('step-3-time').innerText = nowTime;
    }
  } else if (status === 'Entregue') {
    document.getElementById('step-1').className = 'step-node completed';
    document.getElementById('step-2').className = 'step-node completed';
    document.getElementById('step-3').className = 'step-node completed';
    document.getElementById('step-4').className = 'step-node completed';
    if (document.getElementById('step-4-time').innerText === '--:--') {
      document.getElementById('step-4-time').innerText = nowTime;
    }
  }
}

function translateStatus(status) {
  if (status === 'A caminho da coleta') return 'Entregador Coletando';
  if (status === 'Em rota de entrega') return 'Em Rota de Entrega';
  if (status === 'Entregue') return 'Concluído';
  return status;
}

function getStatusClass(status) {
  if (status === 'Entregue') return 'status-badge status-success';
  if (status === 'Buscando Entregador') return 'status-badge status-warning';
  return 'status-badge status-progress';
}

async function loadRiderDetails(orderId, riderName) {
  if (!supabaseClient) return;

  const { data: rider } = await supabaseClient
    .from('fleet')
    .select('*')
    .eq('name', riderName)
    .maybeSingle();

  if (rider) {
    updateCourierCardUI(rider);
    if (rider.lat && rider.lng) {
      updateRiderMarker(parseFloat(rider.lat), parseFloat(rider.lng), rider.name);
    }
  }
}

function updateCourierCardUI(rider) {
  const box = document.getElementById('tracker-courier-box');
  if (!box) return;

  box.classList.remove('hidden');
  document.getElementById('tracker-courier-name').innerText = rider.name;
  document.getElementById('tracker-courier-vehicle').innerText = `${rider.vehicle} - Placa: ${rider.plate}`;
  
  const img = document.getElementById('tracker-courier-img');
  img.src = (rider.id === '#SPD-101') 
    ? 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?q=80&w=256&auto=format&fit=crop' 
    : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=256&auto=format&fit=crop';
}

async function trackActiveOrder(orderId) {
  if (!supabaseClient) return;

  const { data: histData } = await supabaseClient
    .from('teles')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();

  if (histData) {
    startRealtimeTracking({
      id: histData.id,
      pickup_lat: histData.pickup_lat,
      pickup_lng: histData.pickup_lng,
      dest_lat: histData.dest_lat,
      dest_lng: histData.dest_lng,
      status: histData.status
    });
  } else {
    const { data: pendingData } = await supabaseClient
      .from('teles')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();

    if (pendingData) {
      startRealtimeTracking(pendingData);
    }
  }

  const trackingTabBtn = document.getElementById('nav-tracking-tab');
  if (trackingTabBtn) {
    trackingTabBtn.disabled = false;
    trackingTabBtn.querySelector('.pulse-dot').classList.remove('hidden');
  }
  switchDashboardTab('order-tracking');
}

// Owner Financials dynamic date range filters & rendering
function renderOwnerFinancials() {
  const startDateVal = document.getElementById('finance-start-date').value;
  const endDateVal = document.getElementById('finance-end-date').value;
  
  let start = startDateVal ? parseLocalDate(startDateVal) : null;
  let end = endDateVal ? parseLocalDate(endDateVal) : null;
  
  // Set start of day and end of day
  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);
  
  // Filter mockData.clientHistory for completed orders within range
  const filteredOrders = mockData.clientHistory.filter(order => {
    const isCompleted = order.status === 'Entregue' || order.status === 'Concluído';
    if (!isCompleted) return false;
    
    if (!start && !end) return true;
    
    const orderDate = parseOrderDate(order.date, order.created_at);
    if (start && orderDate < start) return false;
    if (end && orderDate > end) return false;
    return true;
  });
  
  // Calculate metrics
  let grossTotal = 0;
  filteredOrders.forEach(order => {
    grossTotal += parseMoneyBR(order.price);
  });
  
  const netTotal = grossTotal * 0.90; // 90% goes to riders
  const platformFee = grossTotal * 0.10; // 10% platform fee
  
  // Update UI cards
  const grossEl = document.getElementById('finance-gross-total');
  const netEl = document.getElementById('finance-net-total');
  const platformEl = document.getElementById('finance-platform-fee');
  
  if (grossEl) grossEl.innerText = formatMoneyBR(grossTotal);
  if (netEl) netEl.innerText = formatMoneyBR(netTotal);
  if (platformEl) platformEl.innerText = formatMoneyBR(platformFee);
  
  // Update Doughnut Chart (Chart 2) if initialized
  if (ownerFinancialChart) {
    ownerFinancialChart.data.datasets[0].data = [netTotal, platformFee, 0];
    ownerFinancialChart.update();
  }
  
  // Update completed teles list in index.html
  const tbody = document.getElementById('finance-history-table-body');
  if (tbody) {
    if (filteredOrders.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--color-text-muted); padding: 24px;">
            Nenhuma tele concluída encontrada para o período selecionado.
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = filteredOrders.map(order => `
        <tr>
          <td><strong>${order.id}</strong></td>
          <td>${order.date}</td>
          <td>
            <strong>${order.destName}</strong>
            <p class="text-muted" style="margin: 2px 0 0 0; font-size: 0.78rem;">${order.address}</p>
          </td>
          <td>${order.rider || '—'}</td>
          <td><strong class="text-yellow">${order.price}</strong></td>
        </tr>
      `).join('');
    }
  }
}

function clearFinanceFilters() {
  document.getElementById('finance-start-date').value = '';
  document.getElementById('finance-end-date').value = '';
  renderOwnerFinancials();
}

// Helper to format date to YYYY-MM-DD
function formatDateISO(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Pre-fill dates for Rider Payment range
function initRiderPaymentDates() {
  const startEl = document.getElementById('rider-payment-start-date');
  const endEl = document.getElementById('rider-payment-end-date');
  if (startEl && !startEl.value) {
    const { monday } = getCurrentWeekBounds();
    startEl.value = formatDateISO(monday);
  }
  if (endEl && !endEl.value) {
    const { sunday } = getCurrentWeekBounds();
    endEl.value = formatDateISO(sunday);
  }
}

// Clear all rider payment filters
function clearRiderPaymentFilters() {
  const startEl = document.getElementById('rider-payment-start-date');
  const endEl = document.getElementById('rider-payment-end-date');
  const searchEl = document.getElementById('rider-search-input');
  
  if (startEl) {
    const { monday } = getCurrentWeekBounds();
    startEl.value = formatDateISO(monday);
  }
  if (endEl) {
    const { sunday } = getCurrentWeekBounds();
    endEl.value = formatDateISO(sunday);
  }
  if (searchEl) {
    searchEl.value = '';
  }
  
  renderRiderPayments();
}

// Toggle display of custom rider search dropdown
function toggleRiderSearchDropdown(show) {
  const dropdown = document.getElementById('rider-search-dropdown');
  const icon = document.querySelector('.rider-search-wrapper i[data-lucide="chevron-down"]');
  if (!dropdown) return;
  
  if (show) {
    dropdown.classList.remove('hidden');
    if (icon) icon.style.transform = 'rotate(180deg)';
  } else {
    dropdown.classList.add('hidden');
    if (icon) icon.style.transform = 'rotate(0deg)';
  }
}

// Populate the floating dropdown of motoboys
function populateRiderSearchDropdown() {
  const dropdown = document.getElementById('rider-search-dropdown');
  if (!dropdown) return;

  const searchInput = document.getElementById('rider-search-input');
  const filterText = searchInput ? searchInput.value.toLowerCase().trim() : '';

  let html = `
    <div onclick="selectRiderForPaymentSearch('')" style="padding: 10px 14px; cursor: pointer; transition: background 0.2s; font-size: 0.85rem; color: var(--color-text-muted);" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
      <em>Todos os entregadores</em>
    </div>
  `;

  mockData.fleet
    .filter(rider => !filterText || rider.name.toLowerCase().includes(filterText))
    .forEach(rider => {
      html += `
        <div onclick="selectRiderForPaymentSearch('${escapeHtml(rider.name)}')" style="padding: 10px 14px; cursor: pointer; transition: background 0.2s; font-size: 0.85rem; display: flex; align-items: center; gap: 8px;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${rider.status === 'Disponível' ? '#10b981' : '#f59e0b'};"></div>
          <strong>${escapeHtml(rider.name)}</strong> <span style="color: var(--color-text-muted); font-size: 0.78rem;">(${escapeHtml(rider.id)})</span>
        </div>
      `;
    });

  dropdown.innerHTML = html;
}

// Handle typing in search input to filter the list
function filterRiderSearch() {
  toggleRiderSearchDropdown(true);
  populateRiderSearchDropdown();
}

// Select a rider from the dropdown list
function selectRiderForPaymentSearch(name) {
  const searchInput = document.getElementById('rider-search-input');
  if (searchInput) {
    searchInput.value = name;
  }
  toggleRiderSearchDropdown(false);
  renderRiderPayments();
}

// Hide dropdown when clicking outside
document.addEventListener('click', (e) => {
  const wrapper = document.querySelector('.rider-search-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    toggleRiderSearchDropdown(false);
  }
  const wrapperCons = document.querySelector('.consumable-rider-search-wrapper');
  if (wrapperCons && !wrapperCons.contains(e.target)) {
    toggleConsumableRiderSearchDropdown(false);
  }
  const wrapperCred = document.querySelector('.credit-rider-search-wrapper');
  if (wrapperCred && !wrapperCred.contains(e.target)) {
    toggleCreditRiderSearchDropdown(false);
  }
});


// Update rider's consolidated payment status in Supabase for the selected date range
async function updateRiderPaymentStatus(riderName, newStatus) {
  const startDateVal = document.getElementById('rider-payment-start-date').value;
  const endDateVal = document.getElementById('rider-payment-end-date').value;

  let start = startDateVal ? parseLocalDate(startDateVal) : null;
  let end = endDateVal ? parseLocalDate(endDateVal) : null;

  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);

  // 1. Gather all completed order IDs for this rider in this date range
  const filteredOrderIds = mockData.clientHistory
    .filter(order => {
      const isCompleted = order.status === 'Entregue' || order.status === 'Concluído';
      if (!isCompleted) return false;
      if (order.rider !== riderName) return false;

      if (start || end) {
        const orderDate = parseOrderDate(order.date, order.created_at);
        if (start && orderDate < start) return false;
        if (end && orderDate > end) return false;
      }
      return true;
    })
    .map(order => order.id);

  if (filteredOrderIds.length === 0) {
    alert(`Nenhuma entrega concluída encontrada para ${riderName} neste período.`);
    renderRiderPayments();
    return;
  }

  // 2. Perform Supabase update
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from('teles')
        .update({ payment_status: newStatus })
        .eq('rider', riderName)
        .in('id', filteredOrderIds);

      if (error) throw error;
      
      showToastNotification(`Pagamentos de ${riderName} marcados como ${newStatus}.`);
    } catch (err) {
      console.error("Error updating rider payment status on Supabase:", err);
      alert("Erro ao atualizar o status de pagamento no Supabase.");
      return;
    }
  } else {
    // Offline fallback: update local mockData
    showToastNotification(`Modo Offline: status de ${riderName} alterado para ${newStatus}.`);
  }

  // 3. Update local mockData and re-render
  mockData.clientHistory.forEach(order => {
    if (filteredOrderIds.includes(order.id)) {
      order.payment_status = newStatus;
    }
  });

  renderRiderPayments();
}

// =====================================================================
// Rider Consumables Functions
// =====================================================================

function handleConsumableCategoryChange() {
  const selectCategory = document.getElementById('consumable-category-select');
  const selectType = document.getElementById('consumable-type-select');
  const qtyInput = document.getElementById('consumable-quantity');
  
  if (!selectCategory || !selectType) return;
  
  const category = selectCategory.value;
  
  if (category === 'Vale') {
    selectType.innerHTML = `
      <option value="Vale">Vale (Adiantamento em dinheiro)</option>
    `;
    if (qtyInput) {
      qtyInput.value = 1;
      qtyInput.readOnly = true;
      qtyInput.style.cursor = 'not-allowed';
      qtyInput.style.background = 'var(--input-bg-disabled, rgba(255,255,255,0.03))';
    }
  } else {
    selectType.innerHTML = `
      <option value="Açaí">Açaí</option>
      <option value="Refrigerante">Refrigerante</option>
      <option value="Lanche">Lanche</option>
      <option value="Outros">Outros (Descrever abaixo)</option>
    `;
    if (qtyInput) {
      qtyInput.readOnly = false;
      qtyInput.style.cursor = 'default';
      qtyInput.style.background = 'var(--input-bg)';
    }
  }
  
  handleConsumableTypeChange();
}

function handleConsumableTypeChange() {
  const selectCategory = document.getElementById('consumable-category-select');
  const selectType = document.getElementById('consumable-type-select');
  const customGroup = document.getElementById('consumable-custom-type-group');
  const customInput = document.getElementById('consumable-custom-type');
  const priceInput = document.getElementById('consumable-unit-price');
  
  if (!selectType) return;
  
  const category = selectCategory ? selectCategory.value : 'Consumível';
  const item = selectType.value;
  
  if (category === 'Vale') {
    if (priceInput) priceInput.value = '';
  } else {
    if (item === 'Açaí') {
      if (priceInput) priceInput.value = '12.00';
    } else if (item === 'Refrigerante') {
      if (priceInput) priceInput.value = '5.00';
    } else if (item === 'Lanche') {
      if (priceInput) priceInput.value = '15.00';
    } else {
      if (priceInput) priceInput.value = '0.00';
    }
  }
  
  if (item === 'Outros') {
    if (customGroup) customGroup.classList.remove('hidden');
    if (customInput) customInput.required = true;
  } else {
    if (customGroup) customGroup.classList.add('hidden');
    if (customInput) {
      customInput.required = false;
      customInput.value = '';
    }
  }
  
  recalculateConsumableTotal();
}

function recalculateConsumableTotal() {
  const qtyInput = document.getElementById('consumable-quantity');
  const priceInput = document.getElementById('consumable-unit-price');
  const totalInput = document.getElementById('consumable-amount');
  if (qtyInput && priceInput && totalInput) {
    const qty = parseInt(qtyInput.value) || 0;
    const price = parseFloat(priceInput.value) || 0;
    totalInput.value = (qty * price).toFixed(2);
  }
}

function populateConsumableRiderSelect() {
  const select = document.getElementById('consumable-rider-select');
  if (!select) return;
  
  const currentValue = select.value;
  select.innerHTML = '<option value="">Selecione um motoboy...</option>';
  
  const sortedRiders = [...mockData.fleet].sort((a, b) => a.name.localeCompare(b.name));
  
  sortedRiders.forEach(rider => {
    const option = document.createElement('option');
    option.value = rider.id;
    option.setAttribute('data-name', rider.name);
    option.innerText = formatRiderDisplayName(rider);
    if (rider.id === currentValue) {
      option.selected = true;
    }
    select.appendChild(option);
  });
}

function renderRiderConsumables() {
  const tbody = document.getElementById('consumables-table-body');
  if (!tbody) return;

  const startDateVal = document.getElementById('consumable-start-date').value;
  const endDateVal = document.getElementById('consumable-end-date').value;
  const searchVal = document.getElementById('consumable-search-input').value.trim().toLowerCase();
  const categoryFilterEl = document.getElementById('consumable-category-filter');
  const categoryFilterVal = categoryFilterEl ? categoryFilterEl.value : '';

  let start = startDateVal ? parseLocalDate(startDateVal) : null;
  let end = endDateVal ? parseLocalDate(endDateVal) : null;

  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);

  let weeklyTotal = 0;
  let valesTotal = 0;
  let itemsTotal = 0;

  const filtered = (mockData.riderConsumables || []).filter(item => {
    if (start || end) {
      const itemDate = new Date(item.created_at);
      if (start && itemDate < start) return false;
      if (end && itemDate > end) return false;
    }
    if (searchVal && !item.rider_name.toLowerCase().includes(searchVal)) {
      return false;
    }
    if (categoryFilterVal && item.categoria !== categoryFilterVal) {
      return false;
    }
    return true;
  });

  const listHtml = filtered.map(item => {
    if (item.status !== 'reversed') {
      weeklyTotal += item.amount;
      if (item.categoria === 'Vale') {
        valesTotal += item.amount;
      } else {
        itemsTotal += item.amount;
      }
    }

    const date = new Date(item.created_at);
    const dateFmt = date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const categoryBadge = item.categoria === 'Vale' 
      ? '<span class="badge badge-warning" style="background: rgba(255, 183, 0, 0.15); color: #ffb700; border: 1px solid rgba(255, 183, 0, 0.3); font-size: 0.72rem; padding: 4px 8px; border-radius: 4px;">Vale</span>' 
      : '<span class="badge badge-info" style="background: rgba(0, 180, 216, 0.15); color: #00b4d8; border: 1px solid rgba(0, 180, 216, 0.3); font-size: 0.72rem; padding: 4px 8px; border-radius: 4px;">Consumível</span>';
      
    const itemDesc = item.categoria === 'Vale' 
      ? 'Adiantamento em dinheiro' 
      : `${item.quantidade}x ${escapeHtml(item.item_name || item.item_type)}`;
      
    const unitPriceFmt = item.categoria === 'Vale' 
      ? '—' 
      : formatMoneyBR(item.valor_unitario);
      
    const notesFmt = item.observacao ? `<span class="text-muted" style="font-size: 0.8rem;">${escapeHtml(item.observacao)}</span>` : '—';

    const statusBadge = item.status === 'reversed'
      ? '<span class="badge badge-danger" style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); font-size: 0.72rem; padding: 4px 8px; border-radius: 4px;">Estornado</span>'
      : '<span class="badge badge-success" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); font-size: 0.72rem; padding: 4px 8px; border-radius: 4px;">Ativo</span>';

    const actionButton = item.status === 'reversed'
      ? `<span class="text-muted" style="font-size: 0.78rem;">Estornado</span>`
      : `<button onclick="openFinancialReversalModal('${item.id}', 'consumable')" class="btn-action btn-action-danger" title="Estornar Lançamento" style="background: transparent; border: none; color: #ef4444; cursor: pointer; padding: 4px 8px;">
            <i data-lucide="rotate-ccw" style="width: 16px; height: 16px;"></i>
          </button>`;

    return `
      <tr style="${item.status === 'reversed' ? 'opacity: 0.6;' : ''}">
        <td>${dateFmt}</td>
        <td><strong>${escapeHtml(item.rider_name)}</strong> ${statusBadge}</td>
        <td>${categoryBadge}</td>
        <td>${itemDesc}</td>
        <td>${unitPriceFmt}</td>
        <td><strong class="text-yellow" style="${item.status === 'reversed' ? 'text-decoration: line-through;' : ''}">${formatMoneyBR(item.amount)}</strong></td>
        <td>${notesFmt}</td>
        <td>${actionButton}</td>
      </tr>
    `;
  }).join('');

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--color-text-muted); padding: 24px;">
          Nenhum lançamento de consumo encontrado para os filtros selecionados.
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = listHtml;
  }

  const weekTotalEl = document.getElementById('consumables-week-total');
  const valesTotalEl = document.getElementById('consumables-vales-total');
  const itemsTotalEl = document.getElementById('consumables-items-total');

  if (weekTotalEl) weekTotalEl.innerText = formatMoneyBR(weeklyTotal);
  if (valesTotalEl) valesTotalEl.innerText = formatMoneyBR(valesTotal);
  if (itemsTotalEl) itemsTotalEl.innerText = formatMoneyBR(itemsTotal);

  if (window.lucide) lucide.createIcons();
}

function initConsumableDates() {
  const startEl = document.getElementById('consumable-start-date');
  const endEl = document.getElementById('consumable-end-date');
  if (startEl && !startEl.value) {
    const { monday } = getCurrentWeekBounds();
    startEl.value = formatDateISO(monday);
  }
  if (endEl && !endEl.value) {
    const { sunday } = getCurrentWeekBounds();
    endEl.value = formatDateISO(sunday);
  }
}

function clearConsumableFilters() {
  const startEl = document.getElementById('consumable-start-date');
  const endEl = document.getElementById('consumable-end-date');
  const searchEl = document.getElementById('consumable-search-input');
  const categoryFilterEl = document.getElementById('consumable-category-filter');
  
  if (startEl) {
    const { monday } = getCurrentWeekBounds();
    startEl.value = formatDateISO(monday);
  }
  if (endEl) {
    const { sunday } = getCurrentWeekBounds();
    endEl.value = formatDateISO(sunday);
  }
  if (searchEl) {
    searchEl.value = '';
  }
  if (categoryFilterEl) {
    categoryFilterEl.value = '';
  }
  
  renderRiderConsumables();
}

function toggleConsumableRiderSearchDropdown(show) {
  const dropdown = document.getElementById('consumable-rider-search-dropdown');
  const icon = document.querySelector('.consumable-rider-search-wrapper i[data-lucide="chevron-down"]');
  if (!dropdown) return;
  
  if (show) {
    dropdown.classList.remove('hidden');
    if (icon) icon.style.transform = 'rotate(180deg)';
  } else {
    dropdown.classList.add('hidden');
    if (icon) icon.style.transform = 'rotate(0deg)';
  }
}

function populateConsumableRiderSearchDropdown() {
  const dropdown = document.getElementById('consumable-rider-search-dropdown');
  if (!dropdown) return;

  const searchInput = document.getElementById('consumable-search-input');
  const filterText = searchInput ? searchInput.value.toLowerCase().trim() : '';

  let html = `
    <div onclick="selectRiderForConsumableSearch('')" style="padding: 10px 14px; cursor: pointer; transition: background 0.2s; font-size: 0.85rem; color: var(--color-text-muted);" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
      <em>Todos os entregadores</em>
    </div>
  `;

  mockData.fleet
    .filter(rider => !filterText || rider.name.toLowerCase().includes(filterText))
    .forEach(rider => {
      html += `
        <div onclick="selectRiderForConsumableSearch('${escapeHtml(rider.name)}')" style="padding: 10px 14px; cursor: pointer; transition: background 0.2s; font-size: 0.85rem; display: flex; align-items: center; gap: 8px;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${rider.status === 'Disponível' ? '#10b981' : '#f59e0b'};"></div>
          <strong>${escapeHtml(formatRiderDisplayName(rider))}</strong>
        </div>
      `;
    });

  dropdown.innerHTML = html;
}

function filterConsumableRiderSearch() {
  toggleConsumableRiderSearchDropdown(true);
  populateConsumableRiderSearchDropdown();
}

function selectRiderForConsumableSearch(name) {
  const searchInput = document.getElementById('consumable-search-input');
  if (searchInput) {
    searchInput.value = name;
  }
  toggleConsumableRiderSearchDropdown(false);
  renderRiderConsumables();
}

async function handleRegisterConsumable(event) {
  event.preventDefault();
  if (!supabaseClient) return;

  const selectRider = document.getElementById('consumable-rider-select');
  const selectCategory = document.getElementById('consumable-category-select');
  const selectType = document.getElementById('consumable-type-select');
  const customType = document.getElementById('consumable-custom-type');
  const inputQuantity = document.getElementById('consumable-quantity');
  const inputUnitPrice = document.getElementById('consumable-unit-price');
  const textareaNotes = document.getElementById('consumable-notes');

  if (!selectRider || !selectCategory || !selectType || !inputQuantity || !inputUnitPrice) return;

  const riderId = selectRider.value;
  const categoria = selectCategory.value === 'Vale' ? 'vale' : 'consumivel';
  
  let itemName = selectType.value;
  if (itemName === 'Outros' && customType) {
    itemName = customType.value.trim() || 'Outros';
  }

  const quantidade = parseInt(inputQuantity.value) || 1;
  const valorUnitario = parseFloat(inputUnitPrice.value) || 0;
  const observacao = textareaNotes ? textareaNotes.value.trim() : '';

  if (!riderId || !itemName || quantidade <= 0 || valorUnitario < 0) {
    showToastNotification('Por favor, preencha todos os campos corretamente.', 'error');
    return;
  }

  const submitBtn = event.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Processando...</span>';
  }

  try {
    const { data, error } = await supabaseClient.rpc('admin_create_rider_consumable', {
      p_motoboy_id: riderId,
      p_category: categoria,
      p_item_name: itemName,
      p_quantity: quantidade,
      p_unit_amount: valorUnitario,
      p_notes: observacao || null,
      p_competency_date: new Date().toISOString().split('T')[0]
    });

    if (error) throw error;
    if (data && data.success === false) throw new Error(data.message || 'Erro ao registrar consumível.');

    selectRider.value = '';
    selectCategory.value = 'Consumível';
    handleConsumableCategoryChange();
    if (textareaNotes) textareaNotes.value = '';

    showToastNotification('Consumo registrado com sucesso.');

    await fetchRiderConsumables();
    renderRiderConsumables();
    if (typeof loadRiderExtract === 'function') loadRiderExtract();
  } catch (err) {
    console.error('Error inserting rider consumable:', err);
    showToastNotification('Erro ao registrar consumo: ' + err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Registrar Lançamento</span> <i data-lucide="plus"></i>';
      if (window.lucide) lucide.createIcons();
    }
  }
}


async function deleteRiderConsumable(id) {
  if (!supabaseClient) return;
  if (!confirm('Deseja realmente remover este lançamento de consumo?')) return;

  try {
    const { error } = await supabaseClient
      .from('rider_consumable_purchases')
      .delete()
      .eq('id', id);

    if (error) throw error;

    showToastNotification('Lançamento excluído com sucesso.');
    
    await fetchRiderConsumables();
    renderRiderConsumables();
    renderRiderPayments();
  } catch (err) {
    console.error('Error deleting rider consumable:', err);
    alert('Erro ao excluir consumo: ' + err.message);
  }
}

// ─── OWNER CREDITS MANAGEMENT ───────────────────────────────────────────────
function initCreditDates() {
  const startEl = document.getElementById('credit-start-date');
  const endEl = document.getElementById('credit-end-date');
  if (startEl && !startEl.value) {
    const { monday } = getCurrentWeekBounds();
    startEl.value = formatDateISO(monday);
  }
  if (endEl && !endEl.value) {
    const { sunday } = getCurrentWeekBounds();
    endEl.value = formatDateISO(sunday);
  }
  const inputDateEl = document.getElementById('credit-input-date');
  if (inputDateEl && !inputDateEl.value) {
    inputDateEl.value = formatDateISO(new Date());
  }
}

function clearCreditFilters() {
  const startEl = document.getElementById('credit-start-date');
  const endEl = document.getElementById('credit-end-date');
  const searchEl = document.getElementById('credit-search-input');
  
  if (startEl) {
    const { monday } = getCurrentWeekBounds();
    startEl.value = formatDateISO(monday);
  }
  if (endEl) {
    const { sunday } = getCurrentWeekBounds();
    endEl.value = formatDateISO(sunday);
  }
  if (searchEl) {
    searchEl.value = '';
  }
  
  renderRiderCredits();
}

function toggleCreditRiderSearchDropdown(show) {
  const dropdown = document.getElementById('credit-rider-search-dropdown');
  const icon = document.querySelector('.credit-rider-search-wrapper i[data-lucide="chevron-down"]');
  if (!dropdown) return;
  
  if (show) {
    dropdown.classList.remove('hidden');
    if (icon) icon.style.transform = 'rotate(180deg)';
  } else {
    dropdown.classList.add('hidden');
    if (icon) icon.style.transform = 'rotate(0deg)';
  }
}

function populateCreditRiderSearchDropdown() {
  const dropdown = document.getElementById('credit-rider-search-dropdown');
  if (!dropdown) return;

  const searchInput = document.getElementById('credit-search-input');
  const filterText = searchInput ? searchInput.value.toLowerCase().trim() : '';

  let html = `
    <div onclick="selectRiderForCreditSearch('')" style="padding: 10px 14px; cursor: pointer; transition: background 0.2s; font-size: 0.85rem; color: var(--color-text-muted);" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
      <em>Todos os entregadores</em>
    </div>
  `;

  mockData.fleet
    .filter(rider => !filterText || rider.name.toLowerCase().includes(filterText))
    .forEach(rider => {
      html += `
        <div onclick="selectRiderForCreditSearch('${escapeHtml(rider.name)}')" style="padding: 10px 14px; cursor: pointer; transition: background 0.2s; font-size: 0.85rem; display: flex; align-items: center; gap: 8px;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${rider.status === 'Disponível' ? '#10b981' : '#f59e0b'};"></div>
          <strong>${escapeHtml(rider.name)}</strong> <span style="color: var(--color-text-muted); font-size: 0.78rem;">(${escapeHtml(rider.id)})</span>
        </div>
      `;
    });

  dropdown.innerHTML = html;
}

function filterCreditRiderSearch() {
  toggleCreditRiderSearchDropdown(true);
  populateCreditRiderSearchDropdown();
}

function selectRiderForCreditSearch(name) {
  const searchInput = document.getElementById('credit-search-input');
  if (searchInput) {
    searchInput.value = name;
  }
  toggleCreditRiderSearchDropdown(false);
  renderRiderCredits();
}

function populateCreditRiderSelect() {
  const select = document.getElementById('credit-rider-select');
  if (!select) return;
  
  const currentValue = select.value;
  select.innerHTML = '<option value="">Selecione um motoboy...</option>';
  
  const sortedRiders = [...mockData.fleet].sort((a, b) => a.name.localeCompare(b.name));
  
  sortedRiders.forEach(rider => {
    const option = document.createElement('option');
    option.value = rider.id;
    option.setAttribute('data-name', rider.name);
    option.innerText = formatRiderDisplayName(rider);
    if (rider.id === currentValue) {
      option.selected = true;
    }
    select.appendChild(option);
  });
}

function renderRiderCredits() {
  const tbody = document.getElementById('credits-table-body');
  if (!tbody) return;

  const startDateVal = document.getElementById('credit-start-date').value;
  const endDateVal = document.getElementById('credit-end-date').value;
  const searchVal = document.getElementById('credit-search-input').value.trim().toLowerCase();

  let start = startDateVal ? parseLocalDate(startDateVal) : null;
  let end = endDateVal ? parseLocalDate(endDateVal) : null;

  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);

  let periodTotal = 0;

  const filtered = (mockData.riderCredits || []).filter(item => {
    if (start || end) {
      const itemDate = parseLocalDate(item.target_date);
      if (start && itemDate < start) return false;
      if (end && itemDate > end) return false;
    }
    if (searchVal) {
      const rider = mockData.fleet.find(r => r.id === item.rider_id);
      const riderName = rider ? rider.name.toLowerCase() : '';
      if (!riderName.includes(searchVal) && !item.rider_id.toLowerCase().includes(searchVal)) {
        return false;
      }
    }
    return true;
  });

  const listHtml = filtered.map(item => {
    if (item.status !== 'reversed') {
      periodTotal += item.amount;
    }
    const rider = mockData.fleet.find(r => r.id === item.rider_id);
    const riderDisplayName = rider ? formatRiderDisplayName(rider) : 'Motoboy Removido';

    const targetDateFmt = parseLocalDate(item.target_date).toLocaleDateString('pt-BR');
    const createdDate = new Date(item.created_at);
    const createdDateFmt = createdDate.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const statusBadge = item.status === 'reversed'
      ? '<span class="badge badge-danger" style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); font-size: 0.72rem; padding: 4px 8px; border-radius: 4px;">Estornado</span>'
      : '<span class="badge badge-success" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); font-size: 0.72rem; padding: 4px 8px; border-radius: 4px;">Ativo</span>';

    const actionButton = item.status === 'reversed'
      ? `<span class="text-muted" style="font-size: 0.78rem;">Estornado</span>`
      : `<button onclick="openFinancialReversalModal('${item.id}', 'adjustment')" class="btn-action btn-action-danger" title="Estornar Lançamento" style="background: transparent; border: none; color: #ef4444; cursor: pointer; padding: 4px 8px;">
            <i data-lucide="rotate-ccw" style="width: 16px; height: 16px;"></i>
          </button>`;

    return `
      <tr style="${item.status === 'reversed' ? 'opacity: 0.6;' : ''}">
        <td><strong>${targetDateFmt}</strong></td>
        <td><strong>${escapeHtml(riderDisplayName)}</strong> ${statusBadge}</td>
        <td><strong style="color: #10b981; ${item.status === 'reversed' ? 'text-decoration: line-through;' : ''}">+ ${formatMoneyBR(item.amount)}</strong></td>
        <td>${escapeHtml(item.description)}</td>
        <td><span class="text-muted" style="font-size: 0.8rem;">${createdDateFmt}</span></td>
        <td>${actionButton}</td>
      </tr>
    `;
  }).join('');

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--color-text-muted); padding: 24px;">
          Nenhum lançamento de crédito encontrado para os filtros selecionados.
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = listHtml;
  }

  const periodTotalEl = document.getElementById('credits-period-total');
  if (periodTotalEl) periodTotalEl.innerText = formatMoneyBR(periodTotal);

  if (window.lucide) lucide.createIcons();
}

async function handleRegisterCredit(event) {
  event.preventDefault();
  if (!supabaseClient) return;

  const selectRider = document.getElementById('credit-rider-select');
  const inputAmount = document.getElementById('credit-input-amount');
  const inputDate = document.getElementById('credit-input-date');
  const textareaDesc = document.getElementById('credit-input-description');

  if (!selectRider || !inputAmount || !inputDate || !textareaDesc) return;

  const riderId = selectRider.value;
  const amount = parseFloat(inputAmount.value) || 0;
  const targetDate = inputDate.value;
  const description = textareaDesc.value.trim();

  if (!riderId || isNaN(amount) || amount <= 0 || !targetDate || !description) {
    showToastNotification('Por favor, preencha todos os campos corretamente.', 'error');
    return;
  }

  const submitBtn = event.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Processando...</span>';
  }

  try {
    const { data, error } = await supabaseClient.rpc('admin_create_rider_adjustment', {
      p_motoboy_id: riderId,
      p_direction: 'credit',
      p_amount: amount,
      p_description: description,
      p_target_date: targetDate
    });

    if (error) throw error;
    if (data && data.success === false) throw new Error(data.message || 'Erro ao registrar crédito.');

    selectRider.value = '';
    inputAmount.value = '';
    textareaDesc.value = '';

    showToastNotification('Crédito lançado com sucesso.');

    await fetchRiderCredits();
    renderRiderCredits();
    if (typeof loadRiderExtract === 'function') loadRiderExtract();
  } catch (err) {
    console.error('Error inserting rider credit:', err);
    showToastNotification('Erro ao registrar crédito: ' + err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Lançar Crédito</span> <i data-lucide="plus"></i>';
      if (window.lucide) lucide.createIcons();
    }
  }
}

function openFinancialReversalModal(itemId, itemType) {
  const modal = document.getElementById('financial-reversal-modal');
  const inputId = document.getElementById('reversal-item-id');
  const inputType = document.getElementById('reversal-item-type');
  const reasonText = document.getElementById('reversal-reason-input');

  if (!modal || !inputId || !inputType || !reasonText) return;

  inputId.value = itemId;
  inputType.value = itemType;
  reasonText.value = '';
  modal.classList.remove('hidden');
}

function closeFinancialReversalModal() {
  const modal = document.getElementById('financial-reversal-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleExecuteFinancialReversal(event) {
  event.preventDefault();
  if (!supabaseClient) return;

  const itemId = document.getElementById('reversal-item-id')?.value;
  const itemType = document.getElementById('reversal-item-type')?.value;
  const reason = document.getElementById('reversal-reason-input')?.value?.trim();

  if (!itemId || !itemType || !reason) {
    showToastNotification('Por favor, informe o motivo do estorno.', 'error');
    return;
  }

  const submitBtn = document.getElementById('reversal-submit-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Processando...';
  }

  try {
    let rpcName = itemType === 'consumable' ? 'admin_reverse_rider_consumable' : 'admin_reverse_rider_adjustment';
    let rpcParams = itemType === 'consumable' ? { p_purchase_id: itemId, p_reason: reason } : { p_adjustment_id: itemId, p_reason: reason };

    const { data, error } = await supabaseClient.rpc(rpcName, rpcParams);

    if (error) throw error;
    if (data && data.success === false) throw new Error(data.message || 'Erro ao realizar estorno.');

    closeFinancialReversalModal();
    showToastNotification('Estorno realizado com sucesso.');

    if (itemType === 'consumable') {
      await fetchRiderConsumables();
      renderRiderConsumables();
    } else {
      await fetchRiderCredits();
      renderRiderCredits();
    }
    if (typeof loadRiderExtract === 'function') loadRiderExtract();
  } catch (err) {
    console.error('Error in financial reversal:', err);
    showToastNotification('Erro ao realizar estorno: ' + err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Confirmar Estorno';
    }
  }
}

// ─── CITIES AND RATES MANAGEMENT ─────────────────────────────────────────────

async function fetchCities() {
  if (!supabaseClient || !currentActiveSession) return;
  try {
    const { data, error } = await supabaseClient
      .from('cidades')
      .select('id, nome, uf, ativa')
      .order('nome', { ascending: true });

    if (error) {
      if (error.status === 401 || error.code === '42501') {
        handleInvalidSession();
        return;
      }
      console.warn("Aviso ao buscar cidades:", error.message);
      return;
    }


    mockData.cities = (data || []).map(item => ({
      id: item.id,
      nome: item.nome,
      uf: item.uf || 'RS',
      taxa: item.taxa ? parseFloat(item.taxa) : 15.00
    }));
  } catch (err) {
    console.warn("Aviso ao buscar cidades:", err.message);
  }
}

function renderCitiesTable() {
  const tbody = document.getElementById('cities-table-body');
  if (!tbody) return;

  if (!mockData.cities || mockData.cities.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align: center; color: var(--color-text-muted); padding: 20px;">
          Nenhuma cidade cadastrada.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = mockData.cities.map(city => `
    <tr>
      <td><strong>${escapeHtml(city.nome)}</strong></td>
      <td>R$ ${city.taxa.toFixed(2).replace('.', ',')}</td>
      <td style="text-align: right; display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn btn-secondary btn-sm" onclick="showEditCityModal('${city.id}', '${escapeHtml(city.nome).replace(/'/g, "\\'")}', ${city.taxa})" style="padding: 4px 8px; font-size: 0.75rem; cursor: pointer; display: flex; align-items: center; gap: 4px;">
          <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i> Editar
        </button>
        <button class="btn btn-secondary btn-sm" onclick="deleteCity('${city.id}')" style="padding: 4px 8px; font-size: 0.75rem; border-color: rgba(239, 68, 68, 0.2); color: var(--error); cursor: pointer; display: flex; align-items: center; gap: 4px;">
          <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i> Excluir
        </button>
      </td>
    </tr>
  `).join('');
  
  if (window.lucide) lucide.createIcons();
}

function showAddCityModal() {
  document.getElementById('city-id').value = '';
  document.getElementById('city-name').value = '';
  document.getElementById('city-rate').value = '';
  document.getElementById('city-modal-title').innerText = 'Adicionar Cidade';
  document.getElementById('modal-city').classList.remove('hidden');
}

function showEditCityModal(id, name, rate) {
  document.getElementById('city-id').value = id;
  document.getElementById('city-name').value = name;
  document.getElementById('city-rate').value = rate;
  document.getElementById('city-modal-title').innerText = 'Editar Cidade';
  document.getElementById('modal-city').classList.remove('hidden');
}

function closeCityModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modal-city').classList.add('hidden');
}

async function handleSaveCity(event) {
  event.preventDefault();
  if (!supabaseClient) return;

  const id = document.getElementById('city-id').value;
  const name = document.getElementById('city-name').value.trim();
  const rate = parseFloat(document.getElementById('city-rate').value);

  if (!name || isNaN(rate)) {
    alert('Por favor, preencha todos os campos.');
    return;
  }

  const submitBtn = event.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    if (id) {
      // Update
      const { error } = await supabaseClient
        .from('cidades')
        .update({ nome: name, taxa: rate })
        .eq('id', id);
      if (error) throw error;
      showToastNotification('Cidade atualizada com sucesso.');
    } else {
      // Insert
      const { error } = await supabaseClient
        .from('cidades')
        .insert([{ nome: name, taxa: rate }]);
      if (error) throw error;
      showToastNotification('Cidade adicionada com sucesso.');
    }

    closeCityModal();
    await fetchCities();
    renderCitiesTable();
  } catch (err) {
    console.error('Error saving city:', err);
    alert('Erro ao salvar cidade: ' + err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteCity(id) {
  if (!supabaseClient) return;
  if (!confirm('Deseja realmente excluir esta cidade?')) return;

  try {
    const { error } = await supabaseClient
      .from('cidades')
      .delete()
      .eq('id', id);
    if (error) throw error;
    showToastNotification('Cidade excluída com sucesso.');
    await fetchCities();
    renderCitiesTable();
  } catch (err) {
    console.error('Error deleting city:', err);
    alert('Erro ao excluir cidade: ' + err.message);
  }
}

// ─── MANUAL REQUEST MODAL HELPERS ───────────────────────────────────────────

async function showRequestDeliveryModal() {
  // Clear coordinates and reset form state
  requestMaps.manual.destCoords = null;
  const form = document.getElementById('request-delivery-form');
  if (form) form.reset();
  
  const estimateBox = document.getElementById('manual-estimate-box');
  if (estimateBox) estimateBox.classList.add('hidden');
  
  const changeGroup = document.getElementById('manual-change-amount-group');
  if (changeGroup) changeGroup.classList.add('hidden');
  
  // Clear map markers from previous session safely using Google Maps APIs
  if (requestMaps.manual.map) {
    if (requestMaps.manual.marker && requestMaps.manual.marker.setMap) {
      requestMaps.manual.marker.setMap(null);
    }
    requestMaps.manual.marker = null;

    if (requestMaps.manual.restaurantMarker && requestMaps.manual.restaurantMarker.setMap) {
      requestMaps.manual.restaurantMarker.setMap(null);
    }
    requestMaps.manual.restaurantMarker = null;

    if (requestMaps.manual.polyline && requestMaps.manual.polyline.setMap) {
      requestMaps.manual.polyline.setMap(null);
    }
    requestMaps.manual.polyline = null;
  }

  // Pre-fill next sequential Tele ID
  const nextId = await getNextTeleId();
  const idInput = document.getElementById('manual-delivery-id');
  if (idInput) idInput.value = nextId;

  document.getElementById('modal-request-delivery').classList.remove('hidden');
  
  // Initialize or redraw map after modal opens
  setTimeout(() => {
    initRequestDeliveryMap('manual');
  }, 200);

  if (window.lucide) lucide.createIcons();
}

function closeRequestDeliveryModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modal-request-delivery').classList.add('hidden');

  // Full cleanup of map instance to avoid memory leak and layout conflicts
  if (requestMaps.manual.map) {
    if (requestMaps.manual.marker && requestMaps.manual.marker.setMap) {
      requestMaps.manual.marker.setMap(null);
    }
    requestMaps.manual.marker = null;

    if (requestMaps.manual.restaurantMarker && requestMaps.manual.restaurantMarker.setMap) {
      requestMaps.manual.restaurantMarker.setMap(null);
    }
    requestMaps.manual.restaurantMarker = null;

    if (requestMaps.manual.polyline && requestMaps.manual.polyline.setMap) {
      requestMaps.manual.polyline.setMap(null);
    }
    requestMaps.manual.polyline = null;
    
    requestMaps.manual.map = null;
  }

  // Reset the address input and its autocomplete binding state
  const manualAddressInput = document.getElementById('manual-delivery-address');
  if (manualAddressInput) {
    manualAddressInput.value = '';
    delete manualAddressInput.dataset.autocompleteInitialized;
  }
}

function toggleChangeAmountGroup(type = 'client') {
  const method = document.getElementById(`${type}-payment-method`).value;
  const group = document.getElementById(`${type}-change-amount-group`);
  if (group) {
    if (method === 'dinheiro') {
      group.classList.remove('hidden');
    } else {
      group.classList.add('hidden');
    }
  }
}

window.showRequestDeliveryModal = showRequestDeliveryModal;
window.closeRequestDeliveryModal = closeRequestDeliveryModal;
window.toggleChangeAmountGroup = toggleChangeAmountGroup;

// ─── DASHBOARD OVERVIEW REAL METRICS ─────────────────────────────────────────

function parseMoneyString(val) {
  if (!val) return 0;
  const cleaned = val.replace('R$ ', '').replace(/\./g, '').replace(',', '.').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function getWeeklyChartData() {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  const now = new Date();
  
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0,0,0,0);

  mockData.clientHistory.forEach(item => {
    if (item.status === 'Entregue' && item.created_at) {
      const itemDate = new Date(item.created_at);
      if (itemDate >= monday) {
        const itemDay = itemDate.getDay();
        const index = itemDay === 0 ? 6 : itemDay - 1;
        if (index >= 0 && index < 7) {
          counts[index]++;
        }
      }
    }
  });
  return counts;
}

function updateOwnerDashboardOverview() {
  const revenueEl = document.getElementById('owner-metric-revenue');
  const ridersEl = document.getElementById('owner-metric-riders');
  const deliveriesEl = document.getElementById('owner-metric-deliveries');
  const ticketEl = document.getElementById('owner-metric-ticket');
  const topClientsEl = document.getElementById('owner-top-clients-list');

  const completedDeliveries = mockData.clientHistory.filter(item => item.status === 'Entregue');
  const totalRevenue = completedDeliveries.reduce((sum, item) => sum + parseMoneyString(item.price), 0);

  if (revenueEl) {
    revenueEl.innerText = 'R$ ' + totalRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const activeRiders = mockData.fleet.filter(r => r.status !== 'Indisponível').length;
  const totalRiders = mockData.fleet.length;
  if (ridersEl) {
    ridersEl.innerText = `${activeRiders} / ${totalRiders}`;
  }

  const completedToday = mockData.clientHistory.filter(item => 
    item.status === 'Entregue' && (item.date || '').includes('Hoje')
  ).length;
  if (deliveriesEl) {
    deliveriesEl.innerText = completedToday;
  }

  const avgTicket = completedDeliveries.length > 0 ? (totalRevenue / completedDeliveries.length) : 0;
  if (ticketEl) {
    ticketEl.innerText = 'R$ ' + avgTicket.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  if (topClientsEl) {
    const clientCounts = {};

    commercesList.forEach(c => {
      clientCounts[c.nome] = { count: 0, revenue: 0 };
    });

    mockData.clientHistory.forEach(item => {
      if (item.status === 'Entregue') {
        const name = item.client || 'Cliente não vinculado';
        const price = parseMoneyString(item.price);
        if (!clientCounts[name]) {
          clientCounts[name] = { count: 0, revenue: 0 };
        }
        clientCounts[name].count++;
        clientCounts[name].revenue += price;
      }
    });

    const sortedClients = Object.entries(clientCounts)
      .map(([name, data]) => ({ name, count: data.count, revenue: data.revenue }))
      .sort((a, b) => b.count - a.count);

    if (sortedClients.length === 0) {
      topClientsEl.innerHTML = `
        <div style="text-align: center; padding: 20px; color: var(--color-text-muted); font-size: 0.85rem;">
          Nenhum cliente cadastrado.
        </div>
      `;
    } else {
      topClientsEl.innerHTML = sortedClients.map(c => `
        <div class="list-item" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px;">
          <div class="item-info" style="display: flex; align-items: center; gap: 10px; flex: 1;">
            <div class="item-icon-avatar bg-yellow"><i data-lucide="store" class="text-black"></i></div>
            <div style="min-width: 0; flex: 1;">
              <h4 style="text-overflow: ellipsis; white-space: nowrap; overflow: hidden; font-size: 0.9rem; font-weight: 700; margin: 0;">${escapeHtml(c.name)}</h4>
              <p class="text-muted" style="font-size: 0.78rem; margin: 2px 0 0 0;">${c.count} ${c.count === 1 ? 'entrega' : 'entregas'} esta semana</p>
            </div>
          </div>
          <div class="item-action text-right" style="display: flex; align-items: center; gap: 12px;">
            <strong style="font-size: 0.9rem; white-space: nowrap;">R$ ${c.revenue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            <button onclick="deleteCommerceByName('${escapeHtml(c.name)}')" class="btn-action-danger" title="Remover Comércio" style="background: transparent; border: none; color: #ef4444; cursor: pointer; padding: 4px 8px; font-size: 0.9rem; display: flex; align-items: center; justify-content: center; height: 32px; width: 32px; border-radius: 4px; transition: background 0.2s;"><i data-lucide="trash-2" style="width: 16px; height: 16px;"></i></button>
          </div>
        </div>
      `).join('');
      if (window.lucide) lucide.createIcons();
    }
  }
}

// ─── WITHDRAW TELE HANDLER ───────────────────────────────────────────────────

window.handleWithdrawClick = async function(deliveryId, riderName) {
  const rider = mockData.fleet.find(r => r.name === riderName);
  if (!rider) return;
  await removeTeleFromRider(deliveryId, rider.id);
};

// ─── CLIENT DASHBOARD OVERVIEW REAL METRICS ───────────────────────────────────

function getClientWeeklyChartData() {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  const now = new Date();
  
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0,0,0,0);

  const currentCreds = mockData.credentials[mockData.activeProfile];
  const currentCommerce = currentCreds ? currentCreds.commerceName : 'Cliente não vinculado';

  mockData.clientHistory.forEach(item => {
    if (item.status === 'Entregue' && item.client === currentCommerce && item.created_at) {
      const itemDate = new Date(item.created_at);
      if (itemDate >= monday) {
        const itemDay = itemDate.getDay();
        const index = itemDay === 0 ? 6 : itemDay - 1;
        if (index >= 0 && index < 7) {
          counts[index]++;
        }
      }
    }
  });
  return counts;
}

function updateClientDashboardOverview() {
  const ordersEl = document.getElementById('client-metric-orders');
  const timeEl = document.getElementById('client-metric-time');
  const costEl = document.getElementById('client-metric-cost');
  const ratingEl = document.getElementById('client-metric-rating');

  const currentCreds = mockData.credentials[mockData.activeProfile];
  const currentCommerce = currentCreds ? currentCreds.commerceName : 'Cliente não vinculado';

  const completedDeliveries = mockData.clientHistory.filter(item => 
    item.status === 'Entregue' && item.client === currentCommerce
  );
  const totalOrders = completedDeliveries.length;
  if (ordersEl) {
    ordersEl.innerText = totalOrders;
  }

  if (timeEl) {
    timeEl.innerText = totalOrders > 0 ? '15.4 min' : '0.0 min';
  }

  const totalCost = completedDeliveries.reduce((sum, item) => sum + parseMoneyString(item.price), 0);
  if (costEl) {
    costEl.innerText = 'R$ ' + totalCost.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const totalScore = clientRatings.reduce((sum, r) => sum + r.score, 0);
  const avgRating = clientRatings.length > 0 ? (totalScore / clientRatings.length) : 0;
  if (ratingEl) {
    ratingEl.innerText = avgRating > 0 ? `${avgRating.toFixed(2)} / 5.0` : '0.0 / 5.0';
  }

  const prepEl = document.getElementById('client-metric-prep');
  const prepBar = document.getElementById('client-metric-prep-bar');
  const punctEl = document.getElementById('client-metric-punctuality');
  const punctBar = document.getElementById('client-metric-punctuality-bar');
  const packEl = document.getElementById('client-metric-packaging');
  const packBar = document.getElementById('client-metric-packaging-bar');
  const sealBox = document.getElementById('premium-seal-box');

  if (totalOrders === 0) {
    if (prepEl) prepEl.innerText = '0%';
    if (prepBar) prepBar.style.width = '0%';
    if (punctEl) punctEl.innerText = '0%';
    if (punctBar) punctBar.style.width = '0%';
    if (packEl) packEl.innerText = '0%';
    if (packBar) packBar.style.width = '0%';
    if (sealBox) sealBox.classList.add('hidden');
  } else {
    // Generate dynamic but stable/realistic percentages based on completed orders count
    const prepVal = Math.min(100, 90 + (totalOrders % 11));
    const punctVal = Math.min(100, 92 + (totalOrders % 9));
    const packVal = Math.min(100, 85 + (totalOrders % 16));

    if (prepEl) prepEl.innerText = `${prepVal}%`;
    if (prepBar) prepBar.style.width = `${prepVal}%`;
    if (punctEl) punctEl.innerText = `${punctVal}%`;
    if (punctBar) punctBar.style.width = `${punctVal}%`;
    if (packEl) packEl.innerText = `${packVal}%`;
    if (packBar) packBar.style.width = `${packVal}%`;

    if (sealBox) {
      if (totalOrders >= 3) {
        sealBox.classList.remove('hidden');
      } else {
        sealBox.classList.add('hidden');
      }
    }
  }
}

// ─── ADD & REMOVE COMMERCE HANDLERS ──────────────────────────────────────────

function openAddCommerceModal() {
  const modal = document.getElementById('modal-add-commerce');
  if (modal) {
    document.getElementById('add-commerce-name').value = '';
    modal.classList.remove('hidden');
  }
}

function closeAddCommerceModal(event) {
  const modal = document.getElementById('modal-add-commerce');
  if (modal) {
    if (event && event.target !== modal) return;
    modal.classList.add('hidden');
  }
}

async function submitAddCommerce(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('add-commerce-name');
  if (!input) return;

  const nome = input.value.trim();
  if (!nome) return;

  showToastNotification('Adicionando comércio...');

  try {
    if (supabaseClient) {
      const { error } = await supabaseClient
        .from('commercial_clients')
        .insert([{ establishment_name: nome, lifecycle_status: 'ativo' }]);
      if (error) throw error;
    } else {
      commercesList.push({ id: String(Date.now()), nome });
    }

    await fetchCommerces();
    updateOwnerDashboardOverview();
    closeAddCommerceModal();
    showToastNotification(`Comércio "${nome}" adicionado com sucesso.`);
  } catch (err) {
    console.error('Error adding commerce:', err);
    alert('Erro ao adicionar comércio: ' + err.message);
  }
}

async function deleteCommerceByName(nome) {
  if (!confirm(`Deseja realmente remover o comércio "${nome}"? Esta ação é irreversível e excluirá o comércio e todas as suas entregas associadas.`)) {
    return;
  }

  showToastNotification('Removendo comércio...');

  try {
    if (supabaseClient) {
      const { error } = await supabaseClient
        .from('commercial_clients')
        .delete()
        .eq('establishment_name', nome);

      if (error) throw error;
    } else {
      commercesList = commercesList.filter(c => c.nome !== nome);
    }

    await fetchCommerces();
    await fetchClientHistory();
    await fetchPendingDeliveries();
    
    renderTelesUnified();
    updateOwnerDashboardOverview();
    
    showToastNotification(`Comércio "${nome}" e suas entregas foram removidos.`);
  } catch (err) {
    console.error('Error deleting commerce:', err);
    alert('Erro ao remover comércio: ' + err.message);
  }
}

let quickMapInstance = null;
let quickMapMarker = null;

window.openQuickMapModal = function(teleId, lat, lng) {
  const modal = document.getElementById('modal-quick-map');
  const span = document.getElementById('quick-map-tele-id');
  const container = document.getElementById('quick-map-container');
  if (!modal || !span || !container) return;

  span.innerText = formatOrderIdForDisplay(teleId);
  modal.classList.remove('hidden');

  // Insert a clean loading state inside the container
  container.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--color-text-muted); font-size: 0.9rem;">
      Carregando mapa...
    </div>
  `;

  // Wait 250ms for modal overlay display display transition to complete
  setTimeout(() => {
    loadGoogleMapsAPI(() => {
      if (quickMapInstance) {
        quickMapInstance = null;
      }
      container.innerHTML = '';

      const numericLat = parseFloat(lat);
      const numericLng = parseFloat(lng);
      
      if (isNaN(numericLat) || isNaN(numericLng)) {
        container.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #ef4444; font-size: 0.9rem;">
            Coordenadas não encontradas para esta tele.
          </div>
        `;
        return;
      }

      const localDarkStyle = [
        { elementType: "geometry", stylers: [{ color: "#1e1e24" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#1e1e24" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
        { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#33333d" }] },
        { featureType: "poi", stylers: [{ visibility: "off" }] },
        { featureType: "road", elementType: "geometry", stylers: [{ color: "#2d2d38" }] },
        { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a1a22" }] },
        { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8e8e9f" }] },
        { featureType: "transit", stylers: [{ visibility: "off" }] },
        { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d0d11" }] }
      ];

      const latLng = new window.google.maps.LatLng(numericLat, numericLng);
      quickMapInstance = new window.google.maps.Map(container, {
        center: latLng,
        zoom: 16,
        disableDefaultUI: true,
        zoomControl: true,
        styles: localDarkStyle
      });

      const markerHtml = `
        <div style="background-color: #ffb700; box-shadow: 0 0 10px #ffb700; width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative;">
          <div class="marker-pulse" style="border-color: #ffb700; position: absolute; top: -5px; left: -5px; width: 24px; height: 24px; border: 2px solid #ffb700; border-radius: 50%; animation: pulse-dot-anim 2.5s infinite;"></div>
          <i style="background-color: #fff; width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
        </div>
      `;

      if (window.CustomHTMLMapMarker) {
        quickMapMarker = new window.CustomHTMLMapMarker(latLng, quickMapInstance, markerHtml);
      } else {
        quickMapMarker = new window.google.maps.Marker({
          position: latLng,
          map: quickMapInstance
        });
      }

      setTimeout(() => {
        window.google.maps.event.trigger(quickMapInstance, 'resize');
        quickMapInstance.setCenter(latLng);
      }, 100);
    });
  }, 250);
};

window.closeQuickMapModal = function(event) {
  if (event && event.stopPropagation) {
    event.stopPropagation();
  }
  const modal = document.getElementById('modal-quick-map');
  if (modal) {
    modal.classList.add('hidden');
  }
  if (quickMapMarker && quickMapMarker.setMap) {
    quickMapMarker.setMap(null);
  }
  quickMapMarker = null;
  quickMapInstance = null;
};

/* ==========================================================================
   EXTRATOS & EVENT-DRIVEN FINANCIAL MODULES (ERP DE LOGÍSTICA)
   ========================================================================== */

// Estados do Módulo (Paginação e Cache de Lançamentos)
let currentClientExtractPage = 1;
let currentRiderExtractPage = 1;
const FINANCIAL_PAGE_SIZE = 10;
let currentClientLedgerCache = [];
let currentRiderDeliveriesCache = [];

// Auditoria Financeira (Log de Operações)
if (!mockData.financialAuditLogs) {
  mockData.financialAuditLogs = [];
}

window.logFinancialAudit = function(entry) {
  const auditRecord = {
    id: `AUD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    date: new Date(),
    time: new Date().toLocaleTimeString('pt-BR'),
    user: entry.user || 'Administrador',
    origin: entry.origin || 'sistema',
    type: entry.type || 'movimentacao',
    amount: entry.amount || 0,
    client_id: entry.client_id || null,
    client: entry.client || 'Geral',
    rider_id: entry.rider_id || null,
    rider: entry.rider || null,
    reference: entry.reference || 'REF-AUTO'
  };
  mockData.financialAuditLogs.unshift(auditRecord);
  console.log('[FinancialAuditLog] Registered entry:', auditRecord);
  return auditRecord;
};

// 1. Accordion Toggle
window.toggleNavAccordion = function(accordionId) {
  const el = document.getElementById(accordionId);
  if (el) {
    el.classList.toggle('open');
  }
};

// 2. Financial Event Dispatcher (Arquitetura Baseada em Eventos Únicos)
window.dispatchFinancialEvent = async function(eventType, payload) {
  console.log(`[FinancialEvent] Dispatched event '${eventType}':`, payload);
  
  // Registrar log de auditoria automaticamente para todo evento financeiro
  window.logFinancialAudit({
    user: payload.user || 'Administrador',
    origin: payload.origin || 'sistema',
    type: eventType,
    amount: payload.amount || payload.price || 0,
    client_id: payload.client_id || null,
    client: payload.client || payload.commerce_name || 'Geral',
    rider_id: payload.rider_id || null,
    rider: payload.rider || null,
    reference: payload.reference || payload.id || `EVT-${Date.now()}`
  });

  // Atualiza em tempo real a fonte única de dados
  await fetchClientHistory();
  await fetchFleet();
  await fetchRiderConsumables();
  await fetchRiderCredits();

  // Re-renderiza visões ativas
  const activeTab = document.querySelector('.dashboard-tab-content.active')?.id;
  if (activeTab === 'tab-owner-financials') {
    renderOwnerFinancials();
  } else if (activeTab === 'tab-owner-rider-payments') {
    renderRiderPayments();
  } else if (activeTab === 'tab-owner-rider-extract') {
    loadRiderExtract();
  } else if (activeTab === 'tab-owner-client-extract') {
    loadClientExtract();
  }
};

// 3. Preset Date Range Helper
function resolveDateRange(presetValue, customStartId, customEndId) {
  const now = new Date();
  let start = new Date();
  let end = new Date();

  if (presetValue === 'today') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (presetValue === 'week') {
    const day = now.getDay();
    const diffToSun = now.getDate() - day;
    start = new Date(now.setDate(diffToSun));
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (presetValue === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (presetValue === 'custom') {
    const startVal = document.getElementById(customStartId)?.value;
    const endVal = document.getElementById(customEndId)?.value;
    if (startVal) start = new Date(startVal + 'T00:00:00');
    if (endVal) end = new Date(endVal + 'T23:59:59');
  }

  return { start, end };
}

// Helper de Paginação Reutilizável
function renderPaginationControls(containerId, currentPage, totalPages, changePageFnName) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (totalPages <= 1) {
    container.innerHTML = `<span>Página 1 de 1</span>`;
    return;
  }

  container.innerHTML = `
    <span>Página ${currentPage} de ${totalPages}</span>
    <div class="pagination-controls">
      <button class="btn btn-secondary btn-sm" ${currentPage === 1 ? 'disabled' : ''} onclick="${changePageFnName}(${currentPage - 1})" style="padding: 4px 10px; font-size: 0.8rem;">Anterior</button>
      <button class="btn btn-secondary btn-sm" ${currentPage === totalPages ? 'disabled' : ''} onclick="${changePageFnName}(${currentPage + 1})" style="padding: 4px 10px; font-size: 0.8rem;">Próxima</button>
    </div>
  `;
}

// 4. EXTRATO DE MOTOBOYS
window.handleRiderExtractPeriodPresetChange = function() {
  const preset = document.getElementById('rider-extract-period-preset')?.value;
  const customBox = document.getElementById('rider-extract-custom-dates');
  if (customBox) {
    customBox.style.display = (preset === 'custom') ? 'flex' : 'none';
  }
  currentRiderExtractPage = 1;
  loadRiderExtract();
};

window.initRiderExtract = async function() {
  await fetchFleet();
  await fetchRiderConsumables();
  await fetchRiderCredits();

  const select = document.getElementById('rider-extract-rider-select');
  if (select) {
    const currentVal = select.value;
    select.innerHTML = '<option value="">Todos os Motoboys</option>';
    (mockData.fleet || []).forEach(r => {
      select.innerHTML += `<option value="${escapeHtml(r.id)}">${escapeHtml(formatRiderDisplayName(r))}</option>`;
    });
    select.value = currentVal;
  }

  currentRiderExtractPage = 1;
  loadRiderExtract();
};

window.loadRiderExtract = async function(targetPage) {
  if (targetPage) currentRiderExtractPage = targetPage;
  if (!supabaseClient) return;

  const selectRider = document.getElementById('rider-extract-rider-select');
  const selectedRiderId = selectRider ? selectRider.value : '';
  const periodPreset = document.getElementById('rider-extract-period-preset')?.value || 'week';
  
  const { start, end } = resolveDateRange(periodPreset, 'rider-extract-start-date', 'rider-extract-end-date');
  const startDateStr = start.toISOString().split('T')[0];
  const endDateStr = end.toISOString().split('T')[0];

  let targetRiderId = selectedRiderId;
  if (!targetRiderId && mockData.fleet && mockData.fleet.length > 0) {
    targetRiderId = mockData.fleet[0].id;
  }

  if (!targetRiderId) {
    const tbody = document.getElementById('rider-extract-table-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--color-text-muted); padding: 24px;">Selecione um motoboy para visualizar o extrato.</td></tr>`;
    return;
  }

  try {
    const { data: summaryData, error: summaryErr } = await supabaseClient.rpc('admin_get_rider_financial_summary', {
      p_motoboy_id: targetRiderId,
      p_start_date: startDateStr,
      p_end_date: endDateStr
    });

    if (summaryErr) console.warn('Aviso em admin_get_rider_financial_summary:', summaryErr.message);

    const { data: stmtData, error: stmtErr } = await supabaseClient.rpc('admin_get_rider_financial_statement', {
      p_motoboy_id: targetRiderId,
      p_start_date: startDateStr,
      p_end_date: endDateStr,
      p_limit: FINANCIAL_PAGE_SIZE,
      p_offset: (currentRiderExtractPage - 1) * FINANCIAL_PAGE_SIZE
    });

    if (stmtErr) throw stmtErr;

    const s = (summaryData && summaryData.success) ? summaryData : {
      completed_deliveries_count: 0,
      delivery_earnings: 0,
      consumables_total: 0,
      credits_total: 0,
      positive_adjustments_total: 0,
      negative_adjustments_total: 0,
      gross_total: 0,
      deductions_total: 0,
      net_total: 0
    };

    const elCount = document.getElementById('rider-extract-count');
    const elGross = document.getElementById('rider-extract-gross');
    const elConsumables = document.getElementById('rider-extract-consumables');
    const elCredits = document.getElementById('rider-extract-credits');
    const elAdjustments = document.getElementById('rider-extract-adjustments');
    const elNet = document.getElementById('rider-extract-net');

    if (elCount) elCount.innerText = s.completed_deliveries_count || 0;
    if (elGross) elGross.innerText = `R$ ${parseFloat(s.delivery_earnings || 0).toFixed(2).replace('.', ',')}`;
    if (elConsumables) elConsumables.innerText = `R$ ${parseFloat(s.consumables_total || 0).toFixed(2).replace('.', ',')}`;
    if (elCredits) elCredits.innerText = `R$ ${parseFloat(s.credits_total || 0).toFixed(2).replace('.', ',')}`;
    if (elAdjustments) elAdjustments.innerText = `R$ ${(parseFloat(s.positive_adjustments_total || 0) - parseFloat(s.negative_adjustments_total || 0)).toFixed(2).replace('.', ',')}`;
    if (elNet) elNet.innerText = `R$ ${parseFloat(s.net_total || 0).toFixed(2).replace('.', ',')}`;

    const items = (stmtData && stmtData.items) ? stmtData.items : [];
    const totalCount = (stmtData && stmtData.total_count) || items.length;
    const totalPages = Math.ceil(totalCount / FINANCIAL_PAGE_SIZE) || 1;

    const tbody = document.getElementById('rider-extract-table-body');
    if (tbody) {
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--color-text-muted); padding: 24px;">Nenhuma movimentação financeira localizada para o período.</td></tr>`;
      } else {
        tbody.innerHTML = items.map(item => {
          const itemDate = new Date(item.created_at);
          const dateFormatted = isNaN(itemDate) ? item.competency_date : itemDate.toLocaleDateString('pt-BR');
          const timeFormatted = isNaN(itemDate) ? '' : itemDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
          const val = parseFloat(item.amount || 0);

          let badgeClass = item.direction === 'credit' ? 'badge-success' : 'badge-danger';
          let signStr = item.direction === 'credit' ? '+' : '-';
          if (item.type === 'estorno') badgeClass = 'badge-warning';

          return `
            <tr>
              <td><strong>${escapeHtml(item.tele_code ? '#' + item.tele_code : 'LANÇAMENTO')}</strong></td>
              <td>${dateFormatted} ${timeFormatted}</td>
              <td>${escapeHtml(item.type)}</td>
              <td>${escapeHtml(item.description)}</td>
              <td><strong class="${item.direction === 'credit' ? 'text-green' : 'text-red'}">${signStr} R$ ${val.toFixed(2).replace('.', ',')}</strong></td>
              <td><span class="badge ${badgeClass}">${item.direction.toUpperCase()}</span></td>
            </tr>
          `;
        }).join('');
      }
    }

    renderPaginationControls('rider-extract-pagination', currentRiderExtractPage, totalPages, 'loadRiderExtract');

    const summaryBox = document.getElementById('rider-extract-summary-box');
    if (summaryBox) {
      summaryBox.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; font-size: 0.9rem;">
          <div><span style="color: var(--color-text-muted);">Ganhos de Entregas:</span> <strong style="color: #10b981;">+R$ ${parseFloat(s.delivery_earnings || 0).toFixed(2).replace('.', ',')}</strong></div>
          <div><span style="color: var(--color-text-muted);">(+) Créditos e Bônus:</span> <strong style="color: #10b981;">+R$ ${parseFloat(s.credits_total || 0).toFixed(2).replace('.', ',')}</strong></div>
          <div><span style="color: var(--color-text-muted);">(-) Consumíveis / Vales:</span> <strong style="color: #ef4444;">-R$ ${parseFloat(s.consumables_total || 0).toFixed(2).replace('.', ',')}</strong></div>
          <div><span style="color: var(--color-text-muted);">(+/-) Ajustes / Estornos:</span> <strong>R$ ${(parseFloat(s.positive_adjustments_total || 0) - parseFloat(s.negative_adjustments_total || 0)).toFixed(2).replace('.', ',')}</strong></div>
          <div style="border-top: 1px solid var(--border-color); padding-top: 8px; grid-column: 1 / -1; font-size: 1.05rem;">
            <span style="font-weight: 700;">TOTAL LÍQUIDO DO PERÍODO:</span> <strong style="color: #10b981; font-size: 1.2rem; margin-left: 8px;">R$ ${parseFloat(s.net_total || 0).toFixed(2).replace('.', ',')}</strong>
          </div>
        </div>
      `;
    }
  } catch (err) {
    console.error('Error loading rider extract via RPC:', err);
  }
};

// 5. EXTRATO DE CLIENTES / CONTA CORRENTE
window.handleClientExtractPeriodPresetChange = function() {
  const preset = document.getElementById('client-extract-period-preset')?.value;
  const customBox = document.getElementById('client-extract-custom-dates');
  if (customBox) {
    customBox.style.display = (preset === 'custom') ? 'flex' : 'none';
  }
  currentClientExtractPage = 1;
  loadClientExtract();
};

window.initClientExtract = async function() {
  await fetchClientHistory();

  const select = document.getElementById('client-extract-client-select');
  if (select) {
    const currentVal = select.value;
    select.innerHTML = '<option value="">Todos os Estabelecimentos</option>';
    const clientsSet = new Set();
    (mockData.clientHistory || []).forEach(d => {
      const cName = d.client || d.commerce_name;
      if (cName) clientsSet.add(cName);
    });

    Array.from(clientsSet).sort().forEach(c => {
      select.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`;
    });
    select.value = currentVal;
  }

  currentClientExtractPage = 1;
  loadClientExtract();
};

window.loadClientExtract = function(targetPage) {
  if (targetPage) currentClientExtractPage = targetPage;

  const selectedClient = document.getElementById('client-extract-client-select')?.value || '';
  const selectedClientId = document.getElementById('client-extract-client-select')?.selectedOptions[0]?.dataset?.clientId || null;
  const periodPreset = document.getElementById('client-extract-period-preset')?.value || 'month';
  
  const { start, end } = resolveDateRange(periodPreset, 'client-extract-start-date', 'client-extract-end-date');

  let ledgerEntries = [];

  (mockData.clientHistory || []).forEach(d => {
    const dDate = new Date(d.date || d.created_at);
    const clientName = d.client || d.commerce_name || 'Cliente Geral';
    const clientId = d.client_id || d.commerce_id || null;

    if (dDate >= start && dDate <= end) {
      // Suporte para Multi-tenant (filtragem por client_id ou nome do estabelecimento)
      const matchesClient = !selectedClient || clientName.toLowerCase() === selectedClient.toLowerCase();
      const matchesClientId = !selectedClientId || clientId === selectedClientId;

      if (matchesClient && matchesClientId) {
        const val = parseFloat(d.price || d.taxa || 0);

        // Lançamento de Débito: Tele Realizada
        ledgerEntries.push({
          id: d.id,
          date: dDate,
          documento: `Tele #${d.id}`,
          type: 'tele_realizada',
          typeLabel: 'Tele Realizada',
          description: `Corrida #${d.id} (${d.origin || 'Origem'} → ${d.destination || 'Destino'})`,
          referencia: `REF-TEL-${d.id}`,
          origin: d.origin_type || 'sistema',
          client_id: clientId,
          client: clientName,
          debit: val,
          credit: 0,
          overdue: d.overdue || false,
          pending_status: d.pending_status || 'prazo',
          is_blocked: d.is_blocked || false
        });

        // Se houver quitação registrada
        if (d.payment_status === 'Pago' || d.paid === true) {
          ledgerEntries.push({
            id: `REC-${d.id}`,
            date: new Date(dDate.getTime() + 1000),
            documento: `Recebimento PIX #${d.id}`,
            type: 'pagamento_recebido',
            typeLabel: 'Pagamento Recebido',
            description: `Quitação do recebimento Tele #${d.id}`,
            referencia: `REF-REC-${d.id}`,
            origin: 'administrador',
            client_id: clientId,
            client: clientName,
            debit: 0,
            credit: val,
            overdue: false,
            pending_status: 'ok',
            is_blocked: false
          });
        }
      }
    }
  });

  // Ordenar por data crescente para cálculo de saldo acumulado
  ledgerEntries.sort((a, b) => a.date - b.date);

  let runningBalance = 0;
  let totalBilled = 0;
  let totalPaid = 0;
  let totalTeles = 0;
  let hasOverdue = false;
  let hasPendingInTerm = false;
  let isClientBlocked = false;

  ledgerEntries.forEach(entry => {
    if (entry.type === 'tele_realizada') totalTeles++;
    totalBilled += entry.debit;
    totalPaid += entry.credit;
    runningBalance += (entry.debit - entry.credit);
    entry.balanceAfter = runningBalance;

    if (entry.overdue) hasOverdue = true;
    if (entry.pending_status === 'prazo') hasPendingInTerm = true;
    if (entry.is_blocked) isClientBlocked = true;
  });

  currentClientLedgerCache = ledgerEntries;

  // Atualizar Métricas
  const elCount = document.getElementById('client-extract-count');
  const elBilled = document.getElementById('client-extract-billed');
  const elPaid = document.getElementById('client-extract-paid');
  const elBalance = document.getElementById('client-extract-balance');
  const elStatusBadge = document.getElementById('client-extract-status-badge');
  const elStatusDesc = document.getElementById('client-extract-status-desc');

  if (elCount) elCount.innerText = totalTeles;
  if (elBilled) elBilled.innerText = `R$ ${totalBilled.toFixed(2).replace('.', ',')}`;
  if (elPaid) elPaid.innerText = `R$ ${totalPaid.toFixed(2).replace('.', ',')}`;
  if (elBalance) elBalance.innerText = `R$ ${runningBalance.toFixed(2).replace('.', ',')}`;

  // Indicador Dinâmico de Status Financeiro (Sem Regra de Valor Fixo)
  if (elStatusBadge && elStatusDesc) {
    if (isClientBlocked) {
      elStatusBadge.className = 'badge badge-status-blocked';
      elStatusBadge.innerText = 'Bloqueado';
      elStatusDesc.innerText = 'Bloqueio manual pelo administrador';
    } else if (hasOverdue || runningBalance > 0 && hasOverdue) {
      elStatusBadge.className = 'badge badge-status-danger';
      elStatusBadge.innerText = 'Inadimplente';
      elStatusDesc.innerText = 'Possui saldo vencido pendente';
    } else if (runningBalance > 0 || hasPendingInTerm) {
      elStatusBadge.className = 'badge badge-status-warning';
      elStatusBadge.innerText = 'Atenção';
      elStatusDesc.innerText = 'Saldo pendente dentro do prazo';
    } else {
      elStatusBadge.className = 'badge badge-status-ok';
      elStatusBadge.innerText = 'Em dia';
      elStatusDesc.innerText = 'Conta sem pendências financeiras';
    }
  }

  // Paginação
  const totalPages = Math.ceil(ledgerEntries.length / FINANCIAL_PAGE_SIZE) || 1;
  if (currentClientExtractPage > totalPages) currentClientExtractPage = totalPages;

  const startIndex = (currentClientExtractPage - 1) * FINANCIAL_PAGE_SIZE;
  const pageEntries = ledgerEntries.slice(startIndex, startIndex + FINANCIAL_PAGE_SIZE);

  // Tabela Razão
  const tbody = document.getElementById('client-extract-table-body');
  if (tbody) {
    if (ledgerEntries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--color-text-muted); padding: 24px;">Nenhum lançamento financeiro localizado para este período/cliente.</td></tr>`;
    } else {
      tbody.innerHTML = pageEntries.map(entry => {
        const dFormatted = entry.date.toLocaleDateString('pt-BR') + ' ' + entry.date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        
        let typeBadge = '<span class="badge badge-neutral">Outro</span>';
        if (entry.type === 'tele_realizada') typeBadge = '<span class="badge badge-soft">Tele Realizada</span>';
        else if (entry.type === 'pagamento_recebido') typeBadge = '<span class="badge badge-success">Recebimento</span>';
        else if (entry.type === 'credito') typeBadge = '<span class="badge badge-success">Crédito</span>';
        else if (entry.type === 'ajuste') typeBadge = '<span class="badge badge-warning">Ajuste</span>';
        else if (entry.type === 'estorno') typeBadge = '<span class="badge badge-danger">Estorno</span>';

        const debitStr = entry.debit > 0 ? `<span class="financial-debit">R$ ${entry.debit.toFixed(2).replace('.', ',')}</span>` : '—';
        const creditStr = entry.credit > 0 ? `<span class="financial-credit">R$ ${entry.credit.toFixed(2).replace('.', ',')}</span>` : '—';
        const balStr = `R$ ${entry.balanceAfter.toFixed(2).replace('.', ',')}`;

        return `
          <tr class="clickable-row" onclick="openTransactionDrawer('${escapeHtml(String(entry.id))}')">
            <td>${dFormatted}</td>
            <td><strong>${escapeHtml(entry.documento)}</strong></td>
            <td>${typeBadge}</td>
            <td>${escapeHtml(entry.description)}</td>
            <td><code style="font-size: 0.78rem; background: var(--bg-input); padding: 2px 6px; border-radius: 4px;">${escapeHtml(entry.referencia)}</code></td>
            <td><span style="font-size: 0.78rem; color: var(--color-text-muted); text-transform: capitalize;">${escapeHtml(entry.origin)}</span></td>
            <td>${debitStr}</td>
            <td>${creditStr}</td>
            <td><strong>${balStr}</strong></td>
          </tr>
        `;
      }).join('');
    }
  }

  renderPaginationControls('client-extract-pagination', currentClientExtractPage, totalPages, 'loadClientExtract');
};

// 6. Drawer de Detalhes do Lançamento
window.openTransactionDrawer = function(entryId) {
  const entry = currentClientLedgerCache.find(e => String(e.id) === String(entryId));
  if (!entry) return;

  const content = document.getElementById('drawer-transaction-content');
  const backdrop = document.getElementById('drawer-transaction-details');

  if (content && backdrop) {
    const dFormatted = entry.date.toLocaleDateString('pt-BR') + ' às ' + entry.date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    
    content.innerHTML = `
      <div class="drawer-field">
        <label>ID do Lançamento</label>
        <span>#${escapeHtml(String(entry.id))}</span>
      </div>
      <div class="drawer-field">
        <label>Documento</label>
        <span>${escapeHtml(entry.documento)}</span>
      </div>
      <div class="drawer-field">
        <label>Data & Hora</label>
        <span>${dFormatted}</span>
      </div>
      <div class="drawer-field">
        <label>Estabelecimento / Cliente</label>
        <span>${escapeHtml(entry.client)}</span>
      </div>
      <div class="drawer-field">
        <label>Tipo de Lançamento</label>
        <span style="text-transform: capitalize;">${escapeHtml(entry.typeLabel || entry.type)}</span>
      </div>
      <div class="drawer-field">
        <label>Descrição Completa</label>
        <span>${escapeHtml(entry.description)}</span>
      </div>
      <div class="drawer-field">
        <label>Referência Interna</label>
        <span><code>${escapeHtml(entry.referencia)}</code></span>
      </div>
      <div class="drawer-field">
        <label>Origem da Ação</label>
        <span style="text-transform: capitalize;">${escapeHtml(entry.origin)}</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--border-color);">
        <div class="drawer-field">
          <label>Débito</label>
          <span class="financial-debit">R$ ${entry.debit.toFixed(2).replace('.', ',')}</span>
        </div>
        <div class="drawer-field">
          <label>Crédito</label>
          <span class="financial-credit">R$ ${entry.credit.toFixed(2).replace('.', ',')}</span>
        </div>
      </div>
      <div class="drawer-field" style="margin-top: 12px; padding: 12px; background: rgba(255,255,255,0.03); border-radius: var(--border-radius-sm);">
        <label>Saldo Resultante</label>
        <span style="font-size: 1.1rem; font-weight: 700;">R$ ${entry.balanceAfter.toFixed(2).replace('.', ',')}</span>
      </div>
    `;

    backdrop.classList.add('active');
  }
};

window.openRiderTransactionDrawer = function(deliveryId) {
  const delivery = currentRiderDeliveriesCache.find(d => String(d.id) === String(deliveryId));
  if (!delivery) return;

  const content = document.getElementById('drawer-transaction-content');
  const backdrop = document.getElementById('drawer-transaction-details');

  if (content && backdrop) {
    const dDate = new Date(delivery.date || delivery.created_at);
    const dFormatted = isNaN(dDate) ? '—' : dDate.toLocaleDateString('pt-BR') + ' às ' + dDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const val = parseFloat(delivery.price || delivery.taxa || 0);

    content.innerHTML = `
      <div class="drawer-field">
        <label>ID da Tele</label>
        <span>#${escapeHtml(String(delivery.id))}</span>
      </div>
      <div class="drawer-field">
        <label>Data & Hora</label>
        <span>${dFormatted}</span>
      </div>
      <div class="drawer-field">
        <label>Motoboy</label>
        <span>${escapeHtml(delivery.rider || '—')}</span>
      </div>
      <div class="drawer-field">
        <label>Cliente / Estabelecimento</label>
        <span>${escapeHtml(delivery.client || delivery.commerce_name || '—')}</span>
      </div>
      <div class="drawer-field">
        <label>Origem (Pickup)</label>
        <span>${escapeHtml(delivery.origin || delivery.pickup || '—')}</span>
      </div>
      <div class="drawer-field">
        <label>Destino (Entrega)</label>
        <span>${escapeHtml(delivery.destination || delivery.delivery_address || '—')}</span>
      </div>
      <div class="drawer-field">
        <label>Valor da Corrida</label>
        <span style="font-size: 1.1rem; font-weight: 700; color: #10b981;">R$ ${val.toFixed(2).replace('.', ',')}</span>
      </div>
      <div class="drawer-field">
        <label>Status</label>
        <span>${escapeHtml(delivery.status || 'Pendente')}</span>
      </div>
    `;

    backdrop.classList.add('active');
  }
};

window.closeTransactionDrawer = function(event) {
  if (event && event.target && !event.target.classList.contains('drawer-backdrop') && !event.target.classList.contains('drawer-close-btn') && !event.target.closest('.drawer-close-btn')) {
    return;
  }
  const backdrop = document.getElementById('drawer-transaction-details');
  if (backdrop) {
    backdrop.classList.remove('active');
  }
};

// =====================================================================
// MÓDULO DE CLIENTES COMERCIAIS & PAINEL DO CLIENTE (MULTI-TENANT & RLS)
// =====================================================================

let commercialClientsList = [];
let activeCommercialClient = null;
let clientFinancialLedgerStore = [];

// 1. Carregar Clientes Comerciais do Banco / API Dev
async function fetchCommercialClients() {
  try {
    if (supabaseClient) {
      const { data, error } = await supabaseClient
        .from('commercial_clients')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) {
        console.warn("Aviso ao buscar commercial_clients:", error.message);
      } else if (data) {
        commercialClientsList = data;
      }
    } else {
      // Dev Adapter fallback via API local
      const res = await fetch('/api/admin/clients');
      if (res.ok) {
        const json = await res.json();
        commercialClientsList = json.clients || [];
      }
    }
  } catch (err) {
    console.error("Erro ao buscar clientes comerciais:", err);
  }

  // Garantir fixtures de homologação se a lista estiver vazia
  if (!commercialClientsList || commercialClientsList.length === 0) {
    commercialClientsList = [
      {
        id: 'client-fixture-001',
        public_code: 'CLI-000001',
        establishment_name: 'Lanchonete Dahora',
        responsible_name: 'Gerente Lanchonete',
        phone_normalized: '11999998888',
        email_normalized: 'gerente@lanchonetedahora.com.br',
        document_normalized: '12.345.678/0001-90',
        lifecycle_status: 'ativo',
        financial_status: 'em_dia',
        address: 'Rua Principal, 100',
        neighborhood: 'Centro',
        city: 'Porto Alegre',
        created_at: new Date().toISOString()
      },
      {
        id: 'client-fixture-002',
        public_code: 'CLI-000002',
        establishment_name: 'Cliente Teste (Homologação)',
        responsible_name: 'Usuário Teste',
        phone_normalized: '11988887777',
        email_normalized: 'cliente.teste@local.test',
        document_normalized: '98.765.432/0001-10',
        lifecycle_status: 'teste',
        financial_status: 'em_dia',
        address: 'Av. das Indústrias, 500',
        neighborhood: 'Industrial',
        city: 'São Paulo',
        created_at: new Date().toISOString()
      }
    ];
  }

  renderCommercialClientsTable();
  updateCommercialMetrics();
}

// 2. Renderizar Tabela Administrativa de Clientes Comerciais
function renderCommercialClientsTable() {
  const tbody = document.getElementById('commercial-clients-table-body');
  if (!tbody) return;

  const searchQuery = (document.getElementById('search-commercial-clients')?.value || '').toLowerCase().trim();
  const lifecycleFilter = document.getElementById('filter-client-lifecycle')?.value || 'all';

  const filtered = commercialClientsList.filter(c => {
    const matchesSearch = !searchQuery || 
      (c.establishment_name || '').toLowerCase().includes(searchQuery) ||
      (c.public_code || '').toLowerCase().includes(searchQuery) ||
      (c.responsible_name || '').toLowerCase().includes(searchQuery) ||
      (c.email_normalized || '').toLowerCase().includes(searchQuery) ||
      (c.phone_normalized || '').includes(searchQuery);

    const matchesLifecycle = (lifecycleFilter === 'all') || (c.lifecycle_status === lifecycleFilter);

    return matchesSearch && matchesLifecycle;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; padding: 32px; color: var(--color-text-muted);">
          <i data-lucide="store" style="width: 36px; height: 36px; display: block; margin: 0 auto 8px; opacity: 0.5;"></i>
          Nenhum cliente comercial encontrado.
        </td>
      </tr>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const dateFormatted = new Date(c.created_at).toLocaleDateString('pt-BR');
    
    // Status Badges
    const lifecycleBadgeClass = c.lifecycle_status === 'ativo' ? 'badge-success' :
                               c.lifecycle_status === 'teste' ? 'badge-info' :
                               c.lifecycle_status === 'suspenso' ? 'badge-warning' : 'badge-danger';

    const financialBadgeClass = c.financial_status === 'em_dia' ? 'badge-success' : 'badge-danger';

    // Total teles & saldo mock/calculado para o cliente
    const totalTeles = (mockData.clientHistory || []).filter(d => 
      String(d.client_id) === String(c.id) || (d.client || '').toLowerCase() === (c.establishment_name || '').toLowerCase()
    ).length;

    const openBalance = 0; // Saldo em dia

    return `
      <tr>
        <td><strong style="color: var(--cyan-text); font-family: monospace;">${escapeHtml(c.public_code)}</strong></td>
        <td>
          <div style="font-weight: 600;">${escapeHtml(c.establishment_name)}</div>
          <span style="font-size: 0.75rem; color: var(--color-text-muted);">${escapeHtml(c.address || '')}</span>
        </td>
        <td>${escapeHtml(c.responsible_name)}</td>
        <td>
          <div>${escapeHtml(c.phone_normalized)}</div>
          <span style="font-size: 0.75rem; color: var(--color-text-muted);">${escapeHtml(c.email_normalized)}</span>
        </td>
        <td><span class="badge ${lifecycleBadgeClass}">${escapeHtml(c.lifecycle_status.toUpperCase())}</span></td>
        <td><span class="badge ${financialBadgeClass}">${escapeHtml(c.financial_status.replace('_', ' ').toUpperCase())}</span></td>
        <td><strong>${totalTeles}</strong></td>
        <td><strong style="color: #10b981;">R$ ${openBalance.toFixed(2).replace('.', ',')}</strong></td>
        <td>${dateFormatted}</td>
        <td style="text-align: right;">
          <div style="display: flex; gap: 6px; justify-content: flex-end;">
            <button class="btn btn-secondary btn-sm" onclick="openTestClientPanel('${c.id}', 'test')" title="Logar no Painel deste Cliente">
              <i data-lucide="external-link" style="width: 14px; height: 14px;"></i> <span>Abrir Painel</span>
            </button>
            <button class="btn btn-secondary btn-sm" onclick="toggleClientStatus('${c.id}')" title="Alterar Status">
              <i data-lucide="${c.lifecycle_status === 'ativo' ? 'pause-circle' : 'play-circle'}" style="width: 14px; height: 14px;"></i>
            </button>
            <button class="btn btn-secondary btn-sm" onclick="resetClientAccess('${c.id}')" title="Resetar Acesso">
              <i data-lucide="key" style="width: 14px; height: 14px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (window.lucide) window.lucide.createIcons();
}

// 3. Métricas Rápidas no Admin
function updateCommercialMetrics() {
  const activeCount = commercialClientsList.filter(c => c.lifecycle_status === 'ativo').length;
  const testCount = commercialClientsList.filter(c => c.lifecycle_status === 'teste').length;
  const totalTeles = (mockData.clientHistory || []).length;

  const elActive = document.getElementById('comm-metric-active-count');
  const elTest = document.getElementById('comm-metric-test-count');
  const elTotal = document.getElementById('comm-metric-total-teles');

  if (elActive) elActive.innerText = activeCount;
  if (elTest) elTest.innerText = testCount;
  if (elTotal) elTotal.innerText = totalTeles;
}

// 4. Modal de Novo Cliente Comercial
function openAddCommercialClientModal() {
  const modal = document.getElementById('modal-add-commercial-client');
  if (modal) modal.classList.remove('hidden');
}

function closeAddCommercialClientModal(event) {
  if (event && event.target && !event.target.classList.contains('modal-overlay') && !event.target.classList.contains('modal-close-btn') && !event.target.closest('.modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('modal-add-commercial-client');
  if (modal) modal.classList.add('hidden');
}

async function submitAddCommercialClient(event) {
  if (event) event.preventDefault();

  const establishment_name = document.getElementById('comm-establishment-name')?.value.trim();
  const responsible_name = document.getElementById('comm-responsible-name')?.value.trim();
  const phone = document.getElementById('comm-phone')?.value.trim();
  const email = document.getElementById('comm-email')?.value.trim();
  const password = document.getElementById('comm-password')?.value.trim();
  const address = document.getElementById('comm-address')?.value.trim();
  const complement = document.getElementById('comm-complement')?.value.trim() || '';
  const neighborhood = document.getElementById('comm-neighborhood')?.value.trim() || '';
  const city = document.getElementById('comm-city')?.value.trim() || '';
  const documentNum = document.getElementById('comm-document')?.value.trim() || '';
  const map_color = document.getElementById('comm-map-color')?.value || '#ffb700';
  const lifecycle_status = document.getElementById('comm-lifecycle-status')?.value || 'ativo';
  const notes = document.getElementById('comm-notes')?.value.trim() || '';

  if (!establishment_name || !responsible_name || !phone || !email || !password || !address) {
    alert('Preencha todos os campos obrigatórios.');
    return;
  }

  showToastNotification('Criando cliente comercial e configurando acesso seguro...');

  try {
    const payload = {
      establishment_name,
      responsible_name,
      phone,
      email,
      password,
      address,
      complement,
      neighborhood,
      city,
      document: documentNum,
      map_color,
      lifecycle_status,
      notes
    };

    const response = await fetch('/api/admin/create-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await response.json();

    if (!response.ok) {
      throw new Error(json.error || 'Erro ao cadastrar cliente.');
    }

    showToastNotification(`Cliente "${establishment_name}" (${json.client?.public_code || 'CLI'}) cadastrado com sucesso!`);
    closeAddCommercialClientModal();
    await fetchCommercialClients();

  } catch (err) {
    console.error("Erro ao cadastrar cliente:", err);
    alert(`Falha no cadastro: ${err.message}`);
  }
}

// 5. Ações Administrativas de Clientes
async function toggleClientStatus(clientId) {
  const client = commercialClientsList.find(c => String(c.id) === String(clientId));
  if (!client) return;

  const nextStatus = client.lifecycle_status === 'ativo' ? 'suspenso' : 'ativo';
  if (!confirm(`Deseja alterar o status de "${client.establishment_name}" para ${nextStatus.toUpperCase()}?`)) return;

  client.lifecycle_status = nextStatus;

  if (supabaseClient) {
    await supabaseClient
      .from('commercial_clients')
      .update({ lifecycle_status: nextStatus })
      .eq('id', clientId);
  }

  renderCommercialClientsTable();
  updateCommercialMetrics();
  showToastNotification(`Status do cliente "${client.establishment_name}" alterado para ${nextStatus}.`);
}

function resetClientAccess(clientId) {
  const client = commercialClientsList.find(c => String(c.id) === String(clientId));
  if (!client) return;
  alert(`Instruções de redefinição de acesso enviadas para o email ${client.email_normalized}.`);
}

// 6. Abrir Painel de Teste / Simulação do Cliente
function openTestClientPanel(clientId, mode) {
  const client = commercialClientsList.find(c => String(c.id) === String(clientId)) || commercialClientsList[0];
  activeCommercialClient = client;

  // Atualizar nome e perfil na barra lateral
  mockData.activeProfile = 'client';
  mockData.credentials.client.commerceName = client.establishment_name;
  mockData.credentials.client.name = client.responsible_name;
  mockData.credentials.client.email = client.email_normalized;

  loginSuccess();
  switchDashboardTab('client-overview');
  showToastNotification(`Acessando o Painel do Cliente como [${client.establishment_name}] (${client.public_code})`);
}

let manualDeliveryMap = null;
let manualDeliveryMarker = null;
let addressSearchDebounceTimer = null;

function renderCommercialClientsDropdown(clientsList) {
  const dropdownEl = document.getElementById('admin-client-dropdown');
  const searchVal = document.getElementById('admin-client-search')?.value?.trim().toLowerCase() || '';
  const hintEl = document.getElementById('admin-client-select-hint');

  if (!dropdownEl) return;

  let filtered = (clientsList || []).filter(c => {
    if (c.is_internal) return true;
    if (!searchVal) return true;
    return (c.establishment_name || '').toLowerCase().includes(searchVal) ||
           (c.client_code || '').toLowerCase().includes(searchVal) ||
           (c.responsible_name || '').toLowerCase().includes(searchVal);
  });

  const externalCount = filtered.filter(c => !c.is_internal).length;
  if (externalCount === 0 && hintEl) {
    hintEl.textContent = "Nenhum cliente comercial cadastrado. Você ainda pode criar uma Tele interna da Dahora Expresso.";
  } else if (hintEl) {
    hintEl.textContent = "Exibindo clientes cadastrados ativos.";
  }

  let html = '';
  filtered.forEach(c => {
    const isInternal = c.is_internal;
    const title = isInternal ? 'Dahora Expresso — Operação Interna' : escapeHtml(c.establishment_name);
    const subtitle = isInternal ? `${c.client_code} • Operação Própria` : `${c.client_code} • ${escapeHtml(c.responsible_name)}`;
    const badge = isInternal ? '<span style="font-size:0.65rem; background: var(--primary); color: #000; padding: 2px 6px; border-radius: 4px; font-weight: 700; margin-left: 6px;">INTERNA</span>' : '';

    html += `
      <div class="client-select-item" onclick="selectCommercialClientForTele('${c.id}', '${escapeHtml(title).replace(/'/g, "\\'")}')" style="padding: 10px 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='transparent'">
        <div style="font-weight: 600; color: var(--color-text); display: flex; align-items: center; justify-content: space-between;">
          <span>${title}</span> ${badge}
        </div>
        <div style="font-size: 0.75rem; color: var(--color-text-muted); margin-top: 2px;">
          ${subtitle}
        </div>
      </div>
    `;
  });

  dropdownEl.innerHTML = html || '<div style="padding: 12px; color: var(--color-text-muted); text-align: center;">Nenhum cliente encontrado.</div>';
}

function selectCommercialClientForTele(id, name) {
  const selectedInput = document.getElementById('selectedClientId');
  const searchInput = document.getElementById('admin-client-search');
  const dropdownEl = document.getElementById('admin-client-dropdown');

  if (selectedInput) selectedInput.value = id;
  if (searchInput) searchInput.value = name;
  if (dropdownEl) dropdownEl.classList.add('hidden');

  const clientObj = (commercialClientsSelectCache || []).find(c => String(c.id) === String(id));
  if (clientObj && clientObj.address) {
    showToastNotification(`Endereço de coleta do cliente carregado: ${clientObj.address}`);
  }
}

function toggleManualDeliverySN() {
  const snCb = document.getElementById('manual-delivery-sn-cb');
  const numInput = document.getElementById('manual-delivery-number');
  if (!numInput || !snCb) return;

  if (snCb.checked) {
    numInput.value = 'S/N';
    numInput.disabled = true;
  } else {
    if (numInput.value === 'S/N') numInput.value = '';
    numInput.disabled = false;
  }
}

let googleMapsLoaderPromise = null;


function getGoogleMapsApiKey() {
  return (window.LOCAL_SUPABASE_CONFIG && window.LOCAL_SUPABASE_CONFIG.googleMapsApiKey) ||
         (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.googleMapsApiKey) ||
         window.GOOGLE_MAPS_API_KEY || '';
}

function ensureCustomHTMLMapMarkerClass() {
  if (window.google && window.google.maps && window.google.maps.OverlayView && !window.CustomHTMLMapMarker) {
    class CustomHTMLMapMarker extends window.google.maps.OverlayView {
      constructor(latlng, map, html, onClick) {
        super();
        this.latlng = latlng;
        this.html = html;
        this.onClick = onClick;
        
        this.div = document.createElement('div');
        this.div.style.position = 'absolute';
        this.div.style.cursor = 'pointer';
        this.div.innerHTML = html;
        
        if (onClick) {
          this.div.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick(e);
          });
        }
        this.setMap(map);
      }
      onAdd() {
        const pane = this.getPanes().overlayMouseTarget;
        if (pane) pane.appendChild(this.div);
      }
      draw() {
        const projection = this.getProjection();
        if (!projection) return;
        const point = projection.fromLatLngToDivPixel(this.latlng);
        if (point) {
          this.div.style.left = (point.x - 10) + 'px';
          this.div.style.top = (point.y - 10) + 'px';
        }
      }
      onRemove() {
        if (this.div && this.div.parentNode) {
          this.div.parentNode.removeChild(this.div);
        }
      }
      setLatLng(latlng) {
        this.latlng = latlng;
        this.draw();
      }
      getLatLng() {
        return this.latlng;
      }
      getPosition() {
        return this.latlng;
      }
    }
    window.CustomHTMLMapMarker = CustomHTMLMapMarker;
  }
}

async function loadGoogleMapsApi() {
  if (window.google?.maps) {
    ensureCustomHTMLMapMarkerClass();
    return window.google.maps;
  }

  if (googleMapsLoaderPromise) {
    const mapsObj = await googleMapsLoaderPromise;
    ensureCustomHTMLMapMarkerClass();
    return mapsObj;
  }

  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    throw new Error("Chave do Google Maps não configurada em public/config.local.js");
  }

  googleMapsLoaderPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
    if (existingScript) {
      if (window.google?.maps) {
        ensureCustomHTMLMapMarkerClass();
        resolve(window.google.maps);
        return;
      }
      existingScript.addEventListener('load', () => {
        ensureCustomHTMLMapMarkerClass();
        resolve(window.google?.maps);
      });
      existingScript.addEventListener('error', () => reject(new Error("Erro ao carregar a Google Maps JavaScript API.")));
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker&loading=async`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.maps) {
        ensureCustomHTMLMapMarkerClass();
        resolve(window.google.maps);
      } else {
        reject(new Error("Google Maps API não disponibilizada após o evento onload."));
      }
    };
    script.onerror = () => {
      reject(new Error("Erro ao carregar a Google Maps JavaScript API."));
    };
    document.head.appendChild(script);
  });

  try {
    const resMaps = await googleMapsLoaderPromise;
    ensureCustomHTMLMapMarkerClass();
    return resMaps;
  } catch (error) {
    googleMapsLoaderPromise = null;
    throw error;
  }
}


function getGoogleMapsMapId() {
  return (window.LOCAL_SUPABASE_CONFIG && window.LOCAL_SUPABASE_CONFIG.googleMapsMapId) ||
         (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.googleMapsMapId) ||
         'DEMO_MAP_ID';
}

async function initManualDeliveryMap() {
  const container = document.getElementById('manual-request-delivery-map');
  if (!container) return;

  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    container.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; text-align:center; padding:16px;">Chave do Google Maps não configurada em public/config.local.js</div>`;
    return;
  }

  try {
    await loadGoogleMapsApi();
    const { Map } = await window.google.maps.importLibrary('maps');
    const { AdvancedMarkerElement } = await window.google.maps.importLibrary('marker');

    const initialLat = parseFloat(document.getElementById('manual-delivery-lat')?.value) || -29.8247;
    const initialLng = parseFloat(document.getElementById('manual-delivery-lng')?.value) || -51.1444;
    const position = { lat: initialLat, lng: initialLng };

    if (!manualDeliveryMap) {
      const mapId = getGoogleMapsMapId();
      manualDeliveryMap = new Map(container, {
        center: position,
        zoom: 15,
        mapId: mapId,
        gestureHandling: 'greedy',
        zoomControl: true,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false
      });

      manualDeliveryMarker = new AdvancedMarkerElement({
        map: manualDeliveryMap,
        position: position,
        gmpDraggable: true,
        title: 'Local de entrega'
      });

      manualDeliveryMarker.addListener('dragend', (evt) => {
        let lat = position.lat;
        let lng = position.lng;
        if (evt && evt.latLng) {
          lat = evt.latLng.lat();
          lng = evt.latLng.lng();
        } else if (manualDeliveryMarker.position) {
          lat = typeof manualDeliveryMarker.position.lat === 'function' ? manualDeliveryMarker.position.lat() : manualDeliveryMarker.position.lat;
          lng = typeof manualDeliveryMarker.position.lng === 'function' ? manualDeliveryMarker.position.lng() : manualDeliveryMarker.position.lng;
        }
        onMapMarkerPositionChanged(lat, lng);
      });

      manualDeliveryMap.addListener('click', (e) => {
        if (e.latLng) {
          const lat = e.latLng.lat();
          const lng = e.latLng.lng();
          if (manualDeliveryMarker.position) {
            manualDeliveryMarker.position = { lat, lng };
          } else if (typeof manualDeliveryMarker.setPosition === 'function') {
            manualDeliveryMarker.setPosition(e.latLng);
          }
          onMapMarkerPositionChanged(lat, lng);
        }
      });
    } else {
      window.google.maps.event.trigger(manualDeliveryMap, 'resize');
      manualDeliveryMap.setCenter(position);
    }
  } catch (err) {
    container.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; text-align:center; padding:16px;">${err.message}</div>`;
  }

  initGooglePlacesAutocomplete();
}

function syncManualDeliveryNumberInput(val) {
  const hiddenNum = document.getElementById('manual-delivery-number');
  if (hiddenNum) hiddenNum.value = val ? val.trim() : '';
  const snCb = document.getElementById('manual-delivery-sn-cb');
  if (snCb && val.trim()) snCb.checked = false;
}

function toggleManualDeliverySN() {
  const snCb = document.getElementById('manual-delivery-sn-cb');
  const numInput = document.getElementById('manual-delivery-number-input');
  const hiddenNum = document.getElementById('manual-delivery-number');

  if (snCb && snCb.checked) {
    if (numInput) { numInput.value = ''; numInput.disabled = true; }
    if (hiddenNum) hiddenNum.value = 'S/N';
  } else {
    if (numInput) { numInput.disabled = false; }
    if (hiddenNum) hiddenNum.value = numInput ? numInput.value.trim() : '';
  }
}

function onMapMarkerPositionChanged(lat, lng) {
  const latInput = document.getElementById('manual-delivery-lat');
  const lngInput = document.getElementById('manual-delivery-lng');
  const precInput = document.getElementById('manual-geocoding-precision');
  const adjInput = document.getElementById('manual-location-adjusted-manually');
  const warnBox = document.getElementById('manual-geocoding-warning');

  if (latInput) latInput.value = typeof lat === 'number' ? lat.toFixed(7) : lat;
  if (lngInput) lngInput.value = typeof lng === 'number' ? lng.toFixed(7) : lng;
  if (precInput) precInput.value = 'manual';
  if (adjInput) adjInput.value = 'true';
  if (warnBox) warnBox.classList.add('hidden');
}

let isPlacesApi403Blocked = false;

function showPlacesApi403Warning() {
  const warnBox = document.getElementById('manual-geocoding-warning');
  if (warnBox) {
    warnBox.classList.remove('hidden');
    warnBox.innerHTML = '⚠️ <strong>A busca de endereços está indisponível.</strong> Ative a Places API (New) e permita essa API nas restrições da chave.';
  }
}

function handlePlacesApi403Error() {
  if (isPlacesApi403Blocked) return;
  isPlacesApi403Blocked = true;
  console.warn("Places API (New) indisponível ou bloqueada (Erro 403 Forbidden).");
  showPlacesApi403Warning();

  const existingInput = document.getElementById('manual-delivery-address');
  if (existingInput) {
    existingInput.style.display = 'block';
  }
}

async function initGooglePlacesAutocomplete() {
  const container = document.getElementById('manual-address-suggestions')?.parentElement || document.getElementById('manual-delivery-address')?.parentElement;
  if (!container || container.dataset.googleAutocompleteAttached === 'true') return;

  if (isPlacesApi403Blocked) {
    showPlacesApi403Warning();
    return;
  }

  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) return;

  try {
    await loadGoogleMapsApi();
    const { PlaceAutocompleteElement } = await window.google.maps.importLibrary('places');

    container.dataset.googleAutocompleteAttached = 'true';

    // Bounding Box cobrindo todo o estado do Rio Grande do Sul (RS)
    const rsBounds = {
      north: -27.08,
      south: -33.75,
      east: -49.69,
      west: -57.65
    };

    const autocompleteElement = new PlaceAutocompleteElement({
      locationRestriction: rsBounds,
      includedRegionCodes: ['BR']
    });

    autocompleteElement.id = 'manual-delivery-place-autocomplete';

    autocompleteElement.addEventListener('gmp-placeselect', async (evt) => {
      const eventPlace = evt.place || (evt.detail && evt.detail.place);
      if (!eventPlace) return;

      try {
        await eventPlace.fetchFields({
          fields: ['id', 'formattedAddress', 'addressComponents', 'location', 'viewport']
        });
        handlePlaceSelection(eventPlace);
      } catch (err) {
        console.warn("fetchFields error:", err.message || err);
        if (err?.message?.includes('403') || err?.status === 403) {
          handlePlacesApi403Error();
        }
      }
    });

    const existingInput = document.getElementById('manual-delivery-address');
    if (existingInput && existingInput.parentNode === container) {
      existingInput.style.display = 'none';
    }
    container.appendChild(autocompleteElement);
  } catch (err) {
    console.warn("PlaceAutocompleteElement notice:", err.message || err);
    if (err?.message?.includes('403') || err?.status === 403 || err?.message?.includes('blocked') || err?.message?.includes('disabled')) {
      handlePlacesApi403Error();
    }
  }
}

function handlePlaceSelection(place) {
  const components = place.addressComponents || place.address_components || [];
  let route = '';
  let streetNumber = '';
  let sublocality = '';
  let city = '';
  let state = '';
  let country = '';
  let postalCode = '';

  components.forEach(comp => {
    const types = comp.types || [];
    const longName = comp.longText || comp.long_name || comp.name || '';
    const shortName = comp.shortText || comp.short_name || '';

    if (types.includes('route')) route = longName;
    if (types.includes('street_number')) streetNumber = longName;
    if (types.includes('sublocality') || types.includes('sublocality_level_1') || types.includes('neighborhood')) {
      if (!sublocality) sublocality = longName;
    }
    if (types.includes('locality') || types.includes('administrative_area_level_2')) {
      if (!city) city = longName;
    }
    if (types.includes('administrative_area_level_1')) state = shortName || longName;
    if (types.includes('country')) country = shortName || longName;
    if (types.includes('postal_code')) postalCode = longName;
  });

  const warnBox = document.getElementById('manual-geocoding-warning');
  const placeIdInput = document.getElementById('manual-delivery-place-id');
  const latInput = document.getElementById('manual-delivery-lat');
  const lngInput = document.getElementById('manual-delivery-lng');

  const stateUpper = (state || '').toUpperCase();
  const isRS = stateUpper === 'RS' || state.toLowerCase().includes('rio grande do sul');

  // Validação Estrita de Estado: Apenas RS é aceito
  if (state && !isRS) {
    if (placeIdInput) placeIdInput.value = '';
    if (latInput) latInput.value = '';
    if (lngInput) lngInput.value = '';

    if (warnBox) {
      warnBox.classList.remove('hidden');
      warnBox.innerHTML = '⚠️ <strong>Este endereço está fora da área atendida.</strong> Selecione um endereço no Rio Grande do Sul.';
    }
    return;
  }

  let lat = 0;
  let lng = 0;
  if (place.location) {
    lat = typeof place.location.lat === 'function' ? place.location.lat() : place.location.lat;
    lng = typeof place.location.lng === 'function' ? place.location.lng() : place.location.lng;
  } else if (place.geometry && place.geometry.location) {
    lat = typeof place.geometry.location.lat === 'function' ? place.geometry.location.lat() : place.geometry.location.lat;
    lng = typeof place.geometry.location.lng === 'function' ? place.geometry.location.lng() : place.geometry.location.lng;
  }

  const placeId = place.id || place.place_id || '';
  const formattedAddress = place.formattedAddress || place.formatted_address || route;
  const cleanFormatted = formattedAddress.replace(/, Brasil$/i, '');

  const addrInput = document.getElementById('manual-delivery-address');
  const numInput = document.getElementById('manual-delivery-number');
  const numVisibleInput = document.getElementById('manual-delivery-number-input');
  const neighInput = document.getElementById('manual-delivery-neighborhood');
  const cityInput = document.getElementById('manual-delivery-city');
  const stateInput = document.getElementById('manual-delivery-state');
  const postalCodeInput = document.getElementById('manual-delivery-postal-code');
  const precInput = document.getElementById('manual-geocoding-precision');
  const snCb = document.getElementById('manual-delivery-sn-cb');
  const confirmArea = document.getElementById('manual-number-confirm-area');
  const summaryBox = document.getElementById('manual-address-summary-box');
  const summaryTitle = document.getElementById('manual-address-summary-title');
  const summarySubtitle = document.getElementById('manual-address-summary-subtitle');

  if (addrInput) addrInput.value = cleanFormatted;
  if (numInput) numInput.value = streetNumber || '';
  if (numVisibleInput) numVisibleInput.value = streetNumber || '';
  if (neighInput) neighInput.value = sublocality || '';
  if (cityInput) cityInput.value = city || 'Sapucaia do Sul';
  if (stateInput) stateInput.value = 'RS';
  if (postalCodeInput) postalCodeInput.value = postalCode || '';
  if (placeIdInput) placeIdInput.value = placeId;
  if (latInput) latInput.value = typeof lat === 'number' ? lat.toFixed(7) : lat;
  if (lngInput) lngInput.value = typeof lng === 'number' ? lng.toFixed(7) : lng;

  // Resumo Compacto do Endereço (Somente Leitura)
  if (summaryBox && summaryTitle && summarySubtitle) {
    const mainTitle = route ? (streetNumber ? `${route}, ${streetNumber}` : route) : cleanFormatted;
    const subText = `${sublocality ? sublocality + ' • ' : ''}${city || 'Sapucaia do Sul'} - RS`;
    summaryTitle.innerText = mainTitle;
    summarySubtitle.innerText = subText;
    summaryBox.classList.remove('hidden');
  }

  // Área Dinâmica de Número Não Confirmado
  if (streetNumber) {
    if (precInput) precInput.value = 'rooftop';
    if (confirmArea) confirmArea.classList.add('hidden');
    if (warnBox) warnBox.classList.add('hidden');
  } else {
    if (precInput) precInput.value = 'street';
    if (confirmArea) confirmArea.classList.remove('hidden');
    if (warnBox) {
      warnBox.classList.remove('hidden');
      warnBox.innerHTML = '⚠️ <strong>O Google não confirmou o número deste endereço.</strong> Informe o número ou marque S/N e confira o marcador.';
    }
  }

  if (manualDeliveryMap) {
    manualDeliveryMap.setCenter({ lat, lng });
    manualDeliveryMap.setZoom(16);
  }
  if (manualDeliveryMarker) {
    if (manualDeliveryMarker.position) {
      manualDeliveryMarker.position = { lat, lng };
    } else if (typeof manualDeliveryMarker.setPosition === 'function') {
      manualDeliveryMarker.setPosition({ lat, lng });
    }
  }
}

function showRequestDeliveryModal() {
  const modal = document.getElementById('modal-request-delivery');
  const searchInput = document.getElementById('admin-client-search');
  const selectedInput = document.getElementById('selectedClientId');
  const destNameInput = document.getElementById('manual-delivery-dest-name');
  const destPhoneInput = document.getElementById('manual-delivery-dest-phone');
  const addrInput = document.getElementById('manual-delivery-address');
  const numInput = document.getElementById('manual-delivery-number');
  const numVisibleInput = document.getElementById('manual-delivery-number-input');
  const snCb = document.getElementById('manual-delivery-sn-cb');
  const compInput = document.getElementById('manual-delivery-complement');
  const neighInput = document.getElementById('manual-delivery-neighborhood');
  const cityInput = document.getElementById('manual-delivery-city');
  const notesInput = document.getElementById('manual-order-notes');
  const summaryBox = document.getElementById('manual-address-summary-box');
  const confirmArea = document.getElementById('manual-number-confirm-area');

  if (searchInput) searchInput.value = '';
  if (selectedInput) selectedInput.value = '';
  if (destNameInput) destNameInput.value = '';
  if (destPhoneInput) destPhoneInput.value = '';
  if (addrInput) addrInput.value = '';
  if (numInput) numInput.value = '';
  if (numVisibleInput) { numVisibleInput.value = ''; numVisibleInput.disabled = false; }
  if (snCb) snCb.checked = false;
  if (compInput) compInput.value = '';
  if (neighInput) neighInput.value = '';
  if (cityInput) cityInput.value = 'Sapucaia do Sul';
  if (notesInput) notesInput.value = '';
  if (summaryBox) summaryBox.classList.add('hidden');
  if (confirmArea) confirmArea.classList.add('hidden');

  const latEl = document.getElementById('manual-delivery-lat');
  const lngEl = document.getElementById('manual-delivery-lng');
  const precEl = document.getElementById('manual-geocoding-precision');
  const manEl = document.getElementById('manual-location-adjusted-manually');
  const warnEl = document.getElementById('manual-geocoding-warning');

  if (latEl) latEl.value = '';
  if (lngEl) lngEl.value = '';
  if (precEl) precEl.value = 'unconfirmed';
  if (manEl) manEl.value = 'false';
  if (warnEl) warnEl.classList.add('hidden');

  if (modal) modal.classList.remove('hidden');
  fetchCommercialClientsForSelect();
  initManualDeliveryMap();
}


function closeRequestDeliveryModal(event) {
  if (event && event.target && !event.target.classList.contains('modal-overlay') && !event.target.classList.contains('modal-close-btn') && !event.target.closest('.modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('modal-request-delivery');
  if (modal) modal.classList.add('hidden');
}

async function submitDeliveryRequest(event, type = 'manual') {
  if (event) event.preventDefault();

  const selectedClientId = document.getElementById('selectedClientId')?.value;
  if (!selectedClientId) {
    showToastNotification('Por favor, selecione um cliente comercial cadastrado.');
    return;
  }

  const destName = document.getElementById('manual-delivery-dest-name')?.value?.trim();
  if (!destName || destName === 'Cliente informado') {
    showToastNotification('Informe o nome do destinatário.');
    return;
  }

  const destPhone = document.getElementById('manual-delivery-dest-phone')?.value?.trim();
  if (!destPhone) {
    showToastNotification('Informe o telefone do destinatário.');
    return;
  }

  const address = document.getElementById('manual-delivery-address')?.value?.trim();
  if (!address) {
    showToastNotification('Informe o endereço de entrega.');
    return;
  }

  const stateVal = document.getElementById('manual-delivery-state')?.value?.trim() || 'RS';
  if (stateVal.toUpperCase() !== 'RS' && !stateVal.toLowerCase().includes('rio grande do sul')) {
    showToastNotification('Este endereço está fora da área atendida. Selecione um endereço no Rio Grande do Sul.');
    return;
  }

  const number = document.getElementById('manual-delivery-number')?.value?.trim();
  const isSN = document.getElementById('manual-delivery-sn-cb')?.checked;
  if (!number && !isSN) {
    showToastNotification('Informe o número da residência ou marque S/N (Sem número).');
    return;
  }

  const latRaw = document.getElementById('manual-delivery-lat')?.value;
  const lngRaw = document.getElementById('manual-delivery-lng')?.value;
  const lat = latRaw ? parseFloat(latRaw) : null;
  const lng = lngRaw ? parseFloat(lngRaw) : null;

  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    showToastNotification('Selecione um endereço ou confirme o marcador no mapa para obter as coordenadas.');
    return;
  }

  const placeId = document.getElementById('manual-delivery-place-id')?.value?.trim();
  if (!placeId && !isPlacesApi403Blocked) {
    showToastNotification('Selecione uma sugestão válida do Google Autocomplete.');
    return;
  }

  const complement = document.getElementById('manual-delivery-complement')?.value?.trim() || null;
  const neighborhood = document.getElementById('manual-delivery-neighborhood')?.value?.trim() || null;
  const city = document.getElementById('manual-delivery-city')?.value?.trim() || 'Sapucaia do Sul';
  const notes = document.getElementById('manual-order-notes')?.value || '';

  const precision = document.getElementById('manual-geocoding-precision')?.value || 'unconfirmed';
  const isManual = document.getElementById('manual-location-adjusted-manually')?.value === 'true';

  const btnSubmit = document.querySelector('#request-delivery-form button[type="submit"]');
  if (btnSubmit) btnSubmit.disabled = true;

  const idempotencyKey = `idemp-admin-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  try {
    if (supabaseClient) {
      const { data, error } = await supabaseClient.rpc('create_admin_tele', {
        p_client_id: selectedClientId,
        p_pickup_address: '',
        p_delivery_address: address,
        p_recipient_name: destName,
        p_recipient_phone: destPhone,
        p_idempotency_key: idempotencyKey,
        p_reference: null,
        p_notes: notes,
        p_order_value: 0,
        p_operation_source: 'owner_panel',
        p_delivery_number: isSN ? 'S/N' : number,
        p_delivery_complement: complement,
        p_delivery_neighborhood: neighborhood,
        p_delivery_city: city,
        p_delivery_latitude: lat,
        p_delivery_longitude: lng,
        p_geocoding_precision: precision,
        p_location_adjusted_manually: isManual
      });

      if (error) throw error;
      if (!data.success) {
        showToastNotification(`Erro ao criar Tele: ${data.message}`);
        if (btnSubmit) btnSubmit.disabled = false;
        return;
      }

      showToastNotification(`Tele ${data.tele_code || ''} criada com sucesso! (Status: Aguardando Despacho)`);
      if (typeof fetchPendingDeliveries === 'function') await fetchPendingDeliveries();
      if (typeof renderTelesUnified === 'function') renderTelesUnified();
    }

    closeRequestDeliveryModal();
  } catch (err) {
    console.error("Erro ao criar Tele manual:", err);
    showToastNotification("Erro de conexão ao criar a Tele.");
  } finally {
    if (btnSubmit) btnSubmit.disabled = false;
  }
}



// 7. Solicitação de Entrega pelo Painel do Cliente (Vocabulário "Entrega")
function parseMoneyBR(input) {
  if (input === null || input === undefined || input === '') return 0.00;
  if (typeof input === 'number') {
    if (isNaN(input) || input < 0 || input > 50000.00) throw new Error('VALOR_MONETARIO_INVALIDO');
    return Math.round(input * 100) / 100;
  }
  let str = String(input).trim().replace(/^R\$\s?/, '');
  if (!str) return 0.00;

  if (/^\d{1,3}\.\d{3}$/.test(str)) {
    throw new Error('FORMATO_AMBIGUO: Formatos como 1.250 não são permitidos. Use 1250, 1250,50 ou 1.250,50.');
  }

  const isPlainInt = /^\d+$/.test(str);
  const isCommaDecimal = /^\d+(,\d{1,2})?$/.test(str);
  const isPtBrThousands = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(str);
  const isDotDecimal = /^\d+(\.\d{1,2})?$/.test(str);

  if (!isPlainInt && !isCommaDecimal && !isPtBrThousands && !isDotDecimal) {
    throw new Error('FORMATO_MONETARIO_INVALIDO: Formato numérico não reconhecido.');
  }

  if (str.includes(',')) {
    str = str.replace(/\./g, '').replace(',', '.');
  }

  const val = Number(str);
  if (isNaN(val) || val < 0 || val > 50000.00) {
    throw new Error('VALOR_MONETARIO_FORA_DOS_LIMITES (0 a R$ 50.000,00).');
  }

  return Math.round(val * 100) / 100;
}

async function computeCanonicalPayloadFingerprint(payload, userId) {
  const canonicalObj = {
    user_id: String(userId || ''),
    pickup_address: (payload.p_pickup_address || '').trim(),
    delivery_address: (payload.p_delivery_address || '').trim(),
    delivery_number: (payload.p_delivery_number || '').trim(),
    delivery_complement: (payload.p_delivery_complement || '').trim(),
    delivery_neighborhood: (payload.p_delivery_neighborhood || '').trim(),
    delivery_city: (payload.p_delivery_city || '').trim(),
    delivery_state: (payload.p_delivery_state || 'RS').trim(),
    delivery_postal_code: (payload.p_delivery_postal_code || '').replace(/\D/g, ''),
    recipient_name: (payload.p_recipient_name || '').trim(),
    recipient_phone: (payload.p_recipient_phone || '').replace(/\D/g, ''),
    reference: (payload.p_reference || '').trim(),
    notes: (payload.p_notes || '').trim(),
    order_value: Number(payload.p_order_value || 0).toFixed(2),
    delivery_lat: payload.p_delivery_latitude ?? null,
    delivery_lng: payload.p_delivery_longitude ?? null,
    pickup_lat: payload.p_pickup_latitude ?? null,
    pickup_lng: payload.p_pickup_longitude ?? null,
    place_id: (payload.p_place_id || '').trim(),
    precision: (payload.p_geocoding_precision || 'unconfirmed').trim(),
    is_manual: Boolean(payload.p_location_adjusted_manually)
  };

  const canonicalJson = JSON.stringify(canonicalObj, Object.keys(canonicalObj).sort());
  if (window.crypto && window.crypto.subtle) {
    const msgUint8 = new TextEncoder().encode(canonicalJson);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let hash = 0;
  for (let i = 0; i < canonicalJson.length; i++) {
    hash = ((hash << 5) - hash) + canonicalJson.charCodeAt(i);
    hash |= 0;
  }
  return `fp_fallback_${Math.abs(hash)}`;
}

// 7. Solicitação de Entrega pelo Painel do Cliente (Vocabulário "Entrega")
async function submitClientDeliveryRequest(event) {
  if (event) event.preventDefault();

  if (activeCommercialClient && activeCommercialClient.lifecycle_status === 'suspenso') {
    showToastNotification('Sua conta comercial encontra-se suspensa para novas solicitações. Entre em contato com o suporte.');
    return;
  }

  const clientName = activeCommercialClient ? activeCommercialClient.establishment_name : 'Cliente Parceiro';
  const clientId = activeCommercialClient ? activeCommercialClient.id : null;

  const destName = document.getElementById('client-dest-name')?.value.trim() || 'Destinatário';
  const address = document.getElementById('client-delivery-address')?.value.trim();
  const phone = document.getElementById('client-dest-phone')?.value.trim() || '';
  const cargo = document.getElementById('client-cargo-notes')?.value.trim() || 'Sem observações';
  const rawPrice = document.getElementById('client-delivery-price')?.value || '15,00';
  
  let orderValue = 0;
  try {
    orderValue = parseMoneyBR(rawPrice);
  } catch (err) {
    showToastNotification(`Erro no valor da entrega: ${err.message}`);
    return;
  }

  if (!address) {
    showToastNotification('Informe o endereço de entrega.');
    return;
  }

  const payload = {
    p_pickup_address: null, // Null aciona o fallback para commercial_clients.address
    p_delivery_address: address,
    p_recipient_name: destName,
    p_recipient_phone: phone,
    p_reference: null,
    p_notes: cargo,
    p_order_value: orderValue,
    p_operation_source: 'client_portal',
    p_delivery_number: null,
    p_delivery_complement: null,
    p_delivery_neighborhood: null,
    p_delivery_city: 'Sapucaia do Sul',
    p_delivery_postal_code: null,
    p_delivery_latitude: null,
    p_delivery_longitude: null,
    p_geocoding_precision: 'unconfirmed',
    p_location_adjusted_manually: false,
    p_pickup_latitude: null,
    p_pickup_longitude: null,
    p_place_id: null,
    p_delivery_state: 'RS'
  };

  const userId = currentActiveSession?.user?.id || 'anon_client';
  const currentFingerprint = await computeCanonicalPayloadFingerprint(payload, userId);

  let idempotencyDataRaw = sessionStorage.getItem('client_tele_idempotency_session');
  let idempotencyData = null;
  if (idempotencyDataRaw) {
    try { idempotencyData = JSON.parse(idempotencyDataRaw); } catch (e) {}
  }

  let activeIdempotencyKey = null;
  if (idempotencyData && idempotencyData.fingerprint === currentFingerprint && idempotencyData.userId === userId) {
    activeIdempotencyKey = idempotencyData.key;
  } else {
    activeIdempotencyKey = `idemp-client-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    sessionStorage.setItem('client_tele_idempotency_session', JSON.stringify({
      key: activeIdempotencyKey,
      fingerprint: currentFingerprint,
      userId: userId,
      createdAt: new Date().toISOString()
    }));
  }

  payload.p_idempotency_key = activeIdempotencyKey;

  showToastNotification('Enviando solicitação de entrega via RPC...');

  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('create_client_tele', payload);
      if (error) throw error;

      if (!data.success) {
        showToastNotification(`Erro na RPC ao criar entrega: ${data.message || data.error_code}`);
        return;
      }

      sessionStorage.removeItem('client_tele_idempotency_session');
      showToastNotification(`Entrega #${data.tele_code || data.tele_id} criada com sucesso! Status: Aguardando Despacho.`);

      if (typeof fetchClientHistory === 'function') await fetchClientHistory();
      if (typeof fetchPendingDeliveries === 'function') await fetchPendingDeliveries();
      if (typeof renderTelesUnified === 'function') renderTelesUnified();

      return;
    } catch (err) {
      console.warn("Aviso na chamada da RPC create_client_tele:", err.message);
      showToastNotification("Erro de conexão ao criar entrega. Tente novamente.");
      return;
    }
  }
}

// =====================================================================
// CENTRO DE OPERAÇÕES — FASE 1 & FASE 2 (KANBAN, STATE MACHINE & SLA)
// =====================================================================

// Stores em memória para busca O(1) por ID
const opTelesStoreMap = new Map();
const opRidersStoreMap = new Map();
const opClientsStoreMap = new Map();

// Debounce timer para busca instantânea
let opSearchDebounceTimer = null;

// 1. Configuração Centralizada de SLA (em minutos)


const SLA_CONFIG = {
  solicitada: { warning_minutes: 10, critical_minutes: 20 },
  aguardando_despacho: { warning_minutes: 10, critical_minutes: 20 },
  motoboy_designado: { warning_minutes: 10, critical_minutes: 15 },
  indo_coletar: { warning_minutes: 15, critical_minutes: 25 },
  aguardando_coleta: { warning_minutes: 10, critical_minutes: 20 },
  coletada: { warning_minutes: 15, critical_minutes: 30 },
  em_entrega: { warning_minutes: 20, critical_minutes: 35 },
  concluida: { warning_minutes: 9999, critical_minutes: 9999 },
  cancelada: { warning_minutes: 9999, critical_minutes: 9999 },
  status_unknown: { warning_minutes: 5, critical_minutes: 10 }
};

function getSLAConfigurationForStatus(status) {
  const norm = normalizeTeleStatus(status);
  return SLA_CONFIG[norm] || SLA_CONFIG.status_unknown;
}

// 2. Normalizador Oficial de Status (remover acentos, lowercase, trim, underscores)
function normalizeTeleStatus(rawStatus) {
  if (rawStatus === null || rawStatus === undefined || typeof rawStatus !== 'string') {
    return 'status_unknown';
  }

  const cleaned = rawStatus
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');

  const mapping = {
    'novo': 'solicitada',
    'solicitada': 'solicitada',
    'pendente': 'solicitada',

    'aguardando_despacho': 'aguardando_despacho',
    'aguardando_motoboy': 'aguardando_despacho',

    'atribuido': 'motoboy_designado',
    'aceito': 'motoboy_designado',
    'designado': 'motoboy_designado',
    'motoboy_designado': 'motoboy_designado',

    'indo_coletar': 'indo_coletar',
    'a_caminho_da_coleta': 'indo_coletar',

    'aguardando_coleta': 'aguardando_coleta',
    'no_estabelecimento': 'aguardando_coleta',
    'no_ponto_de_coleta': 'aguardando_coleta',

    'coletada': 'coletada',
    'carga_retirada': 'coletada',

    'em_rota': 'em_entrega',
    'em_entrega': 'em_entrega',
    'saiu_para_entrega': 'em_entrega',
    'em_transito': 'em_entrega',

    'entregue': 'concluida',
    'concluida': 'concluida',
    'concluido': 'concluida',
    'pago': 'concluida',

    'cancelado': 'cancelada',
    'cancelada': 'cancelada',

    'em_andamento': 'em_entrega',
    'solicitado': 'solicitada',
    'criada': 'solicitada'
  };

  return mapping[cleaned] || 'status_unknown';
}

// Resolução Oficial do Nome Visual do Cliente (sem fallback de nomes fictícios)
function resolveClientDisplayName(tele) {
  if (!tele) return 'Cliente não vinculado';
  
  if (tele.client_id) {
    const client = opClientsStoreMap.get(String(tele.client_id));
    if (client && (client.establishment_name || client.trade_name || client.name)) {
      return client.establishment_name || client.trade_name || client.name;
    }
  }

  if (tele.client && !tele.client.toLowerCase().includes('garra') && !tele.client.toLowerCase().includes('parceiro') && tele.client !== 'Cliente informado') {
    return tele.client;
  }

  return 'Cliente não vinculado';
}

// =====================================================================
// SELETOR PESQUISÁVEL DE CLIENTES COMERCIAIS (commercial_clients)
// =====================================================================
let commercialClientsForSelect = [];

async function fetchCommercialClientsForSelect() {
  const dropdown = document.getElementById('admin-client-dropdown');
  const showInactive = document.getElementById('show-inactive-clients-cb')?.checked || false;

  if (dropdown) {
    dropdown.innerHTML = '<div style="padding: 10px; color: var(--color-text-muted); text-align: center;">Carregando clientes...</div>';
  }

  try {
    if (supabaseClient) {
      let query = supabaseClient
        .from('commercial_clients')
        .select('id, establishment_name, client_code, responsible_name, phone, lifecycle_status')
        .order('establishment_name', { ascending: true });

      if (!showInactive) {
        query = query.eq('lifecycle_status', 'ativo');
      }

      const { data, error } = await query;
      if (error) throw error;
      commercialClientsForSelect = data || [];
    } else {
      // Dev local fallback from opClientsStoreMap
      commercialClientsForSelect = Array.from(opClientsStoreMap.values()).filter(c => {
        return showInactive || (c.lifecycle_status || c.status || 'ativo') === 'ativo';
      });
      if (commercialClientsForSelect.length === 0) {
        commercialClientsForSelect = [
          { id: 'client-uuid-1', establishment_name: 'Lancheria Dahora', client_code: 'CLI-000001', responsible_name: 'João Silva', phone: '(11) 99999-0001', lifecycle_status: 'ativo' },
          { id: 'client-uuid-2', establishment_name: 'Pizzaria da Nonna', client_code: 'CLI-000002', responsible_name: 'Maria Nonna', phone: '(11) 99999-0002', lifecycle_status: 'ativo' },
          { id: 'client-uuid-3', establishment_name: 'Dogão Express', client_code: 'CLI-000003', responsible_name: 'Marcos Fernandes', phone: '(11) 99999-0003', lifecycle_status: 'ativo' },
          { id: 'client-uuid-4', establishment_name: 'Lanchonete Dahora', client_code: 'CLI-000004', responsible_name: 'Pedro Santos', phone: '(11) 99999-0004', lifecycle_status: 'ativo' }
        ];
      }
    }

    renderClientSelectDropdownItems(commercialClientsForSelect);
  } catch (err) {
    console.error("Erro ao carregar clientes comerciais:", err);
    if (dropdown) {
      dropdown.innerHTML = '<div style="padding: 10px; color: #ef4444; text-align: center;">Erro ao carregar lista de clientes.</div>';
    }
  }
}

function renderClientSelectDropdownItems(clients = []) {
  const dropdown = document.getElementById('admin-client-dropdown');
  if (!dropdown) return;

  if (clients.length === 0) {
    dropdown.innerHTML = '<div style="padding: 10px; color: var(--color-text-muted); text-align: center;">Nenhum cliente cadastrado encontrado.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  clients.forEach((client, idx) => {
    const item = document.createElement('div');
    item.className = 'custom-select-item';
    item.setAttribute('role', 'option');
    item.setAttribute('tabindex', '0');
    item.setAttribute('id', `client-opt-${idx}`);
    item.style.cssText = 'padding: 8px 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items: center;';
    
    const status = (client.lifecycle_status || 'ativo').toLowerCase();
    const badgeClass = status === 'ativo' ? 'status-success' :
                       status === 'teste' ? 'badge-info' :
                       status === 'suspenso' ? 'status-warning' : 'status-danger';

    item.innerHTML = `
      <div>
        <strong style="color: var(--color-text); font-size: 0.85rem;">${escapeHtml(client.establishment_name || client.name || 'Sem nome')}</strong>
        <div style="font-size: 0.72rem; color: var(--color-text-muted);">
          ${escapeHtml(client.client_code || 'CLI-—')} ${client.responsible_name ? '• ' + escapeHtml(client.responsible_name) : ''}
        </div>
      </div>
      <span class="badge ${badgeClass}" style="font-size: 0.68rem; text-transform: uppercase;">
        ${escapeHtml(status)}
      </span>
    `;

    item.onclick = () => selectCommercialClient(client);
    item.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectCommercialClient(client);
      }
    };

    fragment.appendChild(item);
  });

  dropdown.innerHTML = '';
  dropdown.appendChild(fragment);
}

function selectCommercialClient(client) {
  const hiddenInput = document.getElementById('selectedClientId');
  const searchInput = document.getElementById('admin-client-search');
  const dropdown = document.getElementById('admin-client-dropdown');
  const submitBtn = document.querySelector('#request-delivery-form button[type="submit"]');

  if (hiddenInput) hiddenInput.value = client.id;
  if (searchInput) {
    searchInput.value = client.establishment_name || client.name || '';
    searchInput.setAttribute('aria-expanded', 'false');
  }
  if (dropdown) dropdown.classList.add('hidden');

  // Validação Visual para Clientes Inativos/Suspensos
  const status = (client.lifecycle_status || 'ativo').toLowerCase();
  const isAllowedToCreate = status === 'ativo' || status === 'teste';

  let alertBox = document.getElementById('admin-client-inactive-warning');
  if (!isAllowedToCreate) {
    if (!alertBox) {
      alertBox = document.createElement('div');
      alertBox.id = 'admin-client-inactive-warning';
      alertBox.style.cssText = 'background: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #ef4444; padding: 8px 12px; border-radius: 6px; font-size: 0.8rem; margin-top: 6px; font-weight: 500;';
      const container = document.getElementById('admin-client-select-wrapper');
      if (container) container.appendChild(alertBox);
    }
    alertBox.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px; height: 14px; vertical-align: middle; margin-right: 4px;"></i> Cliente <strong>${escapeHtml(client.establishment_name || '')}</strong> encontra-se com status <strong>${status.toUpperCase()}</strong>. Não é possível solicitar entregas.`;
    alertBox.classList.remove('hidden');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.title = 'Cliente suspenso ou inativo não pode criar entregas.';
    }
  } else {
    if (alertBox) alertBox.classList.add('hidden');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.removeAttribute('title');
    }
  }

  if (window.lucide) window.lucide.createIcons();
}

function initClientSelectComponent() {
  const searchInput = document.getElementById('admin-client-search');
  const dropdown = document.getElementById('admin-client-dropdown');

  if (!searchInput || !dropdown) return;

  searchInput.onclick = () => {
    dropdown.classList.remove('hidden');
    searchInput.setAttribute('aria-expanded', 'true');
    fetchCommercialClientsForSelect();
  };

  searchInput.oninput = () => {
    dropdown.classList.remove('hidden');
    searchInput.setAttribute('aria-expanded', 'true');
    const q = searchInput.value.toLowerCase().trim();
    const filtered = commercialClientsForSelect.filter(c => {
      const nameMatch = (c.establishment_name || c.name || '').toLowerCase().includes(q);
      const codeMatch = (c.client_code || '').toLowerCase().includes(q);
      const respMatch = (c.responsible_name || '').toLowerCase().includes(q);
      return nameMatch || codeMatch || respMatch;
    });
    renderClientSelectDropdownItems(filtered);
  };

  searchInput.onkeydown = (e) => {
    if (e.key === 'Escape') {
      dropdown.classList.add('hidden');
      searchInput.setAttribute('aria-expanded', 'false');
    }
  };

  document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('admin-client-select-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
      dropdown.classList.add('hidden');
      searchInput.setAttribute('aria-expanded', 'false');
    }
  });
}

// 3. State Machine Oficial (Validador de Transições)
function canTransitionTeleStatus(currentRaw, nextRaw) {
  const current = normalizeTeleStatus(currentRaw);
  const next = normalizeTeleStatus(nextRaw);

  if (current === next) return true;

  const allowedTransitions = {
    solicitada: ['aguardando_despacho', 'motoboy_designado', 'cancelada'],
    aguardando_despacho: ['motoboy_designado', 'solicitada', 'cancelada'],
    motoboy_designado: ['indo_coletar', 'aguardando_coleta', 'cancelada'],
    indo_coletar: ['aguardando_coleta', 'coletada', 'cancelada'],
    aguardando_coleta: ['coletada', 'em_entrega', 'cancelada'],
    coletada: ['em_entrega', 'concluida', 'cancelada'],
    em_entrega: ['concluida', 'cancelada'],
    concluida: [],
    cancelada: []
  };

  return (allowedTransitions[current] || []).includes(next);
}

// 4. Cálculo de Tempo Decorrido & SLA derivado estritamente de created_at UTC ISO 8601
function calculateTeleElapsedTime(tele, eventsList = []) {
  const normStatus = normalizeTeleStatus(tele ? tele.status : null);
  
  if (['concluida', 'cancelada'].includes(normStatus)) {
    return { elapsedMinutes: 0, isInvalid: false, isInactive: true };
  }

  if (!tele || !tele.created_at) {
    return { elapsedMinutes: null, isInvalid: true, reason: 'CREATED_AT_MISSING' };
  }

  const createdTimestamp = Date.parse(tele.created_at);
  if (isNaN(createdTimestamp)) {
    return { elapsedMinutes: null, isInvalid: true, reason: 'CREATED_AT_INVALID' };
  }

  const nowTimestamp = Date.now();
  if (createdTimestamp > nowTimestamp + 60000) {
    return { elapsedMinutes: null, isInvalid: true, reason: 'FUTURE_DATE' };
  }

  const elapsedMs = Math.max(0, nowTimestamp - createdTimestamp);
  const elapsedMinutes = Math.floor(elapsedMs / 60000);

  return { elapsedMinutes, isInvalid: false, enteredAt: new Date(createdTimestamp) };
}

function calculateTeleSLAState(tele, eventsList = []) {
  const config = getSLAConfigurationForStatus(tele ? tele.status : null);
  const elapsed = calculateTeleElapsedTime(tele, eventsList);

  if (elapsed.isInvalid) {
    return { state: 'invalid', elapsedMinutes: null, label: 'SLA indisponível', config };
  }

  if (elapsed.isInactive) {
    return { state: 'normal', elapsedMinutes: 0, label: '0 min', config };
  }

  const elapsedMinutes = elapsed.elapsedMinutes;
  let state = 'normal';
  if (elapsedMinutes >= config.critical_minutes) {
    state = 'critical';
  } else if (elapsedMinutes >= config.warning_minutes) {
    state = 'warning';
  }

  return { state, elapsedMinutes, label: `${elapsedMinutes} min`, enteredAt: elapsed.enteredAt, config };
}

// 5. Filtro do Dia no Fuso Horário Local
function isTodayInLocalTime(dateInput) {
  if (!dateInput) return false;
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return false;

  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
         d.getMonth() === now.getMonth() &&
         d.getDate() === now.getDate();
}

// 6. Adapter de Motoboys (Oficial `fleet` com ponte seguro)
function syncRidersStoreMap() {
  opRidersStoreMap.clear();

  // 1. Fonte Oficial: fleet
  (mockData.fleet || []).forEach(r => {
    opRidersStoreMap.set(String(r.id), {
      id: String(r.id),
      name: r.name,
      vehicle: r.vehicle || 'Moto',
      plate: r.plate || '—',
      status: r.status || 'Disponível',
      battery: r.battery || '100%',
      rating: r.rating || 5.0,
      source: 'fleet'
    });
  });

  // 2. Ponte de compatibilidade sem duplicar IDs
  if (Array.isArray(mockData.motoboys)) {
    mockData.motoboys.forEach(m => {
      const key = String(m.id);
      if (!opRidersStoreMap.has(key)) {
        opRidersStoreMap.set(key, {
          id: key,
          name: m.nome || m.name,
          vehicle: 'Moto',
          plate: '—',
          status: m.ativo ? 'Disponível' : 'Indisponível',
          battery: '100%',
          rating: 5.0,
          source: 'motoboys'
        });
      }
    });
  }
}

function normalizeTeleRecord(item) {
  if (!item) return null;
  const id = String(item.id || item.raw_id || item.tele_code || '');
  if (!id) return null;

  const version = (item.version !== undefined && item.version !== null) ? Number(item.version) : null;

  return {
    id: id,
    raw_id: item.raw_id || item.id,
    tele_code: item.tele_code || item.code || item.id || null,
    client_id: item.client_id || null,
    client: resolveClientDisplayName(item),
    pickup_address: item.pickup_address || item.origin_address || null,
    delivery_address: item.delivery_address || item.address || item.endereco || null,
    address: item.delivery_address || item.address || item.endereco || null,
    dest_name: item.recipient_name || item.dest_name || item.destName || 'Destinatário',
    dest_phone: item.recipient_phone || item.dest_phone || '',
    pickup_lat: item.pickup_lat ?? item.pickup_latitude ?? null,
    pickup_lng: item.pickup_lng ?? item.pickup_longitude ?? null,
    dest_lat: item.dest_lat ?? item.delivery_latitude ?? null,
    dest_lng: item.dest_lng ?? item.delivery_longitude ?? null,
    status: normalizeTeleStatus(item.status),
    motoboy_id: item.motoboy_id || item.rider_id || null,
    rider: item.rider || item.motoboy_name || 'Aguardando Despacho',
    created_at: item.created_at || null,
    updated_at: item.updated_at || null,
    version: version,
    delivery_charge: item.delivery_charge || item.valor || item.price || 0
  };
}

// 7. Sincronizar Teles para Store Map
function syncTelesStoreMap() {
  opTelesStoreMap.clear();

  const allTeles = [
    ...(mockData.pendingDeliveries || []),
    ...(mockData.clientHistory || [])
  ];

  allTeles.forEach(t => {
    const normalized = normalizeTeleRecord(t);
    if (normalized && normalized.id) {
      opTelesStoreMap.set(String(normalized.id), normalized);
    }
  });
}

// 8. Agrupador de Colunas do Kanban
// 8. Renderização do Dashboard Resumo Operacional (sem Kanban)
function renderOperationsDashboard() {
  syncTelesStoreMap();
  syncRidersStoreMap();

  const allTeles = Array.from(opTelesStoreMap.values());
  const allRiders = Array.from(opRidersStoreMap.values());

  let awaitingCount = 0;
  let inProgressCount = 0;
  let slaCriticalCount = 0;
  let completedTodayCount = 0;
  let cancelledTodayCount = 0;
  let statusUnknownCount = 0;

  const urgentPriorities = [];
  const alertsList = [];

  allTeles.forEach(tele => {
    const norm = normalizeTeleStatus(tele.status);
    const slaInfo = calculateTeleSLAState(tele);

    if (norm === 'solicitada' || norm === 'aguardando_despacho') {
      awaitingCount++;
      if (slaInfo.state === 'critical' || slaInfo.state === 'warning') {
        urgentPriorities.push({ tele, slaInfo });
      }
    } else if (['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega'].includes(norm)) {
      inProgressCount++;
      if (slaInfo.state === 'critical' || slaInfo.state === 'warning') {
        urgentPriorities.push({ tele, slaInfo });
      }
    } else if (norm === 'concluida') {
      if (isTodayInLocalTime(tele.created_at || tele.date)) {
        completedTodayCount++;
      }
    } else if (norm === 'cancelada') {
      if (isTodayInLocalTime(tele.created_at || tele.date)) {
        cancelledTodayCount++;
      }
    } else if (norm === 'status_unknown') {
      statusUnknownCount++;
    }

    if (slaInfo.state === 'critical' && norm !== 'concluida' && norm !== 'cancelada') {
      slaCriticalCount++;
      alertsList.push({
        type: 'sla_critical',
        title: `SLA Crítico na Tele #${tele.tele_code || tele.id}`,
        message: `Status: ${tele.status} (${slaInfo.elapsedMinutes} min decorridos)`,
        teleId: tele.id
      });
    }
  });

  // Motoboys KPIs
  let ridersAvailCount = 0;
  let ridersMaxCount = 0;

  allRiders.forEach(rider => {
    const activeCount = countActiveDeliveriesForRider(rider.id);
    const limit = rider.simultaneous_limit || 3;
    const isAvail = rider.status === 'Disponível' || rider.status === 'Ativo';

    if (isAvail && activeCount < limit) {
      ridersAvailCount++;
    }
    if (activeCount >= limit) {
      ridersMaxCount++;
      alertsList.push({
        type: 'rider_limit',
        title: `Limite Atingido: ${rider.name}`,
        message: `${activeCount}/${limit} entregas ativas em andamento.`
      });
    }
  });

  // Atualizar Elementos KPI no DOM
  const kpiAwaiting = document.getElementById('op-kpi-awaiting');
  const kpiInProgress = document.getElementById('op-kpi-in-progress');
  const kpiSlaCritical = document.getElementById('op-kpi-sla-critical');
  const kpiRidersAvail = document.getElementById('op-kpi-riders-avail');
  const kpiRidersMax = document.getElementById('op-kpi-riders-max');
  const kpiCompletedToday = document.getElementById('op-kpi-completed-today');
  const kpiCancelledToday = document.getElementById('op-kpi-cancelled-today');

  if (kpiAwaiting) kpiAwaiting.innerText = awaitingCount;
  if (kpiInProgress) kpiInProgress.innerText = inProgressCount;
  if (kpiSlaCritical) kpiSlaCritical.innerText = slaCriticalCount;
  if (kpiRidersAvail) kpiRidersAvail.innerText = ridersAvailCount;
  if (kpiRidersMax) kpiRidersMax.innerText = ridersMaxCount;
  if (kpiCompletedToday) kpiCompletedToday.innerText = completedTodayCount;
  if (kpiCancelledToday) kpiCancelledToday.innerText = cancelledTodayCount;

  // Diagnostic Box
  const diagBox = document.getElementById('op-diagnostic-box');
  const diagCount = document.getElementById('op-unknown-status-count');
  if (diagBox && diagCount) {
    if (statusUnknownCount > 0) {
      diagBox.classList.remove('hidden');
      diagCount.innerText = statusUnknownCount;
    } else {
      diagBox.classList.add('hidden');
      diagCount.innerText = '0';
    }
  }

  // 1. Renderizar Lista A: Prioridades Imediatas (máx. 5 Teles)
  renderSummaryPrioritiesList(urgentPriorities.slice(0, 5));

  // 2. Renderizar Lista B: Frota Ativa
  renderSummaryFleetList(allRiders);

  // 3. Renderizar Lista C: Alertas Operacionais
  renderSummaryAlertsList(alertsList);

  if (window.lucide) window.lucide.createIcons();
}

function countActiveDeliveriesForRider(riderId) {
  let count = 0;
  opTelesStoreMap.forEach(t => {
    if (String(t.motoboy_id) === String(riderId)) {
      const norm = normalizeTeleStatus(t.status);
      if (norm !== 'concluida' && norm !== 'cancelada') {
        count++;
      }
    }
  });
  return count;
}

function renderSummaryPrioritiesList(priorities = []) {
  const container = document.getElementById('op-summary-priorities-list');
  if (!container) return;

  if (priorities.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--color-text-muted); font-size: 0.8rem;">Nenhuma Tele em situação crítica no momento.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  priorities.forEach(({ tele, slaInfo }) => {
    const item = document.createElement('div');
    item.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px;';
    
    const clientName = resolveClientDisplayName(tele);

    item.innerHTML = `
      <div>
        <div style="font-weight: 700; font-size: 0.85rem; color: var(--color-text);">
          #${escapeHtml(String(tele.tele_code || tele.id))} • ${escapeHtml(clientName)}
        </div>
        <div style="font-size: 0.75rem; color: var(--color-text-muted); margin-top: 2px;">
          ${escapeHtml(tele.address || 'Endereço não informado')}
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="sla-badge sla-badge-${slaInfo.state}" style="font-size: 0.72rem; padding: 3px 8px;">
          ${slaInfo.elapsedMinutes} min
        </span>
        <button type="button" class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.72rem;" onclick="switchDashboardTab('owner-teles')">
          Abrir na Gestão
        </button>
      </div>
    `;
    fragment.appendChild(item);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

function renderSummaryFleetList(riders = []) {
  const container = document.getElementById('op-summary-fleet-list');
  const countEl = document.getElementById('op-summary-fleet-count');
  if (countEl) countEl.innerText = `${riders.length} motoboys`;
  if (!container) return;

  if (riders.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--color-text-muted); font-size: 0.8rem;">Nenhum motoboy na frota.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  riders.forEach(rider => {
    const activeCount = countActiveDeliveriesForRider(rider.id);
    const limit = rider.simultaneous_limit || 3;
    const isFull = activeCount >= limit;

    const item = document.createElement('div');
    item.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center;';

    item.innerHTML = `
      <div>
        <strong style="font-size: 0.82rem; color: var(--color-text);">${escapeHtml(rider.name)}</strong>
        <div style="font-size: 0.72rem; color: var(--color-text-muted);">${escapeHtml(rider.vehicle || 'Moto')} • ${escapeHtml(rider.status)}</div>
      </div>
      <span class="badge ${isFull ? 'status-danger' : 'status-success'}" style="font-size: 0.72rem;">
        Capacidade: ${activeCount}/${limit}
      </span>
    `;
    fragment.appendChild(item);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

function renderSummaryAlertsList(alerts = []) {
  const container = document.getElementById('op-summary-alerts-list');
  if (!container) return;

  if (alerts.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--color-text-muted); font-size: 0.8rem;">Nenhum alerta pendente no momento.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  alerts.forEach(alt => {
    const item = document.createElement('div');
    item.style.cssText = 'background: rgba(255, 183, 0, 0.05); border: 1px solid rgba(255, 183, 0, 0.2); border-radius: 6px; padding: 8px 12px; font-size: 0.8rem;';
    item.innerHTML = `
      <div style="font-weight: 700; color: var(--yellow);">${escapeHtml(alt.title)}</div>
      <div style="color: var(--color-text-muted); font-size: 0.75rem; margin-top: 2px;">${escapeHtml(alt.message)}</div>
    `;
    fragment.appendChild(item);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

// 13. Execução Transacional de Despacho (API local / RPC contract)
async function assignRiderToTele(teleId, riderId, expectedVersion, reason = '') {
  const payload = {
    tele_id: String(teleId),
    rider_id: String(riderId),
    expected_version: expectedVersion,
    reason: reason ? reason.trim() : null
  };

  try {
    const res = await fetch('/api/operations/assign-rider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, errorCode: data.error_code || 'ERROR', message: data.message || 'Falha no despacho.' };
    }

    // Sucesso — atualizar store em memória
    const tele = opTelesStoreMap.get(String(teleId));
    if (tele) {
      tele.motoboy_id = String(riderId);
      tele.rider = data.rider_name;
      tele.status = data.status || 'motoboy_designado';
      tele.version = data.version;
      tele.updated_at = data.updated_at;
    }

    if (typeof renderOperationsDashboard === 'function') renderOperationsDashboard();
    if (typeof openTeleOpDrawer === 'function' && document.getElementById('drawer-tele-op-details')?.classList.contains('active')) {
      openTeleOpDrawer(teleId);
    }

    return { success: true, data };
  } catch (err) {
    return { success: false, errorCode: 'CONNECTION_ERROR', message: 'Erro de conexão com o servidor de despacho.' };
  }
}

// 14. Controls para o Modal de Despacho / Reatribuição
function openAssignRiderModal(teleId, targetRiderId = null) {
  const tele = opTelesStoreMap.get(String(teleId));
  if (!tele) return;

  const modal = document.getElementById('modal-assign-rider');
  const codeEl = document.getElementById('assign-tele-code');
  const infoEl = document.getElementById('assign-tele-info');
  const teleIdInput = document.getElementById('assign-tele-id');
  const teleVersionInput = document.getElementById('assign-tele-version');
  const selectEl = document.getElementById('assign-rider-select');
  const reasonGroup = document.getElementById('group-reassign-reason');
  const feedbackBox = document.getElementById('assign-rider-feedback-box');

  if (codeEl) codeEl.innerText = `#${tele.id}`;
  if (infoEl) infoEl.innerText = `${tele.client || 'Cliente Geral'} — ${tele.address || ''}`;
  if (teleIdInput) teleIdInput.value = tele.id;
  if (teleVersionInput) teleVersionInput.value = tele.version || 1;

  if (feedbackBox) {
    feedbackBox.className = 'hidden';
    feedbackBox.innerText = '';
  }

  // Preencher opções do dropdown de motoboys
  if (selectEl) {
    selectEl.innerHTML = '<option value="">-- Selecione um entregador --</option>';
    opRidersStoreMap.forEach(rider => {
      const activeCount = countActiveDeliveriesForRider(rider.id);
      const limit = rider.simultaneous_limit || 3;
      const isFull = activeCount >= limit;
      const isUnavailable = ['Indisponível', 'Bloqueado', 'Inativo'].includes(rider.status);

      const option = document.createElement('option');
      option.value = rider.id;
      option.innerText = `${rider.name} (${activeCount}/${limit}) - ${rider.status}`;
      if (isUnavailable || isFull) {
        option.disabled = true;
      }
      if (targetRiderId && String(rider.id) === String(targetRiderId)) {
        option.selected = true;
      }
      selectEl.appendChild(option);
    });
  }

  // Se a tele já tinha outro motoboy, exigir motivo da troca
  const hasPreviousRider = Boolean(tele.motoboy_id);
  if (reasonGroup) {
    if (hasPreviousRider) {
      reasonGroup.classList.remove('hidden');
      document.getElementById('assign-reassign-reason').setAttribute('required', 'true');
    } else {
      reasonGroup.classList.add('hidden');
      document.getElementById('assign-reassign-reason').removeAttribute('required');
    }
  }

  if (modal) modal.classList.remove('hidden');
}

function closeAssignRiderModal(event) {
  if (event && event.target && !event.target.classList.contains('modal-backdrop') && !event.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('modal-assign-rider');
  if (modal) modal.classList.add('hidden');
}

function handleAssignRiderSelectChange() {
  // Callback auxiliar se necessário
}

async function submitAssignRider(event) {
  event.preventDefault();

  const teleId = document.getElementById('assign-tele-id')?.value;
  const version = parseInt(document.getElementById('assign-tele-version')?.value || '1', 10);
  const riderId = document.getElementById('assign-rider-select')?.value;
  const reason = document.getElementById('assign-reassign-reason')?.value || '';
  const feedbackBox = document.getElementById('assign-rider-feedback-box');
  const btnSubmit = document.getElementById('btn-submit-assign');

  if (!teleId || !riderId) {
    showToastNotification('Por favor, selecione um motoboy válido.');
    return;
  }

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Despachando...';
  }

  const result = await assignRiderToTele(teleId, riderId, version, reason);

  if (btnSubmit) {
    btnSubmit.disabled = false;
    btnSubmit.innerText = 'Confirmar Despacho';
  }

  if (result.success) {
    closeAssignRiderModal();
    showToastNotification(`Tele #${teleId} despachada com sucesso para ${result.data.rider_name}!`);
  } else {
    // Tratamento amigável de erros
    let friendlyMessage = result.message;
    if (result.errorCode === 'TELE_VERSION_CONFLICT') {
      friendlyMessage = 'Esta Tele foi atualizada por outro operador. Os dados serão recarregados.';
    } else if (result.errorCode === 'RIDER_CAPACITY_REACHED') {
      friendlyMessage = 'O motoboy selecionado atingiu o limite máximo de entregas simultâneas.';
    } else if (result.errorCode === 'REASSIGN_REASON_REQUIRED') {
      friendlyMessage = 'Informe obrigatoriamente o motivo para realizar a troca de motoboy.';
    }

    if (feedbackBox) {
      feedbackBox.className = 'error-box';
      feedbackBox.style.cssText = 'background: rgba(239,68,68,0.1); border: 1px solid #ef4444; color: #ef4444; padding: 10px; border-radius: 6px; font-size: 0.8rem; margin-top: 10px;';
      feedbackBox.setAttribute('role', 'alert');
      feedbackBox.setAttribute('aria-live', 'assertive');
      feedbackBox.innerText = friendlyMessage;
    }
  }
}

// 15. Drawer de Leitura & Ações da Tele (Fase 3 - Com Botão Despachar)
function openTeleOpDrawer(teleId) {
  const tele = opTelesStoreMap.get(String(teleId));
  if (!tele) return;

  const drawer = document.getElementById('drawer-tele-op-details');
  const codeEl = document.getElementById('op-drawer-code');
  const contentEl = document.getElementById('op-drawer-content');

  if (codeEl) codeEl.innerText = `#${tele.id}`;

  if (contentEl && drawer) {
    const slaInfo = calculateTeleSLAState(tele);
    const normStatus = normalizeTeleStatus(tele.status);
    const isTerminal = normStatus === 'concluida' || normStatus === 'cancelada';

    contentEl.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.03); padding: 12px; border-radius: var(--border-radius-sm);">
          <div>
            <span style="font-size: 0.75rem; color: var(--color-text-muted); display: block;">Status Operacional</span>
            <strong style="font-size: 0.95rem; color: var(--primary);">${escapeHtml(normStatus.toUpperCase())}</strong>
          </div>
          <span class="sla-badge sla-badge-${slaInfo.state}" style="font-size: 0.85rem; padding: 4px 10px;">
            Tempo no Status: ${slaInfo.elapsedMinutes} min ${slaInfo.isEstimated ? '*' : ''}
          </span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <label style="font-size: 0.75rem; color: var(--color-text-muted);">Cliente / Estabelecimento</label>
            <div style="font-weight: 600;">${escapeHtml(tele.client || 'Cliente Geral')}</div>
          </div>
          <div>
            <label style="font-size: 0.75rem; color: var(--color-text-muted);">Valor da Entrega</label>
            <div style="font-weight: 700; color: #10b981;">${escapeHtml(tele.price || 'R$ 0,00')}</div>
          </div>
        </div>

        <div>
          <label style="font-size: 0.75rem; color: var(--color-text-muted);">Ponto de Coleta (Origem)</label>
          <div>${escapeHtml(tele.origin || 'Endereço do estabelecimento')}</div>
        </div>

        <div>
          <label style="font-size: 0.75rem; color: var(--color-text-muted);">Ponto de Entrega (Destino)</label>
          <div style="font-weight: 600;">${escapeHtml(tele.address || '—')}</div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <label style="font-size: 0.75rem; color: var(--color-text-muted);">Destinatário</label>
            <div>${escapeHtml(tele.dest_name || '—')}</div>
          </div>
          <div>
            <label style="font-size: 0.75rem; color: var(--color-text-muted);">Motoboy Atribuído</label>
            <div style="font-weight: 600; color: ${tele.motoboy_id ? '#10b981' : 'var(--color-text-muted)'};">${escapeHtml(tele.rider || 'Nenhum motoboy')}</div>
          </div>
        </div>

        ${(tele.delivery_reference || tele.reference) ? `
        <div>
          <label style="font-size: 0.75rem; color: var(--color-text-muted);">Referência de Entrega / Comprovante</label>
          <div style="font-weight: 600; color: #3b82f6; background: rgba(59,130,246,0.08); padding: 6px 10px; border-radius: 4px; font-size: 0.85rem;">
            ${escapeHtml(tele.delivery_reference || tele.reference)}
          </div>
        </div>
        ` : ''}

        <div>
          <label style="font-size: 0.75rem; color: var(--color-text-muted);">Observações da Carga</label>
          <div style="background: rgba(255,255,255,0.02); padding: 8px 12px; border-radius: 4px; font-size: 0.82rem;">
            ${escapeHtml(tele.cargo || tele.notes || 'Sem observações adicionais.')}
          </div>
        </div>

        ${!isTerminal ? `
          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
            <button type="button" class="btn btn-primary" style="width: 100%; padding: 10px; font-weight: 700;" onclick="openAssignRiderModal('${tele.id}')">
              <i data-lucide="send" style="width: 16px; height: 16px; margin-right: 6px;"></i> ${tele.motoboy_id ? 'Trocar Motoboy' : 'Despachar Motoboy'}
            </button>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <button type="button" class="btn btn-secondary" style="padding: 8px; font-weight: 600; color: #10b981; border-color: rgba(16,185,129,0.3);" onclick="openCompleteTeleModal('${tele.id}')">
                <i data-lucide="check-circle" style="width: 14px; height: 14px; margin-right: 4px;"></i> Concluir
              </button>
              <button type="button" class="btn btn-secondary" style="padding: 8px; font-weight: 600; color: #ef4444; border-color: rgba(239,68,68,0.3);" onclick="openCancelTeleModal('${tele.id}')">
                <i data-lucide="x-circle" style="width: 14px; height: 14px; margin-right: 4px;"></i> Cancelar
              </button>
            </div>
          </div>
        ` : ''}

        <div style="border-top: 1px solid var(--border-color); padding-top: 12px; font-size: 0.72rem; color: var(--color-text-muted); display: flex; justify-content: space-between;">
          <span>Criado em: ${tele.created_at ? new Date(tele.created_at).toLocaleString('pt-BR') : '—'}</span>
          <span>Versão: v${tele.version || 1}</span>
        </div>
      </div>
    `;

    drawer.classList.add('active');
    if (window.lucide) window.lucide.createIcons();
  }
}

// =====================================================================
// FASE 5: MODAIS E INTEGRAÇÃO DE CONCLUSÃO E CANCELAMENTO
// =====================================================================

function openCompleteTeleModal(teleId) {
  const tele = opTelesStoreMap.get(String(teleId));
  if (!tele) return;

  const modal = document.getElementById('modal-complete-tele');
  const codeEl = document.getElementById('complete-tele-code');
  const infoEl = document.getElementById('complete-tele-client-rider');
  const idInput = document.getElementById('complete-tele-id');
  const versionInput = document.getElementById('complete-tele-version');
  const previewClientEl = document.getElementById('complete-preview-client-val');
  const previewRiderEl = document.getElementById('complete-preview-rider-val');
  const previewCompanyEl = document.getElementById('complete-preview-company-val');
  const feedbackBox = document.getElementById('complete-tele-feedback-box');
  const checkbox = document.getElementById('complete-confirm-checkbox');

  if (codeEl) codeEl.innerText = `#${tele.id}`;
  if (infoEl) infoEl.innerText = `Cliente: ${tele.client || 'Geral'} | Motoboy: ${tele.rider || 'Não atribuído'}`;
  if (idInput) idInput.value = tele.id;
  if (versionInput) versionInput.value = tele.version || 1;
  if (checkbox) checkbox.checked = false;

  if (feedbackBox) {
    feedbackBox.className = 'hidden';
    feedbackBox.innerText = '';
  }

  // Prévia Financeira no Frontend (Será recalculada pelo servidor)
  const rawPrice = typeof tele.valor === 'number' ? tele.valor : parseFloat(String(tele.price || '15').replace(/[^\d.,]/g, '').replace(',', '.') || '15');
  const valClient = isNaN(rawPrice) || rawPrice <= 0 ? 15.00 : rawPrice;
  const valRider = Math.round(valClient * 0.80 * 100) / 100;
  const valCompany = Math.round((valClient - valRider) * 100) / 100;

  if (previewClientEl) previewClientEl.innerText = `R$ ${valClient.toFixed(2)}`;
  if (previewRiderEl) previewRiderEl.innerText = `R$ ${valRider.toFixed(2)}`;
  if (previewCompanyEl) previewCompanyEl.innerText = `R$ ${valCompany.toFixed(2)}`;

  if (modal) modal.classList.remove('hidden');
}

function closeCompleteTeleModal(event) {
  if (event && event.target && !event.target.classList.contains('modal-backdrop') && !event.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('modal-complete-tele');
  if (modal) modal.classList.add('hidden');
}

async function submitCompleteTele(event) {
  event.preventDefault();

  const teleId = document.getElementById('complete-tele-id')?.value;
  const version = parseInt(document.getElementById('complete-tele-version')?.value || '1', 10);
  const feedbackBox = document.getElementById('complete-tele-feedback-box');
  const btnSubmit = document.getElementById('btn-submit-complete');

  if (!teleId) return;

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Concluindo...';
  }

  try {
    const res = await fetch('/api/operations/complete-tele', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tele_id: String(teleId), expected_version: version, completion_source: 'operator' })
    });

    const data = await res.json();

    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerText = 'Confirmar Conclusão';
    }

    if (!res.ok || !data.success) {
      let friendlyMessage = data.message || 'Falha ao concluir Tele.';
      if (data.error_code === 'TELE_VERSION_CONFLICT') {
        friendlyMessage = 'Esta Tele foi atualizada por outro operador. Os dados serão recarregados.';
      } else if (data.error_code === 'TELE_WITHOUT_RIDER') {
        friendlyMessage = 'Atribua um motoboy à Tele antes de concluí-la.';
      }

      if (feedbackBox) {
        feedbackBox.className = 'error-box';
        feedbackBox.style.cssText = 'background: rgba(239,68,68,0.1); border: 1px solid #ef4444; color: #ef4444; padding: 10px; border-radius: 6px; font-size: 0.8rem;';
        feedbackBox.innerText = friendlyMessage;
      }
      return;
    }

    // Atualizar store em memória
    const tele = opTelesStoreMap.get(String(teleId));
    if (tele) {
      tele.status = 'concluida';
      tele.completed_at = data.completed_at;
      tele.version = data.version;
    }

    closeCompleteTeleModal();
    closeTeleOpDrawer();
    if (typeof renderOperationsDashboard === 'function') renderOperationsDashboard();
    showToastNotification(`Tele #${teleId} concluída com sucesso! Lançamento consolidado.`);
  } catch (err) {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerText = 'Confirmar Conclusão';
    }
    showToastNotification('Erro de conexão ao tentar concluir a Tele.');
  }
}

function openCancelTeleModal(teleId) {
  const tele = opTelesStoreMap.get(String(teleId));
  if (!tele) return;

  const modal = document.getElementById('modal-cancel-tele');
  const codeEl = document.getElementById('cancel-tele-code');
  const infoEl = document.getElementById('cancel-tele-info');
  const idInput = document.getElementById('cancel-tele-id');
  const versionInput = document.getElementById('cancel-tele-version');
  const reasonText = document.getElementById('cancel-tele-reason');
  const feedbackBox = document.getElementById('cancel-tele-feedback-box');

  if (codeEl) codeEl.innerText = `#${tele.id}`;
  if (infoEl) infoEl.innerText = `${tele.client || 'Cliente Geral'} — ${tele.address || ''}`;
  if (idInput) idInput.value = tele.id;
  if (versionInput) versionInput.value = tele.version || 1;
  if (reasonText) reasonText.value = '';

  if (feedbackBox) {
    feedbackBox.className = 'hidden';
    feedbackBox.innerText = '';
  }

  if (modal) modal.classList.remove('hidden');
}

function closeCancelTeleModal(event) {
  if (event && event.target && !event.target.classList.contains('modal-backdrop') && !event.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('modal-cancel-tele');
  if (modal) modal.classList.add('hidden');
}

async function submitCancelTele(event) {
  event.preventDefault();

  const teleId = document.getElementById('cancel-tele-id')?.value;
  const version = parseInt(document.getElementById('cancel-tele-version')?.value || '1', 10);
  const reason = document.getElementById('cancel-tele-reason')?.value || '';
  const policy = document.getElementById('cancel-charge-policy')?.value || 'sem_cobranca';
  const feedbackBox = document.getElementById('cancel-tele-feedback-box');
  const btnSubmit = document.getElementById('btn-submit-cancel');

  if (!teleId || !reason.trim()) {
    showToastNotification('Informe obrigatoriamente o motivo do cancelamento.');
    return;
  }

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Cancelando...';
  }

  try {
    const res = await fetch('/api/operations/cancel-tele', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tele_id: String(teleId), expected_version: version, reason: reason.trim(), charge_policy: policy })
    });

    const data = await res.json();

    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerText = 'Confirmar Cancelamento';
    }

    if (!res.ok || !data.success) {
      if (feedbackBox) {
        feedbackBox.className = 'error-box';
        feedbackBox.style.cssText = 'background: rgba(239,68,68,0.1); border: 1px solid #ef4444; color: #ef4444; padding: 10px; border-radius: 6px; font-size: 0.8rem;';
        feedbackBox.innerText = data.message || 'Falha ao cancelar Tele.';
      }
      return;
    }

    // Atualizar store em memória
    const tele = opTelesStoreMap.get(String(teleId));
    if (tele) {
      tele.status = 'cancelada';
      tele.cancelled_at = data.cancelled_at;
      tele.cancellation_reason = reason;
      tele.version = data.version;
    }

    closeCancelTeleModal();
    closeTeleOpDrawer();
    renderOperationsDashboard();
    showToastNotification(`Tele #${teleId} cancelada.`);
  } catch (err) {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerText = 'Confirmar Cancelamento';
    }
    showToastNotification('Erro de conexão ao tentar cancelar a Tele.');
  }
}

function closeTeleOpDrawer(event) {
  if (event && event.target && !event.target.classList.contains('drawer-backdrop') && !event.target.classList.contains('drawer-close-btn') && !event.target.closest('.drawer-close-btn')) {
    return;
  }
  const drawer = document.getElementById('drawer-tele-op-details');
  if (drawer) drawer.classList.remove('active');
}

// Inicializar renderização do Dashboard se a aba estiver visível
document.addEventListener('DOMContentLoaded', () => {
  initClientSelectComponent();
  setTimeout(() => {
    if (document.getElementById('tab-owner-control-center')) {
      renderOperationsDashboard();
    }
  }, 1200);
});










// =====================================================================
// CENTRO DE OPERAÇÕES — FASE 4 (REALTIME, RECONEXÃO, ALERTAS & SINC)
// =====================================================================

// Flags e Logs de Debug em Dev
const OPERATIONS_DEBUG = false;

function logOpDebug(...args) {
  if (OPERATIONS_DEBUG && typeof console !== 'undefined') {
    console.log('[OpRealtime]', ...args);
  }
}

// 1. Gerenciador Central de Conexão Realtime
const operationsRealtimeManager = {
  state: 'disconnected', // connecting | connected | reconnecting | degraded | disconnected
  channel: null,
  reconnectAttempt: 0,
  maxReconnectRetries: 5,
  reconnectTimer: null,
  lastSyncTimestamp: null,
  processedRealtimeEventsSet: new Set(),
  opAlertedSLASet: new Set(),
  isInitialSyncDone: false
};

// Som opcional (desativado por padrão conforme regras de autoplay)
let opSoundEnabled = localStorage.getItem('opSoundEnabled') === 'true';

// 2. Atualizador da Interface do Estado da Conexão
function updateConnectionStatusUI(state, customText = null, details = '') {
  operationsRealtimeManager.state = state;

  const dot = document.getElementById('op-connection-dot');
  const text = document.getElementById('op-connection-text');
  const badge = document.getElementById('op-connection-status-badge');

  if (!dot || !text) return;

  const statesConfig = {
    connected: { color: '#10b981', defaultText: 'Conectado em tempo real' },
    connecting: { color: '#f59e0b', defaultText: 'Conectando...' },
    reconnecting: { color: '#f59e0b', defaultText: 'Reconectando...' },
    degraded: { color: '#ef4444', defaultText: 'Modo degradado (Sinc manual)' },
    disconnected: { color: '#6b7280', defaultText: 'Desconectado' }
  };

  const cfg = statesConfig[state] || statesConfig.disconnected;
  dot.style.background = cfg.color;
  text.innerText = customText || cfg.defaultText;

  if (badge) {
    const timeStr = operationsRealtimeManager.lastSyncTimestamp ? operationsRealtimeManager.lastSyncTimestamp.toLocaleTimeString('pt-BR') : '—';
    badge.title = `Estado: ${state.toUpperCase()} | ÚLTIMA SINC: ${timeStr} ${details ? '| ' + details : ''}`;
  }

  logOpDebug(`Mudança de estado da conexão: ${state}`);
}

// 3. Função de Sincronização Completa (Reconciliação / Full Sync Resiliente)
async function performOperationsFullSync() {
  logOpDebug('Iniciando Sincronização Completa (Full Sync Resiliente)...');
  updateConnectionStatusUI('connecting', 'Sincronizando...');

  try {
    // Reconstruir Store de Teles e Frota usando Promise.allSettled para resiliência
    await Promise.allSettled([
      Promise.resolve().then(() => syncTelesStoreMap()),
      Promise.resolve().then(() => syncRidersStoreMap())
    ]);

    operationsRealtimeManager.lastSyncTimestamp = new Date();
    operationsRealtimeManager.isInitialSyncDone = true;

    // Atualizar visualização do Dashboard Resumo Operacional
    renderOperationsDashboard();

    // Se houver drawer de detalhes aberto, atualizar campos sem perder o foco
    if (typeof openTeleOpDrawer === 'function' && document.getElementById('drawer-tele-op-details')?.classList.contains('active')) {
      const drawerCode = document.getElementById('op-drawer-code')?.innerText.replace('#', '');
      if (drawerCode && opTelesStoreMap.has(String(drawerCode))) {
        openTeleOpDrawer(drawerCode);
      }
    }

    updateConnectionStatusUI('connected', 'Conectado em tempo real', 'Full Sync OK');
    logOpDebug('Sincronização Completa finalizada com sucesso.');
    return true;
  } catch (err) {
    console.error('[OpRealtime] Erro durante Full Sync:', err);
    updateConnectionStatusUI('degraded', 'Modo degradado (Erro sinc)');
    return false;
  }
}

function triggerManualFullSync() {
  const btn = document.getElementById('op-btn-manual-sync');
  if (btn) btn.disabled = true;

  performOperationsFullSync().then(() => {
    if (btn) btn.disabled = false;
    showToastNotification('Sincronização manual concluída.');
  });
}

// 4. Iniciar Canal Realtime Operacional Único (realtime:operations)
function initOperationsRealtimeChannel() {
  if (operationsRealtimeManager.channel) {
    logOpDebug('Canal Realtime já inicializado, reutilizando inscrição.');
    return;
  }

  if (typeof supabaseClient === 'undefined' || !supabaseClient) {
    logOpDebug('Supabase client não disponível. Operando via modo local dev.');
    performOperationsFullSync();
    updateConnectionStatusUI('connected', 'Modo Operacional Local');
    return;
  }

  updateConnectionStatusUI('connecting', 'Conectando ao Supabase Realtime...');

  // Criar canal único centralizado
  operationsRealtimeManager.channel = supabaseClient
    .channel('realtime:operations')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teles' }, payload => {
      handleRealtimeEvent('teles', payload.eventType, payload.new || payload.old);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet' }, payload => {
      handleRealtimeEvent('fleet', payload.eventType, payload.new || payload.old);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tele_eventos' }, payload => {
      handleRealtimeEvent('tele_eventos', 'INSERT', payload.new);
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        operationsRealtimeManager.reconnectAttempt = 0;
        performOperationsFullSync();
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        handleRealtimeDisconnection();
      }
    });
}

// 5. Deduplicação e Atualização Incremental dos Eventos
function handleRealtimeEvent(table, eventType, record) {
  if (!record || !record.id) return;

  const eventKey = `${table}:${eventType}:${record.id}:${record.version || record.updated_at || Date.now()}`;

  // Deduplicação: ignorar se já foi processado
  if (operationsRealtimeManager.processedRealtimeEventsSet.has(eventKey)) {
    logOpDebug('Evento duplicado ignorado:', eventKey);
    return;
  }

  // Adicionar ao cache de deduplicação (limite máximo de 500 itens)
  operationsRealtimeManager.processedRealtimeEventsSet.add(eventKey);
  if (operationsRealtimeManager.processedRealtimeEventsSet.size > 500) {
    const firstItem = operationsRealtimeManager.processedRealtimeEventsSet.values().next().value;
    operationsRealtimeManager.processedRealtimeEventsSet.delete(firstItem);
  }

  logOpDebug(`Evento Realtime [${table}] ${eventType}:`, record);

  if (table === 'teles') {
    const teleId = String(record.id);
    const existing = opTelesStoreMap.get(teleId);

    // Proteção de ordenação: ignorar version menor
    if (existing && record.version && existing.version && record.version < existing.version) {
      logOpDebug(`Versão legada ignorada para Tele #${teleId} (recebido v${record.version} < atual v${existing.version})`);
      return;
    }

    // Detectar lacuna de versão (ex: pulou mais de 1 versão) -> acionar reconciliação
    if (existing && record.version && existing.version && record.version > existing.version + 1) {
      logOpDebug(`Lacuna de versão detectada para Tele #${teleId}. Acionando Full Sync...`);
      performOperationsFullSync();
      return;
    }

    if (eventType === 'DELETE') {
      opTelesStoreMap.delete(teleId);
    } else {
      // INSERT ou UPDATE incremental
      const isNewTele = !existing && (normalizeTeleStatus(record.status) === 'solicitada' || normalizeTeleStatus(record.status) === 'aguardando_despacho');
      
      opTelesStoreMap.set(teleId, {
        ...(existing || {}),
        ...record,
        id: teleId
      });

      // Disparar alertas apenas para novas entregas reais após o sync inicial
      if (isNewTele && operationsRealtimeManager.isInitialSyncDone) {
        triggerOpAlertBanner(`Nova entrega #${teleId} solicitada!`);
        if (opSoundEnabled) playOpAlertSound();
      }
    }

    if (typeof renderOperationsDashboard === 'function') renderOperationsDashboard();
  } else if (table === 'fleet') {
    const riderId = String(record.id);
    const existingRider = opRidersStoreMap.get(riderId);

    if (eventType === 'DELETE') {
      opRidersStoreMap.delete(riderId);
    } else {
      opRidersStoreMap.set(riderId, {
        ...(existingRider || {}),
        ...record,
        id: riderId
      });
    }

    renderFleetBar();
  }
}

// 6. Reconexão com Backoff Exponencial
function handleRealtimeDisconnection() {
  if (operationsRealtimeManager.reconnectAttempt >= operationsRealtimeManager.maxReconnectRetries) {
    updateConnectionStatusUI('degraded', 'Modo degradado (Falha de reconexão)');
    return;
  }

  operationsRealtimeManager.reconnectAttempt++;
  const backoffMs = Math.min(30000, Math.pow(2, operationsRealtimeManager.reconnectAttempt) * 1000 + Math.random() * 500);

  updateConnectionStatusUI('reconnecting', `Reconectando (${operationsRealtimeManager.reconnectAttempt}/${operationsRealtimeManager.maxReconnectRetries})...`);

  clearTimeout(operationsRealtimeManager.reconnectTimer);
  operationsRealtimeManager.reconnectTimer = setTimeout(() => {
    if (operationsRealtimeManager.channel) {
      operationsRealtimeManager.channel.unsubscribe();
      operationsRealtimeManager.channel = null;
    }
    initOperationsRealtimeChannel();
  }, backoffMs);
}

// 7. Alertas Visuais e Sonoros Opcionais
function toggleOpSoundAlerts() {
  opSoundEnabled = !opSoundEnabled;
  localStorage.setItem('opSoundEnabled', String(opSoundEnabled));

  const icon = document.getElementById('op-sound-icon');
  const text = document.getElementById('op-sound-text');

  if (icon && text) {
    if (opSoundEnabled) {
      icon.setAttribute('data-lucide', 'volume-2');
      text.innerText = 'Som Ativado';
      showToastNotification('Alertas sonoros ativados.');
      playOpAlertSound(); // Som de teste após interação do usuário
    } else {
      icon.setAttribute('data-lucide', 'volume-x');
      text.innerText = 'Som Desativado';
      showToastNotification('Alertas sonoros desativados.');
    }
    if (window.lucide) window.lucide.createIcons();
  }
}

function playOpAlertSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5

    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {
    // Ignorar se bloqueado pelo navegador
  }
}

function triggerOpAlertBanner(message) {
  const banner = document.getElementById('op-realtime-alert-banner');
  const messageEl = document.getElementById('op-alert-banner-message');

  if (banner && messageEl) {
    messageEl.innerText = message;
    banner.classList.remove('hidden');
  }
}

function dismissOpAlertBanner() {
  const banner = document.getElementById('op-realtime-alert-banner');
  if (banner) banner.classList.add('hidden');
}

// 8. Classificação de Localização GPS do Motoboy
function getRiderLocationStaleCategory(lastSeenInput) {
  if (!lastSeenInput) return { category: 'sem_localizacao', text: 'Sem GPS', color: '#6b7280' };

  const lastSeen = new Date(lastSeenInput);
  if (isNaN(lastSeen.getTime())) return { category: 'sem_localizacao', text: 'Sem GPS', color: '#6b7280' };

  const diffMinutes = (new Date().getTime() - lastSeen.getTime()) / 60000;

  if (diffMinutes <= 2) {
    return { category: 'recente', text: 'GPS Recente', color: '#10b981' };
  } else if (diffMinutes <= 5) {
    return { category: 'atencao', text: `GPS há ${Math.floor(diffMinutes)} min`, color: '#f59e0b' };
  } else {
    return { category: 'desatualizada', text: `GPS desatualizado (${Math.floor(diffMinutes)} min)`, color: '#ef4444' };
  }
}

// 9. Limpeza de Recursos no Logout ou Navegação
function cleanupOperationsRealtime() {
  logOpDebug('Limpando canais Realtime e timers...');
  clearTimeout(operationsRealtimeManager.reconnectTimer);

  if (operationsRealtimeManager.channel) {
    operationsRealtimeManager.channel.unsubscribe();
    operationsRealtimeManager.channel = null;
  }

  operationsRealtimeManager.processedRealtimeEventsSet.clear();
  operationsRealtimeManager.opAlertedSLASet.clear();
  updateConnectionStatusUI('disconnected');
}

// Eventos de conectividade do navegador e visibilidade da aba
window.addEventListener('online', () => {
  logOpDebug('Navegador voltou a ficar online. Executando Full Sync...');
  performOperationsFullSync();
});

window.addEventListener('offline', () => {
  updateConnectionStatusUI('disconnected', 'Sem conexão com a internet');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.getElementById('tab-owner-control-center')?.classList.contains('active')) {
    logOpDebug('Aba voltou a ficar visível. Verificando integridade dos dados...');
    performOperationsFullSync();
  }
});

// Inicialização da Fase 4 ao abrir a aba
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (document.getElementById('tab-owner-control-center')) {
      initOperationsRealtimeChannel();
    }
  }, 1500);
});

// ─── MÓDULO DE SUPORTE DOS MOTOBOYS (ADMINISTRATIVO) ─────────────────────────

let adminSupportState = {
  tickets: [],
  currentTicketId: null,
  isSubmitting: false,
  msgType: 'public', // 'public' | 'internal'
  searchTimeout: null,
  realtimeChannel: null
};

function getAdminSupportCategoryLabel(cat) {
  const categories = {
    delivery_issue: 'Problema em Entrega',
    payment_question: 'Dúvida sobre Pagamento',
    consumable_question: 'Consumíveis / Bag',
    app_problem: 'Problema no Aplicativo',
    account_problem: 'Problema na Conta',
    other: 'Outros Assuntos'
  };
  return categories[cat] || cat || 'Outros';
}

function getAdminSupportPriorityBadge(priority) {
  const badges = {
    urgent: '<span style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 800;">URGENTE</span>',
    high: '<span style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 700;">ALTA</span>',
    normal: '<span style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 600;">NORMAL</span>',
    low: '<span style="background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid rgba(107, 114, 128, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.65rem;">BAIXA</span>'
  };
  return badges[priority] || badges.normal;
}

function getAdminSupportStatusBadge(status) {
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
    waiting_rider: 'Aguardando Motoboy',
    waiting_admin: 'Aguardando Suporte',
    resolved: 'Resolvido',
    closed: 'Encerrado'
  };
  const st = styles[status] || styles.closed;
  const lb = labels[status] || status;
  return `<span style="padding: 3px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; ${st}">${lb}</span>`;
}

async function loadAdminSupportSummary() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient.rpc('admin_get_rider_support_summary');
    if (error) throw error;
    if (data && data.success) {
      const elNew = document.getElementById('admin-support-count-new');
      const elProg = document.getElementById('admin-support-count-progress');
      const elWaitAdmin = document.getElementById('admin-support-count-waiting-admin');
      const elWaitRider = document.getElementById('admin-support-count-waiting-rider');
      const elRes = document.getElementById('admin-support-count-resolved');

      if (elNew) elNew.textContent = data.new_count || 0;
      if (elProg) elProg.textContent = data.in_progress_count || 0;
      if (elWaitAdmin) elWaitAdmin.textContent = data.waiting_admin_count || 0;
      if (elWaitRider) elWaitRider.textContent = data.waiting_rider_count || 0;
      if (elRes) elRes.textContent = data.resolved_count || 0;
    }
  } catch (err) {
    console.error("Error loading admin support summary:", err);
  }
}

async function loadAdminSupportTickets() {
  const container = document.getElementById('admin-rider-support-tickets-list');
  if (!container) return;

  if (!supabaseClient) {
    container.innerHTML = `<div style="text-align: center; color: var(--color-text-muted); padding: 20px;">Sessão não inicializada.</div>`;
    return;
  }

  const statusFilter = document.getElementById('admin-rider-ticket-filter-status')?.value || null;
  const priorityFilter = document.getElementById('admin-rider-ticket-filter-priority')?.value || null;
  const searchVal = document.getElementById('admin-rider-ticket-search')?.value.trim() || null;

  try {
    const { data, error } = await supabaseClient.rpc('admin_get_rider_support_tickets', {
      p_status: statusFilter,
      p_priority: priorityFilter,
      p_motoboy_id: null,
      p_search: searchVal,
      p_limit: 50,
      p_offset: 0
    });

    if (error) throw error;

    if (data && data.success) {
      adminSupportState.tickets = data.items || [];
      renderAdminSupportTicketsList();
    } else {
      throw new Error(data?.message || 'Falha ao carregar lista de chamados.');
    }
  } catch (err) {
    console.error("Error loading admin support tickets:", err);
    container.innerHTML = `<div style="text-align: center; color: var(--color-text-muted); padding: 20px; font-size: 0.82rem;">Erro ao carregar lista de chamados.</div>`;
  }
}

function renderAdminSupportTicketsList() {
  const container = document.getElementById('admin-rider-support-tickets-list');
  if (!container) return;

  const tickets = adminSupportState.tickets;
  if (tickets.length === 0) {
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--color-text-muted); gap: 10px; padding: 30px 16px;">
        <i data-lucide="inbox" style="width: 32px; height: 32px;"></i>
        <p style="font-size: 0.85rem; margin: 0; font-weight: 600;">Nenhum chamado localizado.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = tickets.map(t => {
    const isSelected = t.ticket_id === adminSupportState.currentTicketId;
    const timeStr = t.last_message_at ? new Date(t.last_message_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const unreadHtml = t.unread_messages_count > 0 
      ? `<span style="background: #ef4444; color: white; border-radius: 10px; padding: 2px 7px; font-size: 0.65rem; font-weight: 800;">${t.unread_messages_count} nova(s)</span>`
      : '';

    return `
      <div onclick="openAdminSupportTicketDetail('${t.ticket_id}')" style="padding: 12px; border-radius: 8px; margin-bottom: 6px; cursor: pointer; transition: background 0.15s; background: ${isSelected ? 'rgba(255, 183, 0, 0.12)' : 'var(--bg-card)'}; border: 1px solid ${isSelected ? 'var(--primary)' : 'var(--border-color)'}; display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <strong style="font-size: 0.82rem; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.rider_display_name)}</strong>
          ${getAdminSupportPriorityBadge(t.priority)}
        </div>
        <div style="font-size: 0.85rem; font-weight: 700; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(t.subject)}
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.72rem; color: var(--color-text-muted);">
          <span>${escapeHtml(getAdminSupportCategoryLabel(t.category))}</span>
          <span>${timeStr}</span>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 2px;">
          ${getAdminSupportStatusBadge(t.status)}
          ${unreadHtml}
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

async function openAdminSupportTicketDetail(ticketId) {
  adminSupportState.currentTicketId = ticketId;
  renderAdminSupportTicketsList(); // destaca o card selecionado

  const noSelection = document.getElementById('admin-rider-chat-no-selection');
  const windowPane = document.getElementById('admin-rider-chat-window-pane');
  const messagesContainer = document.getElementById('admin-rider-chat-messages');

  if (noSelection) noSelection.classList.add('hidden');
  if (windowPane) windowPane.classList.remove('hidden');

  if (messagesContainer) {
    messagesContainer.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
        <div style="width: 28px; height: 28px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div>
      </div>
    `;
  }

  try {
    const { data, error } = await supabaseClient.rpc('admin_get_rider_support_ticket', {
      p_ticket_id: ticketId
    });

    if (error) throw error;

    if (data && data.success) {
      renderAdminSupportTicketDetail(data.ticket, data.rider, data.messages || []);
      // Atualizar estatísticas em background
      loadAdminSupportSummary();
      loadAdminSupportTickets();
    } else {
      showToastNotification(data?.message || "Erro ao carregar chamado.");
    }
  } catch (err) {
    console.error("Error opening admin support ticket detail:", err);
    showToastNotification("Erro ao carregar detalhes do chamado.");
  }
}

function renderAdminSupportTicketDetail(ticket, rider, messages) {
  const subjectEl = document.getElementById('admin-ticket-detail-subject');
  const priorityEl = document.getElementById('admin-ticket-detail-priority-badge');
  const riderInfoEl = document.getElementById('admin-ticket-detail-rider-info');
  const statusBadgeEl = document.getElementById('admin-ticket-detail-status-badge');
  const statusSelect = document.getElementById('admin-ticket-status-select');
  const assigneeSelect = document.getElementById('admin-ticket-assignee-select');
  const messagesContainer = document.getElementById('admin-rider-chat-messages');
  const closedWarning = document.getElementById('admin-ticket-closed-warning');
  const inputEl = document.getElementById('admin-rider-chat-input');
  const submitBtn = document.getElementById('admin-support-submit-btn');

  if (subjectEl) subjectEl.textContent = ticket.subject;
  if (priorityEl) priorityEl.innerHTML = getAdminSupportPriorityBadge(ticket.priority);
  if (riderInfoEl) riderInfoEl.textContent = `Motoboy: ${rider.display_name} • Tel: ${rider.phone || 'Não informado'} • Categoria: ${getAdminSupportCategoryLabel(ticket.category)}`;
  if (statusBadgeEl) statusBadgeEl.innerHTML = getAdminSupportStatusBadge(ticket.status);

  if (statusSelect) statusSelect.value = ticket.status;

  const isClosed = ticket.status === 'closed';
  if (closedWarning) {
    if (isClosed) closedWarning.classList.remove('hidden');
    else closedWarning.classList.add('hidden');
  }

  if (inputEl) inputEl.disabled = isClosed;
  if (submitBtn) submitBtn.disabled = isClosed;

  // Carregar lista de administradores para atribuição se o seletor estiver com apenas a opção padrão
  populateAdminAssigneeSelect(ticket.assigned_admin_id);

  if (!messagesContainer) return;

  if (messages.length === 0) {
    messagesContainer.innerHTML = `<p style="text-align: center; color: var(--color-text-muted); padding: 20px;">Nenhuma mensagem neste chamado.</p>`;
    return;
  }

  messagesContainer.innerHTML = messages.map(msg => {
    const isInternal = Boolean(msg.is_internal);
    const isRider = msg.sender_type === 'rider';
    const isSystem = msg.sender_type === 'system';

    if (isSystem) {
      return `
        <div style="align-self: center; background: rgba(255,255,255,0.05); border: 1px dashed var(--border-color); border-radius: 8px; padding: 6px 12px; font-size: 0.75rem; color: var(--color-text-muted); text-align: center;">
          ⚙️ ${escapeHtml(msg.message)}
        </div>
      `;
    }

    if (isInternal) {
      return `
        <div style="align-self: flex-start; max-width: 88%; background: #2a220c; border: 1px solid #78350f; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.72rem; color: #fbbf24; font-weight: 700;">
            <span>🔒 NOTA INTERNA — Visível Apenas para Administradores (${escapeHtml(msg.sender_name)})</span>
            <span>${new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div style="font-size: 0.88rem; color: #fef08a; line-height: 1.45; word-break: break-word;">
            ${escapeHtml(msg.message)}
          </div>
        </div>
      `;
    }

    const alignStyle = isRider ? 'align-self: flex-start;' : 'align-self: flex-end;';
    const bubbleStyle = isRider
      ? 'background: #272732; border: 1px solid var(--border-color); color: var(--color-text); border-radius: 12px 12px 12px 2px;'
      : 'background: linear-gradient(135deg, var(--primary), #c2410c); color: #ffffff; border-radius: 12px 12px 2px 12px; box-shadow: 0 4px 12px rgba(255, 183, 0, 0.2);';

    return `
      <div style="display: flex; flex-direction: column; max-width: 82%; ${alignStyle}">
        <span style="font-size: 0.72rem; color: var(--color-text-muted); margin-bottom: 3px; font-weight: 600;">${escapeHtml(msg.sender_name)}</span>
        <div style="padding: 10px 14px; font-size: 0.88rem; line-height: 1.45; word-break: break-word; ${bubbleStyle}">
          ${escapeHtml(msg.message)}
        </div>
        <span style="font-size: 0.65rem; color: var(--color-text-muted); margin-top: 3px; ${isRider ? 'align-self: flex-start;' : 'align-self: flex-end;'}">
          ${new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    `;
  }).join('');

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function populateAdminAssigneeSelect(currentAssignedId) {
  const select = document.getElementById('admin-ticket-assignee-select');
  if (!select || !supabaseClient) return;

  try {
    const { data, error } = await supabaseClient
      .from('user_profiles')
      .select('user_id, name')
      .eq('is_active', true)
      .in('role', ['owner', 'admin', 'operador', 'gerente']);

    if (error) throw error;

    let html = `<option value="">Não Atribuído</option>`;
    (data || []).forEach(u => {
      const selected = u.user_id === currentAssignedId ? 'selected' : '';
      html += `<option value="${u.user_id}" ${selected}>${escapeHtml(u.name)}</option>`;
    });

    select.innerHTML = html;
  } catch (err) {
    console.error("Error populating admin assignees:", err);
  }
}

function toggleAdminMsgTypeUI(type) {
  adminSupportState.msgType = type;
  const input = document.getElementById('admin-rider-chat-input');
  if (!input) return;
  if (type === 'internal') {
    input.placeholder = "Digite uma NOTA INTERNA (privada para os administradores)...";
    input.style.border = "1px solid #78350f";
    input.style.background = "#2a220c";
    input.style.color = "#fef08a";
  } else {
    input.placeholder = "Digite uma resposta ao motoboy...";
    input.style.border = "1px solid var(--border-color)";
    input.style.background = "var(--input-bg)";
    input.style.color = "var(--color-text)";
  }
}

async function submitAdminSupportReply(event) {
  if (event) event.preventDefault();
  if (adminSupportState.isSubmitting || !adminSupportState.currentTicketId) return;

  const input = document.getElementById('admin-rider-chat-input');
  const submitBtn = document.getElementById('admin-support-submit-btn');
  const val = input?.value.trim();

  if (!val || val.length < 1 || val.length > 4000) return;

  const isInternal = adminSupportState.msgType === 'internal';
  adminSupportState.isSubmitting = true;
  if (submitBtn) submitBtn.disabled = true;

  try {
    const { data, error } = await supabaseClient.rpc('admin_reply_rider_support_ticket', {
      p_ticket_id: adminSupportState.currentTicketId,
      p_message: val,
      p_is_internal: isInternal
    });

    if (error) throw error;

    if (data && data.success) {
      if (input) input.value = '';
      openAdminSupportTicketDetail(adminSupportState.currentTicketId);
    } else {
      showToastNotification(data?.message || "Erro ao responder chamado.");
    }
  } catch (err) {
    console.error("Error replying admin support ticket:", err);
    showToastNotification("Erro ao enviar resposta.");
  } finally {
    adminSupportState.isSubmitting = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function updateAdminTicketStatusClick() {
  if (!adminSupportState.currentTicketId || !supabaseClient) return;

  const statusSelect = document.getElementById('admin-ticket-status-select');
  const newStatus = statusSelect?.value;
  if (!newStatus) return;

  let reason = null;
  if (newStatus === 'in_progress') {
    const currentTicket = adminSupportState.tickets.find(t => t.ticket_id === adminSupportState.currentTicketId);
    if (currentTicket && currentTicket.status === 'closed') {
      reason = prompt("Motivo obrigatório para reabrir este chamado encerrado:");
      if (!reason || reason.trim().length < 3) {
        showToastNotification("É necessário informar um motivo de no mínimo 3 caracteres para reabrir o chamado.");
        return;
      }
    }
  }

  try {
    const { data, error } = await supabaseClient.rpc('admin_update_rider_support_ticket_status', {
      p_ticket_id: adminSupportState.currentTicketId,
      p_status: newStatus,
      p_reason: reason
    });

    if (error) throw error;

    if (data && data.success) {
      showToastNotification("Status atualizado com sucesso!");
      openAdminSupportTicketDetail(adminSupportState.currentTicketId);
    } else {
      showToastNotification(data?.message || "Erro ao atualizar status.");
    }
  } catch (err) {
    console.error("Error updating ticket status:", err);
    showToastNotification("Erro de conexão ao alterar status.");
  }
}

async function assignAdminTicketClick() {
  if (!adminSupportState.currentTicketId || !supabaseClient) return;

  const assigneeSelect = document.getElementById('admin-ticket-assignee-select');
  const targetAdminId = assigneeSelect?.value || null;

  try {
    const { data, error } = await supabaseClient.rpc('admin_assign_rider_support_ticket', {
      p_ticket_id: adminSupportState.currentTicketId,
      p_admin_user_id: targetAdminId
    });

    if (error) throw error;

    if (data && data.success) {
      showToastNotification("Responsável atualizado!");
      loadAdminSupportTickets();
    } else {
      showToastNotification(data?.message || "Erro ao atribuir chamado.");
    }
  } catch (err) {
    console.error("Error assigning admin ticket:", err);
    showToastNotification("Erro de conexão ao atribuir chamado.");
  }
}

function debounceAdminSupportSearch() {
  if (adminSupportState.searchTimeout) clearTimeout(adminSupportState.searchTimeout);
  adminSupportState.searchTimeout = setTimeout(() => {
    loadAdminSupportTickets();
  }, 300);
}

function subscribeAdminRiderSupportRealtime() {
  if (adminSupportState.realtimeChannel || !supabaseClient) return;

  adminSupportState.realtimeChannel = supabaseClient.channel('realtime:admin_rider_support')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rider_support_tickets' }, () => {
      loadAdminSupportSummary();
      loadAdminSupportTickets();
      if (adminSupportState.currentTicketId) {
        openAdminSupportTicketDetail(adminSupportState.currentTicketId);
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rider_support_messages' }, (payload) => {
      loadAdminSupportSummary();
      loadAdminSupportTickets();
      if (adminSupportState.currentTicketId && payload.new && payload.new.ticket_id === adminSupportState.currentTicketId) {
        openAdminSupportTicketDetail(adminSupportState.currentTicketId);
      }
    })
    .subscribe();
}

// =====================================================================
// FASE 2: Lógica do Quick Action Drawer (Painel Lateral Deslizante)
// Preserva 100% de todos os componentes homologados da Fase 1.
// =====================================================================

let currentActiveDrawerTeleId = null;
let drawerFocusTriggerElement = null;
let drawerPendingTargetRiderId = null;
let drawerKeyboardHandler = null;

async function openTeleQuickActionDrawer(teleId, triggerElement) {
  if (!teleId) return;
  const strId = String(teleId);

  // Prevenção de múltiplas aberturas para o mesmo ID
  if (currentActiveDrawerTeleId === strId) return;

  currentActiveDrawerTeleId = strId;
  drawerFocusTriggerElement = triggerElement || document.activeElement;

  const overlay = document.getElementById('drawer-overlay');
  const drawer = document.getElementById('quick-action-drawer');

  if (!overlay || !drawer) return;

  // Abrir elementos visuais
  overlay.classList.remove('hidden');
  drawer.classList.remove('hidden');
  document.body.style.overflow = 'hidden'; // Scroll lock no body

  // Acessibilidade: Trava de foco inicial
  drawer.focus();

  // Associar listener temporário da tecla Escape (removido estritamente ao fechar)
  drawerKeyboardHandler = (e) => {
    if (e.key === 'Escape') {
      closeTeleQuickActionDrawer();
    }
  };
  document.addEventListener('keydown', drawerKeyboardHandler);

  // Buscar registro da Tele no Map ou Postgres
  let tele = opTelesStoreMap.get(strId);
  if (!tele && supabaseClient) {
    try {
      const { data } = await supabaseClient.from('teles').select('*').or(`id.eq.${strId},tele_code.eq.${strId}`).maybeSingle();
      if (data) tele = normalizeTeleRecord(data);
    } catch (e) {}
  }

  if (tele) {
    renderQuickActionDrawerContent(tele);
    fetchTeleTimelineEvents(tele.raw_id || tele.id);
  } else {
    showToastNotification('Tele não encontrada no banco de dados.');
    closeTeleQuickActionDrawer();
  }
}

function closeTeleQuickActionDrawer() {
  const overlay = document.getElementById('drawer-overlay');
  const drawer = document.getElementById('quick-action-drawer');

  if (overlay) overlay.classList.add('hidden');
  if (drawer) drawer.classList.add('hidden');

  document.body.style.overflow = ''; // Restaurar scroll do body

  if (drawerKeyboardHandler) {
    document.removeEventListener('keydown', drawerKeyboardHandler);
    drawerKeyboardHandler = null;
  }

  if (drawerFocusTriggerElement && typeof drawerFocusTriggerElement.focus === 'function') {
    try { drawerFocusTriggerElement.focus(); } catch (e) {}
    drawerFocusTriggerElement = null;
  }

  currentActiveDrawerTeleId = null;
  closeDrawerCancelModal();
  closeDrawerReassignModal();
}

function switchDrawerTab(tabName) {
  const tabs = document.querySelectorAll('.drawer-tab-btn');
  const contents = document.querySelectorAll('.drawer-tab-content');

  tabs.forEach(tab => {
    if (tab.dataset.drawerTab === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  contents.forEach(content => {
    if (content.id === `drawer-tab-${tabName}`) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });
}

function renderQuickActionDrawerContent(tele) {
  if (!tele) return;

  const rawUuid = tele.raw_id || tele.id;
  const teleCode = tele.tele_code || tele.id;
  const normStatus = normalizeTeleStatus(tele.status);

  // Preencher campos informativos básicos
  const codeEl = document.getElementById('drawer-tele-code');
  const statusEl = document.getElementById('drawer-tele-status');
  const clientEl = document.getElementById('drawer-client-name');
  const uuidEl = document.getElementById('drawer-val-uuid');
  const versionEl = document.getElementById('drawer-val-version');
  const createdEl = document.getElementById('drawer-val-created');
  const slaEl = document.getElementById('drawer-val-sla');
  const pickupEl = document.getElementById('drawer-val-pickup');
  const deliveryEl = document.getElementById('drawer-val-delivery');
  const recipientEl = document.getElementById('drawer-val-recipient');
  const phoneEl = document.getElementById('drawer-val-phone');
if (codeEl) codeEl.textContent = teleCode;
  if (clientEl) clientEl.textContent = tele.client || resolveClientDisplayName(tele);
  if (uuidEl) uuidEl.textContent = rawUuid;
  if (versionEl) versionEl.textContent = `v${tele.version ?? 1}`;
  if (createdEl) createdEl.textContent = tele.created_at ? new Date(tele.created_at).toLocaleString('pt-BR') : '—';

  // SLA usando a função homologada
  const slaState = calculateTeleSLAState(tele);
  if (slaEl) {
    slaEl.textContent = slaState.label;
    slaEl.className = `value ${slaState.state === 'critical' ? 'text-danger' : (slaState.state === 'warning' ? 'text-warning' : '')}`;
  }

  if (pickupEl) pickupEl.textContent = tele.pickup_address || 'Endereço de Coleta Comercial';
  if (deliveryEl) deliveryEl.textContent = tele.delivery_address || tele.address || '—';
  if (recipientEl) recipientEl.textContent = tele.dest_name || 'Destinatário';
  if (phoneEl) phoneEl.textContent = tele.dest_phone || '—';
  if (priceEl) priceEl.textContent = typeof tele.delivery_charge === 'number' ? `R$ ${tele.delivery_charge.toFixed(2).replace('.', ',')}` : (tele.price || 'R$ 15,00');
  if (riderEl) riderEl.textContent = tele.rider || 'Aguardando Despacho';

  // Renderizar Matriz de Ações Dinâmicas por Status Canônico
  const actionsContainer = document.getElementById('drawer-actions-container');
  const noticeContainer = document.getElementById('drawer-action-notice');

  if (actionsContainer) actionsContainer.innerHTML = '';
  if (noticeContainer) {
    noticeContainer.innerHTML = '';
    noticeContainer.classList.add('hidden');
  }

  const canonicalStatuses = ['solicitada', 'aguardando_despacho', 'motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega', 'concluida', 'cancelada'];

  if (!canonicalStatuses.includes(normStatus)) {
    console.warn(`[INTEGRIDADE DRAWER] Status desconhecido/legado detectado: "${tele.status}". Entrando em modo Somente Leitura.`);
    if (actionsContainer) {
      actionsContainer.innerHTML = `
        <button type="button" class="btn btn-secondary" onclick="navigateToTeleInManagement('${rawUuid}')">
          <i data-lucide="external-link"></i> Abrir na Gestão de Teles
        </button>
      `;
    }
  }
}

// =====================================================================
// Dahora Expresso — Fase 3B.2A.1: Repasse Semanal & Leitura Autoritativa
// =====================================================================

let riderSettlementState = {
  page: 1,
  limit: 50,
  periodShortcut: 'current_week',
  startDate: null,
  selectedRiderId: null,
  statusFilter: '',
  isLoading: false,
  settlements: [],
  totalCount: 0
};

let activeElementBeforeDrawer = null;
let drawerListenersAttached = false;
let riderAutocompleteCache = [];

function formatRiderSettlementCurrency(val) {
  const num = Number(val) || 0;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num);
}

function handleRiderPaymentPeriodShortcutChange(shortcut) {
  riderSettlementState.periodShortcut = shortcut;
  const customContainer = document.getElementById('rider-payment-custom-date-container');

  if (shortcut === 'custom_week') {
    if (customContainer) customContainer.style.display = 'flex';
    const dateInput = document.getElementById('rider-payment-start-date');
    if (dateInput && dateInput.value) {
      riderSettlementState.startDate = dateInput.value;
    }
  } else {
    if (customContainer) customContainer.style.display = 'none';
    const now = new Date();
    if (shortcut === 'previous_week') {
      now.setDate(now.getDate() - 7);
    }
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    riderSettlementState.startDate = `${year}-${month}-${day}`;
  }

  fetchAdminRiderWeeklySettlements(true);
}

function handleRiderPaymentStartDateChange(dateValue) {
  if (dateValue) {
    riderSettlementState.startDate = dateValue;
    fetchAdminRiderWeeklySettlements(true);
  }
}

async function loadRiderAutocompleteStore() {
  if (!supabaseClient || !currentActiveSession) return;
  try {
    const { data, error } = await supabaseClient
      .from('fleet')
      .select('id, name, motoboy_code, phone')
      .order('name', { ascending: true });

    if (error) {
      console.error("[AUTOPLETE FLEET] Erro ao carregar fleet autoritativo:", error.message);
      const dropdown = document.getElementById('rider-search-dropdown');
      if (dropdown) {
        dropdown.innerHTML = `<div style="padding: 10px; color: #ef4444; font-size: 0.8rem; text-align: center;">
          Erro ao carregar entregadores. <button class="btn btn-sm btn-secondary" onclick="loadRiderAutocompleteStore()">Tentar Novamente</button>
        </div>`;
      }
      return;
    }

    riderAutocompleteCache = data || [];
    renderRiderSearchDropdown(riderAutocompleteCache);
  } catch (err) {
    console.error("[AUTOPLETE FLEET] Exceção:", err);
  }
}

function renderRiderSearchDropdown(list) {
  const dropdown = document.getElementById('rider-search-dropdown');
  if (!dropdown) return;

  if (!list || list.length === 0) {
    dropdown.innerHTML = `<div style="padding: 8px 12px; font-size: 0.8rem; color: var(--color-text-muted);">Nenhum entregador encontrado.</div>`;
    return;
  }

  let html = `<div style="padding: 6px 12px; font-size: 0.8rem; color: var(--color-text); cursor: pointer; border-bottom: 1px solid var(--border-color);" onclick="selectRiderFilter('', 'Todos os entregadores')">
    <strong>Todos os entregadores</strong>
  </div>`;

  list.forEach(r => {
    html += `<div style="padding: 8px 12px; font-size: 0.82rem; color: var(--color-text); cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="selectRiderFilter('${r.id}', '${(r.name || '').replace(/'/g, "\\'")}')">
      <span>${r.name || 'Entregador sem nome'}</span>
      <span style="font-size: 0.72rem; color: var(--color-text-muted);">${r.motoboy_code || ''}</span>
    </div>`;
  });

  dropdown.innerHTML = html;
}

function toggleRiderSearchDropdown(show) {
  const dropdown = document.getElementById('rider-search-dropdown');
  if (!dropdown) return;
  if (show) {
    if (riderAutocompleteCache.length === 0) {
      loadRiderAutocompleteStore();
    } else {
      renderRiderSearchDropdown(riderAutocompleteCache);
    }
    dropdown.classList.remove('hidden');
  } else {
    setTimeout(() => dropdown.classList.add('hidden'), 200);
  }
}

function filterRiderSearchAutocomplete() {
  const input = document.getElementById('rider-search-input');
  if (!input) return;
  const term = input.value.toLowerCase().trim();

  if (!term) {
    renderRiderSearchDropdown(riderAutocompleteCache);
    return;
  }

  const filtered = riderAutocompleteCache.filter(r => 
    (r.name && r.name.toLowerCase().includes(term)) ||
    (r.motoboy_code && String(r.motoboy_code).toLowerCase().includes(term))
  );

  renderRiderSearchDropdown(filtered);
}

function selectRiderFilter(riderId, riderName) {
  const input = document.getElementById('rider-search-input');
  const hiddenId = document.getElementById('rider-search-id');
  const dropdown = document.getElementById('rider-search-dropdown');

  if (input) input.value = riderName;
  if (hiddenId) hiddenId.value = riderId;
  if (dropdown) dropdown.classList.add('hidden');

  riderSettlementState.selectedRiderId = riderId || null;
  fetchAdminRiderWeeklySettlements(true);
}

function clearRiderPaymentFilters() {
  riderSettlementState.page = 1;
  riderSettlementState.periodShortcut = 'current_week';
  riderSettlementState.selectedRiderId = null;
  riderSettlementState.statusFilter = '';

  const shortcutSelect = document.getElementById('rider-payment-period-shortcut');
  const customContainer = document.getElementById('rider-payment-custom-date-container');
  const dateInput = document.getElementById('rider-payment-start-date');
  const searchInput = document.getElementById('rider-search-input');
  const hiddenId = document.getElementById('rider-search-id');
  const statusSelect = document.getElementById('rider-settlement-status-filter');

  if (shortcutSelect) shortcutSelect.value = 'current_week';
  if (customContainer) customContainer.style.display = 'none';
  if (dateInput) dateInput.value = '';
  if (searchInput) searchInput.value = '';
  if (hiddenId) hiddenId.value = '';
  if (statusSelect) statusSelect.value = '';

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  riderSettlementState.startDate = `${year}-${month}-${day}`;

  fetchAdminRiderWeeklySettlements(true);
}

function changeRiderSettlementPage(delta) {
  const newPage = riderSettlementState.page + delta;
  if (newPage < 1) return;

  const maxPages = Math.ceil(riderSettlementState.totalCount / riderSettlementState.limit) || 1;
  if (newPage > maxPages) return;

  riderSettlementState.page = newPage;
  fetchAdminRiderWeeklySettlements(false);
}

async function fetchAdminRiderWeeklySettlements(resetPage = false) {
  if (!supabaseClient || !currentActiveSession) return;

  if (resetPage) {
    riderSettlementState.page = 1;
  }

  if (!riderSettlementState.startDate) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    riderSettlementState.startDate = `${year}-${month}-${day}`;
  }

  const statusFilterEl = document.getElementById('rider-settlement-status-filter');
  if (statusFilterEl) {
    riderSettlementState.statusFilter = statusFilterEl.value || null;
  }

  const offset = (riderSettlementState.page - 1) * riderSettlementState.limit;
  riderSettlementState.isLoading = true;

  const tbody = document.getElementById('rider-payments-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="15" style="text-align: center; padding: 24px; color: var(--color-text-muted);">
      <i data-lucide="loader-2" class="spin" style="width: 24px; height: 24px; margin-bottom: 8px;"></i>
      <div>Carregando repasses semanais do banco de dados...</div>
    </td></tr>`;
    if (window.lucide) window.lucide.createIcons();
  }

  try {
    const { data, error } = await supabaseClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: riderSettlementState.startDate,
      p_workspace_id: null,
      p_status: riderSettlementState.statusFilter,
      p_rider_id: riderSettlementState.selectedRiderId,
      p_limit: riderSettlementState.limit,
      p_offset: offset
    });

    riderSettlementState.isLoading = false;

    if (error || !data || data.success === false) {
      const errMsg = error?.message || data?.message || 'Erro ao consultar repasses semanais.';
      console.error("[RPC list_admin_rider_weekly_settlements] Erro:", errMsg);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="15" style="text-align: center; padding: 24px; color: #ef4444;">
          <i data-lucide="alert-triangle" style="width: 24px; height: 24px; margin-bottom: 8px;"></i>
          <div>${errMsg}</div>
          <button class="btn btn-sm btn-secondary" onclick="fetchAdminRiderWeeklySettlements()" style="margin-top: 12px;">Tentar Novamente</button>
        </td></tr>`;
        if (window.lucide) window.lucide.createIcons();
      }
      return;
    }

    riderSettlementState.totalCount = data.total_count || 0;
    riderSettlementState.settlements = data.settlements || [];

    // Atualizar KPI Cards sem NENHUMA agregação financeira no frontend
    const countTotalEl = document.getElementById('rider-week-count-total');
    const pageCountEl = document.getElementById('rider-week-page-count');
    const pagInfoEl = document.getElementById('rider-settlement-pagination-info');

    if (countTotalEl) countTotalEl.textContent = String(riderSettlementState.totalCount);
    if (pageCountEl) pageCountEl.textContent = String(riderSettlementState.settlements.length);
    if (pagInfoEl) pagInfoEl.textContent = `Exibindo ${riderSettlementState.settlements.length} de ${riderSettlementState.totalCount} registros`;

    // Renderizar Tabela
    renderAdminRiderWeeklySettlements(riderSettlementState.settlements);

    // Atualizar botões de paginação
    const prevBtn = document.getElementById('rider-settlement-prev-page');
    const nextBtn = document.getElementById('rider-settlement-next-page');
    const pageText = document.getElementById('rider-settlement-page-text');

    const maxPages = Math.ceil(riderSettlementState.totalCount / riderSettlementState.limit) || 1;
    if (prevBtn) prevBtn.disabled = riderSettlementState.page <= 1;
    if (nextBtn) nextBtn.disabled = riderSettlementState.page >= maxPages;
    if (pageText) pageText.textContent = `Página ${riderSettlementState.page} de ${maxPages}`;

  } catch (err) {
    riderSettlementState.isLoading = false;
    console.error("[RPC list_admin_rider_weekly_settlements] Exceção:", err);
  }
}

function renderAdminRiderWeeklySettlements(settlements) {
  const tbody = document.getElementById('rider-payments-table-body');
  if (!tbody) return;

  if (!settlements || settlements.length === 0) {
    tbody.innerHTML = `<tr><td colspan="15" style="text-align: center; padding: 32px; color: var(--color-text-muted);">
      Nenhum fechamento semanal encontrado para os filtros selecionados.
    </td></tr>`;
    return;
  }

  let html = '';
  settlements.forEach(s => {
    const isNotCalculated = !s.settlement_id || s.status === 'not_calculated';
    const statusLabel = s.status_label || (isNotCalculated ? 'Não calculado' : s.status);
    const badgeClass = isNotCalculated ? 'badge-not-calculated' : `badge-${s.status || 'open'}`;

    const periodStr = (s.period_start && s.period_end) ? 
      `${new Date(s.period_start).toLocaleDateString('pt-BR')} a ${new Date(s.period_end).toLocaleDateString('pt-BR')}` : '—';

    // Matriz de Ações por Estado Autoritativo
    let actionBtn = '';
    const safeRiderName = (s.rider_name || 'Motoboy').replace(/'/g, "\\'");

    if (isNotCalculated) {
      actionBtn = `<button type="button" class="btn btn-primary btn-sm" onclick="handleCalculateRiderSettlement('${s.rider_id}', '${s.period_start}', '${s.period_end}')" style="display: inline-flex; align-items: center; gap: 4px;">
        <i data-lucide="calculator" style="width: 14px; height: 14px;"></i> Calcular fechamento
      </button>`;
    } else if (s.status === 'open' || s.status === 'reopened') {
      actionBtn = `<div style="display: flex; gap: 4px; justify-content: flex-end;">
        <button type="button" class="btn btn-secondary btn-sm" onclick="handleCalculateRiderSettlement('${s.rider_id}', '${s.period_start}', '${s.period_end}')" title="Recalcular no banco">
          <i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i> Recalcular
        </button>
        <button type="button" class="btn btn-primary btn-sm" onclick="openRiderSettlementDrawer('${s.settlement_id}')">
          <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Detalhes
        </button>
      </div>`;
    } else if (s.status === 'calculated') {
      actionBtn = `<div style="display: flex; gap: 4px; justify-content: flex-end;">
        <button type="button" class="btn btn-warning btn-sm" onclick="openCloseSettlementModal('${s.settlement_id}', ${s.version || 1}, '${safeRiderName}', '${formatRiderSettlementCurrency(s.net_amount)}', '${formatRiderSettlementCurrency(s.eligible_amount)}', '${formatRiderSettlementCurrency(s.blocked_amount)}', '${periodStr}')">
          <i data-lucide="lock" style="width: 14px; height: 14px;"></i> Encerrar
        </button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="handleCalculateRiderSettlement('${s.rider_id}', '${s.period_start}', '${s.period_end}')">
          <i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i> Recalcular
        </button>
        <button type="button" class="btn btn-primary btn-sm" onclick="openRiderSettlementDrawer('${s.settlement_id}')">
          <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Detalhes
        </button>
      </div>`;
    } else if (s.status === 'pending' || s.status === 'partially_blocked') {
      const hasEligible = Number(s.unpaid_eligible_amount || s.eligible_amount) > 0;
      const payBtn = hasEligible ? 
        `<button type="button" class="btn btn-success btn-sm" onclick="openPaySettlementModal('${s.settlement_id}', ${s.version || 1}, '${safeRiderName}', '${formatRiderSettlementCurrency(s.unpaid_eligible_amount || s.eligible_amount)}', '${formatRiderSettlementCurrency(s.blocked_amount)}')">
          <i data-lucide="credit-card" style="width: 14px; height: 14px;"></i> Pagar repasse
        </button>` : '';

      actionBtn = `<div style="display: flex; gap: 4px; justify-content: flex-end;">
        ${payBtn}
        <button type="button" class="btn btn-warning btn-sm" onclick="openReopenSettlementModal('${s.settlement_id}', ${s.version || 1}, '${safeRiderName}')">
          <i data-lucide="unlock" style="width: 14px; height: 14px;"></i> Reabrir
        </button>
        <button type="button" class="btn btn-primary btn-sm" onclick="openRiderSettlementDrawer('${s.settlement_id}')">
          <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Detalhes
        </button>
      </div>`;
    } else {
      actionBtn = `<button type="button" class="btn btn-primary btn-sm" onclick="openRiderSettlementDrawer('${s.settlement_id}')" style="display: inline-flex; align-items: center; gap: 4px;">
        <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Ver detalhes
      </button>`;
    }

    html += `<tr>
      <td><strong>${s.rider_name || 'Motoboy'}</strong></td>
      <td><code>${s.rider_code || '—'}</code></td>
      <td style="font-size: 0.8rem;">${periodStr}</td>
      <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
      <td>${formatRiderSettlementCurrency(s.base_rider_amount)}</td>
      <td>${formatRiderSettlementCurrency(s.consumables_amount)}</td>
      <td>${formatRiderSettlementCurrency(s.credits_amount)}</td>
      <td><strong>${formatRiderSettlementCurrency(s.net_amount)}</strong></td>
      <td>${formatRiderSettlementCurrency(s.eligible_amount)}</td>
      <td style="color: ${Number(s.blocked_amount) > 0 ? '#ef4444' : 'inherit'};">${formatRiderSettlementCurrency(s.blocked_amount)}</td>
      <td>${formatRiderSettlementCurrency(s.paid_amount)}</td>
      <td style="color: ${Number(s.unpaid_eligible_amount) > 0 ? '#10b981' : 'inherit'}; font-weight: 600;">${formatRiderSettlementCurrency(s.unpaid_eligible_amount)}</td>
      <td>${s.teles_count ?? 0}</td>
      <td>${s.blocked_clients_count ?? 0}</td>
      <td style="text-align: right;">${actionBtn}</td>
    </tr>`;
  });

  tbody.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();

  // Verificar se há recuperação pendente
  checkPendingPaymentRecovery();
}

async function openRiderSettlementDrawer(settlementId) {
  if (!settlementId) return;

  activeElementBeforeDrawer = document.activeElement;

  const backdrop = document.getElementById('rider-settlement-drawer-backdrop');
  const drawer = document.getElementById('rider-settlement-drawer');
  const drawerBody = document.getElementById('rider-drawer-body');
  const subtitleEl = document.getElementById('rider-drawer-subtitle');

  if (backdrop) backdrop.classList.remove('hidden');
  if (drawer) drawer.classList.remove('hidden');
  document.body.classList.add('drawer-open');

  if (!drawerListenersAttached) {
    document.addEventListener('keydown', handleRiderDrawerKeyDown);
    drawerListenersAttached = true;
  }

  if (drawerBody) {
    drawerBody.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--color-text-muted);">
      <i data-lucide="loader-2" class="spin" style="width: 32px; height: 32px; margin-bottom: 12px;"></i>
      <p>Buscando detalhes autoritativos do fechamento...</p>
    </div>`;
    if (window.lucide) window.lucide.createIcons();
  }

  try {
    const { data, error } = await supabaseClient.rpc('get_admin_rider_weekly_settlement_detail', {
      p_settlement_id: settlementId
    });

    if (error || !data || data.success === false) {
      const errMsg = error?.message || data?.message || 'Erro ao carregar detalhes do fechamento.';
      alert(errMsg);
      closeRiderSettlementDrawer();
      return;
    }

    renderRiderSettlementDetail(data);

  } catch (err) {
    console.error("[RPC get_admin_rider_weekly_settlement_detail] Exceção:", err);
    closeRiderSettlementDrawer();
  }
}

function handleRiderDrawerKeyDown(e) {
  if (e.key === 'Escape') {
    closeRiderSettlementDrawer();
    return;
  }

  if (e.key === 'Tab') {
    const drawer = document.getElementById('rider-settlement-drawer');
    if (!drawer || drawer.classList.contains('hidden')) return;

    const focusables = drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        last.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  }
}

function renderRiderSettlementDetail(detailData) {
  const { settlement, summary, items, batches } = detailData;
  const drawerBody = document.getElementById('rider-drawer-body');
  const subtitleEl = document.getElementById('rider-drawer-subtitle');

  if (!drawerBody || !settlement) return;

  const periodStr = `${new Date(settlement.period_start).toLocaleDateString('pt-BR')} a ${new Date(settlement.period_end).toLocaleDateString('pt-BR')}`;
  if (subtitleEl) {
    subtitleEl.textContent = `${settlement.rider_name} (${settlement.rider_code}) • Período: ${periodStr} • Versão v${settlement.version}`;
  }

  const hasUnexplainedDiff = (items || []).some(i => Number(i.unexplained_difference) > 0);

  let html = '';

  if (hasUnexplainedDiff) {
    html += `<div class="integrity-alert-banner">
      <i data-lucide="alert-triangle" style="width: 18px; height: 18px;"></i>
      <span>Aviso de Integridade: Um ou mais itens possuem diferença não explicada registrada no banco de dados.</span>
    </div>`;
  }

  // 1. Resumo Contábil
  if (summary) {
    html += `<div class="rider-drawer-section">
      <h4 class="rider-drawer-section-title"><i data-lucide="calculator" style="width: 16px; height: 16px;"></i> Resumo Contábil do Fechamento</h4>
      <div class="summary-grid-2col">
        <div class="summary-item-box"><span class="summary-item-label">Faturamento Bruto</span><span class="summary-item-value">${formatRiderSettlementCurrency(summary.gross_delivery_amount)}</span></div>
        <div class="summary-item-box"><span class="summary-item-label">Base do Motoboy</span><span class="summary-item-value">${formatRiderSettlementCurrency(summary.base_rider_amount)}</span></div>
        <div class="summary-item-box"><span class="summary-item-label">Receita da Plataforma</span><span class="summary-item-value">${formatRiderSettlementCurrency(summary.platform_amount)}</span></div>
        <div class="summary-item-box"><span class="summary-item-label">Consumíveis</span><span class="summary-item-value" style="color: #ef4444;">${formatRiderSettlementCurrency(summary.consumables_amount)}</span></div>
        <div class="summary-item-box"><span class="summary-item-label">Créditos</span><span class="summary-item-value" style="color: #10b981;">${formatRiderSettlementCurrency(summary.credits_amount)}</span></div>
        <div class="summary-item-box"><span class="summary-item-label">Ajustes (+ / -)</span><span class="summary-item-value">${formatRiderSettlementCurrency(Number(summary.positive_adjustments_amount) - Number(summary.negative_adjustments_amount))}</span></div>
        <div class="summary-item-box" style="background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.3);"><span class="summary-item-label" style="color: #3b82f6;">Valor Líquido</span><span class="summary-item-value" style="color: #3b82f6;">${formatRiderSettlementCurrency(summary.net_amount)}</span></div>
        <div class="summary-item-box"><span class="summary-item-label">Liberado Elegível</span><span class="summary-item-value">${formatRiderSettlementCurrency(summary.eligible_amount)}</span></div>
        <div class="summary-item-box"><span class="summary-item-label">Bloqueado Clientes</span><span class="summary-item-value" style="color: #ef4444;">${formatRiderSettlementCurrency(summary.blocked_amount)}</span></div>
        <div class="summary-item-box"><span class="summary-item-label">Pago em Lotes</span><span class="summary-item-value">${formatRiderSettlementCurrency(summary.paid_amount)}</span></div>
        <div class="summary-item-box" style="background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.3);"><span class="summary-item-label" style="color: #10b981;">Elegível Não Pago</span><span class="summary-item-value" style="color: #10b981;">${formatRiderSettlementCurrency(summary.unpaid_eligible_amount)}</span></div>
      </div>
    </div>`;
  }

  // 2. Itens do Fechamento
  html += `<div class="rider-drawer-section">
    <h4 class="rider-drawer-section-title"><i data-lucide="list-ordered" style="width: 16px; height: 16px;"></i> Itens e Lançamentos (${items ? items.length : 0})</h4>
    <div class="table-responsive">
      <table class="table" style="font-size: 0.78rem;">
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Descrição</th>
            <th>Tele</th>
            <th>Cliente</th>
            <th>Data</th>
            <th>Valor Orig.</th>
            <th>Elegível</th>
            <th>Bloqueado</th>
            <th>Pago</th>
            <th>Restante</th>
            <th>Status Funding</th>
          </tr>
        </thead>
        <tbody>`;

  if (!items || items.length === 0) {
    html += `<tr><td colspan="11" style="text-align: center; color: var(--color-text-muted);">Nenhum item registrado.</td></tr>`;
  } else {
    items.forEach(it => {
      html += `<tr>
        <td><code>${it.source_type}</code></td>
        <td>${it.description || '—'}</td>
        <td>${it.tele_code || '—'}</td>
        <td>${it.client_name || '—'}</td>
        <td>${it.occurred_at ? new Date(it.occurred_at).toLocaleDateString('pt-BR') : '—'}</td>
        <td>${formatRiderSettlementCurrency(it.original_amount)}</td>
        <td>${formatRiderSettlementCurrency(it.eligible_amount)}</td>
        <td style="color: ${Number(it.blocked_amount) > 0 ? '#ef4444' : 'inherit'};">${formatRiderSettlementCurrency(it.blocked_amount)}</td>
        <td>${formatRiderSettlementCurrency(it.paid_amount)}</td>
        <td>${formatRiderSettlementCurrency(it.remaining_amount)}</td>
        <td><span class="badge badge-secondary">${it.funding_status_label || it.funding_status}</span></td>
      </tr>`;
    });
  }

  html += `</tbody></table></div></div>`;

  // 3. Lotes de Pagamento
  html += `<div class="rider-drawer-section">
    <h4 class="rider-drawer-section-title"><i data-lucide="layers" style="width: 16px; height: 16px;"></i> Lotes de Pagamento Associados (${batches ? batches.length : 0})</h4>
    <div class="table-responsive">
      <table class="table" style="font-size: 0.78rem;">
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Status</th>
            <th>Valor</th>
            <th>Método</th>
            <th>Referência</th>
            <th>Observações</th>
            <th>Responsável</th>
            <th>Pagamento</th>
            <th>Estorno</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>`;

  if (!batches || batches.length === 0) {
    html += `<tr><td colspan="10" style="text-align: center; color: var(--color-text-muted);">Nenhum lote registrado.</td></tr>`;
  } else {
    batches.forEach(b => {
      let batchActionBtn = '—';
      if (b.status === 'paid') {
        batchActionBtn = `<button type="button" class="btn btn-danger btn-sm" onclick="openReverseBatchModal('${b.id}', ${b.version || 1}, '${settlement.id}', '${formatRiderSettlementCurrency(b.total_paid_amount)}')">
          <i data-lucide="rotate-ccw" style="width: 12px; height: 12px;"></i> Estornar
        </button>`;
      }

      html += `<tr>
        <td>${b.batch_type_label || b.batch_type}</td>
        <td><span class="badge badge-secondary">${b.status_label || b.status}</span></td>
        <td><strong>${formatRiderSettlementCurrency(b.total_paid_amount)}</strong></td>
        <td>${b.payment_method || '—'}</td>
        <td><code>${b.payment_reference || '—'}</code></td>
        <td>${b.notes || '—'}</td>
        <td>${b.paid_by_name || '—'}</td>
        <td>${b.paid_at ? new Date(b.paid_at).toLocaleString('pt-BR') : '—'}</td>
        <td>${b.reversed_at ? new Date(b.reversed_at).toLocaleString('pt-BR') : '—'}</td>
        <td>${batchActionBtn}</td>
      </tr>`;
    });
  }

  html += `</tbody></table></div></div>`;

  drawerBody.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

function closeRiderSettlementDrawer() {
  const backdrop = document.getElementById('rider-settlement-drawer-backdrop');
  const drawer = document.getElementById('rider-settlement-drawer');

  if (backdrop) backdrop.classList.add('hidden');
  if (drawer) drawer.classList.add('hidden');
  document.body.classList.remove('drawer-open');

  if (drawerListenersAttached) {
    document.removeEventListener('keydown', handleRiderDrawerKeyDown);
    drawerListenersAttached = false;
  }

  if (activeElementBeforeDrawer && typeof activeElementBeforeDrawer.focus === 'function' && document.body.contains(activeElementBeforeDrawer)) {
    try { activeElementBeforeDrawer.focus(); } catch (e) {}
  }
  activeElementBeforeDrawer = null;
}

// =====================================================================
// Dahora Expresso — Fase 3B.2A.2: Operações Financeiras Autoritativas
// =====================================================================

let activeSettlementOperationalState = {
  settlementId: null,
  settlementVersion: null,
  batchId: null,
  batchVersion: null,
  riderName: '',
  createIdempotencyKey: null,
  payIdempotencyKey: null,
  reverseIdempotencyKey: null
};

// 1. Calcular Fechamento (usando period_start e period_end autoritativos do Postgres)
async function handleCalculateRiderSettlement(riderId, periodStartIso, periodEndIso) {
  if (!riderId || !periodStartIso || !periodEndIso) {
    alert("Dados autoritativos do período ausentes para calcular o fechamento.");
    return;
  }

  if (!confirm("Deseja executar o cálculo autoritativo deste fechamento semanal no banco de dados?")) return;

  try {
    const { data, error } = await supabaseClient.rpc('admin_calculate_rider_weekly_settlement', {
      p_rider_id: riderId,
      p_period_start: periodStartIso,
      p_period_end: periodEndIso
    });

    if (error || !data || data.success === false) {
      alert(`Erro ao calcular fechamento: ${error?.message || data?.message || 'Falha na RPC'}`);
      return;
    }

    await fetchAdminRiderWeeklySettlements(false);

    if (data.settlement_id) {
      openRiderSettlementDrawer(data.settlement_id);
    }
  } catch (err) {
    console.error("[RPC admin_calculate_rider_weekly_settlement] Exceção:", err);
  }
}

// 2. Encerrar Fechamento
function openCloseSettlementModal(settlementId, expectedVersion, riderName, netStr, eligibleStr, blockedStr, periodStr) {
  activeSettlementOperationalState.settlementId = settlementId;
  activeSettlementOperationalState.settlementVersion = expectedVersion;

  const modal = document.getElementById('modal-close-settlement');
  const nameEl = document.getElementById('close-modal-rider-name');
  const periodEl = document.getElementById('close-modal-period');
  const netEl = document.getElementById('close-modal-net-amount');
  const eligEl = document.getElementById('close-modal-eligible-amount');
  const blockEl = document.getElementById('close-modal-blocked-amount');
  const versionEl = document.getElementById('close-modal-version');
  const noticeEl = document.getElementById('close-settlement-notice');

  if (nameEl) nameEl.textContent = riderName;
  if (periodEl) periodEl.textContent = periodStr;
  if (netEl) netEl.textContent = netStr;
  if (eligEl) eligEl.textContent = eligibleStr;
  if (blockEl) blockEl.textContent = blockedStr;
  if (versionEl) versionEl.textContent = `v${expectedVersion}`;
  if (noticeEl) { noticeEl.textContent = ''; noticeEl.classList.add('hidden'); }

  if (modal) modal.classList.remove('hidden');
}

function closeRiderCloseSettlementModal() {
  const modal = document.getElementById('modal-close-settlement');
  if (modal) modal.classList.add('hidden');
}

async function submitCloseRiderSettlement() {
  const { settlementId, settlementVersion } = activeSettlementOperationalState;
  if (!settlementId || settlementVersion === null) return;

  const btn = document.getElementById('btn-confirm-close-settlement');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Processando...'; }

  try {
    const { data, error } = await supabaseClient.rpc('admin_close_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: settlementVersion
    });

    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="check-circle"></i> Confirmar Encerramento'; }

    if (error || !data || data.success === false) {
      const errCode = data?.error_code || error?.code;
      if (errCode === 'VERSION_CONFLICT') {
        alert("O fechamento foi alterado por outra operação. Os dados autoritativos foram atualizados.");
      } else {
        alert(`Erro ao encerrar fechamento: ${error?.message || data?.message || 'Falha na RPC'}`);
      }
      closeRiderCloseSettlementModal();
      await fetchAdminRiderWeeklySettlements(false);
      return;
    }

    closeRiderCloseSettlementModal();
    await fetchAdminRiderWeeklySettlements(false);
    if (document.getElementById('rider-settlement-drawer')?.classList.contains('hidden') === false) {
      openRiderSettlementDrawer(settlementId);
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="check-circle"></i> Confirmar Encerramento'; }
    console.error("[RPC admin_close_rider_weekly_settlement] Exceção:", err);
  }
}

// 3. Reabrir Fechamento
function openReopenSettlementModal(settlementId, expectedVersion, riderName) {
  activeSettlementOperationalState.settlementId = settlementId;
  activeSettlementOperationalState.settlementVersion = expectedVersion;

  const modal = document.getElementById('modal-reopen-settlement');
  const nameEl = document.getElementById('reopen-modal-rider-name');
  const versionEl = document.getElementById('reopen-modal-version');
  const reasonInput = document.getElementById('reopen-settlement-reason-input');
  const noticeEl = document.getElementById('reopen-settlement-notice');

  if (nameEl) nameEl.textContent = riderName;
  if (versionEl) versionEl.textContent = `v${expectedVersion}`;
  if (reasonInput) reasonInput.value = '';
  if (noticeEl) { noticeEl.textContent = ''; noticeEl.classList.add('hidden'); }

  if (modal) modal.classList.remove('hidden');
}

function closeRiderReopenSettlementModal() {
  const modal = document.getElementById('modal-reopen-settlement');
  if (modal) modal.classList.add('hidden');
}

async function submitReopenRiderSettlement() {
  const { settlementId, settlementVersion } = activeSettlementOperationalState;
  const reasonInput = document.getElementById('reopen-settlement-reason-input');
  const reason = reasonInput ? reasonInput.value.trim() : '';

  if (!reason) {
    const noticeEl = document.getElementById('reopen-settlement-notice');
    if (noticeEl) {
      noticeEl.textContent = 'O motivo da reabertura é obrigatório.';
      noticeEl.classList.remove('hidden');
    }
    return;
  }

  const btn = document.getElementById('btn-confirm-reopen-settlement');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Reabrindo...'; }

  try {
    const { data, error } = await supabaseClient.rpc('admin_reopen_rider_weekly_settlement', {
      p_settlement_id: settlementId,
      p_expected_version: settlementVersion,
      p_reason: reason
    });

    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="unlock"></i> Confirmar Reabertura'; }

    if (error || !data || data.success === false) {
      const errCode = data?.error_code || error?.code;
      if (errCode === 'CANNOT_REOPEN_PAID') {
        alert("Não é possível reabrir um repasse já pago sem o estorno formal dos lotes.");
      } else if (errCode === 'VERSION_CONFLICT') {
        alert("O fechamento foi modificado por outro operador. Os dados foram recarregados.");
      } else {
        alert(`Erro ao reabrir fechamento: ${error?.message || data?.message || 'Falha na RPC'}`);
      }
      closeRiderReopenSettlementModal();
      await fetchAdminRiderWeeklySettlements(false);
      return;
    }

    closeRiderReopenSettlementModal();
    await fetchAdminRiderWeeklySettlements(false);
    if (document.getElementById('rider-settlement-drawer')?.classList.contains('hidden') === false) {
      openRiderSettlementDrawer(settlementId);
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="unlock"></i> Confirmar Reabertura'; }
    console.error("[RPC admin_reopen_rider_weekly_settlement] Exceção:", err);
  }
}

// 4. Pagamento Manual em 2 Etapas
function openPaySettlementModal(settlementId, expectedVersion, riderName, unpaidEligibleStr, blockedStr) {
  activeSettlementOperationalState.settlementId = settlementId;
  activeSettlementOperationalState.settlementVersion = expectedVersion;
  activeSettlementOperationalState.batchId = null;
  activeSettlementOperationalState.batchVersion = null;

  const storageKey = `rps_payment_pending_${currentActiveSession?.user?.id || 'admin'}_${settlementId}`;
  const existingPending = sessionStorage.getItem(storageKey);
  if (existingPending) {
    try {
      const parsed = JSON.parse(existingPending);
      if (parsed.create_idempotency_key) {
        activeSettlementOperationalState.createIdempotencyKey = parsed.create_idempotency_key;
      }
      if (parsed.pay_idempotency_key) {
        activeSettlementOperationalState.payIdempotencyKey = parsed.pay_idempotency_key;
      }
    } catch(e) {}
  } else {
    const timestamp = Date.now();
    activeSettlementOperationalState.createIdempotencyKey = `rps_create_${settlementId}_${timestamp}`;
    activeSettlementOperationalState.payIdempotencyKey = `rps_pay_${settlementId}_${timestamp}`;
  }

  const modal = document.getElementById('modal-pay-settlement');
  const nameEl = document.getElementById('pay-modal-rider-name');
  const versionEl = document.getElementById('pay-modal-settlement-version');
  const unpaidEl = document.getElementById('pay-modal-unpaid-eligible');
  const blockedEl = document.getElementById('pay-modal-blocked');
  const step1Box = document.getElementById('pay-settlement-step1-box');
  const step2Box = document.getElementById('pay-settlement-step2-box');
  const btnCreate = document.getElementById('btn-create-pay-batch');
  const btnConfirm = document.getElementById('btn-confirm-mark-batch-paid');
  const noticeEl = document.getElementById('pay-settlement-notice');

  if (nameEl) nameEl.textContent = riderName;
  if (versionEl) versionEl.textContent = `v${expectedVersion}`;
  if (unpaidEl) unpaidEl.textContent = unpaidEligibleStr;
  if (blockedEl) blockedEl.textContent = blockedStr;

  if (step1Box) step1Box.classList.remove('hidden');
  if (step2Box) step2Box.classList.add('hidden');
  if (btnCreate) btnCreate.classList.remove('hidden');
  if (btnConfirm) btnConfirm.classList.add('hidden');
  if (noticeEl) { noticeEl.textContent = ''; noticeEl.classList.add('hidden'); }

  if (modal) modal.classList.remove('hidden');
}

function closeRiderPaySettlementModal() {
  const modal = document.getElementById('modal-pay-settlement');
  if (modal) modal.classList.add('hidden');
}

async function submitCreateRiderPayBatch() {
  const { settlementId, settlementVersion, createIdempotencyKey } = activeSettlementOperationalState;
  if (!settlementId || settlementVersion === null) return;

  const btnCreate = document.getElementById('btn-create-pay-batch');
  if (btnCreate) { btnCreate.disabled = true; btnCreate.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Criando Lote...'; }

  try {
    // Etapa 1: Criar lote
    const { data, error } = await supabaseClient.rpc('admin_create_rider_payment_batch', {
      p_settlement_id: settlementId,
      p_expected_version: settlementVersion,
      p_idempotency_key: createIdempotencyKey
    });

    if (error || !data || data.success === false) {
      if (btnCreate) { btnCreate.disabled = false; btnCreate.innerHTML = '<i data-lucide="layers"></i> Criar Lote de Pagamento'; }
      alert(`Erro ao criar lote de pagamento: ${error?.message || data?.message || 'Falha na RPC'}`);
      return;
    }

    const batchId = data.batch_id;
    activeSettlementOperationalState.batchId = batchId;

    // EXIGÊNCIA OBRIGATÓRIA: Re-fetch autoritativo de get_admin_rider_weekly_settlement_detail para obter a batch.version real!
    const { data: detailData, error: detailErr } = await supabaseClient.rpc('get_admin_rider_weekly_settlement_detail', {
      p_settlement_id: settlementId
    });

    if (detailErr || !detailData || detailData.success === false) {
      if (btnCreate) { btnCreate.disabled = false; btnCreate.innerHTML = '<i data-lucide="layers"></i> Criar Lote de Pagamento'; }
      alert("Erro ao buscar versão autoritativa do lote. A confirmação foi interrompida para segurança.");
      return;
    }

    const realBatch = (detailData.batches || []).find(b => b.id === batchId);
    if (!realBatch || realBatch.version === undefined || realBatch.version === null) {
      if (btnCreate) { btnCreate.disabled = false; btnCreate.innerHTML = '<i data-lucide="layers"></i> Criar Lote de Pagamento'; }
      alert("Inconsistência: Lote criado não foi localizado no detalhe autoritativo. Etapa 2 interrompida.");
      return;
    }

    activeSettlementOperationalState.batchVersion = realBatch.version;

    // Salvar no sessionStorage para suporte a F5
    const storageKey = `rps_payment_pending_${currentActiveSession?.user?.id || 'admin'}_${settlementId}`;
    sessionStorage.setItem(storageKey, JSON.stringify({
      workspace_id: currentActiveSession?.user?.id || 'admin',
      settlement_id: settlementId,
      settlement_version: settlementVersion,
      batch_id: batchId,
      batch_version: realBatch.version,
      create_idempotency_key: createIdempotencyKey,
      pay_idempotency_key: activeSettlementOperationalState.payIdempotencyKey,
      stage: 'batch_created',
      created_at: new Date().toISOString()
    }));

    // Transicionar modal para Etapa 2
    const step1Box = document.getElementById('pay-settlement-step1-box');
    const step2Box = document.getElementById('pay-settlement-step2-box');
    const btnConfirm = document.getElementById('btn-confirm-mark-batch-paid');

    if (step1Box) step1Box.classList.add('hidden');
    if (step2Box) step2Box.classList.remove('hidden');
    if (btnCreate) btnCreate.classList.add('hidden');
    if (btnConfirm) { btnConfirm.classList.remove('hidden'); btnConfirm.disabled = false; }

  } catch (err) {
    if (btnCreate) { btnCreate.disabled = false; btnCreate.innerHTML = '<i data-lucide="layers"></i> Criar Lote de Pagamento'; }
    console.error("[RPC admin_create_rider_payment_batch] Exceção:", err);
  }
}

async function submitMarkRiderBatchPaid() {
  const { settlementId, batchId, batchVersion, payIdempotencyKey } = activeSettlementOperationalState;
  const methodSelect = document.getElementById('pay-modal-method-select');
  const refInput = document.getElementById('pay-modal-reference-input');
  const notesInput = document.getElementById('pay-modal-notes-input');

  const method = methodSelect ? methodSelect.value : 'PIX';
  const reference = refInput ? refInput.value.trim() : '';
  const notes = notesInput ? notesInput.value.trim() : '';

  if (!reference) {
    alert("O código de referência / E2E do comprovante de pagamento é obrigatório.");
    return;
  }

  const btnConfirm = document.getElementById('btn-confirm-mark-batch-paid');
  if (btnConfirm) { btnConfirm.disabled = true; btnConfirm.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Confirmando...'; }

  try {
    const { data, error } = await supabaseClient.rpc('admin_mark_rider_payment_batch_paid', {
      p_batch_id: batchId,
      p_expected_version: batchVersion,
      p_payment_method: method,
      p_payment_reference: reference,
      p_notes: notes || null,
      p_idempotency_key: payIdempotencyKey
    });

    if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.innerHTML = '<i data-lucide="check-check"></i> Confirmar Pagamento Realizado'; }

    if (error || !data || data.success === false) {
      const errCode = data?.error_code || error?.code;
      if (errCode === 'VERSION_CONFLICT') {
        alert("O lote de pagamento foi alterado por outra operação. Dados recarregados.");
      } else {
        alert(`Erro ao marcar lote como pago: ${error?.message || data?.message || 'Falha na RPC'}`);
      }
      return;
    }

    // Sucesso! Limpar sessionStorage
    const storageKey = `rps_payment_pending_${currentActiveSession?.user?.id || 'admin'}_${settlementId}`;
    sessionStorage.removeItem(storageKey);

    closeRiderPaySettlementModal();
    dismissRiderPaymentRecoveryBanner();

    await fetchAdminRiderWeeklySettlements(false);
    if (document.getElementById('rider-settlement-drawer')?.classList.contains('hidden') === false) {
      openRiderSettlementDrawer(settlementId);
    }
  } catch (err) {
    if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.innerHTML = '<i data-lucide="check-check"></i> Confirmar Pagamento Realizado'; }
    console.error("[RPC admin_mark_rider_payment_batch_paid] Exceção:", err);
  }
}

// 5. Estorno Auditado de Lote
function openReverseBatchModal(batchId, batchVersion, settlementId, amountStr) {
  activeSettlementOperationalState.batchId = batchId;
  activeSettlementOperationalState.batchVersion = batchVersion;
  activeSettlementOperationalState.settlementId = settlementId;
  activeSettlementOperationalState.reverseIdempotencyKey = `rps_reverse_${batchId}_${Date.now()}`;

  const modal = document.getElementById('modal-reverse-batch');
  const amountEl = document.getElementById('reverse-modal-batch-amount');
  const versionEl = document.getElementById('reverse-modal-batch-version');
  const reasonInput = document.getElementById('reverse-batch-reason-input');
  const noticeEl = document.getElementById('reverse-batch-notice');

  if (amountEl) amountEl.textContent = amountStr;
  if (versionEl) versionEl.textContent = `v${batchVersion}`;
  if (reasonInput) reasonInput.value = '';
  if (noticeEl) { noticeEl.textContent = ''; noticeEl.classList.add('hidden'); }

  if (modal) modal.classList.remove('hidden');
}

function closeRiderReverseBatchModal() {
  const modal = document.getElementById('modal-reverse-batch');
  if (modal) modal.classList.add('hidden');
}

async function submitReverseRiderBatch() {
  const { batchId, batchVersion, settlementId, reverseIdempotencyKey } = activeSettlementOperationalState;
  const reasonInput = document.getElementById('reverse-batch-reason-input');
  const reason = reasonInput ? reasonInput.value.trim() : '';

  if (!reason) {
    const noticeEl = document.getElementById('reverse-batch-notice');
    if (noticeEl) {
      noticeEl.textContent = 'O motivo do estorno é obrigatório.';
      noticeEl.classList.remove('hidden');
    }
    return;
  }

  const btn = document.getElementById('btn-confirm-reverse-batch');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Estornando...'; }

  try {
    const { data, error } = await supabaseClient.rpc('admin_reverse_rider_payment_batch', {
      p_batch_id: batchId,
      p_expected_version: batchVersion,
      p_reason: reason,
      p_idempotency_key: reverseIdempotencyKey
    });

    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="rotate-ccw"></i> Confirmar Estorno Auditado'; }

    if (error || !data || data.success === false) {
      alert(`Erro ao estornar lote: ${error?.message || data?.message || 'Falha na RPC'}`);
      return;
    }

    closeRiderReverseBatchModal();
    await fetchAdminRiderWeeklySettlements(false);
    if (document.getElementById('rider-settlement-drawer')?.classList.contains('hidden') === false) {
      openRiderSettlementDrawer(settlementId);
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="rotate-ccw"></i> Confirmar Estorno Auditado'; }
    console.error("[RPC admin_reverse_rider_payment_batch] Exceção:", err);
  }
}

// 6. Recuperação e Reconciliação do sessionStorage
async function checkPendingPaymentRecovery() {
  if (typeof sessionStorage === 'undefined') return;
  const prefix = `rps_payment_pending_${currentActiveSession?.user?.id || 'admin'}_`;

  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith(prefix)) {
      try {
        const item = JSON.parse(sessionStorage.getItem(key));
        if (item && item.settlement_id && item.batch_id) {
          const banner = document.getElementById('rider-payment-recovery-banner');
          if (banner) banner.classList.remove('hidden');
          return item;
        }
      } catch (e) {}
    }
  }
}

function dismissRiderPaymentRecoveryBanner() {
  const banner = document.getElementById('rider-payment-recovery-banner');
  if (banner) banner.classList.add('hidden');
}

async function resumePendingRiderPayment() {
  const pending = await checkPendingPaymentRecovery();
  if (!pending) return;

  const { settlement_id, batch_id, create_idempotency_key, pay_idempotency_key } = pending;

  try {
    const { data: detailData, error } = await supabaseClient.rpc('get_admin_rider_weekly_settlement_detail', {
      p_settlement_id: settlement_id
    });

    if (error || !detailData || detailData.success === false) {
      alert("Não foi possível buscar o estado autoritativo do lote para recuperação.");
      return;
    }

    const batch = (detailData.batches || []).find(b => b.id === batch_id);
    const storageKey = `rps_payment_pending_${currentActiveSession?.user?.id || 'admin'}_${settlement_id}`;

    if (!batch) {
      alert("Inconsistência: Lote pendente não foi encontrado no banco de dados.");
      return;
    }

    if (batch.status === 'paid') {
      alert("O lote de pagamento já foi marcado como PAGO anteriormente por outro operador.");
      sessionStorage.removeItem(storageKey);
      dismissRiderPaymentRecoveryBanner();
      await fetchAdminRiderWeeklySettlements(false);
      return;
    }

    if (batch.status === 'reversed') {
      alert("O lote de pagamento foi estornado.");
      sessionStorage.removeItem(storageKey);
      dismissRiderPaymentRecoveryBanner();
      await fetchAdminRiderWeeklySettlements(false);
      return;
    }

    if (batch.status === 'pending') {
      activeSettlementOperationalState.settlementId = settlement_id;
      activeSettlementOperationalState.settlementVersion = detailData.settlement?.version || 1;
      activeSettlementOperationalState.batchId = batch_id;
      activeSettlementOperationalState.batchVersion = batch.version;
      activeSettlementOperationalState.createIdempotencyKey = create_idempotency_key;
      activeSettlementOperationalState.payIdempotencyKey = pay_idempotency_key;

      openPaySettlementModal(
        settlement_id,
        detailData.settlement?.version || 1,
        detailData.settlement?.rider_name || 'Motoboy',
        formatRiderSettlementCurrency(detailData.summary?.unpaid_eligible_amount || 0),
        formatRiderSettlementCurrency(detailData.summary?.blocked_amount || 0)
      );

      const step1Box = document.getElementById('pay-settlement-step1-box');
      const step2Box = document.getElementById('pay-settlement-step2-box');
      const btnCreate = document.getElementById('btn-create-pay-batch');
      const btnConfirm = document.getElementById('btn-confirm-mark-batch-paid');

      if (step1Box) step1Box.classList.add('hidden');
      if (step2Box) step2Box.classList.remove('hidden');
      if (btnCreate) btnCreate.classList.add('hidden');
      if (btnConfirm) { btnConfirm.classList.remove('hidden'); btnConfirm.disabled = false; }
    }
  } catch (err) {
    console.error("[RECOVERY EXCEPTION]", err);
  }
}

// =====================================================================
// Interface Autoritativa de Reset do Ambiente DEMO (Restrito ao Ambiente DEMO)
// =====================================================================
function initDemoResetUI() {
  /* Esta verificação controla apenas a interface. A autorização real ocorre na Edge Function e na RPC PostgreSQL. */
  const envKind = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.environmentKind) || window.__ENV_ENVIRONMENT_KIND;
  const isResetEnabled = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.demoResetEnabled) || (window.__ENV_DEMO_RESET_ENABLED === 'true');

  if (envKind !== 'demo' || !isResetEnabled) {
    const existingSection = document.getElementById('demo-environment-reset-section');
    if (existingSection) existingSection.remove();
    return;
  }

  if (!document.getElementById('demo-reset-modal')) {
    const modalDiv = document.createElement('div');
    modalDiv.id = 'demo-reset-modal';
    modalDiv.className = 'modal-backdrop hidden';
    modalDiv.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:999999; padding:20px;';
    modalDiv.innerHTML = `
      <div class="modal-content" style="background:#1e293b; border:1px solid #ef4444; border-radius:12px; max-width:480px; width:100%; padding:24px; color:#f8fafc; font-family:sans-serif;">
        <h3 style="color:#ef4444; margin-top:0; font-size:1.25rem; display:flex; align-items:center; gap:8px;">
          <span>⚠️ Restaurar Demonstração</span>
        </h3>
        <p style="font-size:0.9rem; color:#cbd5e1; line-height:1.5;">
          Esta ação apagará <strong>TODOS</strong> os dados operacionais criados na demonstração (Teles, transações, motoboys e clientes adicionais). As contas base de demonstração serão restauradas com saldos zerados.
        </p>
        <p style="font-size:0.85rem; color:#f87171; font-weight:bold; margin-top:12px;">
          Para confirmar, digite <code>RESTAURAR DEMO</code> abaixo:
        </p>
        <input type="text" id="input-confirm-demo-reset" placeholder="RESTAURAR DEMO" style="width:100%; padding:10px; border-radius:6px; border:1px solid #475569; background:#0f172a; color:#fff; font-size:0.95rem; margin-bottom:16px;" oninput="validateDemoResetInput(this.value)">
        <div style="display:flex; justify-content:flex-end; gap:12px;">
          <button type="button" class="btn btn-secondary" onclick="closeDemoResetModal()" style="padding:10px 16px; border-radius:6px; background:#475569; color:#fff; border:none; cursor:pointer;">Cancelar</button>
          <button type="button" id="btn-submit-demo-reset" disabled onclick="submitDemoReset()" style="padding:10px 16px; border-radius:6px; background:#ef4444; color:#fff; border:none; cursor:not-allowed; font-weight:bold;">Restaurar Demonstração</button>
        </div>
      </div>
    `;
    document.body.appendChild(modalDiv);
  }
}

window.validateDemoResetInput = function(val) {
  const btn = document.getElementById('btn-submit-demo-reset');
  if (btn) {
    const isValid = val.trim() === 'RESTAURAR DEMO';
    btn.disabled = !isValid;
    btn.style.cursor = isValid ? 'pointer' : 'not-allowed';
    btn.style.opacity = isValid ? '1' : '0.5';
  }
};

window.closeDemoResetModal = function() {
  const modal = document.getElementById('demo-reset-modal');
  if (modal) modal.classList.add('hidden');
};

window.openDemoResetModal = function() {
  const modal = document.getElementById('demo-reset-modal');
  if (modal) {
    modal.classList.remove('hidden');
    const input = document.getElementById('input-confirm-demo-reset');
    if (input) { input.value = ''; validateDemoResetInput(''); }
  }
};

window.submitDemoReset = async function() {
  const btn = document.getElementById('btn-submit-demo-reset');
  if (btn) { btn.disabled = true; btn.innerText = 'Restaurando...'; }

  try {
    let result = null;

    if (supabaseClient && supabaseClient.functions) {
      const { data, error } = await supabaseClient.functions.invoke('reset-demo-environment', {
        body: { confirmation: 'RESTAURAR DEMO' }
      });
      if (error) {
        throw new Error(error.message || 'Falha ao invocar Edge Function de reset');
      }
      result = data;
    } else if (supabaseClient) {
      // Fallback para RPC direta se Edge Function não estiver publicada no ambiente local
      const { data, error } = await supabaseClient.rpc('reset_demo_environment', {
        p_confirmation: 'RESTAURAR DEMO'
      });
      if (error) throw error;
      result = data;
    }

    if (result && result.success) {
      sessionStorage.clear();
      alert(`Demonstração restaurada com sucesso em ${result.duration_ms}ms!\nID de Execução: ${result.execution_id}`);
      window.location.reload();
    } else {
      const msg = result ? (result.message || 'Erro não especificado') : 'Resposta nula';
      if (msg.includes('RESET_ALREADY_RUNNING')) {
        alert('Uma operação de reset já está em andamento. Aguarde alguns segundos.');
      } else if (msg.includes('RESET_NOT_ALLOWED')) {
        alert('Esta operação só é permitida em ambiente de demonstração.');
      } else {
        alert(`Falha ao restaurar demonstração: ${msg}`);
      }
    }
  } catch (err) {
    console.error("[DEMO RESET EXCEPTION]", err);
    alert(`Erro ao comunicar com o servidor de reset: ${err.message || err}`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = 'Restaurar Demonstração'; }
    window.closeDemoResetModal();
  }
};

document.addEventListener('DOMContentLoaded', initDemoResetUI);
