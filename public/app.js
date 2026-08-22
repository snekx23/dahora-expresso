// Dahora Expresso - Core Application Logic




// Supabase Configuration
let supabaseClient = null;
let maxSimultaneousDeliveries = 1;
let adminClientViewContext = null;

(function initSupabaseAppClient() {
  if (typeof window === 'undefined') return;

  if (!window.SUPABASE_CONFIG || !window.SUPABASE_CONFIG.url || !window.SUPABASE_CONFIG.key) {
    console.error("[SUPABASE INIT] Configuração do ambiente não disponível.");
    document.addEventListener('DOMContentLoaded', () => {
      const errInfo = window.__CONFIGURATION_ERROR || { message: 'Ambiente não configurado. Verifique as configurações do sistema.' };
      const banner = document.createElement('div');
      banner.className = 'config-error-banner';
      banner.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:#0f172a; color:#f87171; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:99999; padding:24px; text-align:center; font-family:sans-serif;';
      banner.innerHTML = `<h2 style="font-size:1.5rem; margin-bottom:12px;">⚠️ Sistema Indisponível</h2><p style="font-size:1rem; max-width:480px; color:#94a3b8;">${errInfo.message}</p>`;
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
        detectSessionInUrl: true,
        storageKey: 'dahora-owner-auth'
      }
    });
    window.supabaseClient = supabaseClient;
    setupPasswordRecoveryListener();
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
    owner: { name: 'Gustavo Souza', role: 'Dono & CEO', avatar: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?q=80&w=256&auto=format&fit=crop' },
    client: { name: 'Gerente Lanchonete Dahora', role: 'Área do parceiro', commerceName: 'Lanchonete Dahora', avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?q=80&w=256&auto=format&fit=crop' },
    order: { name: 'Pedido Lanchonete Dahora', role: 'Solicitação de entrega', commerceName: 'Lanchonete Dahora', avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?q=80&w=256&auto=format&fit=crop' }
  },
  pendingDeliveries: [],
  riderConsumables: [],
  riderCredits: [],
  cities: []
};
window.mockData = mockData;

let commercesList = [];
let currentTeleFilter = 'all';
let teleViewMode = 'list';
let currentClientTeleFilter = 'all';
let clientTeleViewMode = 'list';

let commercialClientsSelectCache = [];
let currentActiveSession = null;
let currentAdminProfile = null;

function hasPersistedAuthToken() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes('auth') || key.startsWith('sb-'))) {
        const val = localStorage.getItem(key);
        if (val && val !== 'null' && val !== 'undefined') return true;
      }
    }
  } catch (e) {}
  return false;
}

function showLoginViewOnly() {
  currentActiveSession = null;
  currentAdminProfile = null;
  const viewLanding = document.getElementById('view-landing');
  const viewDashboard = document.getElementById('view-dashboard');
  if (viewLanding) viewLanding.classList.add('active');
  if (viewDashboard) viewDashboard.classList.remove('active');
  switchLoginTab('owner');
}

const initialHasAuthToken = hasPersistedAuthToken();

async function checkAdminSession() {
  if (!supabaseClient) return { status: 'no_session' };
  try {
    console.log('[AUTH STORAGE KEY]', supabaseClient?.auth?.storageKey, 'keys:', Object.keys(localStorage));
    const { data: sessionData, error: sessionErr } = await supabaseClient.auth.getSession();
    if (sessionErr || !sessionData || !sessionData.session) {
      currentActiveSession = null;
      currentAdminProfile = null;
      return { status: initialHasAuthToken ? 'expired' : 'no_session' };
    }

    currentActiveSession = sessionData.session;
    console.log(`[AUTH AUDIT] Session active. auth.uid: ${currentActiveSession.user.id}, email: ${currentActiveSession.user.email}`);

    if (!currentAdminProfile) {
      const { data: profile, error: profileErr } = await supabaseClient
        .from('user_profiles')
        .select('id, user_id, name, email, role, is_active, admin_code')
        .or(`user_id.eq.${currentActiveSession.user.id},id.eq.${currentActiveSession.user.id}`)
        .maybeSingle();

      if (profileErr || !profile || !profile.is_active) {
        console.warn("[AUTH AUDIT] Admin profile invalid or inactive:", profileErr?.message || profile);
        await supabaseClient.auth.signOut();
        currentActiveSession = null;
        currentAdminProfile = null;
        return { status: 'expired' };
      }
      currentAdminProfile = profile;
      console.log(`[AUTH AUDIT] Admin profile validated. role: ${profile.role}, is_active: ${profile.is_active}`);
      if (typeof updateOwnerFabVisibility === 'function') updateOwnerFabVisibility();
    }

    return { status: 'valid', session: currentActiveSession, profile: currentAdminProfile };
  } catch (err) {
    console.error("[AUTH AUDIT] Session check error:", err);
    currentActiveSession = null;
    currentAdminProfile = null;
    return { status: hasPersistedAuthToken() ? 'expired' : 'no_session' };
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
      .select('id, client_code, establishment_name, responsible_name, lifecycle_status, is_internal, address, neighborhood, city, postal_code, pickup_latitude, pickup_longitude, pickup_place_id')
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
function escapeHtml(value, fallback = '') {
  if (value === null || value === undefined || value === 'null' || value === 'undefined' || value === 'NaN' || Number.isNaN(value)) {
    return fallback;
  }
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
let ownerFleetCenterCoords = [-29.8247, -51.1444];
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
          batteryDisplay = `âš¡ ${batteryLevel}% — Carregando`;
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
        bypassDistanceLimit: Boolean(item.bypass_distance_limit),
        statusClass: getRiderStatusDetails(item.status).statusClass,
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


    mockData.clientHistory = (data || []).map(item => {
      const assignedRider = item.motoboy_id ? mockData.fleet.find(r => r.id === item.motoboy_id || String(r.id) === String(item.motoboy_id)) : null;
      const riderDisplayName = assignedRider ? assignedRider.name : (item.rider || (item.motoboy_id ? 'Motoboy Vinculado' : 'Aguardando Despacho'));

      return {
        id: escapeHtml(String(item.id || '')),
        raw_id: item.id,
        tele_code: (item.tele_code && !isUuidString(item.tele_code)) ? item.tele_code : null,
        client_id: item.client_id,
        client: escapeHtml(resolveClientDisplayName(item)),
        destName: escapeHtml(item.recipient_name || item.dest_name || 'Cliente'),
        address: escapeHtml(item.delivery_address || item.address || ''),
        delivery_address: escapeHtml(item.delivery_address || item.address || ''),
        pickup_address: escapeHtml(item.pickup_address || item.origin_address || ''),
        rider: escapeHtml(riderDisplayName),
        dist: '—',
        price: formatMoneyBR(Number(item.delivery_charge || item.valor || 15)),
        date: item.created_at ? new Date(item.created_at).toLocaleDateString('pt-BR') : 'Hoje',
        status: escapeHtml(item.status),
        statusClass: item.status === 'concluida' ? 'status-success' : (item.status === 'cancelada' ? 'status-danger' : 'status-warning'),
        payment_status: 'Pendente',
        dest_lat: item.dest_lat !== undefined && item.dest_lat !== null ? Number(item.dest_lat) : (item.delivery_latitude !== undefined && item.delivery_latitude !== null ? Number(item.delivery_latitude) : null),
        dest_lng: item.dest_lng !== undefined && item.dest_lng !== null ? Number(item.dest_lng) : (item.delivery_longitude !== undefined && item.delivery_longitude !== null ? Number(item.delivery_longitude) : null),
        motoboy_id: item.motoboy_id || null,
        created_at: item.created_at,
        version: item.version !== undefined && item.version !== null ? Number(item.version) : null,
        total_order_amount: item.total_order_amount || null
      };
    });
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
      .in('status', ['solicitada', 'solicitado', 'criada', 'aguardando_despacho'])
      .order('created_at', { ascending: true });

    if (error) {
      console.warn("Aviso ao buscar teles pendentes:", error.message);
      return;
    }

    mockData.pendingDeliveries = (data || []).map(item => {
      const assignedRider = item.motoboy_id ? mockData.fleet.find(r => r.id === item.motoboy_id || String(r.id) === String(item.motoboy_id)) : null;
      const riderDisplayName = assignedRider ? assignedRider.name : (item.rider || 'Aguardando...');

      return {
        id: escapeHtml(String(item.id || '')),
        raw_id: item.id,
        tele_code: (item.tele_code && !isUuidString(item.tele_code)) ? item.tele_code : null,
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
        motoboy_id: item.motoboy_id || null,
        rider: escapeHtml(riderDisplayName),
        created_at: item.created_at,
        version: item.version !== undefined && item.version !== null ? Number(item.version) : null,
        total_order_amount: item.total_order_amount || null
      };
    });
  } catch (err) {
    console.warn("Aviso ao buscar teles pendentes:", err.message);
  }
}

function getRiderDisplayCode(code) {
  if (!code || typeof code !== 'string') return '';
  const cleaned = code.trim();
  if (!cleaned || isUuidString(cleaned)) return '';
  return cleaned;
}

function getRiderDisplayIdentity(rider) {
  if (!rider) return { name: 'Motoboy', code: '' };
  const rawName = rider.name || rider.full_name || rider.motoboy_name || '';
  const name = (rawName && !isUuidString(rawName)) ? rawName.trim() : 'Motoboy';
  const rawCode = rider.motoboy_code || rider.rider_code || rider.code || '';
  const code = getRiderDisplayCode(rawCode);
  return { name, code };
}

function getClientDisplayCode(code) {
  if (!code || typeof code !== 'string') return '';
  const cleaned = code.trim();
  if (!cleaned || isUuidString(cleaned)) return '';
  return cleaned;
}

function getClientDisplayIdentity(client) {
  if (!client) return { name: 'Cliente', code: '' };
  const rawName = client.establishment_name || client.name || client.company_name || '';
  const name = (rawName && !isUuidString(rawName)) ? rawName.trim() : 'Cliente';
  const rawCode = client.client_code || client.code || '';
  const code = getClientDisplayCode(rawCode);
  return { name, code };
}

function formatRiderDisplayName(r) {
  if (!r) return 'Motoboy sem nome';
  const { name, code } = getRiderDisplayIdentity(r);
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

    mockData.riderConsumables = (data || []).map(item => {
      const rawRiderName = item.motoboy_name || item.rider_name || '';
      const matchedRider = (mockData.fleet || []).find(r => r.id === item.motoboy_id || r.user_id === item.motoboy_id || r.id === item.rider_id || r.user_id === item.rider_id);

      let displayName = 'Motoboy';
      if (matchedRider) {
        displayName = formatRiderDisplayName(matchedRider);
      } else if (rawRiderName && !isUuidString(rawRiderName)) {
        displayName = rawRiderName;
      }

      return {
        id: item.id,
        rider_id: escapeHtml(String(item.motoboy_id || item.rider_id || '')),
        rider_name: escapeHtml(displayName),
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
      };
    });
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
  // Register Service Worker for PWA (Disabilitado no localhost dev; Ativo em produção)
  if ('serviceWorker' in navigator) {
    const isLocalhost = Boolean(
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]'
    );

    if (isLocalhost) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        for (const registration of registrations) {
          registration.unregister().then(success => {
            if (success) console.log('[SW LOCAL] Service Worker desregistrado com sucesso para localhost');
          });
        }
      }).catch(err => console.warn('[SW LOCAL] Erro ao desregistrar Service Worker:', err));

      if ('caches' in window) {
        caches.keys().then(cacheNames => {
          return Promise.all(
            cacheNames.map(cacheName => {
              console.log('[SW LOCAL] Apagando Cache Storage local:', cacheName);
              return caches.delete(cacheName);
            })
          );
        }).catch(err => console.warn('[SW LOCAL] Erro ao apagar Cache Storage:', err));
      }
    } else {
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
  const authRes = await checkAdminSession();
  if (!authRes || authRes.status === 'no_session') {
    // CENÁRIO A: Primeiro acesso / Sem sessão -> Exibir tela de login sem toast de expiração
    showLoginViewOnly();
    return;
  }
  if (authRes.status === 'expired') {
    // CENÁRIO B: Sessão anterior expirada/inválida -> Exibir toast de expiração
    handleInvalidSession("Sua sessão expirou. Faça login novamente.");
    return;
  }

  // 2. CENÁRIO C: Sessão Ativa & Válida -> Carregar painel
  const authState = authRes;
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
    usernameInput.placeholder = 'admin / admin2 / e-mail';
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
  const adminAliases = new Set([
    'adm',
    'admin',
    'admin1',
    'admin@dahoraexpresso.com.br',
    'admin@dahora.local'
  ]);

  if (adminAliases.has(loginInput)) {
    emailToAuth = 'admin1@dahoraexpresso.com.br';
  } else if (loginInput === 'admin2') {
    emailToAuth = 'admin2@dahoraexpresso.com.br';
  }

  const authPassword = passwordInput;

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: emailToAuth,
      password: authPassword
    });

    if (error || !data.session) {
      if (loader) loader.classList.add('hidden');
      alert('Usuário ou senha incorretos.');
      return;
    }

    currentAdminProfile = null;
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
  document.getElementById('user-display-sub').innerText = (currentAdminProfile && currentAdminProfile.admin_code)
    ? `${currentAdminProfile.admin_code} ¢ ${currentAdminProfile.role === 'owner' ? 'Dono & CEO' : currentAdminProfile.role}`
    : (currentAdminProfile ? currentAdminProfile.role : creds.role);

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
    if (profile === 'owner' && !adminClientViewContext) {
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

    const savedTab = localStorage.getItem('activeDashboardTab') || '';
    const isValidOwnerTab = savedTab && savedTab.startsWith('owner-');
    const targetTab = isValidOwnerTab ? savedTab : 'owner-overview';
    switchDashboardTab(targetTab);
  } else if (profile === 'client') {
    document.getElementById('display-role').innerText = 'Painel do Cliente';
    document.getElementById('nav-client-group').classList.remove('hidden');
    document.getElementById('dashboard-title').innerText = 'Painel do Cliente Parceiro';

    const savedTab = localStorage.getItem('activeDashboardTab') || '';
    const isValidClientTab = savedTab && (savedTab.startsWith('client-') || savedTab === 'order-tracking');
    const targetTab = isValidClientTab ? savedTab : 'client-overview';
    switchDashboardTab(targetTab);
  }
}

function closeTransientOwnerPanels() {
  if (typeof closeRiderActions === 'function') closeRiderActions();
  if (typeof closeEditRider === 'function') closeEditRider();
  if (typeof closeRiderCredentialsModal === 'function') closeRiderCredentialsModal();
  if (typeof closeRiderSettlementDrawer === 'function') closeRiderSettlementDrawer();
  if (typeof closeQuickActionDrawer === 'function') closeQuickActionDrawer();
  document.querySelectorAll('.comm-actions-dropdown').forEach(el => el.remove());
  const notifPanel = document.getElementById('notification-panel');
  if (notifPanel) notifPanel.classList.add('hidden');
}

async function handleLogout() {
  closeTransientOwnerPanels();
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
  if (ownerFab) {
    ownerFab.classList.add('hidden');
    ownerFab.style.display = 'none';
  }

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

function updateOwnerFabVisibility(targetTab) {
  const ownerFab = document.getElementById('owner-fab-btn');
  if (!ownerFab) return;

  const currentTab = targetTab || document.querySelector('.nav-item.active')?.getAttribute('data-tab') || localStorage.getItem('activeDashboardTab') || '';
  const isTelesTab = (currentTab === 'owner-teles');

  const role = String(currentAdminProfile?.role || mockData?.activeProfile || '').trim().toLowerCase();
  const isClientUser = (role === 'client' || role === 'client_user' || localStorage.getItem('loggedInProfile') === 'client');

  if (isTelesTab && !isClientUser) {
    ownerFab.classList.remove('hidden');
    ownerFab.style.display = 'flex';
  } else {
    ownerFab.classList.add('hidden');
    ownerFab.style.display = 'none';
  }
}

async function switchDashboardTab(targetTab) {
  if (!targetTab) return;
  if (typeof showView === 'function') showView('view-dashboard');

  const originalRequestedTab = targetTab;

  const userRole = (currentAdminProfile?.role || '').trim().toLowerCase();
  const isClientUser = (userRole === 'client_user' || userRole === 'client' || mockData.activeProfile === 'client' || !!adminClientViewContext);

  if (isClientUser && targetTab.startsWith('owner-')) {
    targetTab = 'client-overview';
  } else if (!isClientUser && targetTab.startsWith('client-') && targetTab !== 'client-profile') {
    targetTab = 'owner-overview';
  }

  // Mapeamento autoritativo de aliases do painel do cliente para os IDs reais do DOM e inicializadores
  if (targetTab === 'client-request-delivery') {
    targetTab = 'order-request';
  } else if (targetTab === 'client-deliveries') {
    targetTab = 'client-teles';
  } else if (targetTab === 'client-financials') {
    targetTab = 'client-financials';
  } else if (targetTab === 'client-extract') {
    targetTab = 'client-extract';
  } else if (targetTab === 'client-profile') {
    targetTab = 'client-profile';
  }

  localStorage.setItem('activeDashboardTab', targetTab);

  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });

  const navItem = document.querySelector(`.nav-item[data-tab="${originalRequestedTab}"]`) || document.querySelector(`.nav-item[data-tab="${targetTab}"]`);
  if (navItem) {
    navItem.classList.add('active');
  }

  // Update Main Dashboard Views
  document.querySelectorAll('.dashboard-tab-content').forEach(view => {
    view.classList.remove('active');
    view.classList.add('hidden');
  });

  const targetTabId = targetTab === 'client-deliveries' ? 'client-teles' : targetTab;
  const activeTabEl = document.getElementById(`tab-${targetTabId}`);
  if (activeTabEl) {
    activeTabEl.classList.add('active');
    activeTabEl.classList.remove('hidden');
  }

  updateOwnerFabVisibility(targetTab);

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
    if (typeof initOperationsRealtimeChannel === 'function') {
      initOperationsRealtimeChannel();
    }
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
  } else if (targetTab === 'owner-commercial-clients' || targetTab === 'owner-commercial') {
    await loadCommercialClientsModule();
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
      clientActionCards.classList.remove('hidden');
    }
    await fetchClientHistory();
    loadClientOverviewDashboard();
  } else if (targetTab === 'client-financials') {
    await loadClientFinancialsData();
  } else if (targetTab === 'client-extract') {
    await loadClientExtractData();
  } else if (targetTab === 'client-fleet-map') {
    await fetchFleet();
    initClientFleetMap();
  } else if (targetTab === 'client-history') {
    await fetchClientHistory();
    renderClientHistoryTable();
  } else if (targetTab === 'client-ratings') {
    renderClientRatings();
  } else if (targetTab === 'client-profile') {
    await loadClientProfilePage();
  } else if (targetTab === 'client-teles' || targetTab === 'client-deliveries') {
    await loadClientDeliveries();
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
      if (typeof initClientOrderSummaryListeners === 'function') {
        initClientOrderSummaryListeners();
      }
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
  updateOwnerFabVisibility('owner-teles');
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
    const statusDetails = getRiderStatusDetails(rider.status);
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
            <strong>${escapeHtml(rider.name || 'Motoboy')}</strong>
            <p class="text-muted text-xs">${getRiderDisplayCode(rider.motoboy_code) ? `Cód: ${escapeHtml(getRiderDisplayCode(rider.motoboy_code))}` : '—'}</p>
          </div>
        </div>
      </td>

      <td>
        <strong>${escapeHtml(rider.vehicle)}</strong>
        <p class="text-muted">${escapeHtml(rider.plate)}</p>
      </td>
      <td><span class="status-indicator ${statusDetails.statusClass}">${escapeHtml(statusDetails.label)}</span></td>
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

function isUuidString(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
}

function formatOrderIdForDisplay(teleCode, fallbackObj) {
  const extractValidCode = (val) => {
    if (!val) return null;
    const s = String(val).trim();
    if (!s || isUuidString(s)) return null;
    return s;
  };

  let candidate = extractValidCode(teleCode);

  if (!candidate && fallbackObj) {
    if (typeof fallbackObj === 'string') {
      candidate = extractValidCode(fallbackObj);
    } else if (typeof fallbackObj === 'object') {
      candidate = extractValidCode(fallbackObj.tele_code) ||
                  extractValidCode(fallbackObj.teleCode) ||
                  extractValidCode(fallbackObj.code);
    }
  }

  if (candidate) {
    if (candidate.startsWith('TEL-')) return candidate;
    return 'TEL-' + candidate.replace(/^#/, '');
  }

  return 'Código indisponível';
}

function formatRiderOptionLabel(rider) {
  if (!rider) return '';
  const statusNorm = String(rider.status || '').toLowerCase();
  const isOnline = rider.status === 'Disponível' || rider.status === 'disponivel' || statusNorm === 'disponivel' || rider.status === 'Em Atendimento' || rider.status === 'A caminho da coleta';
  const displayStatus = isOnline ? 'Disponível' : (rider.status || 'Indisponível');
  return `${escapeHtml(rider.name)} — ${escapeHtml(displayStatus)}`;
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
  if (typeof fetchAdminRiderWeeklySettlements === 'function') {
    fetchAdminRiderWeeklySettlements(true);
  }
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
          <strong>${escapeHtml(rider.name || 'Motoboy')}</strong>
          <p class="text-muted">${getRiderDisplayCode(rider.motoboy_code) ? escapeHtml(getRiderDisplayCode(rider.motoboy_code)) : '—'}</p>
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
  const estimateBox = document.getElementById(`${type}-estimate-box`);
  if (!estimateBox) return;

  const addressInput = document.getElementById(`${type}-delivery-address`)?.value || '';

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

  // Update UI values
  const estDistEl = document.getElementById(`${type}-est-distance`);
  const estTimeEl = document.getElementById(`${type}-est-time`);
  const estPriceEl = document.getElementById(`${type}-est-price`);

  if (estDistEl) estDistEl.innerText = distance + ' km';
  if (estTimeEl) estTimeEl.innerText = minutes + ' min';
  if (estPriceEl) estPriceEl.innerText = priceText;

  estimateBox.classList.remove('hidden');
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
  const num = Number(value) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
const formatCurrency = formatCurrencyBR;
window.formatCurrency = formatCurrencyBR;
window.formatCurrencyBR = formatCurrencyBR;

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

function destroyOwnerFinancialChart() {
  if (ownerFinancialChart) {
    try { ownerFinancialChart.destroy(); } catch (e) {}
    ownerFinancialChart = null;
  }
  if (window.ownerFinancialChart) {
    try { if (window.ownerFinancialChart !== ownerFinancialChart) window.ownerFinancialChart.destroy(); } catch (e) {}
    window.ownerFinancialChart = null;
  }
}

// Chart 2: Owner Financials doughnut
function initOwnerFinancialChart() {
  const ctx = document.getElementById('ownerFinancialChart');
  if (!ctx) return;

  destroyOwnerFinancialChart();

  const existingChart = typeof Chart !== 'undefined' && Chart.getChart ? Chart.getChart(ctx) : null;
  if (existingChart) {
    try { existingChart.destroy(); } catch (e) {}
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

  window.ownerFinancialChart = ownerFinancialChart;
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


window.getRiderStatusDetails = function(status) {
  const rawStr = String(status || '').trim();
  const norm = rawStr
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

  if (norm.includes('indisponivel') || norm.includes('descanso') || norm.includes('offline') || norm.includes('desconectado')) {
    return {
      statusClass: 'status-neutral',
      color: '#8e8e9f',
      label: norm.includes('descanso') ? 'Em Descanso' : 'Indisponível',
      isPulsing: false,
      isUnavailable: true
    };
  }

  if (norm === 'disponivel' || norm === 'ativo' || norm === 'online') {
    return {
      statusClass: 'status-success',
      color: '#22c55e',
      label: 'Disponível',
      isPulsing: true,
      isUnavailable: false
    };
  }

  if (norm.includes('rota') || norm.includes('coleta') || norm.includes('entrega')) {
    return {
      statusClass: 'status-progress',
      color: '#ffb700',
      label: rawStr || 'Em Rota',
      isPulsing: true,
      isUnavailable: false
    };
  }

  // Inativo / Suspenso / Bloqueado
  return {
    statusClass: 'status-danger',
    color: '#ef4444',
    label: rawStr || 'Inativo',
    isPulsing: false,
    isUnavailable: true
  };
};

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

  // Filtrar motoboys com coordenadas válidas (jamais criar marcadores em posições fictícias)
  const validRiders = (mockData.fleet || []).filter(rider => {
    return rider.lat !== null &&
           rider.lat !== undefined &&
           !isNaN(parseFloat(rider.lat)) &&
           rider.lng !== null &&
           rider.lng !== undefined &&
           !isNaN(parseFloat(rider.lng));
  });

  const currentRidersIds = new Set(validRiders.map(r => String(r.id)));

  if (activePanelRiderId && !currentRidersIds.has(String(activePanelRiderId))) {
    closeFleetRiderPanel();
  }

  // Remover do mapa marcadores de entregadores deletados ou sem coordenadas válidas (usando rider.id)
  Object.keys(ownerFleetMarkers).forEach(riderId => {
    if (!currentRidersIds.has(String(riderId))) {
      if (ownerFleetMarkers[riderId] && ownerFleetMarkers[riderId].setMap) {
        ownerFleetMarkers[riderId].setMap(null);
      }
      delete ownerFleetMarkers[riderId];
    }
  });

  validRiders.forEach(rider => {
    const riderId = String(rider.id);
    const statusDetails = getRiderStatusDetails(rider.status);
    const currentStatusColor = statusDetails.color;
    const isPulsing = statusDetails.isPulsing;

    const riderCoords = [parseFloat(rider.lat), parseFloat(rider.lng)];
    const markerHtml = `
      <div class="custom-map-marker" style="background-color: ${currentStatusColor}; box-shadow: 0 0 10px ${currentStatusColor}; width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative; cursor: pointer;">
        ${isPulsing ? `<div class="marker-pulse" style="border-color: ${currentStatusColor}; position: absolute; top: -5px; left: -5px; width: 24px; height: 24px; border: 2px solid ${currentStatusColor}; border-radius: 50%; animation: pulse-dot-anim 2.5s infinite;"></div>` : ''}
        <i class="marker-icon-dot" style="background-color: #fff; width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
      </div>
    `;

    const riderLatLng = new window.google.maps.LatLng(riderCoords[0], riderCoords[1]);

    let markerEntry = ownerFleetMarkers[riderId];
    if (markerEntry) {
      markerEntry.setLatLng(riderLatLng);
      if (typeof markerEntry.setContent === 'function') {
        markerEntry.setContent(markerHtml);
      } else if (markerEntry.div) {
        markerEntry.div.innerHTML = markerHtml;
      }
    } else {
      const marker = new window.CustomHTMLMapMarker(riderLatLng, ownerFleetMap, markerHtml, () => {
        window.openRiderMapPopup(rider.id);
      });
      ownerFleetMarkers[riderId] = marker;
    }

    if (selectedMapRiderId === rider.id) {
      ownerFleetMap.setCenter(riderLatLng);
      ownerFleetMap.setZoom(16);
      setTimeout(() => window.openRiderMapPopup(rider.id), 150);
      selectedMapRiderId = null; // reset to avoid locking view
    }
  });
}

window.openRiderMapPopup = function(riderId) {
  const rider = mockData.fleet.find(r => String(r.id) === String(riderId));
  if (!rider) return;

  const statusDetails = getRiderStatusDetails(rider.status);

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
        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255, 255, 255, 0.05); padding: 4px 6px; border-radius: 4px; margin-bottom: 4px;">
          <div style="font-size: 0.75rem; color: #fff;">
            <strong>${t.id}</strong> ¢ ${t.destName || 'Cliente'} (${t.price})
          </div>
          <button onclick="window.removeTeleFromRiderFromPopup('${t.id}', '${rider.id}')" style="background: rgba(239, 68, 68, 0.15); border: none; color: #ef4444; border-radius: 4px; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;" title="Desvincular Tele">
            <i data-lucide="trash-2" style="width: 11px; height: 11px;"></i>
          </button>
        </div>
      `;
    });
  } else {
    assignedHtml = `<p style="margin: 0; font-size: 0.75rem; color: #8e8e9f; font-style: italic;">Nenhuma tele atribuída</p>`;
  }

  const htmlContent = `
    <div style="padding: 8px 10px; min-width: 210px; max-width: 240px; font-family: sans-serif; color: #fff; box-sizing: border-box;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 4px; margin-bottom: 8px; padding-right: 20px;">
        <h4 style="margin: 0; font-size: 0.88rem; font-weight: 700; color: #fff;">${escapeHtml(rider.name)}</h4>
        <span class="status-indicator ${statusDetails.statusClass}" style="padding: 2px 6px; border-radius: 10px; font-size: 0.7rem; font-weight: 600; flex-shrink: 0; margin-left: 6px;">
          ${escapeHtml(statusDetails.label)}
        </span>
      </div>

      <div style="margin-bottom: 8px;">
        <label style="display: block; font-size: 0.72rem; color: #8e8e9f; margin-bottom: 3px;">Vincular Nova Tele</label>
        <div style="display: flex; gap: 4px; align-items: center;">
          <select id="popup-select-${rider.id}" style="flex: 1; background: #121216; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 4px; color: #fff; font-size: 0.76rem; padding: 2px 6px; outline: none; height: 28px; box-sizing: border-box;">
            ${pendingOptions}
          </select>
          <button onclick="window.dispatchDeliveryFromPopup('${rider.id}', 'popup-select-${rider.id}')" style="background: #ffb700; border: none; border-radius: 4px; color: #000; font-size: 0.76rem; font-weight: 700; padding: 0 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; height: 28px; box-sizing: border-box; flex-shrink: 0; transition: all 0.2s;">
            Adicionar
          </button>
        </div>
      </div>

      <div>
        <label style="display: block; font-size: 0.72rem; color: #8e8e9f; margin-bottom: 4px;">Teles Atribuídas (${assignedTeles.length})</label>
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

window.activeRouteMaps = window.activeRouteMaps || {};

let currentTeleSortOrder = 'desc'; // 'desc' (mais recentes primeiro) | 'asc' (mais antigas primeiro)

window.toggleTeleSortOrder = function() {
  currentTeleSortOrder = (currentTeleSortOrder === 'desc') ? 'asc' : 'desc';
  if (typeof window.renderTelesUnified === 'function') window.renderTelesUnified();
  if (typeof window.renderClientTelesUnified === 'function') window.renderClientTelesUnified();
};

function getTeleTimestamp(item) {
  if (!item) return 0;
  const raw = item.created_at || item.date;
  if (!raw) return 0;
  const d = new Date(raw);
  const time = d.getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Unified Teles Render Engine
window.renderTelesUnified = function() {
  const container = document.getElementById('teles-content-container');
  if (!container) return;

  window.activeRouteMaps = {};

  const isPendingStatus = (st) => {
    if (!st) return false;
    const s = String(st).toLowerCase();
    return s === 'solicitada' || s === 'solicitado' || s === 'criada' || s === 'novo' || s === 'aguardando_despacho';
  };

  const pendingCount = mockData.pendingDeliveries.length;
  const isTerminalStatus = (st) => {
    if (!st) return false;
    const s = String(st).toLowerCase();
    return s === 'concluida' || s === 'concluido' || s === 'entregue';
  };

  const isCanceledStatus = (st) => {
    if (!st) return false;
    const s = String(st).toLowerCase();
    return s === 'cancelada' || s === 'cancelado';
  };

  const historyNonPending = mockData.clientHistory.filter(o => !isPendingStatus(o.status));
  const activeCount = historyNonPending.filter(o => !isTerminalStatus(o.status) && !isCanceledStatus(o.status)).length;
  const completedCount = historyNonPending.filter(o => isTerminalStatus(o.status)).length;
  const canceledCount = historyNonPending.filter(o => isCanceledStatus(o.status)).length;
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

    const assignedRider = d.motoboy_id ? mockData.fleet.find(r => r.id === d.motoboy_id || String(r.id) === String(d.motoboy_id)) : null;
    const riderDisplayName = assignedRider ? assignedRider.name : (d.rider && d.rider !== 'Aguardando...' ? d.rider : 'Aguardando...');

    return {
      id: d.id,
      tele_code: d.tele_code || null,
      type: 'pending',
      client: d.client || 'Cliente não vinculado',
      destName: d.destName,
      address: d.address,
      dest_lat: d.dest_lat,
      dest_lng: d.dest_lng,
      motoboy_id: d.motoboy_id || null,
      dist: d.dist || '—',
      price: priceFormatted,
      payment: d.payment || 'A combinar',
      cargo: d.cargo || 'Pedido',
      repasseMotoboy: repasseFormatted,
      rider: riderDisplayName,
      riderId: assignedRider ? assignedRider.id : null,
      date: 'Hoje, Agora',
      created_at: d.created_at,
      status: 'Pendente',
      statusClass: 'status-warning'
    };
  });

  const historyItems = historyNonPending.map(o => {
    let type = 'active';
    if (isTerminalStatus(o.status)) type = 'completed';
    else if (isCanceledStatus(o.status)) type = 'canceled';

    const fixedPrice = getFixedPriceByAddress(o.address);
    const priceFormatted = `R$ ${fixedPrice.toFixed(2).replace('.', ',')}`;
    const repasseFormatted = `R$ ${(fixedPrice * 0.9).toFixed(2).replace('.', ',')}`;

    const assignedRider = o.motoboy_id ? mockData.fleet.find(r => r.id === o.motoboy_id || String(r.id) === String(o.motoboy_id)) : null;
    const riderDisplayName = assignedRider ? assignedRider.name : (o.rider && o.rider !== 'Aguardando Despacho' ? o.rider : (o.motoboy_id ? 'Motoboy Vinculado' : 'Aguardando Despacho'));

    return {
      id: o.id,
      tele_code: o.tele_code || null,
      type: type,
      client: o.client || 'Cliente não vinculado',
      destName: o.destName,
      address: o.address,
      dest_lat: o.dest_lat,
      dest_lng: o.dest_lng,
      motoboy_id: o.motoboy_id,
      dist: o.dist || '—',
      price: priceFormatted,
      payment: o.payment || 'Pago',
      cargo: o.cargo || 'Pedido',
      repasseMotoboy: repasseFormatted,
      rider: riderDisplayName,
      riderId: assignedRider ? assignedRider.id : null,
      date: o.date,
      created_at: o.created_at,
      status: isTerminalStatus(o.status) ? 'Concluída' : (isCanceledStatus(o.status) ? 'Cancelada' : o.status),
      statusClass: o.statusClass || (isTerminalStatus(o.status) ? 'status-success' : (isCanceledStatus(o.status) ? 'status-danger' : 'status-progress'))
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

  // Sort by real canonical timestamp (created_at)
  filteredList.sort((a, b) => {
    const timeA = getTeleTimestamp(a);
    const timeB = getTeleTimestamp(b);
    if (timeA !== timeB) {
      return currentTeleSortOrder === 'desc' ? (timeB - timeA) : (timeA - timeB);
    }
    const codeA = String(a.tele_code || a.id || '');
    const codeB = String(b.tele_code || b.id || '');
    return currentTeleSortOrder === 'desc' ? codeB.localeCompare(codeA) : codeA.localeCompare(codeB);
  });

  const sortBtnLabel = document.getElementById('sort-order-label');
  if (sortBtnLabel) {
    sortBtnLabel.innerText = currentTeleSortOrder === 'desc' ? 'Recentes â†“' : 'Antigas â†‘';
  }

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
      const selectId = `pending-select-${item.id.replace('#', '')}`;
      const riderOptions = mockData.fleet.map(r => `<option value="${r.id}">${formatRiderOptionLabel(r)}</option>`).join('');

      html += `
        <div class="active-card" style="border: 1px solid rgba(255, 183, 0, 0.2);">
          <div class="active-card-header">
            <strong style="font-family: var(--font-display);">${formatOrderIdForDisplay(item.tele_code, item)}</strong>
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
              <strong>Distância:</strong> ${item.dist.split('|')[0]} ¢
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
            <strong style="font-family: var(--font-display);">${formatOrderIdForDisplay(item.tele_code, item)}</strong>
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
              <strong>Distância:</strong> ${item.dist.split('|')[0]} ¢
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

            ${item.type === 'active' ? `
              <div style="margin-top: 10px;">
                <button class="btn btn-sm" onclick="window.toggleTeleRouteMap('${item.id}')" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; background-color: rgba(255, 183, 0, 0.1); color: var(--primary); border: 1px solid rgba(255, 183, 0, 0.25); width: 100%; justify-content: center;">
                  <i data-lucide="map" style="width: 14px; height: 14px;"></i>
                  <span id="tele-route-btn-text-${item.id.replace(/[^a-zA-Z0-9_-]/g, '')}">Ver Rota no Mapa</span>
                </button>
                <div id="tele-route-map-wrapper-${item.id.replace(/[^a-zA-Z0-9_-]/g, '')}" class="tele-route-map-wrapper hidden" style="margin-top: 10px;">
                  <div id="tele-route-map-${item.id.replace(/[^a-zA-Z0-9_-]/g, '')}" style="width: 100%; height: 180px; border-radius: 8px; border: 1px solid var(--border-color); overflow: hidden; background: var(--bg-card);"></div>
                </div>
              </div>
            ` : ''}
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
            <th onclick="window.toggleTeleSortOrder()" style="cursor: pointer; user-select: none;" title="Clique para alternar ordenação por Data/Hora">
              <div style="display: inline-flex; align-items: center; gap: 6px;">
                <span>Data/Hora</span>
                <span style="font-size: 0.78rem; padding: 2px 6px; background: rgba(255, 185, 0, 0.15); color: var(--primary); border-radius: 4px; border: 1px solid rgba(255, 185, 0, 0.3);">
                  ${currentTeleSortOrder === 'desc' ? 'â†“ Recentes' : 'â†‘ Antigas'}
                </span>
              </div>
            </th>
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
      const riderOptions = mockData.fleet.map(r => `<option value="${r.id}">${formatRiderOptionLabel(r)}</option>`).join('');
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
      const riderOptions = mockData.fleet.map(r => {
        const isSelected = (item.motoboy_id && String(r.id) === String(item.motoboy_id)) || (r.name && r.name === item.rider);
        return `<option value="${r.id}" ${isSelected ? 'selected' : ''}>${formatRiderOptionLabel(r)}</option>`;
      }).join('');
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
        <td><strong>${formatOrderIdForDisplay(item.tele_code, item)}</strong></td>
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
  const newRider = mockData.fleet.find(r => r.id === newRiderId || String(r.id) === String(newRiderId));
  if (!newRider) return;

  const order = mockData.clientHistory.find(o => o.id === deliveryId || o.raw_id === deliveryId || o.tele_code === deliveryId) ||
                mockData.pendingDeliveries.find(o => o.id === deliveryId || o.raw_id === deliveryId || o.tele_code === deliveryId);
  if (!order) return;

  const targetUuid = (order && order.raw_id) ? order.raw_id : deliveryId;
  const displayCode = order ? (order.tele_code || order.id) : deliveryId;

  if (confirm(`Deseja alterar o motoboy da tele ${displayCode} para ${newRider.name}?`)) {
    if (supabaseClient) {
      let rpcSuccess = false;
      try {
        const { data: rpcRes, error: rpcErr } = await supabaseClient.rpc('assign_rider_to_tele', {
          p_tele_id: targetUuid,
          p_motoboy_id: newRider.id,
          p_expected_version: (order && order.version) ? order.version : 1,
          p_reassignment_reason: 'Reatribuição operacional pelo Admin'
        });
        if (!rpcErr && rpcRes && rpcRes.success) {
          rpcSuccess = true;
        }
      } catch (e) {
        console.warn('Fallback para update direto na reatribuição:', e);
      }

      if (!rpcSuccess) {
        const oldRider = mockData.fleet.find(r => r.name === oldRiderName);
        if (oldRider) {
          await supabaseClient
            .from('fleet')
            .update({ status: 'Disponível', status_class: 'status-success', delivery: 'Nenhuma' })
            .eq('id', oldRider.id);
        }

        await supabaseClient
          .from('fleet')
          .update({ status: order.status || 'Em entrega', status_class: order.statusClass || 'status-progress', delivery: displayCode })
          .eq('id', newRider.id);

        await supabaseClient
          .from('teles')
          .update({ motoboy_id: newRider.id, updated_at: new Date().toISOString() })
          .eq('id', targetUuid);
      }
    }

    await loadTelesManagement();
    showToastNotification(`Tele ${displayCode} reatribuída para ${newRider.name}.`);
  } else {
    renderTelesUnified();
  }
};

window.handleCancelTeleClick = async function(deliveryId, riderName, type) {
  if (!confirm(`Deseja realmente cancelar a tele ${deliveryId}?`)) return;

  const tele = mockData.clientHistory.find(item => item.id === deliveryId || item.raw_id === deliveryId || item.tele_code === deliveryId) ||
               mockData.pendingDeliveries.find(item => item.id === deliveryId || item.raw_id === deliveryId || item.tele_code === deliveryId);
  const targetUuid = (tele && tele.raw_id) ? tele.raw_id : deliveryId;
  const expectedVersion = (tele && tele.version) ? tele.version : 1;

  if (supabaseClient) {
    let rpcSuccess = false;
    try {
      const { data: rpcRes, error: rpcErr } = await supabaseClient.rpc('cancel_tele', {
        p_tele_id: targetUuid,
        p_expected_version: expectedVersion,
        p_reason: 'Cancelado pelo painel admin'
      });
      if (!rpcErr && rpcRes && rpcRes.success) {
        rpcSuccess = true;
      }
    } catch (e) {
      console.warn("RPC cancel_tele indisponível, realizando atualização direta de status:", e);
    }

    if (!rpcSuccess) {
      const { error: updateErr } = await supabaseClient
        .from('teles')
        .update({
          status: 'cancelada',
          cancelled_at: new Date().toISOString(),
          cancellation_reason: 'Cancelado pelo painel admin',
          updated_at: new Date().toISOString()
        })
        .eq('id', targetUuid);

      if (updateErr) {
        console.error('Erro ao cancelar tele:', updateErr);
        alert('Erro ao cancelar tele: ' + updateErr.message);
        return;
      }
    }

    if (riderName && riderName !== 'Nenhum' && riderName !== 'Aguardando...') {
      const rider = mockData.fleet.find(r => r.name === riderName || r.id === riderName);
      if (rider) {
        const remainingOrders = getActiveOrdersForRider(rider).filter(item => item.id !== deliveryId && item.raw_id !== targetUuid);
        if (remainingOrders.length === 0) {
          await supabaseClient
            .from('fleet')
            .update({ status: 'Disponível', status_class: 'status-success', delivery: 'Nenhuma' })
            .eq('id', rider.id);
        }
      }
    }
  }

  await loadTelesManagement();
  showToastNotification(`Tele ${deliveryId} cancelada com sucesso.`);
};

window.toggleTeleRouteMap = async function(deliveryId) {
  const safeId = String(deliveryId).replace(/[^a-zA-Z0-9_-]/g, '');
  const container = document.getElementById(`tele-route-map-wrapper-${safeId}`);
  if (!container) return;

  const isHidden = container.classList.contains('hidden');
  if (!isHidden) {
    container.classList.add('hidden');
    const btnText = document.getElementById(`tele-route-btn-text-${safeId}`);
    if (btnText) btnText.innerText = 'Ver Rota no Mapa';
    return;
  }

  container.classList.remove('hidden');
  const btnText = document.getElementById(`tele-route-btn-text-${safeId}`);
  if (btnText) btnText.innerText = 'Ocultar Mapa';

  const mapDiv = document.getElementById(`tele-route-map-${safeId}`);
  if (!mapDiv) return;

  const tele = mockData.clientHistory.find(item => item.id === deliveryId || item.raw_id === deliveryId || item.tele_code === deliveryId) ||
               mockData.pendingDeliveries.find(item => item.id === deliveryId || item.raw_id === deliveryId || item.tele_code === deliveryId);

  const rider = tele ? mockData.fleet.find(r => (tele.motoboy_id && String(r.id) === String(tele.motoboy_id)) || (tele.rider && r.name === tele.rider)) : null;

  const riderLat = rider ? Number(rider.lat) : null;
  const riderLng = rider ? Number(rider.lng) : null;
  const destLat = tele && tele.dest_lat != null ? Number(tele.dest_lat) : null;
  const destLng = tele && tele.dest_lng != null ? Number(tele.dest_lng) : null;

  const isValidRiderGps = riderLat !== null && !isNaN(riderLat) && riderLng !== null && !isNaN(riderLng) && (riderLat !== 0 || riderLng !== 0);
  const isValidDestGps = destLat !== null && !isNaN(destLat) && destLng !== null && !isNaN(destLng) && (destLat !== 0 || destLng !== 0);

  if (!isValidRiderGps || !isValidDestGps) {
    mapDiv.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; background:rgba(255,255,255,0.02); border-radius:8px; padding:16px; gap:8px;"><i data-lucide="map-pin-off" style="width:16px;height:16px;"></i><span>Rota indisponível</span></div>`;
    lucide.createIcons();
    return;
  }

  try {
    const maps = await loadGoogleMapsApi();
    if (!maps || !window.google?.maps) {
      mapDiv.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; background:rgba(255,255,255,0.02); border-radius:8px;">Rota indisponível</div>`;
      return;
    }

    const riderLatLng = new window.google.maps.LatLng(riderLat, riderLng);
    const destLatLng = new window.google.maps.LatLng(destLat, destLng);

    if (!window.activeRouteMaps[safeId]) {
      const mapOptions = {
        zoom: 13,
        center: riderLatLng,
        disableDefaultUI: true,
        zoomControl: true,
        mapTypeId: window.google.maps.MapTypeId.ROADMAP,
        styles: [
          { elementType: 'geometry', stylers: [{ color: '#212121' }] },
          { elementType: 'labels.text.stroke', stylers: [{ color: '#212121' }] },
          { elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
          { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c2c2c' }] },
          { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3c3c3c' }] },
          { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#000000' }] }
        ]
      };

      const map = new window.google.maps.Map(mapDiv, mapOptions);

      const directionsService = new window.google.maps.DirectionsService();
      const directionsRenderer = new window.google.maps.DirectionsRenderer({
        map: map,
        suppressMarkers: false,
        polylineOptions: {
          strokeColor: '#ffb700',
          strokeOpacity: 0.9,
          strokeWeight: 5
        }
      });

      window.activeRouteMaps[safeId] = { map, directionsService, directionsRenderer };

      directionsService.route({
        origin: riderLatLng,
        destination: destLatLng,
        travelMode: window.google.maps.TravelMode.DRIVING
      }, (result, status) => {
        if (status === 'OK' && result) {
          directionsRenderer.setDirections(result);
          if (result.routes && result.routes[0] && result.routes[0].bounds) {
            map.fitBounds(result.routes[0].bounds);
          }
        } else {
          const bounds = new window.google.maps.LatLngBounds();
          bounds.extend(riderLatLng);
          bounds.extend(destLatLng);

          new window.google.maps.Marker({ position: riderLatLng, map, title: 'Motoboy' });
          new window.google.maps.Marker({ position: destLatLng, map, title: 'Destino' });
          new window.google.maps.Polyline({
            path: [riderLatLng, destLatLng],
            map,
            strokeColor: '#ffb700',
            strokeWeight: 4
          });
          map.fitBounds(bounds);
        }
      });
    } else {
      const itemData = window.activeRouteMaps[safeId];
      if (itemData && itemData.map) {
        window.google.maps.event.trigger(itemData.map, 'resize');
        if (itemData.directionsRenderer && itemData.directionsRenderer.getDirections()) {
          const dirs = itemData.directionsRenderer.getDirections();
          if (dirs.routes && dirs.routes[0] && dirs.routes[0].bounds) {
            itemData.map.fitBounds(dirs.routes[0].bounds);
          }
        }
      }
    }
  } catch (err) {
    console.warn('Aviso ao inicializar mapa de rota para tele:', deliveryId, err);
    mapDiv.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-text-muted); font-size:0.82rem; background:rgba(255,255,255,0.02); border-radius:8px;">Rota indisponível</div>`;
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

let activePanelRiderId = null;

window.showFleetRiderPanel = function(rider, mockRider, currentStatus, currentStatusColor) {
  const panel = document.getElementById('fleet-dispatch-panel');
  if (!panel) return;

  activePanelRiderId = mockRider ? mockRider.id : rider.id;

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

  const statusDetails = getRiderStatusDetails(currentStatus);

  panel.innerHTML = `
    <div class="fleet-panel-header">
      <h4>${escapeHtml(rider.name)}</h4>
      <button class="fleet-panel-close-btn" onclick="closeFleetRiderPanel()" title="Fechar">
        <i data-lucide="x"></i>
      </button>
    </div>
    <p class="fleet-panel-subtitle">${escapeHtml(rider.vehicle)} ¢ <strong>${escapeHtml(rider.plate)}</strong></p>
    <span class="status-indicator ${statusDetails.statusClass}">${escapeHtml(statusDetails.label)}</span>
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
  activePanelRiderId = null;
};

window.updatePanelPosition = function() {
  if (!activePanelRiderId || !ownerFleetMap) return;
  const marker = ownerFleetMarkers[activePanelRiderId];
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
  const delivery = mockData.pendingDeliveries.find(d => d.id === deliveryId || d.raw_id === deliveryId || d.tele_code === deliveryId) ||
                   mockData.clientHistory.find(d => d.id === deliveryId || d.raw_id === deliveryId || d.tele_code === deliveryId);

  const rider = mockData.fleet.find(r => r.id === riderId || String(r.id) === String(riderId));
  if (!rider) {
    alert("Selecione um motoboy válido para atribuição.");
    return;
  }

  const statusNorm = String(rider.status || '').toLowerCase();
  const isAvailable = rider.status === 'Disponível' || rider.status === 'disponivel' || statusNorm === 'disponivel';
  const isRestingOrOffline = rider.status === 'Indisponível' || rider.status === 'Em Descanso' || statusNorm === 'indisponivel' || statusNorm === 'em_descanso' || statusNorm === 'offline';
  const isBlockedOrInactive = rider.status === 'Inativo' || rider.status === 'Suspenso' || rider.status === 'Bloqueado' || statusNorm === 'inativo' || statusNorm === 'suspenso' || statusNorm === 'bloqueado';

  if (!isAvailable) {
    if (isRestingOrOffline) {
      alert("Este motoboy está desconectado no PWA. Conecte o aplicativo antes de atribuir a Tele.");
      return;
    }
    if (isBlockedOrInactive) {
      alert("Este motoboy não está disponível para receber Teles.");
      return;
    }
    alert("Este motoboy não está disponível para receber Teles no momento.");
    return;
  }

  const targetUuid = (delivery && delivery.raw_id) ? delivery.raw_id : deliveryId;
  const displayCode = delivery ? (delivery.tele_code || delivery.id) : deliveryId;

  if (supabaseClient) {
    let rpcSuccess = false;
    try {
      const { data: rpcRes, error: rpcErr } = await supabaseClient.rpc('assign_rider_to_tele', {
        p_tele_id: targetUuid,
        p_motoboy_id: rider.id,
        p_expected_version: (delivery && delivery.version) ? delivery.version : 1
      });
      if (!rpcErr && rpcRes && rpcRes.success) {
        rpcSuccess = true;
      }
    } catch (e) {
      console.warn("RPC assign_rider_to_tele indisponível, realizando atribuição direta:", e);
    }

    if (!rpcSuccess) {
      const { error: teleError } = await supabaseClient
        .from('teles')
        .update({
          motoboy_id: rider.id,
          status: 'motoboy_designado',
          updated_at: new Date().toISOString()
        })
        .eq('id', targetUuid);

      if (teleError) {
        console.error("Erro ao atribuir Tele ao motoboy:", teleError);
        alert("Erro ao atribuir Tele ao motoboy: " + teleError.message);
        return;
      }

      await supabaseClient
        .from('fleet')
        .update({
          status: 'Em Atendimento',
          status_class: 'status-progress',
          delivery: displayCode
        })
        .eq('id', rider.id);
    }
  }

  await loadTelesManagement();
  showToastNotification(`Tele ${displayCode} atribuída com sucesso a ${rider.name}.`);
}

// =========================================================================
// GATE RC.13 — REDESIGN OPERACIONAL DA ABA "ENTREGAS" DO PAINEL DO CLIENTE
// =========================================================================

currentClientTeleFilter = 'all'; // 'all', 'pending', 'active', 'completed', 'canceled'
let currentClientTelePeriod = 'this_month'; // 'this_month', 'today', 'this_week', 'all'
let currentClientTeleSearch = '';
let currentClientDeliveriesPage = 1;
window.currentClientDeliveriesPage = currentClientDeliveriesPage;
const CLIENT_DELIVERIES_PAGE_SIZE = 15;
let currentDeliveriesFetchToken = 0;
let clientDeliveriesCache = [];
let clientDeliveriesTotalCount = 0;

// Mapeamento autoral dos 13 status canônicos reais do banco (sem inventar aliases)
function mapClientDeliveryStatus(statusRaw) {
  const norm = String(statusRaw || '').trim().toLowerCase();

  // 1. AGUARDANDO
  if (norm === 'solicitada' || norm === 'aguardando_despacho') {
    return {
      group: 'pending',
      label: norm === 'solicitada' ? 'Solicitada' : 'Aguardando Despacho',
      badgeClass: 'status-warning'
    };
  }

  // 2. EM EXECUÇÃO
  if (['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_rota', 'em_entrega'].includes(norm)) {
    let label = 'Em execução';
    if (norm === 'motoboy_designado') label = 'Motoboy a caminho';
    else if (norm === 'indo_coletar') label = 'Indo coletar';
    else if (norm === 'aguardando_coleta') label = 'Aguardando coleta';
    else if (norm === 'coletada') label = 'Coletada';
    else if (norm === 'em_rota') label = 'Em rota';
    else if (norm === 'em_entrega') label = 'Em entrega';

    return {
      group: 'active',
      label,
      badgeClass: 'status-info'
    };
  }

  // 3. CONCLUÍDAS
  if (['concluido', 'concluida', 'entregue'].includes(norm)) {
    return {
      group: 'completed',
      label: 'Concluída',
      badgeClass: 'status-success'
    };
  }

  // 4. CANCELADAS
  if (['cancelado', 'cancelada'].includes(norm)) {
    return {
      group: 'canceled',
      label: 'Cancelada',
      badgeClass: 'status-danger'
    };
  }

  // UNKNOWN / UNRECOGNIZED STATUS - SAFE NEUTRAL FALLBACK (Log diagnóstico sem forçar em Aguardando)
  console.warn(`[STATUS MAPPER] Status não reconhecido retornado pelo banco: "${statusRaw}"`);
  return {
    group: 'unknown',
    label: statusRaw || 'Desconhecido',
    badgeClass: 'status-neutral'
  };
}

function getStatusArrayForGroup(group) {
  if (group === 'pending') return ['solicitada', 'aguardando_despacho'];
  if (group === 'active') return ['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_rota', 'em_entrega'];
  if (group === 'completed') return ['concluido', 'concluida', 'entregue'];
  if (group === 'canceled') return ['cancelado', 'cancelada'];
  return null;
}

function getPeriodDateRangeISO(periodKey) {
  const now = new Date();
  if (periodKey === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    return { startIso: start.toISOString() };
  }
  if (periodKey === 'this_week') {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const start = new Date(now.getFullYear(), now.getMonth(), diff, 0, 0, 0, 0);
    return { startIso: start.toISOString() };
  }
  if (periodKey === 'this_month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return { startIso: start.toISOString() };
  }
  return { startIso: null };
}

function formatTeleCodeDisplay(teleCodeOrId) {
  if (!teleCodeOrId) return 'TEL-000000';
  const str = String(teleCodeOrId).trim();
  if (str.startsWith('TEL-')) return str;
  if (isUuidString(str)) {
    return `TEL-${str.slice(0, 6).toUpperCase()}`;
  }
  return `TEL-${str}`;
}

async function updateClientDeliveriesSummaryCountsFromBackend(clientId, periodKey) {
  if (!supabaseClient || !clientId) return;

  try {
    const { startIso } = getPeriodDateRangeISO(periodKey || currentClientTelePeriod);

    let query = supabaseClient
      .from('teles')
      .select('status')
      .eq('client_id', clientId);

    if (startIso) {
      query = query.gte('created_at', startIso);
    }

    const { data, error } = await query;

    if (error || !data) return;

    let pending = 0;
    let active = 0;
    let completed = 0;
    let canceled = 0;

    data.forEach(item => {
      const mapped = mapClientDeliveryStatus(item.status);
      if (mapped.group === 'pending') pending++;
      else if (mapped.group === 'active') active++;
      else if (mapped.group === 'completed') completed++;
      else if (mapped.group === 'canceled') canceled++;
    });

    const all = pending + active + completed + canceled;
    updateClientDeliveriesSummaryCounts({ pending, active, completed, canceled, all });
  } catch (e) {
    console.warn("[SUMMARY COUNTS] Erro ao atualizar contadores:", e);
  }
}

function updateClientDeliveriesSummaryCounts(counts) {
  const elAll = document.getElementById('client-count-all');
  const elPending = document.getElementById('client-count-pending');
  const elActive = document.getElementById('client-count-active');
  const elCompleted = document.getElementById('client-count-completed');
  const elCanceled = document.getElementById('client-count-canceled');

  if (elAll) elAll.innerText = counts.all || 0;
  if (elPending) elPending.innerText = counts.pending || 0;
  if (elActive) elActive.innerText = counts.active || 0;
  if (elCompleted) elCompleted.innerText = counts.completed || 0;
  if (elCanceled) elCanceled.innerText = counts.canceled || 0;
}

async function loadClientDeliveries() {
  const container = document.getElementById('client-teles-content-container');
  if (!container) return;

  const fetchToken = ++currentDeliveriesFetchToken;

  // 1. Resolver o client_id autoritativo do contexto ativo
  const activeCtx = resolveActiveClientContext();
  const resolvedClientId = activeCtx ? activeCtx.clientId : null;

  // FAIL CLOSED se o commercial_clients.id não for resolvido
  if (!resolvedClientId) {
    if (fetchToken !== currentDeliveriesFetchToken) return;
    container.innerHTML = `
      <div style="text-align: center; padding: 48px 20px; background-color: var(--bg-card, #1a1a24); border: 1px dashed var(--border-color, #2a2a3a); border-radius: 12px;">
        <i data-lucide="shield-alert" style="width: 48px; height: 48px; color: var(--warning, #f59e0b); margin-bottom: 12px; display: inline-block;"></i>
        <p style="font-weight: 600; font-size: 1.1rem; color: var(--color-text, #fff); margin-bottom: 6px;">Nenhum cliente ativo selecionado</p>
        <p style="font-size: 0.9rem; color: var(--color-text-muted, #8a8a9e);">Selecione um cliente comercial no painel ou faça login como parceiro.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    updateClientDeliveriesSummaryCounts({ pending: 0, active: 0, completed: 0, canceled: 0, all: 0 });
    return;
  }

  // 2. Exibir Skeleton / Loading State
  container.innerHTML = `
    <div style="text-align: center; padding: 48px 20px;">
      <div class="spinner-border text-primary" role="status" style="width: 32px; height: 32px; border-width: 3px; display: inline-block; animation: spin 0.8s linear infinite; border-radius: 50%; border: 3px solid rgba(230, 57, 70, 0.2); border-top-color: var(--primary, #e63946);"></div>
      <p style="font-size: 0.9rem; color: var(--color-text-muted, #8a8a9e); margin-top: 12px;">Carregando entregas...</p>
    </div>
  `;

  try {
    // 3. Atualizar contadores de resumo do backend para TODO o período do cliente
    updateClientDeliveriesSummaryCountsFromBackend(resolvedClientId, currentClientTelePeriod);

    if (!supabaseClient) {
      if (fetchToken !== currentDeliveriesFetchToken) return;
      container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--color-text-muted);">Supabase não conectado.</div>`;
      return;
    }

    // 4. Montar query Supabase autoritativa e paginada
    const statusArray = getStatusArrayForGroup(currentClientTeleFilter);
    const { startIso } = getPeriodDateRangeISO(currentClientTelePeriod);

    const fromIndex = (currentClientDeliveriesPage - 1) * CLIENT_DELIVERIES_PAGE_SIZE;
    const toIndex = fromIndex + CLIENT_DELIVERIES_PAGE_SIZE - 1;

    let query = supabaseClient
      .from('teles')
      .select('id, tele_code, client_id, motoboy_id, status, pickup_address, delivery_address, delivery_reference, recipient_name, recipient_phone, notes, total_order_amount, delivery_charge, payment_method, created_at, updated_at, completed_at, cancelled_at, cancellation_reason, fleet:motoboy_id(name)', { count: 'exact' })
      .eq('client_id', resolvedClientId)
      .order('created_at', { ascending: false });

    if (statusArray && statusArray.length > 0) {
      query = query.in('status', statusArray);
    }

    if (startIso) {
      query = query.gte('created_at', startIso);
    }

    query = query.range(fromIndex, toIndex);

    const { data, count, error } = await query;

    // Proteção contra resposta assíncrona atrasada em troca de contexto (Race Condition Protection)
    if (fetchToken !== currentDeliveriesFetchToken) return;

    if (error) {
      console.error("[DELIVERIES LOADER] Erro na busca Supabase:", error);
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; background-color: var(--bg-card); border: 1px dashed var(--danger); border-radius: 12px; color: var(--danger);">
          <p style="font-weight: 600;">Falha ao carregar entregas</p>
          <p style="font-size: 0.85rem; color: var(--color-text-muted);">${escapeHtml(error.message || 'Erro de conexão.')}</p>
        </div>
      `;
      return;
    }

    clientDeliveriesCache = data || [];
    clientDeliveriesTotalCount = count || 0;

    // 5. Aplicar busca textual se o usuário digitou no campo
    let itemsToDisplay = clientDeliveriesCache;
    if (currentClientTeleSearch) {
      const q = currentClientTeleSearch.trim().toLowerCase();
      itemsToDisplay = itemsToDisplay.filter(item => {
        const code = String(item.tele_code || formatTeleCodeDisplay(item.id)).toLowerCase();
        const dest = String(item.recipient_name || '').toLowerCase();
        const addr = String(item.delivery_address || '').toLowerCase();
        const phone = String(item.recipient_phone || '').toLowerCase();
        return code.includes(q) || dest.includes(q) || addr.includes(q) || phone.includes(q);
      });
    }

    // 6. Renderizar Tabela / Cards / Estado Vazio / Paginação
    renderClientDeliveriesView(itemsToDisplay, clientDeliveriesTotalCount);

  } catch (err) {
    if (fetchToken !== currentDeliveriesFetchToken) return;
    console.error("[DELIVERIES LOADER] Exceção inesperada:", err);
  }
}

function renderClientDeliveriesView(list, totalCount) {
  const container = document.getElementById('client-teles-content-container');
  if (!container) return;

  if (!list || list.length === 0) {
    let emptyMsg = "Não encontramos entregas para os filtros selecionados.";
    if (currentClientTeleFilter === 'all' && currentClientTelePeriod === 'all' && !currentClientTeleSearch) {
      emptyMsg = "Você ainda não possui entregas cadastradas.";
    }

    container.innerHTML = `
      <div style="text-align: center; padding: 48px 20px; background-color: var(--bg-card, #1a1a24); border: 1px dashed var(--border-color, #2a2a3a); border-radius: 12px; color: var(--color-text-muted, #8a8a9e);">
        <i data-lucide="package-open" style="width: 48px; height: 48px; color: var(--color-text-muted, #8a8a9e); margin-bottom: 12px; display: inline-block;"></i>
        <p style="font-weight: 600; font-size: 1.05rem; color: var(--color-text, #fff); margin-bottom: 6px;">Nenhuma entrega encontrada</p>
        <p style="font-size: 0.9rem; margin-bottom: 16px;">${escapeHtml(emptyMsg)}</p>
        <button class="btn btn-outline btn-sm" onclick="switchDashboardTab('client-request-delivery')" style="display: inline-flex; align-items: center; gap: 6px;">
          <i data-lucide="plus-circle" style="width: 14px; height: 14px;"></i> Nova solicitação
        </button>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  const totalPages = Math.ceil(totalCount / CLIENT_DELIVERIES_PAGE_SIZE) || 1;

  let html = `
    <!-- Tabela Desktop -->
    <div class="table-responsive desktop-deliveries-table">
      <table class="compact-table" style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="border-bottom: 1px solid var(--border-color, #2a2a3a); text-align: left;">
            <th style="padding: 12px;">Código</th>
            <th style="padding: 12px;">Data / Hora</th>
            <th style="padding: 12px;">Destino</th>
            <th style="padding: 12px;">Motoboy</th>
            <th style="padding: 12px;">Valor Tele</th>
            <th style="padding: 12px;">Status</th>
            <th style="padding: 12px; text-align: right;">Ações</th>
          </tr>
        </thead>
        <tbody>
  `;

  list.forEach(item => {
    const teleCodeDisplay = formatTeleCodeDisplay(item.tele_code || item.id);
    const dateFormatted = item.created_at ? new Date(item.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const recipient = item.recipient_name ? escapeHtml(item.recipient_name) : '';
    const address = escapeHtml(item.delivery_address || '');
    const destDisplay = recipient ? `<strong>${recipient}</strong><br><span class="text-muted text-xs">${address}</span>` : `<span class="text-xs">${address}</span>`;

    const motoboyName = item.fleet?.name || (item.rider && item.rider !== 'Aguardando Despacho' ? item.rider : null);
    const riderBadge = motoboyName ? `<span class="badge badge-soft" style="background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.3); font-weight: 500;">${escapeHtml(motoboyName)}</span>` : `<span class="text-muted text-xs" style="font-style: italic;">Aguardando motoboy</span>`;

    const statusObj = mapClientDeliveryStatus(item.status);
    const priceFormatted = formatMoneyBR(Number(item.delivery_charge || 0));

    html += `
      <tr style="border-bottom: 1px solid var(--border-color, #1f1f2e);">
        <td style="padding: 12px;"><strong style="font-family: var(--font-display); font-size: 0.9rem; color: var(--color-text, #fff);">${escapeHtml(teleCodeDisplay)}</strong></td>
        <td style="padding: 12px; font-size: 0.85rem; color: var(--color-text-muted, #a0a0b0);">${dateFormatted}</td>
        <td style="padding: 12px; max-width: 280px; font-size: 0.85rem;">${destDisplay}</td>
        <td style="padding: 12px;">${riderBadge}</td>
        <td style="padding: 12px;"><strong style="color: var(--primary, #e63946); font-size: 0.95rem;">${priceFormatted}</strong></td>
        <td style="padding: 12px;"><span class="status-indicator ${statusObj.badgeClass}">${escapeHtml(statusObj.label)}</span></td>
        <td style="padding: 12px; text-align: right;">
          <button class="btn btn-secondary btn-sm" onclick="openClientTeleDetailModal('${item.id}')" style="padding: 4px 10px; font-size: 0.8rem; border-radius: 6px;">
            <i data-lucide="eye" style="width: 13px; height: 13px; margin-right: 4px;"></i> Ver detalhes
          </button>
        </td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>

    <!-- Lista de Cards Mobile -->
    <div class="mobile-deliveries-list" style="display: flex; flex-direction: column; gap: 12px;">
  `;

  list.forEach(item => {
    const teleCodeDisplay = formatTeleCodeDisplay(item.tele_code || item.id);
    const dateFormatted = item.created_at ? new Date(item.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const recipient = item.recipient_name ? escapeHtml(item.recipient_name) : '';
    const address = escapeHtml(item.delivery_address || '');
    const motoboyName = item.fleet?.name || (item.rider && item.rider !== 'Aguardando Despacho' ? item.rider : null);
    const statusObj = mapClientDeliveryStatus(item.status);
    const priceFormatted = formatMoneyBR(Number(item.delivery_charge || 0));

    html += `
      <div class="mobile-tele-card" style="background: var(--bg-card, #1a1a24); border: 1px solid var(--border-color, #2a2a3a); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-family: var(--font-display); font-size: 1rem; color: var(--color-text, #fff);">${escapeHtml(teleCodeDisplay)}</strong>
          <span class="status-indicator ${statusObj.badgeClass}">${escapeHtml(statusObj.label)}</span>
        </div>
        <div style="font-size: 0.85rem; color: var(--color-text-muted, #a0a0b0);">
          <p style="margin: 0 0 4px 0;"><strong>Destino:</strong> ${recipient ? `${recipient} — ` : ''}${address}</p>
          <p style="margin: 0 0 4px 0;"><strong>Horário:</strong> ${dateFormatted}</p>
          <p style="margin: 0 0 4px 0;"><strong>Motoboy:</strong> ${motoboyName ? escapeHtml(motoboyName) : 'Aguardando motoboy'}</p>
          <p style="margin: 0;"><strong>Valor:</strong> <strong style="color: var(--primary, #e63946);">${priceFormatted}</strong></p>
        </div>
        <div style="margin-top: 6px; text-align: right;">
          <button class="btn btn-secondary btn-sm" onclick="openClientTeleDetailModal('${item.id}')" style="width: 100%; justify-content: center; padding: 6px 12px; font-size: 0.82rem; border-radius: 6px;">
            <i data-lucide="eye" style="width: 14px; height: 14px; margin-right: 4px;"></i> Ver detalhes
          </button>
        </div>
      </div>
    `;
  });

  html += `</div>`;

  // Barra de Paginação
  if (totalPages > 1 || totalCount > CLIENT_DELIVERIES_PAGE_SIZE) {
    html += `
      <div class="pagination-bar" style="display: flex; justify-content: space-between; align-items: center; margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border-color, #2a2a3a); flex-wrap: wrap; gap: 12px;">
        <span class="text-muted text-xs">Exibindo ${list.length} de ${totalCount} entregas (Página ${currentClientDeliveriesPage} de ${totalPages})</span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="btn btn-secondary btn-sm" ${currentClientDeliveriesPage <= 1 ? 'disabled' : ''} onclick="changeClientDeliveriesPage(${currentClientDeliveriesPage - 1})" style="padding: 4px 12px; font-size: 0.8rem;">
            Anterior
          </button>
          <span style="font-size: 0.85rem; font-weight: 600; padding: 0 4px;">${currentClientDeliveriesPage}</span>
          <button class="btn btn-secondary btn-sm" ${currentClientDeliveriesPage >= totalPages ? 'disabled' : ''} onclick="changeClientDeliveriesPage(${currentClientDeliveriesPage + 1})" style="padding: 4px 12px; font-size: 0.8rem;">
            Próxima
          </button>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

// Handlers de Filtro e Paginação
window.setClientTeleFilter = function(filter) {
  currentClientTeleFilter = filter;
  currentClientDeliveriesPage = 1;
  window.currentClientDeliveriesPage = 1;
  document.querySelectorAll('.teles-filters .filter-pill').forEach(btn => {
    btn.classList.remove('active');
  });
  const btn = document.getElementById(`client-filter-${filter}`);
  if (btn) btn.classList.add('active');
  loadClientDeliveries();
};

window.setClientTelePeriodFilter = function(period) {
  currentClientTelePeriod = period;
  currentClientDeliveriesPage = 1;
  window.currentClientDeliveriesPage = 1;
  loadClientDeliveries();
};

window.handleClientTeleSearch = function(val) {
  currentClientTeleSearch = val;
  if (clientDeliveriesCache) {
    let itemsToDisplay = clientDeliveriesCache;
    if (currentClientTeleSearch) {
      const q = currentClientTeleSearch.trim().toLowerCase();
      itemsToDisplay = itemsToDisplay.filter(item => {
        const code = String(item.tele_code || formatTeleCodeDisplay(item.id)).toLowerCase();
        const dest = String(item.recipient_name || '').toLowerCase();
        const addr = String(item.delivery_address || '').toLowerCase();
        const phone = String(item.recipient_phone || '').toLowerCase();
        return code.includes(q) || dest.includes(q) || addr.includes(q) || phone.includes(q);
      });
    }
    renderClientDeliveriesView(itemsToDisplay, clientDeliveriesTotalCount);
  }
};

window.changeClientDeliveriesPage = function(newPage) {
  if (newPage < 1) return;
  currentClientDeliveriesPage = newPage;
  window.currentClientDeliveriesPage = newPage;
  loadClientDeliveries();
};

window.renderClientTelesUnified = function() {
  loadClientDeliveries();
};

// Modal / Drawer de Detalhes da Tele (Sem vazamento de percentuais 85/15 ou UUIDs técnicos)
window.openClientTeleDetailModal = function(teleId) {
  const item = (clientDeliveriesCache || []).find(t => String(t.id) === String(teleId));
  if (!item) {
    console.warn("[DETAIL MODAL] Tele não encontrada no cache local:", teleId);
    return;
  }

  let modal = document.getElementById('modal-client-tele-detail');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-client-tele-detail';
    modal.className = 'modal-overlay';
    modal.onclick = (e) => {
      if (e.target === modal) closeClientTeleDetailModal();
    };
    document.body.appendChild(modal);
  }

  const teleCodeDisplay = formatTeleCodeDisplay(item.tele_code || item.id);
  const statusObj = mapClientDeliveryStatus(item.status);
  const priceFormatted = formatMoneyBR(Number(item.delivery_charge || 0));
  const motoboyName = item.fleet?.name || (item.rider && item.rider !== 'Aguardando Despacho' ? item.rider : 'Aguardando motoboy');

  // Timestamps Reais da Timeline (Sem fabricar horários inexistentes)
  const createdDate = item.created_at ? new Date(item.created_at).toLocaleString('pt-BR') : '—';
  const completedDate = item.completed_at ? new Date(item.completed_at).toLocaleString('pt-BR') : null;
  const cancelledDate = item.cancelled_at ? new Date(item.cancelled_at).toLocaleString('pt-BR') : null;

  let timelineHtml = `
    <div style="display: flex; align-items: center; gap: 10px; margin: 16px 0; padding: 12px; background: rgba(255, 255, 255, 0.03); border-radius: 8px;">
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
        <div style="width: 10px; height: 10px; border-radius: 50%; background: #3b82f6;"></div>
        <span style="font-size: 0.75rem; color: var(--color-text-muted);">Solicitada</span>
        <span style="font-size: 0.7rem; color: var(--color-text-muted);">${createdDate}</span>
      </div>
  `;

  if (completedDate) {
    timelineHtml += `
      <div style="flex: 1; height: 2px; background: #10b981;"></div>
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
        <div style="width: 10px; height: 10px; border-radius: 50%; background: #10b981;"></div>
        <span style="font-size: 0.75rem; color: #10b981; font-weight: 600;">Entregue</span>
        <span style="font-size: 0.7rem; color: var(--color-text-muted);">${completedDate}</span>
      </div>
    `;
  } else if (cancelledDate) {
    timelineHtml += `
      <div style="flex: 1; height: 2px; background: #ef4444;"></div>
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
        <div style="width: 10px; height: 10px; border-radius: 50%; background: #ef4444;"></div>
        <span style="font-size: 0.75rem; color: #ef4444; font-weight: 600;">Cancelada</span>
        <span style="font-size: 0.7rem; color: var(--color-text-muted);">${cancelledDate}</span>
      </div>
    `;
  } else {
    timelineHtml += `
      <div style="flex: 1; height: 2px; background: var(--border-color, #2a2a3a);"></div>
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
        <div style="width: 10px; height: 10px; border-radius: 50%; background: var(--color-text-muted);"></div>
        <span style="font-size: 0.75rem; color: var(--color-text-muted);">Em andamento</span>
      </div>
    `;
  }

  timelineHtml += `</div>`;

  modal.innerHTML = `
    <div class="modal-card" style="max-width: 540px; width: 90%; background: var(--bg-card, #1a1a24); border: 1px solid var(--border-color, #2a2a3a); border-radius: 14px; padding: 24px; color: var(--color-text, #fff);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid var(--border-color, #2a2a3a); padding-bottom: 12px;">
        <div>
          <h3 style="margin: 0; font-family: var(--font-display); font-size: 1.3rem;">Detalhes da Entrega</h3>
          <span style="font-size: 0.85rem; color: var(--color-text-muted);">${escapeHtml(teleCodeDisplay)}</span>
        </div>
        <button onclick="closeClientTeleDetailModal()" style="background: transparent; border: none; color: var(--color-text-muted); cursor: pointer; padding: 4px;">
          <i data-lucide="x" style="width: 20px; height: 20px;"></i>
        </button>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <span class="status-indicator ${statusObj.badgeClass}">${escapeHtml(statusObj.label)}</span>
        <strong style="font-size: 1.2rem; color: var(--primary, #e63946);">${priceFormatted}</strong>
      </div>

      ${timelineHtml}

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 0.85rem; margin-top: 16px;">
        <div style="grid-column: span 2; background: rgba(255,255,255,0.02); padding: 10px; border-radius: 6px;">
          <strong style="color: var(--color-text-muted); display: block; margin-bottom: 2px;">Ponto de Retirada (Coleta):</strong>
          <span>${escapeHtml(item.pickup_address || 'Endereço cadastrado do cliente')}</span>
        </div>

        <div style="grid-column: span 2; background: rgba(255,255,255,0.02); padding: 10px; border-radius: 6px;">
          <strong style="color: var(--color-text-muted); display: block; margin-bottom: 2px;">Endereço de Entrega (Destino):</strong>
          <span>${escapeHtml(item.delivery_address || '—')}</span>
          ${item.delivery_reference ? `<br><small class="text-muted">Ref: ${escapeHtml(item.delivery_reference)}</small>` : ''}
        </div>

        <div style="background: rgba(255,255,255,0.02); padding: 10px; border-radius: 6px;">
          <strong style="color: var(--color-text-muted); display: block; margin-bottom: 2px;">Destinatário:</strong>
          <span>${item.recipient_name ? escapeHtml(item.recipient_name) : '—'}</span>
        </div>

        <div style="background: rgba(255,255,255,0.02); padding: 10px; border-radius: 6px;">
          <strong style="color: var(--color-text-muted); display: block; margin-bottom: 2px;">Telefone de Contato:</strong>
          <span>${item.recipient_phone ? escapeHtml(item.recipient_phone) : '—'}</span>
        </div>

        <div style="background: rgba(255,255,255,0.02); padding: 10px; border-radius: 6px;">
          <strong style="color: var(--color-text-muted); display: block; margin-bottom: 2px;">Motoboy Responsável:</strong>
          <span>${escapeHtml(motoboyName)}</span>
        </div>

        <div style="background: rgba(255,255,255,0.02); padding: 10px; border-radius: 6px;">
          <strong style="color: var(--color-text-muted); display: block; margin-bottom: 2px;">Forma de Pagamento:</strong>
          <span>${escapeHtml(item.payment_method || 'Faturado')}</span>
        </div>

        ${item.cargo_type ? `
          <div style="grid-column: span 2; background: rgba(255,255,255,0.02); padding: 10px; border-radius: 6px;">
            <strong style="color: var(--color-text-muted); display: block; margin-bottom: 2px;">Tipo de Mercadoria:</strong>
            <span>${escapeHtml(item.cargo_type)}</span>
          </div>
        ` : ''}

        ${item.notes ? `
          <div style="grid-column: span 2; background: rgba(255,255,255,0.02); padding: 10px; border-radius: 6px;">
            <strong style="color: var(--color-text-muted); display: block; margin-bottom: 2px;">Observações:</strong>
            <span>${escapeHtml(item.notes)}</span>
          </div>
        ` : ''}

        ${item.cancellation_reason ? `
          <div style="grid-column: span 2; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); padding: 10px; border-radius: 6px; color: #ef4444;">
            <strong style="display: block; margin-bottom: 2px;">Motivo do Cancelamento:</strong>
            <span>${escapeHtml(item.cancellation_reason)}</span>
          </div>
        ` : ''}
      </div>

      <div style="margin-top: 20px; text-align: right;">
        <button class="btn btn-secondary btn-sm" onclick="closeClientTeleDetailModal()">Fechar</button>
      </div>
    </div>
  `;

  modal.classList.add('active');
  if (window.lucide) lucide.createIcons({ el: modal });
};

window.closeClientTeleDetailModal = function() {
  const modal = document.getElementById('modal-client-tele-detail');
  if (modal) modal.classList.remove('active');
};

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

window.handleWithdrawClick = async function(deliveryId, currentRiderName) {
  const tele = mockData.clientHistory.find(d => d.id === deliveryId || d.raw_id === deliveryId || d.tele_code === deliveryId) ||
               mockData.pendingDeliveries.find(d => d.id === deliveryId || d.raw_id === deliveryId || d.tele_code === deliveryId);
  const targetUuid = (tele && tele.raw_id) ? tele.raw_id : deliveryId;
  const displayCode = tele ? (tele.tele_code || tele.id) : deliveryId;

  if (!confirm(`Deseja retirar o motoboy da tele ${displayCode} e retornar para Aguardando Despacho?`)) return;

  if (supabaseClient) {
    const { error: teleErr } = await supabaseClient
      .from('teles')
      .update({
        motoboy_id: null,
        status: 'aguardando_despacho',
        updated_at: new Date().toISOString()
      })
      .eq('id', targetUuid);

    if (teleErr) {
      console.error('Erro ao retirar motoboy da tele:', teleErr);
      alert('Erro ao retirar motoboy: ' + teleErr.message);
      return;
    }

    if (tele && tele.motoboy_id) {
      const { data: otherActive } = await supabaseClient
        .from('teles')
        .select('id')
        .eq('motoboy_id', tele.motoboy_id)
        .in('status', ['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega']);

      if (!otherActive || otherActive.length === 0) {
        await supabaseClient
          .from('fleet')
          .update({
            status: 'Disponível',
            status_class: 'status-success',
            delivery: 'Nenhuma'
          })
          .eq('id', tele.motoboy_id);
      }
    }
  }

  await loadTelesManagement();
  showToastNotification(`Motoboy retirado da tele ${displayCode}. Tele retornou para Aguardando Despacho.`);
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
  if (pinEl)  pinEl.innerText = '¢¢¢¢';

  const toggleBtn = document.getElementById('pin-toggle-btn');
  if (toggleBtn) toggleBtn.innerHTML = '<i data-lucide="eye"></i>';

  document.getElementById('modal-credentials').classList.remove('hidden');
  lucide.createIcons();
}

function closeCredentials(event) {
  if (event && event.target !== document.getElementById('modal-credentials')) return;
  _currentCreds = { code: '', name: '', pin: '' };
  _pinVisible = false;
  document.getElementById('modal-credentials').classList.add('hidden');
}

function togglePinVisibility() {
  _pinVisible = !_pinVisible;
  const pinEl = document.getElementById('cred-pin');
  const toggleBtn = document.getElementById('pin-toggle-btn');
  if (pinEl) pinEl.innerText = _pinVisible ? _currentCreds.pin : '¢¢¢¢';
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
  openCredentialCard(getRiderDisplayCode(rider.motoboy_code) || '—', rider.name || 'Motoboy', rider.pin || '(sem PIN)');
}


function getActiveOrdersForRider(rider) {
  if (!rider) return [];
  return mockData.clientHistory.filter(order => order.rider === rider.name && order.status !== 'Entregue' && order.status !== 'Removida');
}

async function deactivateRiderAccount(riderId) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient
      .from('fleet')
      .update({ status: 'Inativo' })
      .eq('id', riderId);
    if (error) throw error;
    await fetchFleet();
    renderFleetTable();
    closeRiderActions();
    showToastNotification('Entregador desativado com sucesso (status alterado para Inativo).');
  } catch (err) {
    console.error('Erro ao desativar motoboy:', err);
    alert('Erro ao desativar entregador: ' + err.message);
  }
}

async function deleteRiderAccountById(riderId) {
  const rider = (mockData.fleet || []).find(r => r.id === riderId);
  if (!rider) return;

  if (supabaseClient) {
    // Audit operational/financial history before allowing delete
    const [{ count: telesCount }, { count: txCount }, { count: consCount }] = await Promise.all([
      supabaseClient.from('teles').select('id', { count: 'exact', head: true }).eq('motoboy_id', riderId),
      supabaseClient.from('rider_financial_transactions').select('id', { count: 'exact', head: true }).eq('rider_id', riderId),
      supabaseClient.from('rider_consumables').select('id', { count: 'exact', head: true }).eq('rider_id', riderId)
    ]);

    const hasHistory = (telesCount || 0) > 0 || (txCount || 0) > 0 || (consCount || 0) > 0;

    if (hasHistory) {
      const msg = `Este motoboy (${rider.name}) possui histórico operacional/financeiro (${telesCount || 0} teles, ${txCount || 0} transações) e não pode ser excluído definitivamente.\n\nDeseja desativar o acesso alterando o status para INATIVO?`;
      if (confirm(msg)) {
        await deactivateRiderAccount(riderId);
      }
      return;
    }
  }

  if (!confirm(`Tem certeza que deseja EXCLUIR permanentemente o entregador ${rider.name}? Esta ação só é permitida pois não existe histórico operacional registrado.`)) {
    return;
  }

  showToastNotification('Excluindo conta do motoboy...');

  try {
    if (supabaseClient) {
      const { error } = await supabaseClient
        .from('fleet')
        .delete()
        .eq('id', rider.id);

      if (error) throw error;
    }

    await fetchFleet();
    renderFleetTable();
    closeRiderActions();
    showToastNotification(`Conta de ${rider.name} excluída com sucesso.`);
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
  const rider = mockData.fleet.find(r => r.id === riderId || r.name === riderId);
  const order = mockData.clientHistory.find(item => item.id === deliveryId || item.raw_id === deliveryId || item.tele_code === deliveryId) ||
                mockData.pendingDeliveries.find(item => item.id === deliveryId || item.raw_id === deliveryId || item.tele_code === deliveryId);

  const riderLabel = rider ? rider.name : (riderId || 'motoboy');
  if (!confirm(`Remover a tele ${deliveryId} de ${riderLabel} e devolver para Aguardando Despacho?`)) return;

  const targetUuid = (order && order.raw_id) ? order.raw_id : deliveryId;

  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('teles')
      .update({
        motoboy_id: null,
        status: 'aguardando_despacho',
        updated_at: new Date().toISOString()
      })
      .eq('id', targetUuid);

    if (error) {
      console.error('Erro ao retirar motoboy da tele:', error);
      alert('Erro ao retirar motoboy da tele: ' + error.message);
      return;
    }

    if (rider) {
      const remainingOrders = getActiveOrdersForRider(rider).filter(item => item.id !== deliveryId && item.raw_id !== targetUuid);
      if (remainingOrders.length === 0) {
        await supabaseClient
          .from('fleet')
          .update({ status: 'Disponível', status_class: 'status-success', delivery: 'Nenhuma' })
          .eq('id', rider.id);
      }
    }
  }

  await loadTelesManagement();
  showToastNotification(`Motoboy retirado. Tele ${deliveryId} devolvida para Aguardando Despacho.`);
}

function openRiderActions(riderId) {
  const rider = mockData.fleet.find(r => r.id === riderId);
  if (!rider) return;

  selectedRiderId = riderId;
  const nameEl = document.getElementById('rider-action-name');
  const codeEl = document.getElementById('rider-action-code');
  const statusEl = document.getElementById('rider-action-status');

  if (nameEl) nameEl.innerText = rider.name || 'Motoboy';
  if (codeEl) codeEl.innerText = getRiderDisplayCode(rider.motoboy_code) || '—';
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

function getRiderStatusClass(status) {
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

  const payload = {
    name: name,
    phone: phoneDigits,
    vehicle: vehicle,
    plate: plate,
    pin: pinRaw
  };

  let registeredCode = '#MB-' + phoneDigits.slice(-4);

  if (supabaseClient) {
    const { data: resData, error: fnErr } = await supabaseClient.functions.invoke('create-rider-user', {
      body: payload
    });

    if (fnErr || !resData || !resData.success) {
      const errMsg = resData?.error || fnErr?.message || 'Erro ao cadastrar motoboy.';
      if (generalErrorEl) {
        const errTxtEl = document.getElementById('register-motoboy-error-text');
        if (errTxtEl) errTxtEl.innerText = errMsg;
        generalErrorEl.classList.remove('hidden');
      }
      submitBtn.disabled = false;
      submitBtn.querySelector('span').innerText = 'Cadastrar Motoboy';
      return;
    }

    if (resData.motoboy_code) {
      registeredCode = resData.motoboy_code.startsWith('#') ? resData.motoboy_code : '#' + resData.motoboy_code;
    }
  } else {
    // Offline fallback: add to local mockData
    mockData.fleet.push({
      id: registeredCode,
      name: name,
      phone: phoneDigits,
      vehicle: vehicle,
      plate: plate,
      status: 'Indisponível'
    });
  }

  // Reset form inputs
  if (nameEl) nameEl.value = '';
  if (phoneEl) phoneEl.value = '';
  if (vehicleEl) vehicleEl.value = '';
  if (plateEl) plateEl.value = '';
  if (pinEl) pinEl.value = '';

  // Refresh fleet table
  await fetchFleet();
  renderFleetTable();

  // Close registration modal and open credential card with temporary memory
  document.getElementById('modal-register-motoboy').classList.add('hidden');
  openCredentialCard(registeredCode, name, pinRaw);

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
  toast.className = 'toast';
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

/* ================= PERFIL AUTORITATIVO DO CLIENTE COMERCIAL (RC.17B) ================= */

let clientProfileRequestSeq = 0;
let clientProfileCurrentData = null;

function computeInitialsAvatar(name) {
  if (!name || typeof name !== 'string') return 'DC';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'DC';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function openProfileSettings() {
  switchDashboardTab('client-profile');
}

function closeProfileSettings(event) {
  const modal = document.getElementById('modal-profile-settings');
  if (event && event.target !== modal) return;
  if (modal) modal.classList.add('hidden');
}

function updateProfilePreview() {
  // Legacy stub for safety
}

function submitProfileSettings(event) {
  if (event) event.preventDefault();
  submitClientProfilePage(event);
}

async function loadClientProfilePage() {
  const seq = ++clientProfileRequestSeq;
  const feedbackEl = document.getElementById('client-profile-feedback');
  if (feedbackEl) {
    feedbackEl.classList.add('hidden');
    feedbackEl.innerText = '';
  }

  const saveBtn = document.getElementById('btn-save-client-profile');
  if (saveBtn) saveBtn.disabled = true;

  try {
    let profileData = null;
    let error = null;

    if (adminClientViewContext && adminClientViewContext.clientId) {
      const res = await supabaseClient.rpc('admin_get_commercial_client_profile', {
        p_client_id: adminClientViewContext.clientId
      });
      profileData = res.data;
      error = res.error;
    } else {
      const res = await supabaseClient.rpc('get_my_commercial_client_profile');
      profileData = res.data;
      error = res.error;
    }

    if (seq !== clientProfileRequestSeq) return;

    if (error || !profileData || !profileData.success) {
      const errMsg = profileData?.message || error?.message || 'Erro ao carregar dados do perfil.';
      showToastNotification(errMsg, 'error');
      if (feedbackEl) {
        feedbackEl.style.color = '#ef4444';
        feedbackEl.innerText = errMsg;
        feedbackEl.classList.remove('hidden');
      }
      return;
    }

    clientProfileCurrentData = profileData;

    const initials = computeInitialsAvatar(profileData.establishment_name);
    const avatarBadge = document.getElementById('client-profile-avatar-badge');
    if (avatarBadge) avatarBadge.innerText = initials;

    const sidebarAvatar = document.getElementById('user-avatar');
    if (sidebarAvatar) {
      sidebarAvatar.src = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="%23f59e0b"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="%23000" font-family="sans-serif" font-weight="bold" font-size="24">${initials}</text></svg>`;
    }

    const sidebarName = document.getElementById('user-display-name');
    if (sidebarName) sidebarName.innerText = profileData.establishment_name;

    const sidebarSub = document.getElementById('user-display-sub');
    if (sidebarSub) sidebarSub.innerText = `Resp: ${profileData.responsible_name || 'Operacional'}`;

    const titleEl = document.getElementById('client-profile-title');
    if (titleEl) titleEl.innerText = profileData.establishment_name;

    const codeEl = document.getElementById('client-profile-code-text');
    if (codeEl) codeEl.innerText = profileData.client_code;

    const statusBadge = document.getElementById('client-profile-status-badge');
    if (statusBadge) {
      statusBadge.innerText = profileData.lifecycle_status === 'ativo' ? 'Operação Ativa' : (profileData.lifecycle_status || 'ATIVO').toUpperCase();
    }

    const finBadge = document.getElementById('client-profile-fin-badge');
    if (finBadge) {
      finBadge.innerText = profileData.financial_status === 'em_dia' ? 'Financeiro Em Dia' : (profileData.financial_status || 'EM DIA').toUpperCase();
    }

    const fieldEst = document.getElementById('profile-field-establishment');
    if (fieldEst) fieldEst.value = profileData.establishment_name || '';

    const fieldDoc = document.getElementById('profile-field-document');
    if (fieldDoc) fieldDoc.value = profileData.document || '';

    const fieldEmail = document.getElementById('profile-field-email');
    if (fieldEmail) fieldEmail.value = profileData.email || '';

    const fieldResp = document.getElementById('profile-field-responsible');
    if (fieldResp) fieldResp.value = profileData.responsible_name || '';

    const fieldPhone = document.getElementById('profile-field-phone');
    if (fieldPhone) fieldPhone.value = profileData.phone || '';

    const fieldAddr = document.getElementById('profile-field-address');
    if (fieldAddr) fieldAddr.value = profileData.address || '';

    const fieldNum = document.getElementById('profile-field-number');
    if (fieldNum) fieldNum.value = profileData.street_number || '';

    const fieldNeigh = document.getElementById('profile-field-neighborhood');
    if (fieldNeigh) fieldNeigh.value = profileData.neighborhood || '';

    const fieldCity = document.getElementById('profile-field-city');
    if (fieldCity) fieldCity.value = profileData.city || 'Sapucaia do Sul';

    const fieldState = document.getElementById('profile-field-state');
    if (fieldState) fieldState.value = 'RS';

    const fieldZip = document.getElementById('profile-field-zip');
    if (fieldZip) fieldZip.value = profileData.postal_code || '';

    const fieldLat = document.getElementById('profile-field-lat');
    if (fieldLat) fieldLat.value = profileData.pickup_latitude ?? '';

    const fieldLng = document.getElementById('profile-field-lng');
    if (fieldLng) fieldLng.value = profileData.pickup_longitude ?? '';

    const fieldPlaceId = document.getElementById('profile-field-place-id');
    if (fieldPlaceId) fieldPlaceId.value = profileData.pickup_place_id || '';

    initProfilePlacesAutocomplete();

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }

  } catch (err) {
    console.error('Erro em loadClientProfilePage:', err);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function initProfilePlacesAutocomplete() {
  const addressInput = document.getElementById('profile-field-address');
  if (!addressInput || !window.google || !window.google.maps || !window.google.maps.places) return;

  try {
    const autocomplete = new google.maps.places.Autocomplete(addressInput, {
      componentRestrictions: { country: 'br' },
      fields: ['address_components', 'geometry', 'place_id', 'formatted_address']
    });

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place || !place.geometry) return;

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      const placeId = place.place_id;

      document.getElementById('profile-field-lat').value = lat;
      document.getElementById('profile-field-lng').value = lng;
      document.getElementById('profile-field-place-id').value = placeId;
      document.getElementById('profile-field-address').value = place.formatted_address || addressInput.value;

      let streetNumber = '';
      let neighborhood = '';
      let city = '';
      let state = '';
      let postalCode = '';

      if (place.address_components) {
        for (const comp of place.address_components) {
          const types = comp.types;
          if (types.includes('street_number')) streetNumber = comp.long_name;
          if (types.includes('sublocality') || types.includes('sublocality_level_1') || types.includes('neighborhood')) neighborhood = comp.long_name;
          if (types.includes('administrative_area_level_2') || types.includes('locality')) city = comp.long_name;
          if (types.includes('administrative_area_level_1')) state = comp.short_name;
          if (types.includes('postal_code')) postalCode = comp.long_name;
        }
      }

      if (streetNumber) document.getElementById('profile-field-number').value = streetNumber;
      if (neighborhood) document.getElementById('profile-field-neighborhood').value = neighborhood;
      if (city) document.getElementById('profile-field-city').value = city;
      if (state && state.toUpperCase() === 'RS') document.getElementById('profile-field-state').value = 'RS';
      if (postalCode) document.getElementById('profile-field-zip').value = postalCode;
    });
  } catch (err) {
    console.warn('Google Places Autocomplete no perfil indisponível:', err);
  }
}

async function submitClientProfilePage(event) {
  if (event) event.preventDefault();

  const saveBtn = document.getElementById('btn-save-client-profile');
  const feedbackEl = document.getElementById('client-profile-feedback');

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i data-lucide="loader-2" class="spin" style="width:20px;height:20px;"></i> <span>Salvando...</span>`;
    if (window.lucide) window.lucide.createIcons();
  }

  if (feedbackEl) {
    feedbackEl.classList.add('hidden');
    feedbackEl.innerText = '';
  }

  try {
    const responsibleName = document.getElementById('profile-field-responsible')?.value.trim();
    const phone = document.getElementById('profile-field-phone')?.value.trim();
    const address = document.getElementById('profile-field-address')?.value.trim();
    const streetNumber = document.getElementById('profile-field-number')?.value.trim();
    const neighborhood = document.getElementById('profile-field-neighborhood')?.value.trim();
    const city = document.getElementById('profile-field-city')?.value.trim() || 'Sapucaia do Sul';
    const state = 'RS';
    const postalCode = document.getElementById('profile-field-zip')?.value.trim();

    const latRaw = document.getElementById('profile-field-lat')?.value;
    const lngRaw = document.getElementById('profile-field-lng')?.value;
    const placeId = document.getElementById('profile-field-place-id')?.value.trim();

    const lat = latRaw !== '' && !isNaN(parseFloat(latRaw)) ? parseFloat(latRaw) : null;
    const lng = lngRaw !== '' && !isNaN(parseFloat(lngRaw)) ? parseFloat(lngRaw) : null;

    if (!responsibleName || responsibleName.length < 2) {
      throw new Error('Informe o nome do responsável operacional (mínimo 2 caracteres).');
    }
    if (!phone || phone.length < 8) {
      throw new Error('Informe um telefone de contato válido (mínimo 8 dígitos).');
    }
    if (!address || address.length < 5) {
      throw new Error('Informe o endereço de coleta para entregas.');
    }

    const payload = {
      p_responsible_name: responsibleName,
      p_phone: phone,
      p_address: address,
      p_street_number: streetNumber || null,
      p_neighborhood: neighborhood || null,
      p_city: city,
      p_state: state,
      p_postal_code: postalCode || null,
      p_pickup_latitude: lat,
      p_pickup_longitude: lng,
      p_pickup_place_id: placeId || null
    };

    let resData = null;
    let resErr = null;

    if (adminClientViewContext && adminClientViewContext.clientId) {
      const res = await supabaseClient.rpc('admin_update_commercial_client_profile', {
        p_client_id: adminClientViewContext.clientId,
        ...payload
      });
      resData = res.data;
      resErr = res.error;
    } else {
      const res = await supabaseClient.rpc('update_my_commercial_client_profile', payload);
      resData = res.data;
      resErr = res.error;
    }

    if (resErr || !resData || !resData.success) {
      const errMsg = resData?.message || resErr?.message || 'Erro ao salvar alterações no perfil.';
      throw new Error(errMsg);
    }

    showToastNotification('Perfil atualizado com sucesso.', 'success');

    await loadClientProfilePage();

    if (feedbackEl) {
      feedbackEl.style.color = '#10b981';
      feedbackEl.innerText = 'Perfil atualizado com sucesso.';
      feedbackEl.classList.remove('hidden');
    }

  } catch (err) {
    console.error('Erro ao salvar perfil:', err);
    showToastNotification(err.message, 'error');
    if (feedbackEl) {
      feedbackEl.style.color = '#ef4444';
      feedbackEl.innerText = err.message;
      feedbackEl.classList.remove('hidden');
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<i data-lucide="save" style="width:20px;height:20px;"></i> <span>Salvar Alterações</span>`;
      if (window.lucide) window.lucide.createIcons();
    }
  }
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

// ─── SUPPORT CHAT IMPLEMENTATION (RC.15B AUTHORITATIVE) ─────────────────────

let clientSupportChannel = null;
let clientSupportFetchToken = 0;
let activeClientSupportClientId = null;

let adminClientSupportChannel = null;
let activeAdminClientChatId = null;

// Timestamp Formatter (pt-BR with America/Sao_Paulo timezone)
function formatChatTimestamp(createdAtIso) {
  if (!createdAtIso) return 'Agora';
  const d = new Date(createdAtIso);
  if (isNaN(d.getTime())) return 'Agora';

  const now = new Date();
  const isToday = d.getDate() === now.getDate() &&
                  d.getMonth() === now.getMonth() &&
                  d.getFullYear() === now.getFullYear();

  const timeStr = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

  if (isToday) {
    return timeStr;
  }

  const dateStr = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${dateStr} ${timeStr}`;
}

// Helper to create message bubbles
function createMessageBubble(msg, currentRole) {
  if (!msg) return '';

  if (msg.sender_type === 'system') {
    return `
      <div data-message-id="${msg.id || ''}" style="display: flex; justify-content: center; width: 100%; margin: 8px 0;">
        <div style="background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-color); color: var(--color-text-muted); padding: 6px 14px; border-radius: 12px; font-size: 0.75rem; text-align: center;">
          ${escapeHtml(msg.message)}
        </div>
      </div>
    `;
  }

  const isMe = (msg.sender_type || msg.sender_role) === currentRole;
  const alignStyle = isMe ? 'align-self: flex-end; align-items: flex-end;' : 'align-self: flex-start; align-items: flex-start;';

  const bubbleStyle = isMe
    ? 'background: linear-gradient(135deg, #f97316, #c2410c); color: #ffffff; border-radius: 16px 16px 2px 16px; box-shadow: 0 4px 12px rgba(249, 115, 22, 0.25);'
    : 'background: #272732; border: 1px solid var(--border-color); color: var(--color-text); border-radius: 16px 16px 16px 2px;';

  const timeStr = formatChatTimestamp(msg.created_at);

  let readStatusHtml = '';
  if (isMe && currentRole === 'client') {
    if (msg.read_at) {
      readStatusHtml = `<span title="Lida pelo suporte" style="color: var(--accent-cyan); font-weight: 700; margin-left: 4px;">✓✓</span>`;
    } else {
      readStatusHtml = `<span title="Enviada" style="color: rgba(255,255,255,0.7); margin-left: 4px;">✓</span>`;
    }
  }

  return `
    <div data-message-id="${msg.id || ''}" style="display: flex; flex-direction: column; max-width: 85%; ${alignStyle}">
      <span style="font-size: 0.72rem; color: var(--color-text-muted); margin-bottom: 4px; font-weight: 500;">${escapeHtml(msg.sender_name || 'Usuário')}</span>
      <div style="padding: 10px 16px; font-size: 0.88rem; line-height: 1.45; word-break: break-word; overflow-wrap: anywhere; ${bubbleStyle}">
        ${escapeHtml(msg.message)}
      </div>
      <span style="font-size: 0.65rem; color: var(--color-text-muted); margin-top: 4px; display: flex; align-items: center;">
        ${timeStr} ${readStatusHtml}
      </span>
    </div>
  `;
}

// Composer helper functions
function updateClientChatSendButton() {
  const input = document.getElementById('client-chat-input');
  const btn = document.getElementById('client-chat-send-btn');
  if (!input || !btn) return;
  const hasText = input.value.trim().length > 0;
  btn.disabled = !hasText;
}

function sendClientChatMessageKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendClientChatMessage(event);
  }
}

// ─── CLIENT CHAT LOGIC ───────────────────────────────────────────────────────

// Status Badge Helper (Online, Conectando..., Offline)
function updateClientChatStatusBadge(state) {
  const badge = document.getElementById('client-chat-status-badge');
  if (!badge) return;

  if (state === 'ONLINE') {
    badge.style.color = '#10b981';
    badge.style.background = 'rgba(16, 185, 129, 0.1)';
    badge.style.border = '1px solid rgba(16, 185, 129, 0.2)';
    badge.textContent = 'Online';
  } else if (state === 'CONNECTING') {
    badge.style.color = '#f59e0b';
    badge.style.background = 'rgba(245, 158, 11, 0.1)';
    badge.style.border = '1px solid rgba(245, 158, 11, 0.2)';
    badge.textContent = 'Conectando...';
  } else {
    badge.style.color = '#9ca3af';
    badge.style.background = 'rgba(156, 163, 175, 0.1)';
    badge.style.border = '1px solid rgba(156, 163, 175, 0.2)';
    badge.textContent = 'Offline';
  }
}

// ─── CLIENT CHAT LOGIC ───────────────────────────────────────────────────────

async function loadClientChatHistory() {
  const container = document.getElementById('client-chat-messages');
  if (!container) return;

  const currentToken = ++clientSupportFetchToken;

  // 1. Resolve authoritative Client Context
  const context = resolveActiveClientContext();
  const clientId = context ? context.clientId : null;

  // FAIL CLOSED if no client context can be resolved
  if (!clientId) {
    if (clientSupportChannel && supabaseClient) {
      supabaseClient.removeChannel(clientSupportChannel);
      clientSupportChannel = null;
    }
    activeClientSupportClientId = null;
    updateClientChatStatusBadge('OFFLINE');
    setClientChatComposerEnabled(false);
    container.innerHTML = `
      <div class="chat-state-placeholder" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--color-text-muted); gap: 12px; padding: 20px;">
        <i data-lucide="shield-alert" style="width: 36px; height: 36px; color: var(--accent-orange);"></i>
        <p style="font-size: 0.85rem; margin: 0; font-weight: 600; color: var(--color-text);">Nenhum estabelecimento selecionado</p>
        <p style="font-size: 0.78rem; margin: 0; color: var(--color-text-muted);">Não foi possível determinar o ID do cliente para abrir o suporte.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  // 2. Anti-flash: Clear DOM immediately if switching to a new client
  if (activeClientSupportClientId !== clientId) {
    if (clientSupportChannel && supabaseClient) {
      supabaseClient.removeChannel(clientSupportChannel);
      clientSupportChannel = null;
    }
    container.innerHTML = `
      <div class="chat-state-placeholder" style="display: flex; align-items: center; justify-content: center; height: 100%;">
        <div style="width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 1s linear infinite;"></div>
      </div>
    `;
    activeClientSupportClientId = clientId;
  }

  if (!supabaseClient) {
    updateClientChatStatusBadge('OFFLINE');
    setClientChatComposerEnabled(false);
    renderClientMessages([]);
    return;
  }

  updateClientChatStatusBadge('CONNECTING');

  let historyData = null;
  let fetchError = null;

  try {
    const { data, error } = await supabaseClient
      .from('client_support_messages')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    historyData = data || [];
  } catch (err) {
    fetchError = err;
  }

  if (currentToken !== clientSupportFetchToken) return; // Anti-race lock

  if (fetchError) {
    console.error("Error loading client chat history:", fetchError);
    updateClientChatStatusBadge('OFFLINE');
    setClientChatComposerEnabled(false);
    renderClientMessagesError();
    return;
  }

  // Ready / Empty state reached
  setClientChatComposerEnabled(true);
  renderClientMessages(historyData, context);
  updateClientChatStatusBadge('ONLINE');

  // Auxiliary 1: Mark messages as read (context-aware, never throws UI error)
  try {
    if (context.isImpersonated) {
      Promise.resolve(supabaseClient.rpc('admin_mark_client_support_messages_read', { p_client_id: clientId })).catch(() => {});
    } else {
      Promise.resolve(supabaseClient.rpc('mark_my_client_support_messages_read')).catch(() => {});
    }
  } catch (auxErr) {
    console.warn("Non-critical mark-read error:", auxErr);
  }

  // Auxiliary 2: Realtime Subscription
  if (!clientSupportChannel) {
    clientSupportChannel = supabaseClient.channel('realtime-client-support-' + clientId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'client_support_messages',
        filter: `client_id=eq.${clientId}`
      }, (payload) => {
        if (payload.new) appendAndScrollClient(payload.new);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          updateClientChatStatusBadge('ONLINE');
        } else if (status === 'CLOSED') {
          updateClientChatStatusBadge('OFFLINE');
        }
      });
  }
}

function setClientChatComposerEnabled(enabled) {
  const input = document.getElementById('client-chat-input');
  const btn = document.getElementById('client-chat-send-btn');
  if (input) input.disabled = !enabled;
  if (btn && !enabled) btn.disabled = true;
  if (enabled) updateClientChatSendButton();
}

function renderClientMessages(messages, context) {
  const container = document.getElementById('client-chat-messages');
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = `
      <div class="chat-state-placeholder" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--color-text-muted); gap: 12px; padding: 20px;">
        <i data-lucide="headset" style="width: 42px; height: 42px; color: var(--accent-cyan); opacity: 0.8;"></i>
        <p style="font-size: 0.9rem; margin: 0; font-weight: 600; color: var(--color-text);">Fale com nosso suporte</p>
        <p style="font-size: 0.8rem; margin: 0; color: var(--color-text-muted); max-width: 320px; line-height: 1.4;">Envie sua dúvida ou mensagem abaixo. Nossa equipe responderá por aqui em tempo real.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  const role = (context && context.isImpersonated) ? 'admin' : 'client';
  container.innerHTML = messages.map(msg => createMessageBubble(msg, role)).join('');
  container.scrollTop = container.scrollHeight;
}

function renderClientMessagesError() {
  const container = document.getElementById('client-chat-messages');
  if (!container) return;

  container.innerHTML = `
    <div class="chat-state-placeholder" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--color-text-muted); gap: 12px; padding: 20px;">
      <i data-lucide="alert-circle" style="width: 36px; height: 36px; color: #ef4444;"></i>
      <p style="font-size: 0.88rem; margin: 0; font-weight: 600; color: var(--color-text);">Não foi possível carregar a conversa</p>
      <button class="btn btn-secondary" onclick="loadClientChatHistory()" style="margin-top: 4px; padding: 6px 16px; font-size: 0.8rem;">Tentar novamente</button>
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}

async function sendClientChatMessage(event) {
  if (event) event.preventDefault();

  const input = document.getElementById('client-chat-input');
  const btn = document.querySelector('#client-chat-form button[type="submit"]');
  if (!input) return;

  const val = input.value.trim();
  if (!val) return;

  if (!supabaseClient) {
    showToastNotification("Backend não conectado.");
    return;
  }

  input.disabled = true;
  if (btn) btn.disabled = true;

  try {
    const context = resolveActiveClientContext();
    if (!context || !context.clientId) {
      throw new Error("Nenhum estabelecimento comercial ativo.");
    }

    let rpcRes;
    if (context.isImpersonated) {
      rpcRes = await supabaseClient.rpc('admin_send_client_support_message', {
        p_client_id: context.clientId,
        p_message: val
      });
    } else {
      rpcRes = await supabaseClient.rpc('send_my_client_support_message', { p_message: val });
    }

    if (rpcRes.error) throw rpcRes.error;

    if (rpcRes.data && rpcRes.data.success) {
      input.value = '';
      if (rpcRes.data.message) {
        appendAndScrollClient(rpcRes.data.message);
      }
    } else {
      throw new Error(rpcRes.data ? rpcRes.data.message : 'Erro ao enviar');
    }
  } catch (err) {
    console.error("Error sending client chat message:", err);
    showToastNotification(err.message || "Erro ao enviar mensagem.");
  } finally {
    input.disabled = false;
    if (btn) btn.disabled = false;
    updateClientChatSendButton();
    input.focus();
  }
}

function appendAndScrollClient(msg) {
  const container = document.getElementById('client-chat-messages');
  if (!container || !msg) return;

  // Deduplicate by message ID if present
  if (msg.id && container.querySelector(`[data-message-id="${msg.id}"]`)) {
    return;
  }

  // Remove any placeholder (empty state, error state, or no-client state)
  const placeholder = container.querySelector('.chat-state-placeholder');
  if (placeholder) {
    placeholder.remove();
  }

  const context = resolveActiveClientContext();
  const currentRole = (context && context.isImpersonated) ? 'admin' : 'client';
  const div = document.createElement('div');
  div.style.display = 'contents';
  div.innerHTML = createMessageBubble(msg, currentRole);
  container.appendChild(div);

  container.scrollTop = container.scrollHeight;
}

// ─── ADMIN CLIENT CHAT LOGIC ─────────────────────────────────────────────────

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
    const { data, error } = await supabaseClient.rpc('get_admin_client_support_channels');
    if (error) throw error;

    const channels = (data && data.success && Array.isArray(data.channels)) ? data.channels : [];
    activeAdminChatChannels = channels;
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
    const { name: clientName, code: clientCode } = getClientDisplayIdentity({ establishment_name: chan.establishment_name, client_code: chan.client_code });
    const displayTitle = clientName || 'Cliente';
    const displaySubtitle = clientCode ? `${clientCode} • ${chan.email || ''}` : (chan.email || '');

    const isActive = activeAdminClientChatId === chan.client_id;
    const activeBg = isActive ? 'background: rgba(255, 255, 255, 0.08); border-left: 3px solid var(--accent-cyan);' : 'border-left: 3px solid transparent;';
    const highlightHover = 'this.style.background=\'rgba(255, 255, 255, 0.05)\'';
    const normalBg = isActive ? 'this.style.background=\'rgba(255, 255, 255, 0.08)\'' : 'this.style.background=\'transparent\'';
    const unreadBadge = chan.unread_count > 0
      ? `<span style="background: #ef4444; color: #fff; font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 10px;">${chan.unread_count}</span>`
      : '';
    const lastMsgText = chan.last_message ? chan.last_message.message : 'Sem mensagens';
    const timeText = chan.last_message ? new Date(chan.last_message.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';

    return `
      <div class="chat-channel-item" onclick="selectAdminChatChannel('${chan.client_id}', '${escapeHtml(displayTitle).replace(/'/g, "\\'")}', '${escapeHtml(displaySubtitle).replace(/'/g, "\\'")}')"
           onmouseover="${highlightHover}" onmouseout="${normalBg}"
           style="padding: 14px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid rgba(255,255,255,0.03); transition: background 0.2s; ${activeBg}">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 0.88rem; color: var(--color-text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${escapeHtml(displayTitle)}</strong>
          <div style="display: flex; align-items: center; gap: 6px;">
            ${unreadBadge}
            <span style="font-size: 0.68rem; color: var(--color-text-muted);">${timeText}</span>
          </div>
        </div>
        <p style="font-size: 0.78rem; color: var(--color-text-muted); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(lastMsgText)}</p>
      </div>
    `;
  }).join('');
}

function filterAdminChatChannels() {
  const query = document.getElementById('admin-chat-search')?.value.trim().toLowerCase() || '';
  const filtered = activeAdminChatChannels.filter(c =>
    (c.establishment_name || '').toLowerCase().includes(query) ||
    (c.email || '').toLowerCase().includes(query)
  );
  renderAdminChatChannels(filtered);
}

async function selectAdminChatChannel(clientId, name, email) {
  if (activeAdminClientChatId !== clientId) {
    if (adminClientSupportChannel && supabaseClient) {
      supabaseClient.removeChannel(adminClientSupportChannel);
      adminClientSupportChannel = null;
    }
  }

  activeAdminClientChatId = clientId;

  const adminDot = document.getElementById('admin-chat-dot');
  if (adminDot) adminDot.classList.add('hidden');

  document.getElementById('admin-chat-no-selection').classList.add('hidden');
  document.getElementById('admin-chat-window-pane').classList.remove('hidden');

  document.getElementById('admin-chat-client-title').innerText = name;
  document.getElementById('admin-chat-client-subtitle').innerText = email;

  renderAdminChatChannels(activeAdminChatChannels);

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
      .from('client_support_messages')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    renderAdminMessages(data || []);

    // Mark messages as read by admin
    supabaseClient.rpc('admin_mark_client_support_messages_read', { p_client_id: clientId }).catch(err => {
      console.warn('Failed to mark admin client messages as read:', err);
    });

    // Subscribe to Realtime
    if (!adminClientSupportChannel) {
      adminClientSupportChannel = supabaseClient.channel('realtime-admin-client-support-' + clientId)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'client_support_messages',
          filter: `client_id=eq.${clientId}`
        }, (payload) => {
          if (payload.new) appendAndScrollAdmin(payload.new);
        })
        .subscribe();
    }
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
  const btn = document.querySelector('#admin-chat-form button[type="submit"]');
  if (!input) return;

  const val = input.value.trim();
  if (!val || !activeAdminClientChatId) return;

  if (!supabaseClient) {
    showToastNotification("Backend não conectado.");
    return;
  }

  input.disabled = true;
  if (btn) btn.disabled = true;

  try {
    const { data, error } = await supabaseClient.rpc('admin_send_client_support_message', {
      p_client_id: activeAdminClientChatId,
      p_message: val
    });

    if (error) throw error;

    if (data && data.success) {
      input.value = '';
      if (data.message) {
        appendAndScrollAdmin(data.message);
      }
    } else {
      throw new Error(data ? data.message : 'Erro ao responder');
    }
  } catch (err) {
    console.error("Error sending admin message:", err);
    showToastNotification("Erro ao enviar resposta.");
  } finally {
    input.disabled = false;
    if (btn) btn.disabled = false;
    input.focus();
  }
}

function appendAndScrollAdmin(msg) {
  const container = document.getElementById('admin-chat-messages');
  if (!container) return;

  if (msg.id && container.querySelector(`[data-message-id="${msg.id}"]`)) {
    return;
  }

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


// â”€â”€â”€ ADMIN RIDER CHAT LOGIC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ REALTIME SUPPORT SUBSCRIPTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        renderTelesUnified();
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
        if (document.getElementById('tab-client-overview')?.classList.contains('active')) {
          loadClientOverviewDashboard();
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

// â”€â”€â”€ REQUEST DELIVERY MAP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function loadGoogleMapsAPI(callback) {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    if (callback) callback(new Error("Chave do Google Maps não configurada no ambiente."));
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
        setContent(html) {
          this.html = html;
          if (this.div) this.div.innerHTML = html;
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
    centerCoords: [-29.8247, -51.1444],
    destCoords: null
  },
  manual: {
    map: null,
    marker: null,
    restaurantMarker: null,
    centerCoords: [-29.8247, -51.1444],
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
      if (type === 'manual') {
        if (typeof updateManualTelePickupMarker === 'function') {
          updateManualTelePickupMarker();
        }
        return;
      }
      const center = new window.google.maps.LatLng(coords[0], coords[1]);
      const clientName = (currentUserProfile && currentUserProfile.establishment_name) ? currentUserProfile.establishment_name : 'Ponto de Coleta';
      requestMaps[type].restaurantMarker = new window.CustomHTMLMapMarker(center, requestMaps[type].map, restaurantIconHtml, () => {
        const info = new window.google.maps.InfoWindow({ content: `<strong style="color:var(--color-text);">${escapeHtml(clientName)}</strong>` });
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

  const latInput = document.getElementById(`${type}-delivery-lat`) || document.getElementById('manual-delivery-lat');
  const lngInput = document.getElementById(`${type}-delivery-lng`) || document.getElementById('manual-delivery-lng');
  if (latInput) latInput.value = lat;
  if (lngInput) lngInput.value = lng;

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
      const newLat = pos.lat();
      const newLng = pos.lng();
      requestMaps[type].destCoords = { lat: newLat, lng: newLng, isManualPin: true };
      const isManualInput = document.getElementById(`${type}-location-adjusted-manually`) || document.getElementById('manual-location-adjusted-manually');
      if (isManualInput) isManualInput.value = 'true';
      const precisionInput = document.getElementById(`${type}-geocoding-precision`) || document.getElementById('manual-geocoding-precision');
      if (precisionInput) precisionInput.value = 'manual_pin';

      const curLatInput = document.getElementById(`${type}-delivery-lat`) || document.getElementById('manual-delivery-lat');
      const curLngInput = document.getElementById(`${type}-delivery-lng`) || document.getElementById('manual-delivery-lng');
      if (curLatInput) curLatInput.value = newLat;
      if (curLngInput) curLngInput.value = newLng;

      updateRequestDeliveryDestination(newLat, newLng, false, false, type);
      updatePrecisionBadge(type);
    });
  }

  updatePrecisionBadge(type);

  if (shouldCenter) {
    requestMaps[type].map.setCenter(destLatLng);
    requestMaps[type].map.setZoom(16);
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
  if (type === 'manual' && addressInput.dataset.placesNewActive === 'true') {
    return;
  }

  try {
    await loadGoogleMapsApi();
    if (!window.google?.maps?.places) return;

    addressInput.dataset.autocompleteInitialized = "true";

    const rsBounds = new window.google.maps.LatLngBounds(
      { lat: -33.75, lng: -57.65 },
      { lat: -27.08, lng: -49.69 }
    );

    const options = {
      componentRestrictions: { country: "br" },
      bounds: rsBounds,
      strictBounds: true,
      fields: ["address_components", "geometry", "formatted_address", "place_id"],
      types: ["address"]
    };

    const autocomplete = new window.google.maps.places.Autocomplete(addressInput, options);

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();

      if (!place || !place.geometry || !place.geometry.location) {
        alert("Endereço não encontrado ou inválido. Selecione um endereço sugerido pela lista.");
        return;
      }

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      const locType = place.geometry.location_type || 'ROOFTOP';

      requestMaps[type].destCoords = { lat, lng, isManualPin: false };
      addressInput.value = place.formatted_address;
      addressInput.dataset.lastResolvedAddress = place.formatted_address;
      addressInput.dataset.isPlacesResolved = "true";

      const placeIdInput = document.getElementById(`${type}-delivery-place-id`) || document.getElementById('manual-delivery-place-id');
      if (placeIdInput) placeIdInput.value = place.place_id || '';

      const isManualInput = document.getElementById(`${type}-location-adjusted-manually`) || document.getElementById('manual-location-adjusted-manually');
      if (isManualInput) isManualInput.value = 'false';

      const precisionInput = document.getElementById(`${type}-geocoding-precision`) || document.getElementById('manual-geocoding-precision');
      if (precisionInput) precisionInput.value = String(locType).toLowerCase();

      updateRequestDeliveryDestination(lat, lng, true, false, type);
    });

    addressInput.addEventListener('input', () => {
      const val = addressInput.value.trim();
      if (val !== addressInput.dataset.lastResolvedAddress) {
        delete addressInput.dataset.isPlacesResolved;
        addressInput.dataset.lastResolvedAddress = '';
        requestMaps[type].destCoords = null;

        const latInput = document.getElementById(`${type}-delivery-lat`) || document.getElementById('manual-delivery-lat');
        const lngInput = document.getElementById(`${type}-delivery-lng`) || document.getElementById('manual-delivery-lng');
        if (latInput) latInput.value = '';
        if (lngInput) lngInput.value = '';

        const placeIdInput = document.getElementById(`${type}-delivery-place-id`) || document.getElementById('manual-delivery-place-id');
        if (placeIdInput) placeIdInput.value = '';

        const isManualInput = document.getElementById(`${type}-location-adjusted-manually`) || document.getElementById('manual-location-adjusted-manually');
        if (isManualInput) isManualInput.value = 'false';

        const precisionInput = document.getElementById(`${type}-geocoding-precision`) || document.getElementById('manual-geocoding-precision');
        if (precisionInput) precisionInput.value = 'unconfirmed';

        if (requestMaps[type].marker) {
          requestMaps[type].marker.setMap(null);
          requestMaps[type].marker = null;
        }
        if (requestMaps[type].polyline) {
          requestMaps[type].polyline.setMap(null);
          requestMaps[type].polyline = null;
        }
      }
    });

    const handleManualGeocode = () => {
      const value = addressInput.value.trim();
      if (!value) return;
      if (addressInput.dataset.isPlacesResolved === "true") return;
      if (addressInput.dataset.lastResolvedAddress && addressInput.dataset.lastResolvedAddress === value) return;

      const isManualAdjusted = document.getElementById(`${type}-location-adjusted-manually`)?.value === 'true' || document.getElementById('manual-location-adjusted-manually')?.value === 'true';
      if (isManualAdjusted && requestMaps[type].destCoords) return;

      if (window.google?.maps?.Geocoder) {
        const geocoder = new window.google.maps.Geocoder();
        const query = (value.toLowerCase().includes('rs') || value.toLowerCase().includes('rio grande do sul')) ? value : `${value}, RS, Brasil`;
        geocoder.geocode({
          address: query,
          bounds: rsBounds,
          componentRestrictions: { country: 'BR', administrativeArea: 'RS' }
        }, (results, status) => {
          if (status === 'OK' && results[0]) {
            const res = results[0];
            const lat = res.geometry.location.lat();
            const lng = res.geometry.location.lng();
            requestMaps[type].destCoords = { lat, lng, isManualPin: false };
            addressInput.dataset.lastResolvedAddress = value;
            addressInput.dataset.isPlacesResolved = "true";

            const placeIdInput = document.getElementById(`${type}-delivery-place-id`) || document.getElementById('manual-delivery-place-id');
            if (placeIdInput) placeIdInput.value = res.place_id || '';

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

// â”€â”€â”€ REALTIME ORDER TRACKING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function startRealtimeTracking(order) {
  const trackerStatus = document.getElementById('tracker-badge-status');
  const orderId = order.id;

  // Unsubscribe from any previous tracking channel
  if (trackingRealtimeChannel) {
    if (supabaseClient) supabaseClient.removeChannel(trackingRealtimeChannel);
    trackingRealtimeChannel = null;
  }

  // Determine coordinates
  const pickupLat = parseFloat(order.pickup_lat) || -29.8247;
  const pickupLng = parseFloat(order.pickup_lng) || -51.1444;
  const destLat = parseFloat(order.dest_lat) || -29.825;
  const destLng = parseFloat(order.dest_lng) || -51.145;

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

// Owner Financials dynamic date range filters & rendering via authoritative backend RPC
async function renderOwnerFinancials() {
  if (!supabaseClient || !currentActiveSession) return;

  const startDateVal = document.getElementById('finance-start-date')?.value || null;
  const endDateVal = document.getElementById('finance-end-date')?.value || null;

  try {
    const { data, error } = await supabaseClient.rpc('get_admin_company_financial_summary', {
      p_start_date: startDateVal,
      p_end_date: endDateVal,
      p_period_shortcut: (!startDateVal && !endDateVal) ? 'current_week' : null
    });

    if (error || !data || data.success === false) {
      console.error("[RPC get_admin_company_financial_summary] Erro:", error || data);
      return;
    }

    const grossEl = document.getElementById('finance-gross-total');
    const netEl = document.getElementById('finance-net-total');
    const platformEl = document.getElementById('finance-platform-fee');

    if (grossEl) grossEl.textContent = formatRiderSettlementCurrency(data.gross_revenue);
    if (netEl) netEl.textContent = formatRiderSettlementCurrency(data.rider_payout_total);
    if (platformEl) platformEl.textContent = formatRiderSettlementCurrency(data.platform_revenue);

    // Update Doughnut Chart (Chart 2) if canvas exists and is connected
    const ownerCanvas = document.getElementById('ownerFinancialChart');
    if (ownerCanvas && ownerCanvas.isConnected) {
      const activeChart = ownerFinancialChart || window.ownerFinancialChart;
      const isChartValid = activeChart && activeChart.data && Array.isArray(activeChart.data.datasets) && activeChart.data.datasets[0];

      if (!isChartValid) {
        initOwnerFinancialChart();
      }

      const validChart = ownerFinancialChart || window.ownerFinancialChart;
      if (validChart && validChart.data && Array.isArray(validChart.data.datasets) && validChart.data.datasets[0]) {
        validChart.data.datasets[0].data = [
          Number(data.rider_payout_total) || 0,
          Number(data.platform_revenue) || 0
        ];
        validChart.update();
      }
    }

    // Update completed teles list in index.html
    const tbody = document.getElementById('finance-history-table-body');
    if (tbody) {
      const teles = data.completed_teles || [];
      if (teles.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; color: var(--color-text-muted); padding: 24px;">
              Nenhuma tele concluída encontrada para o período selecionado.
            </td>
          </tr>
        `;
      } else {
        tbody.innerHTML = teles.map(t => `
          <tr>
            <td><code>${escapeHtml(t.tele_code || '—')}</code></td>
            <td>${t.date ? new Date(t.date).toLocaleDateString('pt-BR') : '—'}</td>
            <td><strong>${escapeHtml(t.establishment_dest || '—')}</strong></td>
            <td>${escapeHtml(t.motoboy_name || '—')}</td>
            <td><strong class="text-yellow">${formatRiderSettlementCurrency(t.delivery_charge)}</strong></td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error("[RPC get_admin_company_financial_summary] Exceção:", err);
  }
}

function clearFinanceFilters() {
  const startEl = document.getElementById('finance-start-date');
  const endEl = document.getElementById('finance-end-date');
  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';
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
function clearRiderPaymentFiltersLegacy() {
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
function toggleRiderSearchDropdownLegacy(show) {
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

// â”€â”€â”€ OWNER CREDITS MANAGEMENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const rider = (mockData.fleet || []).find(r => r.id === item.rider_id || r.user_id === item.rider_id);
    const riderDisplayName = rider ? formatRiderDisplayName(rider) : 'Motoboy';

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

// â”€â”€â”€ CITIES AND RATES MANAGEMENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ MANUAL REQUEST MODAL HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function showRequestDeliveryModal() {
  if (requestMaps && requestMaps.manual) {
    requestMaps.manual.destCoords = null;
  }
  const form = document.getElementById('request-delivery-form');
  if (form) form.reset();

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
  const changeGroup = document.getElementById('manual-change-amount-group');

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
  if (changeGroup) changeGroup.classList.add('hidden');

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

  manualTelePickupState = {
    clientId: null,
    establishmentName: '',
    isCustom: false,
    defaultAddress: '',
    defaultLat: null,
    defaultLng: null,
    defaultPlaceId: '',
    customAddress: '',
    customLat: null,
    customLng: null,
    customPlaceId: ''
  };
  if (typeof updateManualTelePickupUI === 'function') updateManualTelePickupUI();

  if (requestMaps && requestMaps.manual && requestMaps.manual.map) {
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

  try {
    const nextId = await getNextTeleId();
    const idInput = document.getElementById('manual-delivery-id');
    if (idInput) idInput.value = nextId;
  } catch (e) {
    console.warn("Could not prefill next Tele ID:", e);
  }

  const modal = document.getElementById('modal-request-delivery');
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }

  if (typeof fetchCommercialClientsForSelect === 'function') fetchCommercialClientsForSelect();

  setTimeout(() => {
    if (typeof initRequestDeliveryMap === 'function') {
      initRequestDeliveryMap('manual');
    } else if (typeof initManualDeliveryMap === 'function') {
      initManualDeliveryMap();
    }
  }, 200);

  if (window.lucide) lucide.createIcons();
}

function resetManualDeliveryForm() {
  if (requestMaps && requestMaps.manual) {
    requestMaps.manual.destCoords = null;
  }
  const form = document.getElementById('request-delivery-form');
  if (form) form.reset();

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
  const changeGroup = document.getElementById('manual-change-amount-group');
  const errBanner = document.getElementById('manual-modal-error-banner');

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
  if (changeGroup) changeGroup.classList.add('hidden');
  if (errBanner) errBanner.remove();

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

  manualTelePickupState = {
    clientId: null,
    establishmentName: '',
    isCustom: false,
    defaultAddress: '',
    defaultLat: null,
    defaultLng: null,
    defaultPlaceId: '',
    customAddress: '',
    customLat: null,
    customLng: null,
    customPlaceId: ''
  };
  if (typeof updateManualTelePickupUI === 'function') updateManualTelePickupUI();

  if (typeof updatePrecisionBadge === 'function') updatePrecisionBadge('manual');
}

function isManualDeliveryFormDirty() {
  const selectedClientId = document.getElementById('selectedClientId')?.value?.trim();
  const destName = document.getElementById('manual-delivery-dest-name')?.value?.trim();
  const destPhone = document.getElementById('manual-delivery-dest-phone')?.value?.trim();
  const address = document.getElementById('manual-delivery-address')?.value?.trim();
  const complement = document.getElementById('manual-delivery-complement')?.value?.trim();
  const charge = document.getElementById('manual-delivery-charge')?.value?.trim();
  const orderValue = document.getElementById('manual-order-value')?.value?.trim();
  const notes = document.getElementById('manual-order-notes')?.value?.trim();
  const isManualAdjusted = document.getElementById('manual-location-adjusted-manually')?.value === 'true';

  return !!(selectedClientId || destName || destPhone || address || complement || charge || orderValue || notes || isManualAdjusted);
}

function showDiscardConfirmationModal() {
  const modal = document.getElementById('modal-confirm-discard-request');
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
}

function hideDiscardConfirmationModal() {
  const modal = document.getElementById('modal-confirm-discard-request');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

function closeRequestDeliveryModal(skipConfirm = false, event = null) {
  if (event && event.type === 'click' && event.target === event.currentTarget) return;

  if (skipConfirm !== true && isManualDeliveryFormDirty()) {
    showDiscardConfirmationModal();
    return;
  }

  forceCloseRequestDeliveryModal();
}

function forceCloseRequestDeliveryModal() {
  hideDiscardConfirmationModal();

  const modal = document.getElementById('modal-request-delivery');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }

  // Full cleanup of map instance to avoid memory leak and layout conflicts
  if (requestMaps.manual && requestMaps.manual.map) {
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

  // Reset all form inputs and states cleanly
  resetManualDeliveryForm();
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
window.hideDiscardConfirmationModal = hideDiscardConfirmationModal;
window.forceCloseRequestDeliveryModal = forceCloseRequestDeliveryModal;
window.toggleChangeAmountGroup = toggleChangeAmountGroup;

// â”€â”€â”€ DASHBOARD OVERVIEW REAL METRICS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
}

let currentOverviewFetchToken = 0;
let clientOverviewChartInstance = null;

async function loadClientOverviewDashboard() {
  const localToken = ++currentOverviewFetchToken;
  const context = typeof resolveActiveClientContext === 'function' ? resolveActiveClientContext() : null;

  const nameEl = document.getElementById('client-overview-establishment-name');
  const pendingEl = document.getElementById('client-overview-kpi-pending');
  const activeEl = document.getElementById('client-overview-kpi-active');
  const completedTodayEl = document.getElementById('client-overview-kpi-completed-today');
  const totalTodayEl = document.getElementById('client-overview-kpi-total-today');

  const monthTotalEl = document.getElementById('client-overview-month-total');
  const monthCompletedEl = document.getElementById('client-overview-month-completed');
  const monthCanceledEl = document.getElementById('client-overview-month-canceled');
  const avgDurationEl = document.getElementById('client-overview-avg-duration');
  const rateEl = document.getElementById('client-overview-completion-rate');

  const emptyNoticeEl = document.getElementById('client-overview-empty-notice');
  const errorStateEl = document.getElementById('client-overview-error-state');

  // Reset / Skeleton Loading State
  if (pendingEl) pendingEl.innerText = '...';
  if (activeEl) activeEl.innerText = '...';
  if (completedTodayEl) completedTodayEl.innerText = '...';
  if (totalTodayEl) totalTodayEl.innerText = '...';
  if (monthTotalEl) monthTotalEl.innerText = '...';
  if (monthCompletedEl) monthCompletedEl.innerText = '...';
  if (monthCanceledEl) monthCanceledEl.innerText = '...';
  if (avgDurationEl) avgDurationEl.innerText = '...';
  if (rateEl) rateEl.innerText = '...';
  if (errorStateEl) errorStateEl.classList.add('hidden');
  if (emptyNoticeEl) emptyNoticeEl.classList.add('hidden');

  const isImpersonated = Boolean(context && (context.isAdminView || context.isImpersonated));

  if (!supabaseClient || (isImpersonated && !context?.clientId)) {
    if (pendingEl) pendingEl.innerText = '0';
    if (activeEl) activeEl.innerText = '0';
    if (completedTodayEl) completedTodayEl.innerText = '0';
    if (totalTodayEl) totalTodayEl.innerText = '0';
    if (monthTotalEl) monthTotalEl.innerText = '0';
    if (monthCompletedEl) monthCompletedEl.innerText = '0';
    if (monthCanceledEl) monthCanceledEl.innerText = '0';
    if (avgDurationEl) avgDurationEl.innerText = 'N/A';
    if (rateEl) rateEl.innerText = 'N/A';
    renderClientOverviewChart([]);
    return;
  }

  try {
    let res = null;
    if (isImpersonated) {
      res = await supabaseClient.rpc('admin_get_client_dashboard_overview', { p_client_id: context.clientId });
    } else {
      res = await supabaseClient.rpc('get_client_dashboard_overview');
    }

    if (localToken !== currentOverviewFetchToken) {
      return; // Anti-race guard
    }

    if (res.error || !res.data || !res.data.success) {
      throw new Error(res.error ? res.error.message : (res.data ? res.data.message : 'Falha ao carregar resumo'));
    }

    const payload = res.data;

    if (nameEl) {
      nameEl.innerText = payload.establishment_name || 'Visão Geral da Operação';
    }

    if (pendingEl) pendingEl.innerText = payload.today.pending;
    if (activeEl) activeEl.innerText = payload.today.active;
    if (completedTodayEl) completedTodayEl.innerText = payload.today.completed;
    if (totalTodayEl) totalTodayEl.innerText = payload.today.total_created;

    if (monthTotalEl) monthTotalEl.innerText = payload.month.total_created;
    if (monthCompletedEl) monthCompletedEl.innerText = payload.month.completed;
    if (monthCanceledEl) monthCanceledEl.innerText = payload.month.canceled;

    if (avgDurationEl) {
      avgDurationEl.innerText = payload.performance.avg_delivery_minutes !== null ? `${payload.performance.avg_delivery_minutes} min` : 'N/A';
    }

    if (rateEl) {
      rateEl.innerText = payload.performance.completion_rate !== null ? `${payload.performance.completion_rate}%` : 'N/A';
    }

    if (emptyNoticeEl) {
      if (payload.month.completed === 0 && payload.month.total_created === 0) {
        emptyNoticeEl.classList.remove('hidden');
      } else {
        emptyNoticeEl.classList.add('hidden');
      }
    }

    renderClientOverviewChart(payload.last_7_days || []);

  } catch (err) {
    if (localToken !== currentOverviewFetchToken) return;
    console.warn("Client overview load failed:", err);
    if (errorStateEl) errorStateEl.classList.remove('hidden');
    if (pendingEl) pendingEl.innerText = '0';
    if (activeEl) activeEl.innerText = '0';
    if (completedTodayEl) completedTodayEl.innerText = '0';
    if (totalTodayEl) totalTodayEl.innerText = '0';
    renderClientOverviewChart([]);
  }
}

function renderClientOverviewChart(last7Days) {
  const ctx = document.getElementById('clientOverviewChart');
  if (!ctx) return;

  if (clientOverviewChartInstance) {
    clientOverviewChartInstance.destroy();
    clientOverviewChartInstance = null;
  }

  const labels = last7Days.map(d => d.label || d.date);
  const totals = last7Days.map(d => d.total || 0);
  const completed = last7Days.map(d => d.completed || 0);

  if (typeof Chart === 'undefined') return;

  try {
    clientOverviewChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['-','-','-','-','-','-','-'],
        datasets: [
          {
            label: 'Total Solicitado',
            data: totals.length > 0 ? totals : [0,0,0,0,0,0,0],
            backgroundColor: '#8b5cf6',
            borderRadius: 4
          },
          {
            label: 'Concluídas',
            data: completed.length > 0 ? completed : [0,0,0,0,0,0,0],
            backgroundColor: '#10b981',
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            labels: { color: '#8e8e9f' }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { stepSize: 1, precision: 0, color: '#8e8e9f' },
            grid: { color: 'rgba(255,255,255,0.05)' }
          },
          x: {
            ticks: { color: '#8e8e9f' },
            grid: { display: false }
          }
        }
      }
    });
  } catch (chartErr) {
    console.warn("Client overview Chart.js render warning:", chartErr);
  }
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

// â”€â”€â”€ ADD & REMOVE COMMERCE HANDLERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  const teleObj = mockData.pendingDeliveries.find(t => t.id === teleId || t.raw_id === teleId || t.tele_code === teleId) ||
                  mockData.clientHistory.find(t => t.id === teleId || t.raw_id === teleId || t.tele_code === teleId);
  span.innerText = formatOrderIdForDisplay(teleObj ? teleObj.tele_code : teleId, teleObj);
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

window.handleRiderExtractRiderChange = function() {
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
    select.innerHTML = '<option value="">Selecione um motoboy</option>';
    (mockData.fleet || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(r => {
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
  const statusFilter = document.getElementById('rider-extract-status-select')?.value || '';

  const emptyState = document.getElementById('rider-extract-empty-state');
  const loadingState = document.getElementById('rider-extract-loading-state');
  const contentBox = document.getElementById('rider-extract-content');

  // 1. ESTADO INICIAL / SEM SELEÇÃO: Não executa nenhuma RPC financeira backend
  if (!selectedRiderId) {
    if (contentBox) contentBox.style.display = 'none';
    if (loadingState) loadingState.style.display = 'none';
    if (emptyState) emptyState.style.display = 'block';

    const tbody = document.getElementById('rider-extract-table-body');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--color-text-muted); padding: 24px;">Selecione um motoboy para visualizar o extrato.</td></tr>`;
    }
    return;
  }

  // 2. TROCA DE MOTOBOY: Esconde dados anteriores instantaneamente e mostra loading
  if (emptyState) emptyState.style.display = 'none';
  if (contentBox) contentBox.style.display = 'none';
  if (loadingState) loadingState.style.display = 'block';

  try {
    const { start, end } = resolveDateRange(periodPreset, 'rider-extract-start-date', 'rider-extract-end-date');
    const startDateStr = start.toISOString().split('T')[0];
    const endDateStr = end.toISOString().split('T')[0];

    // Consultas isoladas estritamente pelo rider_id selecionado
    const { data: summaryData, error: summaryErr } = await supabaseClient.rpc('admin_get_rider_financial_summary', {
      p_motoboy_id: selectedRiderId,
      p_start_date: startDateStr,
      p_end_date: endDateStr
    });

    if (summaryErr) console.warn('Aviso em admin_get_rider_financial_summary:', summaryErr.message);

    const { data: stmtData, error: stmtErr } = await supabaseClient.rpc('admin_get_rider_financial_statement', {
      p_motoboy_id: selectedRiderId,
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

    // Renderiza Cards do Resumo
    const elCount = document.getElementById('rider-extract-count');
    const elGross = document.getElementById('rider-extract-gross');
    const elCommission = document.getElementById('rider-extract-commission');
    const elConsumables = document.getElementById('rider-extract-consumables');
    const elCredits = document.getElementById('rider-extract-credits');
    const elAdjustments = document.getElementById('rider-extract-adjustments');
    const elNet = document.getElementById('rider-extract-net');

    if (elCount) elCount.innerText = s.completed_deliveries_count || 0;
    if (elGross) elGross.innerText = `R$ ${parseFloat(s.delivery_earnings || 0).toFixed(2).replace('.', ',')}`;
    if (elCommission) elCommission.innerText = `R$ 0,00`;
    if (elConsumables) elConsumables.innerText = `R$ ${parseFloat(s.consumables_total || 0).toFixed(2).replace('.', ',')}`;
    if (elCredits) elCredits.innerText = `R$ ${parseFloat(s.credits_total || 0).toFixed(2).replace('.', ',')}`;
    if (elAdjustments) elAdjustments.innerText = `R$ ${(parseFloat(s.positive_adjustments_total || 0) - parseFloat(s.negative_adjustments_total || 0)).toFixed(2).replace('.', ',')}`;
    if (elNet) elNet.innerText = `R$ ${parseFloat(s.net_total || 0).toFixed(2).replace('.', ',')}`;

    let items = (stmtData && stmtData.items) ? stmtData.items : [];

    // VALIDAÇÃO 1: Filtro autoritativo por Status da Tele (se aplicado pelo admin)
    if (statusFilter && items.length > 0) {
      const teleIds = [...new Set(items.map(item => item.tele_id).filter(Boolean))];
      let teleStatusMap = {};

      if (teleIds.length > 0) {
        const { data: teleRows, error: teleErr } = await supabaseClient
          .from('teles')
          .select('id, status')
          .in('id', teleIds);

        if (!teleErr && teleRows) {
          teleRows.forEach(t => {
            teleStatusMap[t.id] = t.status;
          });
        }
      }

      items = items.filter(item => {
        if (item.tele_id) {
          const tStatus = teleStatusMap[item.tele_id];
          if (!tStatus) return false;
          if (statusFilter === 'Entregue') {
            return tStatus === 'Entregue' || tStatus === 'Concluído';
          }
          return tStatus.toLowerCase() === statusFilter.toLowerCase();
        }
        return false;
      });
    }

    const totalCount = (stmtData && stmtData.total_count) || items.length;
    const totalPages = Math.ceil(totalCount / FINANCIAL_PAGE_SIZE) || 1;

    // Renderiza a Tabela de Detalhamento de Movimentações (6 Colunas Semânticas)
    const tbody = document.getElementById('rider-extract-table-body');
    if (tbody) {
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--color-text-muted); padding: 24px;">Nenhuma movimentação financeira localizada para o período.</td></tr>`;
      } else {
        tbody.innerHTML = items.map(item => {
          const itemDate = new Date(item.created_at || item.competency_date);
          const dateFormatted = isNaN(itemDate) ? item.competency_date : itemDate.toLocaleDateString('pt-BR');
          const timeFormatted = isNaN(itemDate) ? '' : itemDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
          const val = parseFloat(item.amount || 0);

          let badgeClass = item.direction === 'credit' ? 'badge-success' : 'badge-danger';
          let badgeLabel = item.direction === 'credit' ? 'CRÉDITO' : 'DÉBITO';
          let signStr = item.direction === 'credit' ? '+' : '-';
          if (item.type === 'estorno') {
            badgeClass = 'badge-warning';
            badgeLabel = 'ESTORNO';
          }

          let typeLabel = item.type;
          if (item.type === 'credito_entrega') typeLabel = 'Crédito de Entrega';
          else if (item.type === 'ajuste_credito') typeLabel = 'Ajuste Crédito';
          else if (item.type === 'ajuste_debito') typeLabel = 'Ajuste Débito / Consumível';
          else if (item.type === 'estorno') typeLabel = 'Estorno';

          let teleCodeDisplay = 'LANÇAMENTO';
          if (item.tele_code) {
            const cleanCode = String(item.tele_code).trim();
            if (!isUuidString(cleanCode)) {
              teleCodeDisplay = '#' + cleanCode;
            }
          }

          return `
            <tr>
              <td><strong>${escapeHtml(teleCodeDisplay)}</strong></td>
              <td>${dateFormatted} ${timeFormatted}</td>
              <td><span style="font-weight: 500; font-size: 0.85rem;">${escapeHtml(typeLabel)}</span></td>
              <td>${escapeHtml(item.description || '—')}</td>
              <td><strong class="${item.direction === 'credit' ? 'text-green' : 'text-red'}">${signStr} R$ ${val.toFixed(2).replace('.', ',')}</strong></td>
              <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
            </tr>
          `;
        }).join('');
      }
    }

    renderPaginationControls('rider-extract-pagination', currentRiderExtractPage, totalPages, 'loadRiderExtract');

    // Renderiza Demonstrativo Consolidado
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
  } finally {
    if (loadingState) loadingState.style.display = 'none';
    if (contentBox) contentBox.style.display = 'block';
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

window.handleClientExtractClientChange = function() {
  const select = document.getElementById('client-extract-client-select');
  const btnReceipt = document.getElementById('btn-open-register-receipt');

  if (btnReceipt) {
    if (select && select.value) {
      btnReceipt.disabled = false;
      btnReceipt.style.cursor = 'pointer';
      btnReceipt.style.opacity = '1';
      btnReceipt.style.background = 'rgba(16, 185, 129, 0.15)';
      btnReceipt.style.color = '#10b981';
      btnReceipt.style.border = '1px solid rgba(16, 185, 129, 0.3)';
    } else {
      btnReceipt.disabled = true;
      btnReceipt.style.cursor = 'not-allowed';
      btnReceipt.style.opacity = '0.6';
      btnReceipt.style.background = 'rgba(16, 185, 129, 0.1)';
      btnReceipt.style.color = 'var(--color-text-muted)';
      btnReceipt.style.border = '1px solid var(--border-color)';
    }
  }

  currentClientExtractPage = 1;
  loadClientExtract();
};

window.initClientExtract = async function() {
  if (typeof fetchCommercialClientsForSelect === 'function') {
    await fetchCommercialClientsForSelect();
  }

  const select = document.getElementById('client-extract-client-select');
  if (select) {
    const currentVal = select.value;
    select.innerHTML = '<option value="">Selecione um cliente</option>';

    const clients = (commercialClientsSelectCache || commercialClientsForSelect || []).slice().sort((a, b) => {
      return (a.establishment_name || '').localeCompare(b.establishment_name || '');
    });

    clients.forEach(c => {
      const { name, code } = getClientDisplayIdentity(c);
      const codeStr = code ? ` (${escapeHtml(code)})` : '';
      select.innerHTML += `<option value="${escapeHtml(c.id)}">${escapeHtml(name)}${codeStr}</option>`;
    });
    select.value = currentVal;
  }

  handleClientExtractClientChange();
};

window.loadClientExtract = async function(targetPage) {
  if (targetPage) currentClientExtractPage = targetPage;
  if (!supabaseClient) return;

  const selectClient = document.getElementById('client-extract-client-select');
  const selectedClientId = selectClient ? selectClient.value : '';
  const periodPreset = document.getElementById('client-extract-period-preset')?.value || 'month';

  const emptyState = document.getElementById('client-extract-empty-state');
  const loadingState = document.getElementById('client-extract-loading-state');
  const contentBox = document.getElementById('client-extract-content');

  // 1. ESTADO INICIAL: Nenhum cliente selecionado -> Não dispara RPCs
  if (!selectedClientId) {
    if (contentBox) contentBox.style.display = 'none';
    if (loadingState) loadingState.style.display = 'none';
    if (emptyState) emptyState.style.display = 'block';

    const tbody = document.getElementById('client-extract-table-body');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--color-text-muted); padding: 24px;">Selecione um cliente para visualizar o extrato.</td></tr>`;
    }
    return;
  }

  // 2. CLIENTE SELECIONADO: Mostra loading e oculta dados anteriores imediatamente
  if (emptyState) emptyState.style.display = 'none';
  if (contentBox) contentBox.style.display = 'none';
  if (loadingState) loadingState.style.display = 'block';

  try {
    const { start, end } = resolveDateRange(periodPreset, 'client-extract-start-date', 'client-extract-end-date');
    const startDateStr = start.toISOString().split('T')[0];
    const endDateStr = end.toISOString().split('T')[0];

    let s = null;
    try {
      const { data: stmtData, error: stmtErr } = await supabaseClient.rpc('admin_get_client_financial_statement', {
        p_client_id: selectedClientId,
        p_start_date: startDateStr,
        p_end_date: endDateStr,
        p_limit: FINANCIAL_PAGE_SIZE,
        p_offset: (currentClientExtractPage - 1) * FINANCIAL_PAGE_SIZE
      });
      if (!stmtErr && stmtData && stmtData.success) {
        s = stmtData;
      }
    } catch (e) {}

    // Fallback: Consulta direta autoritativa ao ledger client_financial_transactions com JOIN em teles
    if (!s) {
      const { data: allTxs } = await supabaseClient
        .from('client_financial_transactions')
        .select('*, teles(tele_code)')
        .eq('client_id', selectedClientId)
        .order('created_at', { ascending: true });

      const txs = allTxs || [];
      let total_open_balance = 0;
      let opening_balance = 0;
      let billed_total = 0;
      let paid_total = 0;
      let completed_teles_count = 0;
      const periodItems = [];

      txs.forEach(t => {
        const tAmount = Number(t.amount || 0);
        const isDebit = t.direction === 'debit';
        const tDate = new Date(t.created_at);
        const isPeriod = tDate >= start && tDate < end;

        if (isDebit) {
          total_open_balance += tAmount;
        } else {
          total_open_balance -= tAmount;
        }

        if (tDate < start) {
          opening_balance += isDebit ? tAmount : -tAmount;
        }

        if (isPeriod) {
          if (isDebit) {
            billed_total += tAmount;
            if (t.type === 'cobranca_entrega' && t.tele_id) completed_teles_count++;
          } else {
            paid_total += tAmount;
          }

          let teleCodeStr = null;
          if (t.teles && t.teles.tele_code) {
            teleCodeStr = 'TEL-' + t.teles.tele_code;
          }

          periodItems.push({
            transaction_id: t.id,
            client_id: t.client_id,
            tele_id: t.tele_id,
            tele_code: teleCodeStr,
            type: t.type,
            direction: t.direction,
            amount: tAmount,
            description: t.description,
            created_at: t.created_at,
            running_balance: total_open_balance
          });
        }
      });

      periodItems.reverse();

      s = {
        total_open_balance,
        opening_balance,
        completed_teles_count,
        billed_total,
        paid_total,
        total_count: periodItems.length,
        items: periodItems.slice((currentClientExtractPage - 1) * FINANCIAL_PAGE_SIZE, currentClientExtractPage * FINANCIAL_PAGE_SIZE)
      };
    }

    // Atualiza os Cards de Resumo (Pipeline 100% Numérico)
    const elCount = document.getElementById('client-extract-count');
    const elBilled = document.getElementById('client-extract-billed');
    const elPaid = document.getElementById('client-extract-paid');
    const elBalance = document.getElementById('client-extract-balance');
    const elStatusBadge = document.getElementById('client-extract-status-badge');
    const elStatusDesc = document.getElementById('client-extract-status-desc');

    const totalTelesCount = Number(s.completed_teles_count || 0);
    const billedTotalVal = Number(s.billed_total || 0);
    const paidTotalVal = Number(s.paid_total || 0);
    const openBalanceVal = Number(s.total_open_balance || 0);

    if (elCount) elCount.innerText = totalTelesCount;
    if (elBilled) elBilled.innerText = `R$ ${billedTotalVal.toFixed(2).replace('.', ',')}`;
    if (elPaid) elPaid.innerText = `R$ ${paidTotalVal.toFixed(2).replace('.', ',')}`;
    if (elBalance) elBalance.innerText = `R$ ${openBalanceVal.toFixed(2).replace('.', ',')}`;

    if (elStatusBadge && elStatusDesc) {
      if (openBalanceVal > 0) {
        elStatusBadge.className = 'badge badge-status-warning';
        elStatusBadge.innerText = 'Pendente';
        elStatusDesc.innerText = 'Possui saldo atual em aberto';
      } else {
        elStatusBadge.className = 'badge badge-status-ok';
        elStatusBadge.innerText = 'Em dia';
        elStatusDesc.innerText = 'Conta sem pendências financeiras';
      }
    }

    const items = Array.isArray(s.items) ? s.items : [];
    const totalCount = Number(s.total_count || items.length);
    const totalPages = Math.ceil(totalCount / FINANCIAL_PAGE_SIZE) || 1;

    // Tabela Razão
    const tbody = document.getElementById('client-extract-table-body');
    if (tbody) {
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--color-text-muted); padding: 24px;">Nenhum lançamento financeiro localizado para o período selecionado.</td></tr>`;
      } else {
        tbody.innerHTML = items.map(item => {
          const itemDate = new Date(item.created_at);
          const dFormatted = isNaN(itemDate) ? '—' : (itemDate.toLocaleDateString('pt-BR') + ' ' + itemDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));

          let typeBadge = '<span class="badge badge-neutral">Outro</span>';
          if (item.type === 'cobranca_entrega') typeBadge = '<span class="badge badge-soft">Cobrança Entrega</span>';
          else if (item.type === 'pagamento_recebido') typeBadge = '<span class="badge badge-success">Pagamento Recebido</span>';
          else if (item.type === 'credito_concedido') typeBadge = '<span class="badge badge-success">Crédito Concedido</span>';
          else if (item.type === 'ajuste_debito') typeBadge = '<span class="badge badge-warning">Ajuste Débito</span>';
          else if (item.type === 'estorno') typeBadge = '<span class="badge badge-danger">Estorno</span>';

          const valNum = Number(item.amount || 0);
          const isDebit = item.direction === 'debit';

          const debitStr = isDebit ? `<span class="financial-debit">R$ ${valNum.toFixed(2).replace('.', ',')}</span>` : '—';
          const creditStr = !isDebit ? `<span class="financial-credit">R$ ${valNum.toFixed(2).replace('.', ',')}</span>` : '—';

          const runBalNum = Number(item.running_balance || 0);
          const balStr = `R$ ${runBalNum.toFixed(2).replace('.', ',')}`;
          const docStr = item.tele_code || 'LANÇAMENTO';

          return `
            <tr class="clickable-row" onclick="openTransactionDrawer('${escapeHtml(String(item.transaction_id))}')">
              <td>${dFormatted}</td>
              <td><strong>${escapeHtml(docStr)}</strong></td>
              <td>${typeBadge}</td>
              <td>${escapeHtml(item.description || '—')}</td>
              <td><span style="font-size: 0.78rem; color: var(--color-text-muted);">sistema</span></td>
              <td>${debitStr}</td>
              <td>${creditStr}</td>
              <td><strong>${balStr}</strong></td>
            </tr>
          `;
        }).join('');
      }
    }

    renderPaginationControls('client-extract-pagination', currentClientExtractPage, totalPages, 'loadClientExtract');
  } catch (err) {
    console.error('Error loading client extract:', err);
  } finally {
    if (loadingState) loadingState.style.display = 'none';
    if (contentBox) contentBox.style.display = 'block';
  }
};

// Modal de Recebimento de Cliente & Handlers
let currentClientReceiptIdempotencyKey = null;

window.openRegisterReceiptModal = async function() {
  const selectClient = document.getElementById('client-extract-client-select');
  const selectedClientId = selectClient ? selectClient.value : '';

  if (!selectedClientId) {
    showToastNotification('Por favor, selecione um cliente primeiro.', 'error');
    return;
  }

  const clientObj = (commercialClientsSelectCache || commercialClientsForSelect || []).find(c => String(c.id) === String(selectedClientId));
  const clientName = clientObj ? clientObj.establishment_name : 'Cliente Selecionado';

  const modal = document.getElementById('modal-register-client-receipt');
  const inputName = document.getElementById('receipt-modal-client-name');
  const inputAmount = document.getElementById('receipt-modal-amount-input');
  const inputNotes = document.getElementById('receipt-modal-notes-input');
  const openBalanceEl = document.getElementById('receipt-modal-open-balance');

  // Consulta o saldo autoritativo atual em aberto
  let currentOpenBal = 0;
  if (supabaseClient) {
    try {
      const { data: stmtData } = await supabaseClient.rpc('admin_get_client_financial_statement', {
        p_client_id: selectedClientId
      });
      if (stmtData && stmtData.success) {
        currentOpenBal = Number(stmtData.total_open_balance || 0);
      }
    } catch (e) {}

    if (currentOpenBal === 0) {
      const { data: txs } = await supabaseClient
        .from('client_financial_transactions')
        .select('amount, direction')
        .eq('client_id', selectedClientId);

      (txs || []).forEach(t => {
        const amt = Number(t.amount || 0);
        currentOpenBal += (t.direction === 'debit' ? amt : -amt);
      });
    }
  }

  if (inputName) inputName.value = clientName;
  if (inputAmount) inputAmount.value = '';
  if (inputNotes) inputNotes.value = '';
  if (openBalanceEl) openBalanceEl.innerText = `R$ ${currentOpenBal.toFixed(2).replace('.', ',')}`;

  // Idempotency key única para este envio
  currentClientReceiptIdempotencyKey = `receipt:${selectedClientId}:${Date.now()}:${Math.random().toString(36).substring(2, 7)}`;

  if (modal) modal.classList.remove('hidden');
};

window.closeRegisterReceiptModal = function() {
  const modal = document.getElementById('modal-register-client-receipt');
  if (modal) modal.classList.add('hidden');
  currentClientReceiptIdempotencyKey = null;
};

window.handleRegisterClientReceipt = async function(event) {
  event.preventDefault();
  if (!supabaseClient) return;

  const selectClient = document.getElementById('client-extract-client-select');
  const selectedClientId = selectClient ? selectClient.value : '';
  const inputAmount = document.getElementById('receipt-modal-amount-input');
  const selectMethod = document.getElementById('receipt-modal-method-select');
  const inputNotes = document.getElementById('receipt-modal-notes-input');
  const submitBtn = document.getElementById('btn-submit-client-receipt');

  if (!selectedClientId) {
    showToastNotification('Nenhum cliente selecionado.', 'error');
    return;
  }

  const amountVal = parseFloat(inputAmount?.value || 0);
  const paymentMethod = selectMethod?.value || 'PIX';
  const notes = inputNotes?.value?.trim() || '';

  if (isNaN(amountVal) || amountVal <= 0) {
    showToastNotification('Por favor, informe um valor válido para o recebimento.', 'error');
    return;
  }

  // Validação Frontend do Saldo em Aberto
  let currentOpenBal = 0;
  try {
    const { data: stmtCheck } = await supabaseClient.rpc('admin_get_client_financial_statement', {
      p_client_id: selectedClientId
    });
    if (stmtCheck && stmtCheck.success) {
      currentOpenBal = Number(stmtCheck.total_open_balance || 0);
    }
  } catch (e) {}

  if (currentOpenBal === 0) {
    const { data: txs } = await supabaseClient
      .from('client_financial_transactions')
      .select('amount, direction')
      .eq('client_id', selectedClientId);

    (txs || []).forEach(t => {
      const amt = Number(t.amount || 0);
      currentOpenBal += (t.direction === 'debit' ? amt : -amt);
    });
  }

  if (amountVal > currentOpenBal) {
    showToastNotification('O valor recebido não pode ser maior que o saldo atual em aberto do cliente.', 'error');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Processando...</span>';
  }

  try {
    const { data, error } = await supabaseClient.rpc('admin_register_client_payment', {
      p_client_id: selectedClientId,
      p_amount: amountVal,
      p_payment_method: paymentMethod,
      p_notes: notes,
      p_idempotency_key: currentClientReceiptIdempotencyKey
    });

    if (error) {
      console.error('[ADMIN_REGISTER_CLIENT_PAYMENT_RPC_ERROR]', {
        rpc: 'admin_register_client_payment',
        error: error.message,
        code: error.code,
        details: error.details
      });
      showToastNotification('Não foi possível registrar o recebimento. Nenhuma alteração financeira foi realizada. Tente novamente.', 'error');
      return;
    }

    if (data && data.success === false) {
      if (data.error_code === 'AMOUNT_EXCEEDS_BALANCE') {
        showToastNotification('O valor recebido não pode ser maior que o saldo atual em aberto do cliente.', 'error');
      } else {
        showToastNotification(data.message || 'Erro ao registrar recebimento.', 'error');
      }
      return;
    }

    closeRegisterReceiptModal();
    showToastNotification((data && data.message) || 'Recebimento registrado com sucesso.');

    // Recarrega o extrato
    loadClientExtract();
  } catch (err) {
    console.error('[ADMIN_REGISTER_CLIENT_PAYMENT_UNEXPECTED_ERROR]', {
      rpc: 'admin_register_client_payment',
      error: err.message
    });
    showToastNotification('Não foi possível registrar o recebimento. Nenhuma alteração financeira foi realizada. Tente novamente.', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="check-circle" style="width: 16px; height: 16px;"></i> Confirmar Recebimento';
      if (window.lucide) lucide.createIcons();
    }
  }
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
let commercialClientsModuleFetchPromise = null;

// Função Auxiliar de Normalização Defensiva do Schema de Commercial Clients
function normalizeCommercialClient(row) {
  if (!row) return null;

  const clientCode = row.client_code || row.public_code || '—';
  const establishmentName = row.establishment_name || 'Sem nome';
  const responsibleName = row.responsible_name || 'Não informado';
  const phone = row.phone || row.phone_normalized || 'Não informado';
  const email = row.email || row.email_normalized || 'Não informado';
  const address = row.pickup_address || row.address || '';

  const latNum = (row.pickup_latitude !== null && row.pickup_latitude !== undefined && row.pickup_latitude !== '')
    ? Number(row.pickup_latitude)
    : null;
  const lngNum = (row.pickup_longitude !== null && row.pickup_longitude !== undefined && row.pickup_longitude !== '')
    ? Number(row.pickup_longitude)
    : null;

  return {
    id: String(row.id || ''),
    client_code: clientCode,
    establishment_name: establishmentName,
    responsible_name: responsibleName,
    phone: phone,
    email: email,
    document: row.document || row.document_normalized || '',
    address: address,
    neighborhood: row.neighborhood || '',
    city: row.city || '',
    state: row.state || '',
    postal_code: row.postal_code || '',
    lifecycle_status: row.lifecycle_status || 'ativo',
    financial_status: row.financial_status || 'em_dia',
    created_at: row.created_at || new Date().toISOString(),
    pickup_address: address,
    pickup_latitude: (latNum !== null && !isNaN(latNum)) ? latNum : null,
    pickup_longitude: (lngNum !== null && !isNaN(lngNum)) ? lngNum : null,
    pickup_place_id: row.pickup_place_id || null,
    is_internal: !!row.is_internal,
    open_balance: Number(row.open_balance) || 0
  };
}

// Rotina Canônica de Carregamento do Módulo de Clientes Comerciais
async function loadCommercialClientsModule() {
  if (commercialClientsModuleFetchPromise) {
    return commercialClientsModuleFetchPromise;
  }

  commercialClientsModuleFetchPromise = (async () => {
    try {
      await fetchCommercialClients();
    } finally {
      commercialClientsModuleFetchPromise = null;
    }
  })();

  return commercialClientsModuleFetchPromise;
}

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
        commercialClientsList = data.map(normalizeCommercialClient).filter(Boolean);
      }
    } else {
      // Dev Adapter fallback via API local
      const res = await fetch('/api/admin/clients');
      if (res.ok) {
        const json = await res.json();
        commercialClientsList = (json.clients || []).map(normalizeCommercialClient).filter(Boolean);
      }
    }
  } catch (err) {
    console.error("Erro ao buscar clientes comerciais:", err);
  }

  // Garantir fixtures de homologação se a lista estiver vazia e não estiver conectado ao Supabase
  if ((!commercialClientsList || commercialClientsList.length === 0) && !supabaseClient) {
    commercialClientsList = [
      normalizeCommercialClient({
        id: 'client-fixture-001',
        client_code: 'CLI-000001',
        establishment_name: 'Lanchonete Dahora',
        responsible_name: 'Gerente Lanchonete',
        phone: '11999998888',
        email: 'gerente@lanchonetedahora.com.br',
        document: '12.345.678/0001-90',
        lifecycle_status: 'ativo',
        financial_status: 'em_dia',
        address: 'Rua Principal, 100',
        neighborhood: 'Centro',
        city: 'Porto Alegre',
        created_at: new Date().toISOString()
      }),
      normalizeCommercialClient({
        id: 'client-fixture-002',
        client_code: 'CLI-000002',
        establishment_name: 'Cliente Teste (Homologação)',
        responsible_name: 'Usuário Teste',
        phone: '11988887777',
        email: 'cliente.teste@local.test',
        document: '98.765.432/0001-10',
        lifecycle_status: 'teste',
        financial_status: 'em_dia',
        address: 'Av. das Indústrias, 500',
        neighborhood: 'Industrial',
        city: 'São Paulo',
        created_at: new Date().toISOString()
      })
    ].filter(Boolean);
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
      (c.client_code || '').toLowerCase().includes(searchQuery) ||
      (c.responsible_name || '').toLowerCase().includes(searchQuery) ||
      (c.email || '').toLowerCase().includes(searchQuery) ||
      (c.phone || '').includes(searchQuery);

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
    const dateFormatted = c.created_at ? new Date(c.created_at).toLocaleDateString('pt-BR') : '—';

    // Status Badges
    const lifecycleBadgeClass = c.lifecycle_status === 'ativo' ? 'badge-success' :
                               c.lifecycle_status === 'teste' ? 'badge-info' :
                               c.lifecycle_status === 'suspenso' ? 'badge-warning' : 'badge-danger';

    const financialBadgeClass = c.financial_status === 'em_dia' ? 'badge-success' : 'badge-danger';

    // Total teles para o cliente
    const totalTeles = (mockData.clientHistory || []).filter(d =>
      String(d.client_id) === String(c.id) || (d.client || '').toLowerCase() === (c.establishment_name || '').toLowerCase()
    ).length;

    const openBalance = c.open_balance || 0;

    const hasValidLocation = c.pickup_latitude !== null && c.pickup_longitude !== null && !isNaN(c.pickup_latitude) && !isNaN(c.pickup_longitude);

    const locationBadge = !hasValidLocation
      ? `<div style="margin-top: 4px;"><span class="badge badge-warning" style="font-size: 0.7rem; padding: 2px 6px;">Localização de coleta ainda não definida</span></div>`
      : `<div style="margin-top: 4px;"><span class="badge badge-success" style="font-size: 0.7rem; padding: 2px 6px;">Coleta configurada</span></div>`;

    return `
      <tr>
        <td><span class="client-code-chip">${escapeHtml(c.client_code)}</span></td>
        <td class="comm-col-establishment">
          <div class="comm-establishment-name">${escapeHtml(c.establishment_name)}</div>
          <div class="comm-establishment-address">${escapeHtml(c.address || '—')}</div>
          ${locationBadge}
        </td>
        <td>${escapeHtml(c.responsible_name)}</td>
        <td class="comm-col-contact">
          <div class="comm-contact-phone">${escapeHtml(c.phone)}</div>
          <div class="comm-contact-email">${escapeHtml(c.email)}</div>
        </td>
        <td><span class="badge ${lifecycleBadgeClass}">${escapeHtml((c.lifecycle_status || '').toUpperCase())}</span></td>
        <td><span class="badge ${financialBadgeClass}">${escapeHtml((c.financial_status || '').replace('_', ' ').toUpperCase())}</span></td>
        <td style="text-align: center;"><strong>${totalTeles}</strong></td>
        <td style="text-align: right;"><strong style="color: #10b981;">R$ ${openBalance.toFixed(2).replace('.', ',')}</strong></td>
        <td>${dateFormatted}</td>
        <td class="comm-actions-cell">
          <button class="btn-icon-action"
                  data-client-id="${c.id}"
                  onclick="toggleClientActionDropdown(event, '${c.id}')"
                  title="Ações do cliente"
                  aria-label="Ações do cliente"
                  aria-expanded="false"
                  aria-haspopup="menu">
            <i data-lucide="more-vertical"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  if (window.lucide) window.lucide.createIcons();
}

// ----------------------------------------------------
// GERENCIADOR DO MENU CONTEXTUAL FLUTUANTE DE AÇÕES
// ----------------------------------------------------
let currentOpenDropdownClientId = null;

function closeCommActionDropdown() {
  const el = document.getElementById('comm-client-floating-dropdown');
  if (el) {
    el.style.display = 'none';
    el.innerHTML = '';
  }
  if (currentOpenDropdownClientId) {
    const btn = document.querySelector(`.btn-icon-action[data-client-id="${currentOpenDropdownClientId}"]`);
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('active');
    }
    currentOpenDropdownClientId = null;
  }
}

function initCommClientFloatingMenuListeners() {
  if (window._commClientListenersAttached) return;
  window._commClientListenersAttached = true;

  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('comm-client-floating-dropdown');
    if (!dropdown || dropdown.style.display === 'none') return;

    if (dropdown.contains(e.target) || e.target.closest('.btn-icon-action')) {
      return;
    }
    closeCommActionDropdown();
  });

  window.addEventListener('scroll', () => {
    closeCommActionDropdown();
  }, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    closeCommActionDropdown();
  }, { passive: true });
}

function toggleClientActionDropdown(event, clientId) {
  event.stopPropagation();
  initCommClientFloatingMenuListeners();

  if (currentOpenDropdownClientId === clientId) {
    closeCommActionDropdown();
    return;
  }

  closeCommActionDropdown();

  const client = (commercialClientsList || []).find(c => String(c.id) === String(clientId));
  if (!client) return;

  let dropdown = document.getElementById('comm-client-floating-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'comm-client-floating-dropdown';
    dropdown.className = 'comm-actions-dropdown';
    document.body.appendChild(dropdown);
  }

  const isAtivo = client.lifecycle_status === 'ativo';

  dropdown.innerHTML = `
    <button class="comm-dropdown-item" onclick="handleCommClientDropdownAction(event, '${clientId}', 'pickup')">
      <i data-lucide="map-pin"></i>
      <span>Ponto de Coleta</span>
    </button>
    <button class="comm-dropdown-item" onclick="handleCommClientDropdownAction(event, '${clientId}', 'panel')">
      <i data-lucide="external-link"></i>
      <span>Abrir Painel</span>
    </button>
    <button class="comm-dropdown-item" onclick="handleCommClientDropdownAction(event, '${clientId}', 'status')">
      <i data-lucide="${isAtivo ? 'pause-circle' : 'play-circle'}"></i>
      <span>${isAtivo ? 'Pausar Cliente' : 'Ativar Cliente'}</span>
    </button>
    <button class="comm-dropdown-item" onclick="handleCommClientDropdownAction(event, '${clientId}', 'recover')">
      <i data-lucide="key"></i>
      <span>Recuperar Acesso</span>
    </button>
  `;

  if (window.lucide) window.lucide.createIcons({ el: dropdown });

  const btn = event.currentTarget;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('active');
  currentOpenDropdownClientId = clientId;

  dropdown.style.display = 'flex';

  const rect = btn.getBoundingClientRect();
  const menuHeight = dropdown.offsetHeight || 160;
  const menuWidth = dropdown.offsetWidth || 175;

  let left = rect.right - menuWidth;
  if (left < 10) left = 10;

  let top = rect.bottom + 4;
  if (rect.bottom + menuHeight > window.innerHeight - 10) {
    top = rect.top - menuHeight - 4;
  }

  dropdown.style.top = `${Math.max(10, top)}px`;
  dropdown.style.left = `${left}px`;
}

function handleCommClientDropdownAction(event, clientId, action) {
  event.stopPropagation();
  closeCommActionDropdown();

  if (action === 'pickup') {
    openConfigureClientPickupModal(clientId);
  } else if (action === 'panel') {
    openAdminClientPanelView(clientId);
  } else if (action === 'status') {
    toggleClientStatus(clientId);
  } else if (action === 'recover') {
    openRecoverClientAccessModal(clientId);
  }
}

window.toggleClientActionDropdown = toggleClientActionDropdown;
window.handleCommClientDropdownAction = handleCommClientDropdownAction;
window.closeCommActionDropdown = closeCommActionDropdown;

// 3. Métricas Rápidas no Admin
function updateCommercialMetrics() {
  const activeCount = commercialClientsList.filter(c => c.lifecycle_status === 'ativo').length;
  const testCount = commercialClientsList.filter(c => c.lifecycle_status === 'teste').length;
  let totalTelesCount = 0;
  if (Array.isArray(window.allTelesList) && window.allTelesList.length > 0) {
    totalTelesCount = window.allTelesList.filter(t => t.client_id || t.commercial_client_id).length;
  } else if (Array.isArray(mockData.clientHistory)) {
    totalTelesCount = mockData.clientHistory.length;
  }

  let totalOpenBalance = 0;
  commercialClientsList.forEach(c => {
    if (c.open_balance) {
      totalOpenBalance += Number(c.open_balance) || 0;
    }
  });

  const elActive = document.getElementById('comm-metric-active-count');
  const elTest = document.getElementById('comm-metric-test-count');
  const elTotal = document.getElementById('comm-metric-total-teles');
  const elBalance = document.getElementById('comm-metric-open-balance');

  if (elActive) elActive.innerText = activeCount;
  if (elTest) elTest.innerText = testCount;
  if (elTotal) elTotal.innerText = totalTelesCount;
  if (elBalance) elBalance.innerText = `R$ ${totalOpenBalance.toFixed(2).replace('.', ',')}`;
}

let commClientLocationState = {
  formatted_address: '',
  place_id: '',
  latitude: null,
  longitude: null,
  street_number: '',
  route: '',
  neighborhood: '',
  city: '',
  state: '',
  postal_code: '',
  isManualPin: false
};

window.commClientLocationState = commClientLocationState;
window.setCommClientLocationState = function(state) {
  commClientLocationState = { ...commClientLocationState, ...state };
};

let commMiniMap = null;
let commMiniMarker = null;

function resetCommClientLocationState() {
  commClientLocationState = {
    formatted_address: '',
    place_id: '',
    latitude: null,
    longitude: null,
    street_number: '',
    route: '',
    neighborhood: '',
    city: '',
    state: '',
    postal_code: '',
    isManualPin: false
  };
  if (commMiniMarker) {
    commMiniMarker.setMap(null);
    commMiniMarker = null;
  }
}

async function initCommClientLocationControls() {
  const addressInput = document.getElementById('comm-address');
  const mapContainer = document.getElementById('comm-mini-map');
  if (!addressInput || !mapContainer) return;

  try {
    await loadGoogleMapsApi();
    if (!window.google?.maps) return;

    const defaultCenter = new window.google.maps.LatLng(-29.8333, -51.1444);

    if (!commMiniMap) {
      commMiniMap = new window.google.maps.Map(mapContainer, {
        center: defaultCenter,
        zoom: 14,
        mapTypeId: window.google.maps.MapTypeId.ROADMAP,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
        zoomControl: true
      });
    } else {
      window.google.maps.event.trigger(commMiniMap, 'resize');
    }

    if (!addressInput.dataset.autocompleteAttached) {
      addressInput.dataset.autocompleteAttached = 'true';
      const options = {
        componentRestrictions: { country: "br" },
        fields: ["address_components", "geometry", "formatted_address", "place_id"],
        types: ["address"]
      };

      const autocomplete = new window.google.maps.places.Autocomplete(addressInput, options);

      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (!place || !place.geometry || !place.geometry.location) {
          alert("Endereço não encontrado ou inválido. Por favor, escolha um endereço válido sugerido pela lista.");
          return;
        }

        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();

        commClientLocationState.formatted_address = place.formatted_address || addressInput.value.trim();
        commClientLocationState.place_id = place.place_id || '';
        commClientLocationState.latitude = lat;
        commClientLocationState.longitude = lng;
        commClientLocationState.isManualPin = false;

        commClientLocationState.street_number = '';
        commClientLocationState.route = '';
        commClientLocationState.neighborhood = '';
        commClientLocationState.city = '';
        commClientLocationState.state = '';
        commClientLocationState.postal_code = '';

        if (place.address_components) {
          for (const comp of place.address_components) {
            const types = comp.types || [];
            if (types.includes('street_number')) commClientLocationState.street_number = comp.long_name;
            if (types.includes('route')) commClientLocationState.route = comp.long_name;
            if (types.includes('sublocality_level_1') || types.includes('sublocality') || types.includes('neighborhood')) {
              if (!commClientLocationState.neighborhood) commClientLocationState.neighborhood = comp.long_name;
            }
            if (types.includes('locality') || types.includes('administrative_area_level_2')) {
              if (!commClientLocationState.city) commClientLocationState.city = comp.long_name;
            }
            if (types.includes('administrative_area_level_1')) commClientLocationState.state = comp.short_name || comp.long_name;
            if (types.includes('postal_code')) commClientLocationState.postal_code = comp.long_name;
          }
        }

        addressInput.value = commClientLocationState.formatted_address;
        updateCommMiniMapMarker(lat, lng, true);
      });
    }
  } catch (err) {
    console.warn("Aviso ao inicializar Google Places / Mapa no cadastro de cliente:", err.message || err);
  }
}

function updateCommMiniMapMarker(lat, lng, panTo = true) {
  if (!commMiniMap || typeof window.google === 'undefined' || typeof window.google.maps === 'undefined') return;

  const latLng = new window.google.maps.LatLng(lat, lng);
  if (panTo) {
    commMiniMap.setCenter(latLng);
    commMiniMap.setZoom(17);
  }

  if (commMiniMarker) {
    commMiniMarker.setPosition(latLng);
    commMiniMarker.setMap(commMiniMap);
  } else {
    commMiniMarker = new window.google.maps.Marker({
      position: latLng,
      map: commMiniMap,
      title: 'Ponto Exato da Coleta',
      draggable: true
    });

    commMiniMarker.addListener('dragend', () => {
      const newPos = commMiniMarker.getPosition();
      commClientLocationState.latitude = newPos.lat();
      commClientLocationState.longitude = newPos.lng();
      commClientLocationState.isManualPin = true;
      if (typeof showToastNotification === 'function') {
        showToastNotification('Ponto de coleta ajustado manualmente no mapa.');
      }
    });
  }
}

function openAddCommercialClientModal() {
  const modal = document.getElementById('modal-add-commercial-client');
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    resetCommClientLocationState();
    setTimeout(() => {
      initCommClientLocationControls();
    }, 150);
  }
}
window.openAddCommercialClientModal = openAddCommercialClientModal;

function closeAddCommercialClientModal(event) {
  if (event && event.target && !event.target.classList.contains('modal-overlay') && !event.target.classList.contains('modal-close-btn') && !event.target.closest('.modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('modal-add-commercial-client');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}
window.closeAddCommercialClientModal = closeAddCommercialClientModal;

let isSubmittingCommercialClient = false;

async function submitAddCommercialClient(event) {
  if (event) event.preventDefault();

  if (isSubmittingCommercialClient) return;

  const submitBtn = document.querySelector('#modal-add-commercial-client form button[type="submit"]');

  const establishment_name = document.getElementById('comm-establishment-name')?.value.trim();
  const responsible_name = document.getElementById('comm-responsible-name')?.value.trim();
  const phone = document.getElementById('comm-phone')?.value.trim();
  const email = document.getElementById('comm-email')?.value.trim();
  const password = document.getElementById('comm-password')?.value.trim();
  const rawAddressInput = document.getElementById('comm-address')?.value.trim();
  const complement = document.getElementById('comm-complement')?.value.trim() || '';
  const documentNum = document.getElementById('comm-document')?.value.trim() || '';
  const map_color = document.getElementById('comm-map-color')?.value || '#ffb700';
  const lifecycle_status = document.getElementById('comm-lifecycle-status')?.value || 'ativo';
  const notes = document.getElementById('comm-notes')?.value.trim() || '';

  const address = commClientLocationState.formatted_address || rawAddressInput;
  let lat = commClientLocationState.latitude;
  let lng = commClientLocationState.longitude;

  if (!establishment_name || !responsible_name || !phone || !email || !password || !rawAddressInput) {
    showToastNotification('Preencha todos os campos obrigatórios (estabelecimento, responsável, telefone, e-mail, senha e endereço).');
    return;
  }

  if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) {
    lat = -29.8245;
    lng = -51.1412;
  }

  isSubmittingCommercialClient = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.dataset.origText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>Cadastrando...</span>';
  }

  showToastNotification('Criando cliente comercial e salvando ponto autoritativo de coleta...');

  try {
    const payload = {
      establishment_name,
      responsible_name,
      phone,
      email,
      password,
      address,
      complement,
      neighborhood: commClientLocationState.neighborhood || '',
      city: commClientLocationState.city || '',
      postal_code: commClientLocationState.postal_code || '',
      document: documentNum,
      map_color,
      lifecycle_status,
      notes,
      pickup_latitude: lat,
      pickup_longitude: lng,
      pickup_place_id: commClientLocationState.place_id || '',
      street_number: commClientLocationState.street_number || '',
      route: commClientLocationState.route || '',
      state: commClientLocationState.state || ''
    };

    let data = null;
    let invokeError = null;

    if (supabaseClient) {
      const res = await supabaseClient.functions.invoke('create-client-user', {
        body: payload
      });
      data = res.data;
      invokeError = res.error;

      // Se no ambiente local a Edge Function retornar HTTP 404 real (sem container de Edge Functions rodando no Supabase local), provisionar de forma autoritativa localmente
      const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (invokeError && isLocalHost && invokeError.context?.status === 404) {
        try {
          const isLocalEnv = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
          if (isLocalEnv) {
            console.log('[LOCAL PROVISIONER] Executando provisionamento autoritativo local no Supabase 127.0.0.1...');

            const { data: sessData } = await supabaseClient.auth.getSession();
            const accessToken = sessData?.session?.access_token;

            if (!accessToken) {
              throw new Error('Sessão administrativa não encontrada no navegador.');
            }

            const localApiRes = await fetch('/api/admin/create-client', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
              },
              body: JSON.stringify(payload)
            });
            const localJson = await localApiRes.json();
            if (localApiRes.ok) {
              data = localJson;
              invokeError = null;
            } else {
              invokeError = new Error(localJson.error || 'Falha ao concluir o cadastro do cliente no ambiente local.');
            }
          }
        } catch (localErr) {
          console.warn("Aviso no provisionamento local:", localErr.message);
        }
      }
    } else {
      throw new Error('Conexão Supabase não inicializada no navegador.');
    }

    let errMsg = null;
    if (invokeError) {
      errMsg = invokeError.message || 'Não foi possível concluir o cadastro. Nenhuma alteração foi realizada.';
    }

    if (!errMsg && data && data.error) {
      errMsg = data.error;
    }

    if (errMsg) {
      throw new Error(errMsg);
    }

    const createdClient = normalizeCommercialClient(data?.client);
    if (createdClient && createdClient.id) {
      commercialClientsList = [createdClient, ...commercialClientsList.filter(c => c.id !== createdClient.id)];
      renderCommercialClientsTable();
    }
    showToastNotification(`Cliente "${establishment_name}" (${createdClient?.client_code || createdClient?.public_code || 'CLI'}) cadastrado com sucesso!`);

    // Reset form & location state on success
    const form = document.querySelector('#modal-add-commercial-client form');
    if (form) form.reset();
    resetCommClientLocationState();

    closeAddCommercialClientModal();
    await loadCommercialClientsModule();
    return createdClient;

  } catch (err) {
    console.error("Erro ao cadastrar cliente:", err);
    showToastNotification(`Falha no cadastro: ${err.message}`);
  } finally {
    isSubmittingCommercialClient = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      if (submitBtn.dataset.origText) submitBtn.innerHTML = submitBtn.dataset.origText;
    }
  }
}
window.submitAddCommercialClient = submitAddCommercialClient;

// 4.1. Modal de Configuração do Ponto de Coleta do Cliente Comercial
let configurePickupMap = null;
let configurePickupMarker = null;
let configurePickupLocationState = {
  address: '',
  latitude: null,
  longitude: null,
  place_id: '',
  city: '',
  state: ''
};

async function openConfigureClientPickupModal(clientId) {
  const client = commercialClientsList.find(c => String(c.id) === String(clientId)) || Array.from(opClientsStoreMap.values()).find(c => String(c.id) === String(clientId));
  if (!client) {
    alert("Cliente não encontrado.");
    return;
  }

  document.getElementById('configure-pickup-client-id').value = clientId;
  document.getElementById('configure-pickup-modal-title').innerText = `Ponto de Coleta — ${client.establishment_name}`;
  const addressInput = document.getElementById('configure-pickup-address');
  if (addressInput) addressInput.value = client.address || client.pickup_address || '';

  const modal = document.getElementById('modal-configure-client-pickup');
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }

  const initialLat = (client.pickup_latitude && !isNaN(Number(client.pickup_latitude))) ? Number(client.pickup_latitude) : -29.8247;
  const initialLng = (client.pickup_longitude && !isNaN(Number(client.pickup_longitude))) ? Number(client.pickup_longitude) : -51.1444;

  configurePickupLocationState = {
    address: client.address || '',
    latitude: initialLat,
    longitude: initialLng,
    place_id: client.pickup_place_id || '',
    city: client.city || '',
    state: client.state || ''
  };

  setTimeout(async () => {
    try {
      await loadGoogleMapsApi();
      const container = document.getElementById('configure-pickup-map');
      if (!container) return;

      const pos = { lat: initialLat, lng: initialLng };

      if (!configurePickupMap) {
        configurePickupMap = new window.google.maps.Map(container, {
          center: pos,
          zoom: 15,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          zoomControl: true
        });

        configurePickupMarker = new window.google.maps.Marker({
          position: pos,
          map: configurePickupMap,
          draggable: true,
          title: 'Ponto de Coleta'
        });

        configurePickupMarker.addListener('dragend', (evt) => {
          if (evt && evt.latLng) {
            configurePickupLocationState.latitude = evt.latLng.lat();
            configurePickupLocationState.longitude = evt.latLng.lng();
          }
        });
      } else {
        window.google.maps.event.trigger(configurePickupMap, 'resize');
        configurePickupMap.setCenter(pos);
        if (configurePickupMarker) configurePickupMarker.setPosition(pos);
      }

      if (addressInput && !addressInput.dataset.autocompleteAttached) {
        addressInput.dataset.autocompleteAttached = 'true';
        const autocomplete = new window.google.maps.places.Autocomplete(addressInput, {
          componentRestrictions: { country: "br" },
          bounds: new window.google.maps.LatLngBounds({ lat: -33.75, lng: -57.65 }, { lat: -27.08, lng: -49.69 }),
          fields: ["address_components", "geometry", "formatted_address", "place_id"]
        });

        autocomplete.addListener('place_changed', () => {
          const place = autocomplete.getPlace();
          if (place && place.geometry && place.geometry.location) {
            const lat = place.geometry.location.lat();
            const lng = place.geometry.location.lng();
            configurePickupLocationState.latitude = lat;
            configurePickupLocationState.longitude = lng;
            configurePickupLocationState.address = place.formatted_address;
            configurePickupLocationState.place_id = place.place_id || '';
            if (configurePickupMap) configurePickupMap.setCenter({ lat, lng });
            if (configurePickupMarker) configurePickupMarker.setPosition({ lat, lng });
          }
        });
      }
    } catch (err) {
      console.warn("Error loading configurePickupMap:", err);
    }
  }, 200);

  if (window.lucide) window.lucide.createIcons();
}

function closeConfigureClientPickupModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById('modal-configure-client-pickup');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

async function submitConfigureClientPickup(event) {
  if (event) event.preventDefault();
  const clientId = document.getElementById('configure-pickup-client-id')?.value;
  const address = document.getElementById('configure-pickup-address')?.value?.trim();

  if (!clientId) {
    alert("Cliente não selecionado.");
    return;
  }
  if (!address) {
    alert("Informe o endereço de coleta.");
    return;
  }

  let lat = configurePickupLocationState.latitude;
  let lng = configurePickupLocationState.longitude;

  if (configurePickupMarker && typeof configurePickupMarker.getPosition === 'function') {
    const pos = configurePickupMarker.getPosition();
    if (pos) {
      lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
      lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
    }
  }

  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    alert("Selecione um endereço ou confirme o marcador no mapa para obter as coordenadas do ponto de coleta.");
    return;
  }

  try {
    if (supabaseClient) {
      // Obter registro autoritativo atual do cliente no banco para preservar integralmente todos os campos cadastrais
      const { data: dbClient, error: dbFetchErr } = await supabaseClient
        .from('commercial_clients')
        .select('id, responsible_name, phone, address, street_number, neighborhood, city, state, postal_code')
        .eq('id', clientId)
        .maybeSingle();

      if (dbFetchErr || !dbClient) {
        throw new Error("Cliente comercial não localizado no banco de dados.");
      }

      const cleanResp = (dbClient.responsible_name || '').trim();
      const cleanPhone = (dbClient.phone || '').trim();
      const cleanCity = (configurePickupLocationState.city || dbClient.city || 'Sapucaia do Sul').trim();
      const cleanState = (configurePickupLocationState.state || dbClient.state || 'RS').trim().toUpperCase();

      if (cleanResp.length < 2 || cleanPhone.length < 8) {
        throw new Error("Dados cadastrais do cliente (responsável/telefone) incompletos para atualização.");
      }

      const { data: resData, error: rpcErr } = await supabaseClient.rpc('admin_update_commercial_client_profile', {
        p_client_id: clientId,
        p_responsible_name: cleanResp,
        p_phone: cleanPhone,
        p_address: address,
        p_street_number: dbClient.street_number || null,
        p_neighborhood: dbClient.neighborhood || null,
        p_city: cleanCity || 'Sapucaia do Sul',
        p_state: cleanState === 'RS' ? 'RS' : 'RS',
        p_postal_code: dbClient.postal_code || null,
        p_pickup_latitude: Number(lat),
        p_pickup_longitude: Number(lng),
        p_pickup_place_id: configurePickupLocationState.place_id || null
      });

      if (rpcErr) throw rpcErr;
      if (resData && !resData.success) {
        throw new Error(resData.message || 'Erro ao atualizar ponto de coleta no banco de dados.');
      }

      // Confirmação pós-UPDATE: re-consultar no Supabase para garantir que persistiu
      const { data: verifiedData, error: verifyErr } = await supabaseClient
        .from('commercial_clients')
        .select('id, address, pickup_latitude, pickup_longitude, pickup_place_id')
        .eq('id', clientId)
        .maybeSingle();

      if (verifyErr || !verifiedData) {
        throw new Error("Não foi possível confirmar a gravação do ponto de coleta no banco de dados.");
      }

      if (verifiedData.pickup_latitude == null || verifiedData.pickup_longitude == null || isNaN(Number(verifiedData.pickup_latitude)) || isNaN(Number(verifiedData.pickup_longitude))) {
        throw new Error("As coordenadas do ponto de coleta não foram gravadas corretamente no banco de dados.");
      }
    } else {
      const client = opClientsStoreMap.get(String(clientId));
      if (client) {
        client.address = address;
        client.pickup_address = address;
        client.pickup_latitude = lat;
        client.pickup_longitude = lng;
        client.pickup_place_id = configurePickupLocationState.place_id || null;
      }
    }

    // Somente após confirmação de persistência no Supabase:
    await fetchCommercialClientsForSelect();
    await loadCommercialClientsModule();
    closeConfigureClientPickupModal();
    showToastNotification("Ponto de coleta salvo com sucesso!");
  } catch (err) {
    console.error("Erro ao atualizar ponto de coleta:", err);
    showToastNotification(`Falha ao salvar ponto de coleta: ${err.message || 'Erro de persistência.'}`);
  }
}

window.openConfigureClientPickupModal = openConfigureClientPickupModal;
window.closeConfigureClientPickupModal = closeConfigureClientPickupModal;
window.submitConfigureClientPickup = submitConfigureClientPickup;

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

let pendingRecoverClientId = null;

function openRecoverClientAccessModal(clientId) {
  const client = commercialClientsList.find(c => String(c.id) === String(clientId));
  if (!client) return;

  const email = (client.email || '').trim();
  if (!email || email === '—' || email === 'Não informado' || !email.includes('@')) {
    showToastNotification("Este cliente não possui um e-mail de acesso válido cadastrado.", "warning");
    return;
  }

  pendingRecoverClientId = clientId;

  const nameEl = document.getElementById('recover-modal-client-name');
  const emailEl = document.getElementById('recover-modal-client-email');
  const noticeEl = document.getElementById('recover-modal-notice');
  const btn = document.getElementById('btn-confirm-recover-client-access');

  if (nameEl) nameEl.textContent = client.establishment_name;
  if (emailEl) emailEl.textContent = email;
  if (noticeEl) {
    noticeEl.classList.add('hidden');
    noticeEl.textContent = '';
  }
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="mail" style="width: 14px; height: 14px;"></i> Enviar Recuperação`;
  }

  const modal = document.getElementById('modal-recover-client-access');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

function closeRecoverClientAccessModal(event) {
  if (event && event.target && !event.target.classList.contains('modal-overlay') && !event.target.classList.contains('modal-close-btn') && !event.target.closest('.modal-close-btn') && event.target.tagName !== 'BUTTON') {
    return;
  }
  pendingRecoverClientId = null;
  const modal = document.getElementById('modal-recover-client-access');
  if (modal) modal.classList.add('hidden');
}

async function submitRecoverClientAccess() {
  if (!pendingRecoverClientId) return;

  const client = commercialClientsList.find(c => String(c.id) === String(pendingRecoverClientId));
  if (!client) {
    closeRecoverClientAccessModal();
    return;
  }

  const email = (client.email || '').trim();
  if (!email || !email.includes('@')) {
    showToastNotification("Este cliente não possui um e-mail de acesso válido cadastrado.", "warning");
    closeRecoverClientAccessModal();
    return;
  }

  const btn = document.getElementById('btn-confirm-recover-client-access');
  const noticeEl = document.getElementById('recover-modal-notice');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 6px;"></span> Enviando...`;
  }

  try {
    if (supabaseClient && supabaseClient.auth) {
      const redirectTo = `${window.location.origin}/index.html`;
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
    }

    showToastNotification(`Instruções de recuperação enviadas para ${email}.`);
    pendingRecoverClientId = null;
    const modal = document.getElementById('modal-recover-client-access');
    if (modal) modal.classList.add('hidden');
  } catch (err) {
    console.error("Erro ao enviar e-mail de recuperação de acesso:", err);
    if (noticeEl) {
      noticeEl.textContent = `Erro ao enviar e-mail: ${err.message || 'Falha na comunicação com o servidor de autenticação.'}`;
      noticeEl.classList.remove('hidden');
    }
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="mail" style="width: 14px; height: 14px;"></i> Tentar Novamente`;
    }
  }
}

function resetClientAccess(clientId) {
  openRecoverClientAccessModal(clientId);
}

// Listener de Recuperação de Senha (PASSWORD_RECOVERY)
function setupPasswordRecoveryListener() {
  if (!supabaseClient || !supabaseClient.auth) return;

  try {
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        console.log('[AUTH RECOVERY] Evento PASSWORD_RECOVERY detectado.');
        openUpdatePasswordModal();
      }
    });
  } catch (err) {
    console.warn('[AUTH RECOVERY] Aviso ao configurar onAuthStateChange:', err.message);
  }

  // Validação de segurança complementar para hash de URL de recuperação
  if (typeof window !== 'undefined' && window.location && window.location.hash && window.location.hash.includes('type=recovery')) {
    openUpdatePasswordModal();
  }
}

function openUpdatePasswordModal() {
  const modal = document.getElementById('modal-update-password');
  if (modal) modal.classList.remove('hidden');
  const pwdInput = document.getElementById('update-new-password');
  if (pwdInput) pwdInput.focus();
  if (window.lucide) window.lucide.createIcons();
}

function closeUpdatePasswordModal(event) {
  if (event && event.target && !event.target.classList.contains('modal-overlay') && !event.target.classList.contains('modal-close-btn') && !event.target.closest('.modal-close-btn') && event.target.tagName !== 'BUTTON') {
    return;
  }
  const modal = document.getElementById('modal-update-password');
  if (modal) modal.classList.add('hidden');
}

async function submitUpdatePassword(event) {
  if (event) event.preventDefault();

  const newPwd = (document.getElementById('update-new-password')?.value || '').trim();
  const confirmPwd = (document.getElementById('update-confirm-password')?.value || '').trim();
  const noticeEl = document.getElementById('update-password-notice');
  const btn = document.getElementById('btn-submit-update-password');

  if (!newPwd || newPwd.length < 6) {
    if (noticeEl) {
      noticeEl.textContent = 'A nova senha deve ter no mínimo 6 caracteres.';
      noticeEl.classList.remove('hidden');
    }
    return;
  }

  if (newPwd !== confirmPwd) {
    if (noticeEl) {
      noticeEl.textContent = 'As senhas digitadas não coincidem.';
      noticeEl.classList.remove('hidden');
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 6px;"></span> Atualizando...`;
  }

  try {
    if (supabaseClient && supabaseClient.auth) {
      const { error } = await supabaseClient.auth.updateUser({ password: newPwd });
      if (error) throw error;
    }

    showToastNotification('Sua nova senha foi salva com sucesso!');
    closeUpdatePasswordModal();
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  } catch (err) {
    console.error('Erro ao redefinir senha:', err);
    if (noticeEl) {
      noticeEl.textContent = `Erro ao salvar senha: ${err.message || 'Falha no servidor de autenticação.'}`;
      noticeEl.classList.remove('hidden');
    }
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Salvar Nova Senha';
    }
  }
}

// 6. Contexto Administrativo de Visualização do Cliente Comercial
// (adminClientViewContext foi declarada no topo do arquivo)

// Resolvedor Central de Contexto Ativo de Cliente Comercial
function resolveActiveClientContext() {
  // Cenário 1: Admin visualizando cliente comercial específico (Impersonation Mode)
  if (typeof adminClientViewContext !== 'undefined' && adminClientViewContext && adminClientViewContext.clientId) {
    return {
      isAdminView: true,
      clientId: adminClientViewContext.clientId,
      clientCode: adminClientViewContext.clientCode || 'CLI-000000',
      establishmentName: adminClientViewContext.establishmentName || 'Cliente Comercial',
      source: 'admin_view_context'
    };
  }

  // Cenário 2: Cliente comercial autenticado diretamente
  if (typeof activeCommercialClient !== 'undefined' && activeCommercialClient && activeCommercialClient.id) {
    return {
      isAdminView: false,
      clientId: activeCommercialClient.id,
      clientCode: activeCommercialClient.client_code || activeCommercialClient.public_code || 'CLI-000000',
      establishmentName: activeCommercialClient.establishment_name || 'Meu Estabelecimento',
      source: 'active_commercial_client'
    };
  }

  if (typeof currentClientProfile !== 'undefined' && currentClientProfile && currentClientProfile.client_id) {
    return {
      isAdminView: false,
      clientId: currentClientProfile.client_id,
      clientCode: currentClientProfile.client_code || 'CLI-000000',
      establishmentName: currentClientProfile.establishment_name || 'Meu Estabelecimento',
      source: 'current_client_profile'
    };
  }

  if (typeof window !== 'undefined' && window.currentClientProfile && window.currentClientProfile.client_id) {
    return {
      isAdminView: false,
      clientId: window.currentClientProfile.client_id,
      clientCode: window.currentClientProfile.client_code || 'CLI-000000',
      establishmentName: window.currentClientProfile.establishment_name || 'Meu Estabelecimento',
      source: 'window_client_profile'
    };
  }

  const userRole = String(typeof currentAdminProfile !== 'undefined' && currentAdminProfile?.role || '').trim().toLowerCase();
  const isClientUser = (userRole === 'client_user' || userRole === 'client' || mockData?.activeProfile === 'client');

  if (isClientUser && typeof currentAdminProfile !== 'undefined' && currentAdminProfile && currentAdminProfile.client_id) {
    return {
      isAdminView: false,
      clientId: currentAdminProfile.client_id,
      clientCode: currentAdminProfile.email || 'CLI-000000',
      establishmentName: currentAdminProfile.name || 'Meu Estabelecimento',
      source: 'authenticated_client_profile'
    };
  }

  // Para client_user autenticado diretamente, RLS restringe commercialClientsList estritamente ao seu próprio estabelecimento
  if (isClientUser && typeof commercialClientsList !== 'undefined' && Array.isArray(commercialClientsList) && commercialClientsList.length > 0) {
    const clientRecord = (currentAdminProfile && currentAdminProfile.client_id)
      ? (commercialClientsList.find(c => String(c.id) === String(currentAdminProfile.client_id)) || commercialClientsList[0])
      : commercialClientsList[0];

    if (clientRecord && clientRecord.id) {
      return {
        isAdminView: false,
        clientId: clientRecord.id,
        clientCode: clientRecord.client_code || clientRecord.public_code || 'CLI-000000',
        establishmentName: clientRecord.establishment_name || 'Meu Estabelecimento',
        source: 'client_user_rls_commercial_client'
      };
    }
  }

  // STRICT FAIL CLOSED: Sem fallback arbitrário para admin (owner/manager) nem user_id
  return null;
}

window.resolveActiveClientContext = resolveActiveClientContext;

async function openAdminClientPanelView(clientId) {
  if (!clientId) {
    console.error("[ADMIN CLIENT VIEW] Falha ao abrir painel: clientId não fornecido.");
    showToastNotification("Selecione um cliente comercial válido.", "error");
    return;
  }

  if (!commercialClientsList || commercialClientsList.length === 0) {
    if (typeof fetchCommercialClients === 'function') {
      await fetchCommercialClients();
    }
  }
  let client = (commercialClientsList || []).find(c => String(c.id) === String(clientId));
  if (!client && typeof window !== 'undefined' && Array.isArray(window.commercialClientsList)) {
    client = window.commercialClientsList.find(c => String(c.id) === String(clientId));
  }
  if (!client) {
    console.error(`[ADMIN CLIENT VIEW] Cliente não encontrado no sistema (ID: ${clientId}).`);
    showToastNotification("Cliente comercial não encontrado.", "error");
    return;
  }

  // 1. Registra auditoria obrigatória no backend Supabase via RPC
  if (supabaseClient) {
    try {
      const { data: auditRes, error: auditErr } = await supabaseClient.rpc('admin_log_client_panel_access', {
        p_client_id: client.id
      });

      if (auditErr || !auditRes || !auditRes.success) {
        console.error("[ADMIN CLIENT VIEW] Falha no registro de auditoria de acesso:", auditErr?.message || auditRes);
        showToastNotification("Não foi possível abrir o painel do cliente com segurança. Tente novamente.", "error");
        return; // FAIL CLOSED: Se a auditoria falhar, cancela a transição de visualização
      }
    } catch (err) {
      console.error("[ADMIN CLIENT VIEW] Erro inesperado ao invocar RPC de auditoria:", err);
      showToastNotification("Não foi possível abrir o painel do cliente com segurança. Tente novamente.", "error");
      return; // FAIL CLOSED
    }
  }

  // 2. Define o Contexto Administrativo Explícito de Visualização
  adminClientViewContext = {
    clientId: client.id,
    clientCode: client.client_code || client.public_code || 'CLI-000000',
    establishmentName: client.establishment_name,
    responsibleName: client.responsible_name,
    email: client.email || client.email_normalized
  };

  activeCommercialClient = client;

  // 3. Atualizar estado visual do aplicativo para refletir a visão administrativa
  mockData.activeProfile = 'client';
  if (mockData.credentials && mockData.credentials.client) {
    mockData.credentials.client.commerceName = client.establishment_name;
    mockData.credentials.client.name = client.responsible_name;
    mockData.credentials.client.email = client.email;
  }

  const clientActionCards = document.getElementById('client-action-cards');
  if (clientActionCards) {
    clientActionCards.classList.remove('hidden');
  }

  loginSuccess();
  switchDashboardTab('client-overview');
  loadClientOverviewDashboard();
  renderAdminClientViewBanner();
  showToastNotification(`Visualizando Painel Administrativo como [${client.establishment_name}] (${adminClientViewContext.clientCode})`);
}

function renderAdminClientViewBanner() {
  let banner = document.getElementById('admin-client-view-banner');
  if (!adminClientViewContext) {
    if (banner) banner.remove();
    return;
  }

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'admin-client-view-banner';
    banner.className = 'admin-view-indicator-banner';

    const clientView = document.getElementById('view-client-dashboard') || document.getElementById('app');
    if (clientView) {
      clientView.prepend(banner);
    } else {
      document.body.prepend(banner);
    }
  }

  banner.innerHTML = `
    <div class="admin-banner-content">
      <i data-lucide="shield-alert" style="width: 18px; height: 18px; color: var(--warning);"></i>
      <span>Visualização administrativa — <strong>${escapeHtml(adminClientViewContext.establishmentName)}</strong> (${escapeHtml(adminClientViewContext.clientCode)})</span>
    </div>
    <button class="btn btn-secondary btn-sm" onclick="exitAdminClientPanelView()" style="padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">
      <i data-lucide="arrow-left" style="width: 14px; height: 14px;"></i> <span>Voltar ao Admin</span>
    </button>
  `;

  if (window.lucide) window.lucide.createIcons({ el: banner });
}

function exitAdminClientPanelView() {
  adminClientViewContext = null;
  activeCommercialClient = null;
  mockData.activeProfile = 'owner';

  const banner = document.getElementById('admin-client-view-banner');
  if (banner) banner.remove();

  switchDashboardTab('owner-overview');
  showToastNotification("Visualização administrativa do cliente encerrada.");
}

// Aliases globais seguros
window.openAdminClientPanelView = openAdminClientPanelView;
window.exitAdminClientPanelView = exitAdminClientPanelView;

async function getActiveClientContextId() {
  const ctx = typeof resolveActiveClientContext === 'function' ? resolveActiveClientContext() : null;
  if (ctx && ctx.clientId) return ctx.clientId;
  if (adminClientViewContext && adminClientViewContext.clientId) return adminClientViewContext.clientId;
  if (activeCommercialClient && activeCommercialClient.id) return activeCommercialClient.id;
  return null;
}

async function loadClientFinancialsData() {
  const clientId = await getActiveClientContextId();
  const openBalanceEl = document.getElementById('client-fin-open-balance');
  const billedTotalEl = document.getElementById('client-fin-billed-total');
  const paidTotalEl = document.getElementById('client-fin-paid-total');
  const telesCountEl = document.getElementById('client-fin-teles-count');

  if (!clientId || !supabaseClient) {
    if (openBalanceEl) openBalanceEl.innerText = 'R$ 0,00';
    if (billedTotalEl) billedTotalEl.innerText = 'R$ 0,00';
    if (paidTotalEl) paidTotalEl.innerText = 'R$ 0,00';
    if (telesCountEl) telesCountEl.innerText = '0';
    return;
  }

  try {
    const { data: allTxs } = await supabaseClient
      .from('client_financial_transactions')
      .select('*')
      .eq('client_id', clientId);

    const txs = allTxs || [];
    let openBalance = 0;
    let billedTotal = 0;
    let paidTotal = 0;
    let telesCount = 0;

    txs.forEach(t => {
      const amt = Number(t.amount || 0);
      if (t.direction === 'debit') {
        openBalance += amt;
        billedTotal += amt;
        if (t.type === 'cobranca_entrega' || t.tele_id) telesCount++;
      } else {
        openBalance -= amt;
        paidTotal += amt;
      }
    });

    if (openBalanceEl) openBalanceEl.innerText = formatCurrency(Math.max(0, openBalance));
    if (billedTotalEl) billedTotalEl.innerText = formatCurrency(billedTotal);
    if (paidTotalEl) paidTotalEl.innerText = formatCurrency(paidTotal);
    if (telesCountEl) telesCountEl.innerText = String(telesCount);
  } catch (err) {
    console.error('Erro ao carregar resumo financeiro do cliente:', err);
  }
}

async function loadClientExtractData() {
  const clientId = await getActiveClientContextId();
  const tbody = document.getElementById('client-panel-extract-table-body');
  if (!tbody) return;

  if (!clientId || !supabaseClient) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: var(--color-text-muted);">Nenhuma movimentação encontrada no período.</td></tr>`;
    return;
  }

  try {
    const { data: allTxs } = await supabaseClient
      .from('client_financial_transactions')
      .select('*, teles(tele_code)')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true });

    const txs = allTxs || [];
    if (txs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: var(--color-text-muted);">Nenhuma movimentação encontrada no período.</td></tr>`;
      return;
    }

    let runningBalance = 0;
    const rowsHtml = txs.map(t => {
      const amt = Number(t.amount || 0);
      const isDebit = t.direction === 'debit';
      if (isDebit) {
        runningBalance += amt;
      } else {
        runningBalance -= amt;
      }

      const dateStr = typeof formatTimestampBR === 'function' ? formatTimestampBR(t.created_at) : String(t.created_at || '');
      const refStr = t.teles?.tele_code ? `TEL-${t.teles.tele_code}` : (t.tele_id ? `TEL-${t.tele_id.slice(0,8)}` : 'N/A');
      const typeLabel = t.type === 'cobranca_entrega' ? 'Cobrança Tele' : (t.type === 'pagamento_recebido' ? 'Pagamento Recebido' : t.type);
      const debitVal = isDebit ? formatCurrency(amt) : '-';
      const creditVal = !isDebit ? formatCurrency(amt) : '-';
      const runningVal = formatCurrency(runningBalance);

      return `
        <tr>
          <td>${escapeHtml(dateStr)}</td>
          <td><strong style="color: var(--color-text);">${escapeHtml(refStr)}</strong></td>
          <td><span class="badge ${isDebit ? 'badge-secondary' : 'badge-success'}">${escapeHtml(typeLabel)}</span></td>
          <td>${escapeHtml(t.description || '-')}</td>
          <td style="color: #ef4444;">${debitVal}</td>
          <td style="color: #10b981;">${creditVal}</td>
          <td><strong>${runningVal}</strong></td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = rowsHtml;
  } catch (err) {
    console.error('Erro ao carregar extrato de conta corrente do cliente:', err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #ef4444;">Erro ao carregar extrato.</td></tr>`;
  }
}

window.loadClientFinancialsData = loadClientFinancialsData;
window.loadClientExtractData = loadClientExtractData;
window.exitAdminClientPanelView = exitAdminClientPanelView;
window.openTestClientPanel = openAdminClientPanelView; // Alias seguro para compatibilidade

function updateClientOrderSummaryPreview() {
  const pickupVal = document.getElementById('client-pickup-address')?.value || 'Retirada cadastrada';
  const deliveryVal = document.getElementById('client-delivery-address')?.value?.trim() || 'Ainda não informado';
  const priceVal = document.getElementById('client-delivery-price')?.value?.trim() || '--';
  const orderValueVal = document.getElementById('client-order-value')?.value?.trim() || '--';
  const cargoSelect = document.getElementById('client-cargo-type');
  const cargoText = cargoSelect ? cargoSelect.options[cargoSelect.selectedIndex]?.text : 'Lanches e Bebidas';
  const paymentSelect = document.getElementById('client-payment-method');
  const paymentText = paymentSelect ? paymentSelect.options[paymentSelect.selectedIndex]?.text : 'PIX';

  const sumPickup = document.getElementById('summary-pickup-val');
  if (sumPickup) sumPickup.innerText = pickupVal;

  const sumDelivery = document.getElementById('summary-delivery-val');
  if (sumDelivery) sumDelivery.innerText = deliveryVal;

  const sumPrice = document.getElementById('summary-tele-price-val');
  if (sumPrice) sumPrice.innerText = priceVal.startsWith('R$') ? priceVal : (priceVal !== '--' ? `R$ ${priceVal}` : 'R$ --');

  const sumOrderVal = document.getElementById('summary-order-value-val');
  if (sumOrderVal) sumOrderVal.innerText = orderValueVal.startsWith('R$') ? orderValueVal : (orderValueVal !== '--' ? `R$ ${orderValueVal}` : 'R$ --');

  const sumCargo = document.getElementById('summary-cargo-type-val');
  if (sumCargo) sumCargo.innerText = cargoText;

  const sumPayment = document.getElementById('summary-payment-val');
  if (sumPayment) sumPayment.innerText = paymentText;
}

function initClientOrderSummaryListeners() {
  ['client-delivery-address', 'client-delivery-price', 'client-order-value'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.removeEventListener('input', updateClientOrderSummaryPreview);
      el.addEventListener('input', updateClientOrderSummaryPreview);
    }
  });

  ['client-cargo-type', 'client-payment-method'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.removeEventListener('change', updateClientOrderSummaryPreview);
      el.addEventListener('change', updateClientOrderSummaryPreview);
    }
  });

  updateClientOrderSummaryPreview();
}

function triggerClientDeliveryRequestSubmit() {
  const form = document.getElementById('order-request-form');
  if (form) {
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      const btn = document.getElementById('client-hidden-submit-btn');
      if (btn) btn.click();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }
}

window.updateClientOrderSummaryPreview = updateClientOrderSummaryPreview;
window.initClientOrderSummaryListeners = initClientOrderSummaryListeners;
window.triggerClientDeliveryRequestSubmit = triggerClientDeliveryRequestSubmit;

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
    const subtitle = isInternal ? `${c.client_code} ¢ Operação Própria` : `${c.client_code} ¢ ${escapeHtml(c.responsible_name)}`;
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

let manualTelePickupState = {
  clientId: null,
  establishmentName: '',
  isCustom: false,
  defaultAddress: '',
  defaultLat: null,
  defaultLng: null,
  defaultPlaceId: '',
  customAddress: '',
  customLat: null,
  customLng: null,
  customPlaceId: ''
};

async function geocodeClientAddressOnDemand(addressText) {
  if (!addressText || !addressText.trim()) return null;
  const cleanAddr = addressText.trim();
  const queryStr = (cleanAddr.toLowerCase().includes('rio grande do sul') || cleanAddr.toLowerCase().includes(' - rs'))
    ? cleanAddr
    : `${cleanAddr}, Sapucaia do Sul - RS`;

  try {
    await loadGoogleMapsApi();
    if (window.google && window.google.maps && window.google.maps.Geocoder) {
      const geocoder = new window.google.maps.Geocoder();
      const res = await new Promise((resolve) => {
        geocoder.geocode({
          address: queryStr,
          componentRestrictions: { country: "br", administrativeArea: "RS" }
        }, (results, status) => {
          if (status === 'OK' && results && results[0] && results[0].geometry?.location) {
            resolve(results[0]);
          } else {
            resolve(null);
          }
        });
      });

      if (res && res.geometry && res.geometry.location) {
        return {
          lat: res.geometry.location.lat(),
          lng: res.geometry.location.lng(),
          place_id: res.place_id || null,
          formatted_address: res.formatted_address || cleanAddr
        };
      }
    }
  } catch (err) {
    console.warn("geocodeClientAddressOnDemand notice:", err);
  }
  return null;
}
async function recoverClientPickupLocationSynchronously(clientObj) {
  if (!clientObj || !clientObj.id) return false;
  if (!supabaseClient || !currentActiveSession) return false;
  const ADMIN_ROLES = ['owner', 'admin', 'operador', 'gerente'];
  if (!currentUserProfile || !ADMIN_ROLES.includes(currentUserProfile.role)) return false;

  if (clientObj.pickup_latitude && clientObj.pickup_longitude && !isNaN(Number(clientObj.pickup_latitude)) && !isNaN(Number(clientObj.pickup_longitude))) {
    return true;
  }

  const clientAddr = (clientObj.address || clientObj.pickup_address || '').trim();
  if (!clientAddr) return false;

  const geo = await geocodeClientAddressOnDemand(clientAddr);
  if (!geo || geo.lat == null || geo.lng == null || isNaN(Number(geo.lat)) || isNaN(Number(geo.lng))) {
    return false;
  }

  const latNum = Number(geo.lat);
  const lngNum = Number(geo.lng);

  if (latNum < -34.0 || latNum > -26.0 || lngNum < -58.0 || lngNum > -49.0) {
    console.warn("Recuperação de coleta ignorada: coordenadas fora do Rio Grande do Sul.");
    return false;
  }

  try {
    // Obter registro autoritativo atual do cliente no banco para preservar integralmente todos os campos cadastrais
    const { data: dbClient, error: dbFetchErr } = await supabaseClient
      .from('commercial_clients')
      .select('id, responsible_name, phone, address, street_number, neighborhood, city, state, postal_code')
      .eq('id', clientObj.id)
      .maybeSingle();

    if (dbFetchErr || !dbClient) return false;

    const cleanResp = (dbClient.responsible_name || '').trim();
    const cleanPhone = (dbClient.phone || '').trim();
    const cleanCity = (dbClient.city || 'Sapucaia do Sul').trim();
    const cleanState = (dbClient.state || 'RS').trim().toUpperCase();

    if (cleanResp.length < 2 || cleanPhone.length < 8) return false;

    const { data: resData, error: updateErr } = await supabaseClient.rpc('admin_update_commercial_client_profile', {
      p_client_id: clientObj.id,
      p_responsible_name: cleanResp,
      p_phone: cleanPhone,
      p_address: clientAddr,
      p_street_number: dbClient.street_number || null,
      p_neighborhood: dbClient.neighborhood || null,
      p_city: cleanCity || 'Sapucaia do Sul',
      p_state: cleanState === 'RS' ? 'RS' : 'RS',
      p_postal_code: dbClient.postal_code || null,
      p_pickup_latitude: latNum,
      p_pickup_longitude: lngNum,
      p_pickup_place_id: geo.place_id || null
    });

    if (updateErr || (resData && !resData.success)) {
      console.error("Erro no UPDATE de recuperação automática do ponto de coleta via RPC:", updateErr || resData?.message);
      return false;
    }

    // Confirmação pós-UPDATE: re-consultar no Supabase para garantir persistência
    const { data: verifiedData, error: verifyErr } = await supabaseClient
      .from('commercial_clients')
      .select('id, pickup_latitude, pickup_longitude, pickup_place_id')
      .eq('id', clientObj.id)
      .maybeSingle();

    if (verifyErr || !verifiedData) {
      console.error("Não foi possível confirmar a gravação da recuperação automática:", verifyErr);
      return false;
    }

    if (verifiedData.pickup_latitude == null || verifiedData.pickup_longitude == null || isNaN(Number(verifiedData.pickup_latitude)) || isNaN(Number(verifiedData.pickup_longitude))) {
      console.error("As coordenadas relidas do banco para o cliente continuam nulas.");
      return false;
    }

    const confirmedLat = Number(verifiedData.pickup_latitude);
    const confirmedLng = Number(verifiedData.pickup_longitude);
    const confirmedPlaceId = verifiedData.pickup_place_id || null;

    clientObj.pickup_latitude = confirmedLat;
    clientObj.pickup_longitude = confirmedLng;
    clientObj.pickup_place_id = confirmedPlaceId;

    const cached = (commercialClientsSelectCache || []).find(c => String(c.id) === String(clientObj.id));
    if (cached) {
      cached.pickup_latitude = confirmedLat;
      cached.pickup_longitude = confirmedLng;
      cached.pickup_place_id = confirmedPlaceId;
    }

    return true;
  } catch (err) {
    console.error("Falha ao salvar/confirmar recuperação do ponto de coleta:", err);
    return false;
  }
}

function updateManualTelePickupUI() {
  const estEl = document.getElementById('manual-pickup-establishment-name');
  const defAddrEl = document.getElementById('manual-pickup-default-address');
  const custAddrEl = document.getElementById('manual-pickup-custom-address');
  const custContEl = document.getElementById('manual-pickup-custom-container');
  const btnToggleEl = document.getElementById('btn-toggle-custom-pickup');
  const btnResetEl = document.getElementById('btn-reset-default-pickup');

  if (estEl) {
    estEl.innerText = manualTelePickupState.establishmentName || 'Selecione um estabelecimento acima';
  }
  if (defAddrEl) {
    if (manualTelePickupState.defaultAddress) {
      defAddrEl.innerText = manualTelePickupState.defaultAddress;
    } else if (manualTelePickupState.clientId) {
      defAddrEl.innerText = '⚠️ Endereço não cadastrado para este estabelecimento.';
    } else {
      defAddrEl.innerText = 'O endereço cadastrado do estabelecimento será usado como coleta padrão.';
    }
  }

  if (manualTelePickupState.isCustom) {
    if (custContEl) custContEl.classList.remove('hidden');
    if (btnToggleEl) btnToggleEl.classList.add('hidden');
    if (btnResetEl) btnResetEl.classList.remove('hidden');
    if (custAddrEl && manualTelePickupState.customAddress && custAddrEl.value !== manualTelePickupState.customAddress) {
      custAddrEl.value = manualTelePickupState.customAddress;
    }
  } else {
    if (custContEl) custContEl.classList.add('hidden');
    if (btnToggleEl) btnToggleEl.classList.remove('hidden');
    if (btnResetEl) btnResetEl.classList.add('hidden');
    if (custAddrEl) custAddrEl.value = '';
  }

  updateManualTelePickupMarker();
}

function updateManualTelePickupMarker() {
  if (!requestMaps.manual || !requestMaps.manual.map) return;

  const lat = manualTelePickupState.isCustom ? manualTelePickupState.customLat : manualTelePickupState.defaultLat;
  const lng = manualTelePickupState.isCustom ? manualTelePickupState.customLng : manualTelePickupState.defaultLng;
  const labelName = manualTelePickupState.isCustom
    ? (manualTelePickupState.customAddress ? `Coleta: ${manualTelePickupState.customAddress}` : 'Coleta (Externa)')
    : (manualTelePickupState.establishmentName ? `Coleta: ${manualTelePickupState.establishmentName}` : 'Ponto de Coleta');

  if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
    const center = new window.google.maps.LatLng(lat, lng);
    const pickupIconHtml = `
      <div class="custom-map-marker central-marker" style="background-color: #10b981; box-shadow: 0 0 15px #10b981; border-color: #ffffff; width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative;">
        <div class="marker-pulse" style="border-color: #10b981; animation-duration: 2.5s; position: absolute; top: -5px; left: -5px; width: 24px; height: 24px; border: 2px solid #10b981; border-radius: 50%; animation: pulse-dot-anim 2.5s infinite;"></div>
        <i class="marker-icon-dot" style="background-color: #ffffff; width: 6px; height: 6px; border-radius: 50%; display: block;"></i>
      </div>
    `;

    if (requestMaps.manual.restaurantMarker && requestMaps.manual.restaurantMarker.setMap) {
      requestMaps.manual.restaurantMarker.setMap(null);
    }

    requestMaps.manual.restaurantMarker = new window.CustomHTMLMapMarker(center, requestMaps.manual.map, pickupIconHtml, () => {
      const info = new window.google.maps.InfoWindow({ content: `<strong style="color:var(--color-text);">${escapeHtml(labelName)}</strong>` });
      info.open(requestMaps.manual.map, requestMaps.manual.restaurantMarker);
    });

    if (!requestMaps.manual.destCoords) {
      requestMaps.manual.map.setCenter(center);
    } else {
      const destLatLng = new window.google.maps.LatLng(requestMaps.manual.destCoords.lat, requestMaps.manual.destCoords.lng);
      if (requestMaps.manual.polyline) {
        requestMaps.manual.polyline.setPath([center, destLatLng]);
      }
    }
  } else {
    if (requestMaps.manual.restaurantMarker && requestMaps.manual.restaurantMarker.setMap) {
      requestMaps.manual.restaurantMarker.setMap(null);
    }
    requestMaps.manual.restaurantMarker = null;
    if (requestMaps.manual.polyline) {
      requestMaps.manual.polyline.setMap(null);
      requestMaps.manual.polyline = null;
    }
  }
}

function selectCommercialClientForTele(id, name, directClientObj = null) {
  if (!id) return;
  const selectedInput = document.getElementById('selectedClientId');
  const searchInput = document.getElementById('admin-client-search');
  const dropdownEl = document.getElementById('admin-client-dropdown');

  if (selectedInput) selectedInput.value = id;
  if (searchInput && name) {
    searchInput.value = name;
    searchInput.setAttribute('aria-expanded', 'false');
  }
  if (dropdownEl) dropdownEl.classList.add('hidden');

  const clientObj = directClientObj ||
                    (commercialClientsSelectCache || []).find(c => String(c.id) === String(id)) ||
                    (commercialClientsForSelect || []).find(c => String(c.id) === String(id)) ||
                    opClientsStoreMap.get(String(id));

  const establishmentName = clientObj?.establishment_name || name || 'Estabelecimento';
  const parsedLat = (clientObj?.pickup_latitude != null && !isNaN(Number(clientObj.pickup_latitude))) ? Number(clientObj.pickup_latitude) : null;
  const parsedLng = (clientObj?.pickup_longitude != null && !isNaN(Number(clientObj.pickup_longitude))) ? Number(clientObj.pickup_longitude) : null;

  manualTelePickupState = {
    clientId: id,
    establishmentName: establishmentName,
    isCustom: false,
    defaultAddress: clientObj?.address || '',
    defaultLat: parsedLat,
    defaultLng: parsedLng,
    defaultPlaceId: clientObj?.pickup_place_id || '',
    customAddress: '',
    customLat: null,
    customLng: null,
    customPlaceId: ''
  };

  updateManualTelePickupUI();

  if (clientObj) {
    const hasValidCoords = parsedLat != null && parsedLng != null;
    if (!hasValidCoords) {
      const clientAddr = (clientObj.address || clientObj.pickup_address || '').trim();
      if (clientAddr) {
        showToastNotification(`Geocodificando e salvando ponto de coleta de "${establishmentName}"...`);
        recoverClientPickupLocationSynchronously(clientObj).then(ok => {
          if (ok) {
            manualTelePickupState.defaultLat = Number(clientObj.pickup_latitude);
            manualTelePickupState.defaultLng = Number(clientObj.pickup_longitude);
            manualTelePickupState.defaultPlaceId = clientObj.pickup_place_id || '';
            updateManualTelePickupUI();
            showToastNotification(`Coleta padrão de "${establishmentName}" confirmada no banco: ${clientObj.address}`);
          } else {
            showToastNotification(`Não foi possível salvar automaticamente o ponto de coleta deste cliente. Altere a coleta desta Tele manualmente.`, 'warning');
          }
        });
      } else {
        showToastNotification(`⚠️ Atenção: O cliente "${establishmentName}" ainda não possui um endereço cadastrado.`);
      }
    } else {
      showToastNotification(`Coleta padrão do cliente carregada: ${clientObj.address}`);
    }
  }
}

function toggleCustomPickupManualTele() {
  const currentClientId = manualTelePickupState.clientId || document.getElementById('selectedClientId')?.value;
  if (!currentClientId) {
    showToastNotification('Selecione primeiro um estabelecimento comercial.');
    return;
  }
  if (!manualTelePickupState.clientId && currentClientId) {
    const clientObj = (commercialClientsSelectCache || []).find(c => String(c.id) === String(currentClientId)) ||
                      (commercialClientsForSelect || []).find(c => String(c.id) === String(currentClientId)) ||
                      opClientsStoreMap.get(String(currentClientId));
    selectCommercialClientForTele(currentClientId, clientObj?.establishment_name || '', clientObj);
  }
  manualTelePickupState.isCustom = true;
  updateManualTelePickupUI();
  setupManualPickupAddressAutocomplete();
  const inputEl = document.getElementById('manual-pickup-custom-address');
  if (inputEl) {
    inputEl.focus();
  }
}

function resetToDefaultPickupManualTele() {
  manualTelePickupState.isCustom = false;
  manualTelePickupState.customAddress = '';
  manualTelePickupState.customLat = null;
  manualTelePickupState.customLng = null;
  manualTelePickupState.customPlaceId = '';
  updateManualTelePickupUI();
  showToastNotification('Coleta restaurada para o ponto padrão do estabelecimento.');
}

async function setupManualPickupAddressAutocomplete() {
  const addressInput = document.getElementById('manual-pickup-custom-address');
  if (!addressInput) return;
  if (addressInput.dataset.autocompleteInitialized) return;

  try {
    await loadGoogleMapsApi();
    if (!window.google?.maps?.places) return;

    addressInput.dataset.autocompleteInitialized = 'true';

    const rsBounds = new window.google.maps.LatLngBounds(
      { lat: -33.75, lng: -57.65 },
      { lat: -27.08, lng: -49.69 }
    );

    const options = {
      componentRestrictions: { country: "br" },
      bounds: rsBounds,
      strictBounds: true,
      fields: ["address_components", "geometry", "formatted_address", "place_id"],
      types: ["address"]
    };

    const autocomplete = new window.google.maps.places.Autocomplete(addressInput, options);

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place || !place.geometry || !place.geometry.location) {
        showToastNotification('Endereço de coleta não encontrado ou inválido. Selecione uma sugestão da lista.', 'warning');
        return;
      }

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      manualTelePickupState.isCustom = true;
      manualTelePickupState.customAddress = place.formatted_address || addressInput.value;
      manualTelePickupState.customLat = lat;
      manualTelePickupState.customLng = lng;
      manualTelePickupState.customPlaceId = place.place_id || '';
      addressInput.value = manualTelePickupState.customAddress;

      updateManualTelePickupUI();
      showToastNotification(`Ponto de coleta alterado temporariamente para esta Tele: ${manualTelePickupState.customAddress}`);
    });

    addressInput.addEventListener('input', () => {
      const val = addressInput.value.trim();
      if (val !== manualTelePickupState.customAddress) {
        manualTelePickupState.customAddress = val;
        manualTelePickupState.customLat = null;
        manualTelePickupState.customLng = null;
        manualTelePickupState.customPlaceId = '';
        updateManualTelePickupMarker();
      }
    });
  } catch (err) {
    console.warn("Pickup places autocomplete notice:", err.message);
  }
}

function deliverToEstablishmentManualTele() {
  const clientId = document.getElementById('selectedClientId')?.value || manualTelePickupState.clientId;
  if (!clientId) {
    showToastNotification('Selecione primeiro um estabelecimento comercial acima.', 'warning');
    return;
  }

  const clientObj = (commercialClientsSelectCache || []).find(c => String(c.id) === String(clientId));
  if (!clientObj || !clientObj.address) {
    showToastNotification('O estabelecimento selecionado ainda não possui endereço padrão cadastrado.', 'warning');
    return;
  }

  const addrInput = document.getElementById('manual-delivery-address');
  const numInput = document.getElementById('manual-delivery-number');
  const numVisInput = document.getElementById('manual-delivery-number-input');
  const neighInput = document.getElementById('manual-delivery-neighborhood');
  const cityInput = document.getElementById('manual-delivery-city');
  const stateInput = document.getElementById('manual-delivery-state');
  const postalInput = document.getElementById('manual-delivery-postal-code');
  const placeIdInput = document.getElementById('manual-delivery-place-id');
  const latInput = document.getElementById('manual-delivery-lat');
  const lngInput = document.getElementById('manual-delivery-lng');
  const precInput = document.getElementById('manual-geocoding-precision');
  const isManInput = document.getElementById('manual-location-adjusted-manually');

  const establishmentAddr = clientObj.address;
  const numVal = clientObj.street_number || extractHouseNumberFromAddress(establishmentAddr) || '';

  if (addrInput) addrInput.value = establishmentAddr;
  if (numInput) numInput.value = numVal;
  if (numVisInput) numVisInput.value = numVal;
  if (neighInput) neighInput.value = clientObj.neighborhood || '';
  if (cityInput) cityInput.value = clientObj.city || 'Sapucaia do Sul';
  if (stateInput) stateInput.value = clientObj.state || 'RS';
  if (postalInput) postalInput.value = clientObj.postal_code || '';
  if (placeIdInput) placeIdInput.value = clientObj.pickup_place_id || '';

  const lat = (clientObj.pickup_latitude != null && !isNaN(Number(clientObj.pickup_latitude))) ? Number(clientObj.pickup_latitude) : null;
  const lng = (clientObj.pickup_longitude != null && !isNaN(Number(clientObj.pickup_longitude))) ? Number(clientObj.pickup_longitude) : null;

  if (lat != null && lng != null) {
    if (latInput) latInput.value = lat;
    if (lngInput) lngInput.value = lng;
    if (precInput) precInput.value = 'rooftop';
    if (isManInput) isManInput.value = 'false';
    updateRequestDeliveryDestination(lat, lng, true, false, 'manual');
  }

  showToastNotification(`Destino da Tele definido como o estabelecimento (${clientObj.establishment_name || 'Comércio'}).`);
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
      setContent(html) {
        this.html = html;
        if (this.div) this.div.innerHTML = html;
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
    throw new Error("Chave do Google Maps não configurada no ambiente.");
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

function onMapMarkerPositionChanged(lat, lng) {
  const latInput = document.getElementById('manual-delivery-lat');
  const lngInput = document.getElementById('manual-delivery-lng');
  const isManualInput = document.getElementById('manual-location-adjusted-manually');
  const precInput = document.getElementById('manual-geocoding-precision');

  if (latInput) latInput.value = typeof lat === 'number' ? lat.toFixed(7) : lat;
  if (lngInput) lngInput.value = typeof lng === 'number' ? lng.toFixed(7) : lng;
  if (isManualInput) isManualInput.value = 'true';
  if (precInput) precInput.value = 'manual_pin';

  if (requestMaps.manual) {
    requestMaps.manual.destCoords = { lat: Number(lat), lng: Number(lng), isManualPin: true };
  }

  const warnBox = document.getElementById('manual-geocoding-warning');
  if (warnBox) {
    warnBox.classList.remove('hidden');
    warnBox.innerHTML = `🍩“Œ <strong>Localização ajustada manualmente no mapa.</strong> As coordenadas do marcador serão utilizadas como autoritativas para esta entrega.`;
  }
}

function syncManualDeliveryNumberInput(val) {
  const hiddenNum = document.getElementById('manual-delivery-number');
  if (hiddenNum) hiddenNum.value = val ? val.trim() : '';
  const snCb = document.getElementById('manual-delivery-sn-cb');
  if (snCb && val.trim()) snCb.checked = false;
}

function extractHouseNumberFromAddress(addrText) {
  if (!addrText || typeof addrText !== 'string') return null;
  // Remover CEP (ex: 93260-000 ou 93260000) e rodovias para evitar falsos positivos
  let clean = addrText.replace(/\b\d{5}-?\d{3}\b/g, '').replace(/\b(?:RS|BR)-\d+\b/gi, '');
  // Regex estrita para número de imóvel inequivocamente associado à rua
  const match = clean.match(/(?:,\s*|\s+nº\s*|\s+n°\s*|\s+num\s*|\s+n\.\s*)(\d+[a-zA-Z]?)(?=\s*[,-]|\s*$)/i);
  if (match && match[1]) {
    const candidate = match[1].trim();
    if (candidate.length <= 5 && !/^(19|20)\d{2}$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function validateCityCoherence(userInputText, resultCity) {
  if (!userInputText || !resultCity) return { isCoherent: true };

  const normUser = normalizeAddressText(userInputText);
  const normCity = normalizeAddressText(resultCity);

  if (!normUser || !normCity) return { isCoherent: true };

  if (normUser.includes(normCity)) {
    return { isCoherent: true };
  }

  const segments = normUser.split(/[-–—,]/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (/^\d+$/.test(seg) || ['rs', 'rio grande do sul', 'brasil', 'br', 'rua', 'r', 'av', 'avenida', 'alameda', 'praça', 'praca', 'bairro', 'centro'].includes(seg)) {
      continue;
    }
    if (seg.length >= 4 && seg !== normCity && !normCity.includes(seg) && !seg.includes(normCity)) {
      return { isCoherent: false, userCity: seg, resultCity };
    }
  }

  return { isCoherent: true };
}

let manualAddressGeocodeTimeout = null;
async function geocodeManualAddressText() {
  const addrInput = document.getElementById('manual-delivery-address');
  const addressText = addrInput?.value?.trim();
  if (!addressText) return;

  const isManualAdjusted = document.getElementById('manual-location-adjusted-manually')?.value === 'true';
  const isPlacesResolved = addrInput?.dataset?.isPlacesResolved === 'true';
  const latInput = document.getElementById('manual-delivery-lat');
  const lngInput = document.getElementById('manual-delivery-lng');

  if ((isManualAdjusted || isPlacesResolved) && latInput?.value && lngInput?.value) {
    return;
  }
  const precInput = document.getElementById('manual-geocoding-precision');
  const numInput = document.getElementById('manual-delivery-number');
  const numVisibleInput = document.getElementById('manual-delivery-number-input');

  try {
    await loadGoogleMapsApi();
    if (!window.google || !window.google.maps) return;
    const geocoder = new window.google.maps.Geocoder();

    const rsBounds = new window.google.maps.LatLngBounds(
      { lat: -33.75, lng: -57.65 },
      { lat: -27.08, lng: -49.69 }
    );

    let query = addressText;
    const hasRS = /(\brs\b|rio grande do sul)/i.test(query);
    const hasBrasil = /brasil/i.test(query);

    if (!hasRS && !hasBrasil) {
      query += ', RS, Brasil';
    } else if (hasRS && !hasBrasil) {
      query += ', Brasil';
    }

    query = query
      .replace(/,\s*RS\s*,\s*RS/gi, ', RS')
      .replace(/,\s*Brasil\s*,\s*Brasil/gi, ', Brasil');

    geocoder.geocode({
      address: query,
      bounds: rsBounds,
      componentRestrictions: { country: 'BR', administrativeArea: 'RS' }
    }, (results, status) => {
      if (status === 'OK' && results && results[0]) {
        const place = results[0];
        const location = place.geometry?.location;
        if (!location) return;

        const lat = typeof location.lat === 'function' ? location.lat() : location.lat;
        const lng = typeof location.lng === 'function' ? location.lng() : location.lng;

        // Validação Universal Dinâmica de Coerência de Cidade
        let resultCity = '';
        if (place.address_components) {
          place.address_components.forEach(comp => {
            const types = comp.types || [];
            if (types.includes('locality') || types.includes('administrative_area_level_2')) {
              resultCity = comp.long_name || comp.short_name || '';
            }
          });
        }

        const coherence = validateCityCoherence(addressText, resultCity);
        if (!coherence.isCoherent) {
          console.warn('[GEOCODE REJECT] Cidade divergente:', resultCity);
          const warnBox = document.getElementById('manual-geocoding-warning');
          if (warnBox) {
            warnBox.classList.remove('hidden');
            warnBox.innerHTML = `⚠️ <strong>Confirme o endereço:</strong> a localização encontrada (${resultCity}) não corresponde à cidade informada. Ajuste o marcador no mapa.`;
          }
          return;
        }

        if (latInput) latInput.value = lat.toFixed(7);
        if (lngInput) lngInput.value = lng.toFixed(7);

        if (typeof updateRequestDeliveryDestination === 'function') {
          updateRequestDeliveryDestination(lat, lng, true, false, 'manual');
        }

        let streetNumber = '';
        if (place.address_components) {
          place.address_components.forEach(comp => {
            if (comp.types && comp.types.includes('street_number')) {
              streetNumber = comp.long_name || comp.short_name || '';
            }
          });
        }
        const resolvedNumber = streetNumber || extractHouseNumberFromAddress(addressText);
        if (resolvedNumber) {
          if (numInput) numInput.value = resolvedNumber;
          if (numVisibleInput) numVisibleInput.value = resolvedNumber;
          if (precInput) precInput.value = 'rooftop';
          document.getElementById('manual-number-confirm-area')?.classList.add('hidden');
          document.getElementById('manual-geocoding-warning')?.classList.add('hidden');
        }
      }
    });
  } catch (err) {
    console.warn("geocodeManualAddressText notice:", err);
  }
}

async function initGooglePlacesAutocomplete() {
  const container = document.getElementById('manual-address-suggestions')?.parentElement || document.getElementById('manual-delivery-address')?.parentElement;
  if (!container || container.dataset.googleAutocompleteAttached === 'true') return;

  const addrInput = document.getElementById('manual-delivery-address');
  if (addrInput && !addrInput.dataset.listenerAttached) {
    addrInput.dataset.listenerAttached = 'true';
    addrInput.addEventListener('input', () => {
      const isPlacesResolved = addrInput.dataset.isPlacesResolved === 'true';
      const resolvedAddress = addrInput.dataset.placesResolvedAddress;

      if (isPlacesResolved && addrInput.value.trim() !== resolvedAddress) {
        delete addrInput.dataset.isPlacesResolved;
        delete addrInput.dataset.placesResolvedAddress;
        const isManualInput = document.getElementById('manual-location-adjusted-manually');
        if (isManualInput) isManualInput.value = 'false';
      }

      if (!addrInput.dataset.isPlacesResolved) {
        const latInput = document.getElementById('manual-delivery-lat');
        const lngInput = document.getElementById('manual-delivery-lng');
        const precInput = document.getElementById('manual-geocoding-precision');
        if (latInput) latInput.value = '';
        if (lngInput) lngInput.value = '';
        if (precInput) precInput.value = 'unconfirmed';

        if (manualAddressGeocodeTimeout) clearTimeout(manualAddressGeocodeTimeout);
        manualAddressGeocodeTimeout = setTimeout(() => {
          geocodeManualAddressText();
        }, 600);
      }
    });
  }

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
    if (addrInput) {
      addrInput.dataset.placesNewActive = 'true';
    }

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
      if (manualAddressGeocodeTimeout) {
        clearTimeout(manualAddressGeocodeTimeout);
        manualAddressGeocodeTimeout = null;
      }
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

function normalizeAddressText(str) {
  return String(str || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function updatePrecisionBadge(type = 'manual') {
  const isManualInput = document.getElementById(`${type}-location-adjusted-manually`) || document.getElementById('manual-location-adjusted-manually');
  const isManualAdjusted = isManualInput?.value === 'true' || requestMaps[type]?.destCoords?.isManualPin === true;
  const badgeEl = document.getElementById(`${type}-precision-indicator`) || document.getElementById('manual-precision-indicator');
  if (!badgeEl) return;

  badgeEl.classList.remove('hidden');
  if (isManualAdjusted) {
    badgeEl.style.background = 'rgba(34, 197, 94, 0.12)';
    badgeEl.style.border = '1px solid rgba(34, 197, 94, 0.3)';
    badgeEl.style.color = '#4ade80';
    badgeEl.innerHTML = `🍩Ÿ¢ <strong>Ponto de entrega confirmado</strong>`;
  } else {
    badgeEl.style.background = 'rgba(245, 158, 11, 0.12)';
    badgeEl.style.border = '1px solid rgba(245, 158, 11, 0.3)';
    badgeEl.style.color = '#fbbf24';
    badgeEl.innerHTML = `🍩Ÿ¡ <strong>Localização automática</strong> — confira o ponto no mapa`;
  }
}

function handlePlaceSelection(place) {
  if (manualAddressGeocodeTimeout) {
    clearTimeout(manualAddressGeocodeTimeout);
    manualAddressGeocodeTimeout = null;
  }
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
  const isManualInput = document.getElementById('manual-location-adjusted-manually');
  const addrInput = document.getElementById('manual-delivery-address');

  const userTypedText = normalizeAddressText(addrInput?.value);

  // Validação Estrita de Estado: Apenas RS é aceito
  const stateUpper = (state || '').toUpperCase();
  const isRS = stateUpper === 'RS' || state.toLowerCase().includes('rio grande do sul');
  if (state && !isRS) {
    if (placeIdInput) placeIdInput.value = '';
    if (latInput) latInput.value = '';
    if (lngInput) lngInput.value = '';

    if (warnBox) {
      warnBox.classList.remove('hidden');
      warnBox.innerHTML = '⚠️ <strong>Este endereço está fora da área atendida.</strong> Selecione um endereço no Rio Grande do Sul.';
    }
    return;
  }

  // Validação Universal Dinâmica de Coerência de Cidade (qualquer município do RS)
  if (city && userTypedText) {
    const coherence = validateCityCoherence(userTypedText, city);
    if (!coherence.isCoherent) {
      if (placeIdInput) placeIdInput.value = '';
      if (latInput) latInput.value = '';
      if (lngInput) lngInput.value = '';

      if (warnBox) {
        warnBox.classList.remove('hidden');
        warnBox.innerHTML = `⚠️ <strong>Confirme o endereço:</strong> a localização encontrada (${city}${sublocality ? ' - ' + sublocality : ''}) não corresponde à cidade/bairro informado. Ajuste o marcador no mapa.`;
      }
      return;
    }
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

  const locType = ((place.geometry && place.geometry.location_type) || place.locationType || (streetNumber ? 'ROOFTOP' : 'RANGE_INTERPOLATED')).toUpperCase();

  const placeId = place.id || place.place_id || '';
  const formattedAddress = place.formattedAddress || place.formatted_address || route;
  const cleanFormatted = formattedAddress.replace(/, Brasil$/i, '');

  const numInput = document.getElementById('manual-delivery-number');
  const numVisibleInput = document.getElementById('manual-delivery-number-input');
  const neighInput = document.getElementById('manual-delivery-neighborhood');
  const cityInput = document.getElementById('manual-delivery-city');
  const stateInput = document.getElementById('manual-delivery-state');
  const postalCodeInput = document.getElementById('manual-delivery-postal-code');
  const precInput = document.getElementById('manual-geocoding-precision');
  const confirmArea = document.getElementById('manual-number-confirm-area');
  const summaryBox = document.getElementById('manual-address-summary-box');
  const summaryTitle = document.getElementById('manual-address-summary-title');
  const summarySubtitle = document.getElementById('manual-address-summary-subtitle');

  const resolvedNumber = streetNumber || extractHouseNumberFromAddress(cleanFormatted) || extractHouseNumberFromAddress(addrInput?.value);

  if (addrInput) {
    addrInput.value = cleanFormatted;
    addrInput.dataset.placesResolvedAddress = cleanFormatted;
    addrInput.dataset.isPlacesResolved = "true";
  }
  if (numInput) numInput.value = resolvedNumber || '';
  if (numVisibleInput) numVisibleInput.value = resolvedNumber || '';
  if (neighInput) neighInput.value = sublocality || '';
  if (cityInput) cityInput.value = city || 'Sapucaia do Sul';
  if (stateInput) stateInput.value = 'RS';
  if (postalCodeInput) postalCodeInput.value = postalCode || '';
  if (placeIdInput) placeIdInput.value = placeId;
  if (latInput) latInput.value = typeof lat === 'number' ? lat.toFixed(7) : lat;
  if (lngInput) lngInput.value = typeof lng === 'number' ? lng.toFixed(7) : lng;
  if (isManualInput) isManualInput.value = 'false';

  if (requestMaps.manual) {
    requestMaps.manual.destCoords = { lat: Number(lat), lng: Number(lng), isManualPin: false };
  }

  if (typeof updateRequestDeliveryDestination === 'function') {
    updateRequestDeliveryDestination(Number(lat), Number(lng), true, false, 'manual');
  }

  if (summaryBox && summaryTitle && summarySubtitle) {
    const mainTitle = route ? (resolvedNumber ? `${route}, ${resolvedNumber}` : route) : cleanFormatted;
    const subText = `${sublocality ? sublocality + ' ¢ ' : ''}${city || 'Sapucaia do Sul'} - RS${postalCode ? ' ¢ CEP ' + postalCode : ''}`;
    summaryTitle.innerText = mainTitle;
    summarySubtitle.innerText = subText;
    summaryBox.classList.remove('hidden');
  }

  if (precInput) precInput.value = locType.toLowerCase();

  if (locType !== 'ROOFTOP') {
    if (confirmArea) confirmArea.classList.remove('hidden');
    if (warnBox) {
      warnBox.classList.remove('hidden');
      warnBox.innerHTML = `🍩“ <strong>Posição aproximada (${locType === 'RANGE_INTERPOLATED' ? 'Interpolação na rua' : 'Centro do bairro/área'}).</strong> Se necessário, ajuste o marcador amarelo no ponto exato da casa no mapa.`;
    }
  } else {
    if (confirmArea) confirmArea.classList.add('hidden');
    if (warnBox) warnBox.classList.add('hidden');
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

let isSubmittingManualDelivery = false;

async function submitDeliveryRequest(event) {
  if (event) event.preventDefault();

  if (isSubmittingManualDelivery) return;

  const btnSubmit = document.querySelector('#request-delivery-form button[type="submit"]');
  const originalBtnText = btnSubmit ? (btnSubmit.dataset.origText || btnSubmit.innerText || 'Chamar Tele') : 'Chamar Tele';
  if (btnSubmit && !btnSubmit.dataset.origText) btnSubmit.dataset.origText = originalBtnText;

  function unlockFormSubmission() {
    isSubmittingManualDelivery = false;
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerText = btnSubmit.dataset.origText || 'Chamar Tele';
    }
  }

  isSubmittingManualDelivery = true;
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Chamando...';
  }

  const selectedClientId = document.getElementById('selectedClientId')?.value;
  if (!selectedClientId) {
    showToastNotification('Por favor, selecione um cliente comercial cadastrado.');
    unlockFormSubmission();
    return;
  }

  const destName = document.getElementById('manual-delivery-dest-name')?.value?.trim();
  if (!destName || destName === 'Cliente informado') {
    showToastNotification('Informe o nome do destinatário.');
    unlockFormSubmission();
    return;
  }

  const destPhone = document.getElementById('manual-delivery-dest-phone')?.value?.trim();
  if (!destPhone) {
    showToastNotification('Informe o telefone do destinatário.');
    unlockFormSubmission();
    return;
  }

  const address = document.getElementById('manual-delivery-address')?.value?.trim();
  if (!address) {
    showToastNotification('Informe o endereço de entrega.');
    unlockFormSubmission();
    return;
  }

  const stateVal = document.getElementById('manual-delivery-state')?.value?.trim() || 'RS';
  if (stateVal.toUpperCase() !== 'RS' && !stateVal.toLowerCase().includes('rio grande do sul')) {
    showToastNotification('Este endereço está fora da área atendida. Selecione um endereço no Rio Grande do Sul.');
    unlockFormSubmission();
    return;
  }

  // Capturar e validar Valor da Tele (R$) autoritativo
  const rawDeliveryCharge = document.getElementById('manual-delivery-charge')?.value;
  let deliveryCharge = 0;
  try {
    deliveryCharge = parseMoneyBR(rawDeliveryCharge);
  } catch (err) {
    showToastNotification('Informe um valor válido para a Tele (maior que R$ 0,00).');
    unlockFormSubmission();
    return;
  }
  if (!deliveryCharge || deliveryCharge <= 0) {
    showToastNotification('Informe um valor válido para a Tele (maior que R$ 0,00).');
    unlockFormSubmission();
    return;
  }

  // Capturar e validar Valor do Pedido (R$)
  const rawOrderValue = document.getElementById('manual-order-value')?.value;
  let orderValue = 0;
  if (rawOrderValue && rawOrderValue.trim()) {
    try {
      orderValue = parseMoneyBR(rawOrderValue);
    } catch (err) {
      showToastNotification(`Valor do Pedido inválido: ${err.message}`);
      unlockFormSubmission();
      return;
    }
  }

function showModalSubmitError(msg) {
  let errEl = document.getElementById('manual-modal-error-banner');
  if (!errEl) {
    const form = document.getElementById('request-delivery-form');
    if (form) {
      errEl = document.createElement('div');
      errEl.id = 'manual-modal-error-banner';
      errEl.style.cssText = 'background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; border-radius: 6px; padding: 10px 14px; font-size: 0.85rem; margin-bottom: 12px; font-weight: 600; display: flex; align-items: center; justify-content: space-between;';
      form.insertBefore(errEl, form.firstChild);
    }
  }
  if (errEl) {
    errEl.innerHTML = `<span>${escapeHtml(msg)}</span><button type="button" onclick="this.parentElement.remove()" style="background:none;border:none;color:#ef4444;cursor:pointer;font-weight:bold;">&times;</button>`;
    errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    alert(msg);
  }
}

  const existingErrBanner = document.getElementById('manual-modal-error-banner');
  if (existingErrBanner) existingErrBanner.remove();

  // Tentar re-geocodificar se as coordenadas estiverem ausentes por edição manual
  let latRaw = document.getElementById('manual-delivery-lat')?.value;
  let lngRaw = document.getElementById('manual-delivery-lng')?.value;
  if ((!latRaw || !lngRaw) && requestMaps.manual?.destCoords) {
    latRaw = requestMaps.manual.destCoords.lat;
    lngRaw = requestMaps.manual.destCoords.lng;
  }
  if (!latRaw || !lngRaw) {
    await geocodeManualAddressText();
    latRaw = document.getElementById('manual-delivery-lat')?.value;
    lngRaw = document.getElementById('manual-delivery-lng')?.value;
  }

  const lat = latRaw ? parseFloat(latRaw) : null;
  const lng = lngRaw ? parseFloat(lngRaw) : null;

  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    showModalSubmitError('Selecione um endereço ou confirme o marcador no mapa para obter as coordenadas.');
    unlockFormSubmission();
    return;
  }

  // Resolver número se ainda estiver ausente
  let number = document.getElementById('manual-delivery-number')?.value?.trim();
  const isSN = document.getElementById('manual-delivery-sn-cb')?.checked;
  if (!number && !isSN) {
    const extracted = extractHouseNumberFromAddress(address);
    if (extracted) {
      number = extracted;
      const numInput = document.getElementById('manual-delivery-number');
      const numVisibleInput = document.getElementById('manual-delivery-number-input');
      if (numInput) numInput.value = extracted;
      if (numVisibleInput) numVisibleInput.value = extracted;
    }
  }

  if (!number && !isSN) {
    showModalSubmitError('Selecione um endereço que contenha o número do imóvel.');
    unlockFormSubmission();
    return;
  }

  const complement = document.getElementById('manual-delivery-complement')?.value?.trim() || null;
  const neighborhood = document.getElementById('manual-delivery-neighborhood')?.value?.trim() || null;
  const city = document.getElementById('manual-delivery-city')?.value?.trim() || 'Sapucaia do Sul';
  const postalCode = document.getElementById('manual-delivery-postal-code')?.value?.trim() || null;
  const placeId = document.getElementById('manual-delivery-place-id')?.value?.trim() || null;
  const notes = document.getElementById('manual-order-notes')?.value || '';

  const precision = document.getElementById('manual-geocoding-precision')?.value || 'unconfirmed';
  const isManual = document.getElementById('manual-location-adjusted-manually')?.value === 'true';

  const clientObj = (commercialClientsSelectCache || []).find(c => String(c.id) === String(selectedClientId));
  let p_pickup_address = null;
  let p_pickup_latitude = null;
  let p_pickup_longitude = null;
  let p_pickup_place_id = null;

  if (manualTelePickupState.isCustom) {
    if (!manualTelePickupState.customAddress || manualTelePickupState.customLat == null || manualTelePickupState.customLng == null || isNaN(manualTelePickupState.customLat) || isNaN(manualTelePickupState.customLng)) {
      showModalSubmitError('O endereço de coleta alterado precisa ser confirmado via busca ou mapa antes de prosseguir. Não é permitido enviar endereço novo com coordenadas antigas.');
      unlockFormSubmission();
      return;
    }
    p_pickup_address = manualTelePickupState.customAddress;
    p_pickup_latitude = manualTelePickupState.customLat;
    p_pickup_longitude = manualTelePickupState.customLng;
    p_pickup_place_id = manualTelePickupState.customPlaceId || null;
  } else {
    let hasCoords = clientObj && clientObj.pickup_latitude && clientObj.pickup_longitude && !isNaN(Number(clientObj.pickup_latitude)) && !isNaN(Number(clientObj.pickup_longitude));
    if (!hasCoords && clientObj) {
      showToastNotification(`Geocodificando e salvando ponto de coleta de "${clientObj.establishment_name}"...`);
      hasCoords = await recoverClientPickupLocationSynchronously(clientObj);
    }

    if (!hasCoords || !clientObj) {
      showModalSubmitError('Não foi possível salvar automaticamente o ponto de coleta deste cliente. Configure o ponto de coleta manualmente.');
      unlockFormSubmission();
      return;
    }
    p_pickup_address = clientObj.address;
    p_pickup_latitude = Number(clientObj.pickup_latitude);
    p_pickup_longitude = Number(clientObj.pickup_longitude);
    p_pickup_place_id = clientObj.pickup_place_id || null;
  }

  const idempotencyKey = `idemp-admin-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  try {
    if (supabaseClient) {
      const { data, error } = await supabaseClient.rpc('create_admin_tele', {
        p_client_id: selectedClientId,
        p_pickup_address: p_pickup_address,
        p_delivery_address: address,
        p_recipient_name: destName,
        p_recipient_phone: destPhone,
        p_idempotency_key: idempotencyKey,
        p_reference: null,
        p_notes: notes,
        p_order_value: orderValue,
        p_operation_source: 'owner_panel',
        p_delivery_number: isSN ? 'S/N' : number,
        p_delivery_complement: complement,
        p_delivery_neighborhood: neighborhood,
        p_delivery_city: city,
        p_delivery_postal_code: postalCode,
        p_delivery_latitude: lat,
        p_delivery_longitude: lng,
        p_geocoding_precision: precision,
        p_location_adjusted_manually: isManual,
        p_pickup_latitude: p_pickup_latitude,
        p_pickup_longitude: p_pickup_longitude,
        p_place_id: placeId,
        p_delivery_state: stateVal,
        p_delivery_charge: deliveryCharge,
        p_pickup_place_id: p_pickup_place_id
      });

      if (error) {
        showModalSubmitError(`Erro ao criar Tele: ${error.message || error}`);
        unlockFormSubmission();
        return;
      }
      if (!data || data.success === false) {
        showModalSubmitError(`Erro ao criar Tele: ${data?.message || 'Falha ao processar solicitação.'}`);
        unlockFormSubmission();
        return;
      }

      const createdCode = data.tele_code || (data.id ? 'TEL-' + data.id.slice(0, 6).toUpperCase() : '');
      forceCloseRequestDeliveryModal();
      showToastNotification(`Tele ${createdCode} criada com sucesso! (Status: Aguardando Despacho)`);
      if (typeof fetchPendingDeliveries === 'function') await fetchPendingDeliveries();
      if (typeof loadTelesManagement === 'function') await loadTelesManagement();
      if (typeof renderTelesUnified === 'function') renderTelesUnified();
    } else {
      forceCloseRequestDeliveryModal();
      showToastNotification("Tele criada com sucesso!");
    }
  } catch (err) {
    console.error("Erro ao criar Tele manual:", err);
    showModalSubmitError("Erro de conexão ao criar a Tele.");
    unlockFormSubmission();
  } finally {
    isSubmittingManualDelivery = false;
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
    delivery_charge: Number(payload.p_delivery_charge || 0).toFixed(2),
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

  const rawDeliveryCharge = document.getElementById('client-delivery-price')?.value;
  let deliveryCharge = 0;
  try {
    deliveryCharge = parseMoneyBR(rawDeliveryCharge);
  } catch (err) {
    showToastNotification('Informe um valor válido para a Tele (maior que R$ 0,00).');
    return;
  }
  if (!deliveryCharge || deliveryCharge <= 0) {
    showToastNotification('Informe um valor válido para a Tele (maior que R$ 0,00).');
    return;
  }

  const rawOrderValue = document.getElementById('client-order-value')?.value;
  let orderValue = 0;
  if (rawOrderValue && rawOrderValue.trim()) {
    try {
      orderValue = parseMoneyBR(rawOrderValue);
    } catch (err) {
      showToastNotification(`Valor do Pedido inválido: ${err.message}`);
      return;
    }
  }

  if (!address) {
    showToastNotification('Informe o endereço de entrega.');
    return;
  }

  const clientAddressEl = document.getElementById('client-delivery-address');
  const isPlacesResolved = clientAddressEl?.dataset?.isPlacesResolved === "true";
  const isManualAdjusted = document.getElementById('client-location-adjusted-manually')?.value === 'true' || requestMaps.client?.destCoords?.isManualPin === true;
  const hasDestCoords = !!requestMaps.client?.destCoords || (!!document.getElementById('client-delivery-lat')?.value && !!document.getElementById('client-delivery-lng')?.value);

  if (!hasDestCoords || (!isPlacesResolved && !isManualAdjusted)) {
    showToastNotification('Endereço alterado. Por favor, selecione uma sugestão da lista ou confirme a localização no mapa.');
    return;
  }

  let clientLatRaw = document.getElementById('client-delivery-lat')?.value;
  let clientLngRaw = document.getElementById('client-delivery-lng')?.value;
  if ((!clientLatRaw || !clientLngRaw) && requestMaps.client?.destCoords) {
    clientLatRaw = requestMaps.client.destCoords.lat;
    clientLngRaw = requestMaps.client.destCoords.lng;
  }
  const clientLat = clientLatRaw ? parseFloat(clientLatRaw) : null;
  const clientLng = clientLngRaw ? parseFloat(clientLngRaw) : null;
  const clientPrecision = document.getElementById('client-geocoding-precision')?.value || (requestMaps.client?.destCoords ? 'rooftop' : 'unconfirmed');
  const isClientManual = document.getElementById('client-location-adjusted-manually')?.value === 'true' || requestMaps.client?.destCoords?.isManualPin === true;

  const payload = {
    p_pickup_address: null, // Null aciona o fallback para commercial_clients.address
    p_delivery_address: address,
    p_recipient_name: destName,
    p_recipient_phone: phone,
    p_reference: null,
    p_notes: cargo,
    p_order_value: orderValue,
    p_delivery_charge: deliveryCharge,
    p_operation_source: 'client_portal',
    p_delivery_number: null,
    p_delivery_complement: null,
    p_delivery_neighborhood: null,
    p_delivery_city: 'Sapucaia do Sul',
    p_delivery_postal_code: null,
    p_delivery_latitude: clientLat,
    p_delivery_longitude: clientLng,
    p_geocoding_precision: clientPrecision,
    p_location_adjusted_manually: isClientManual,
    p_pickup_latitude: null,
    p_pickup_longitude: null,
    p_place_id: document.getElementById('client-delivery-place-id')?.value || null,
    p_delivery_state: 'RS',
    p_pickup_place_id: null
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

  if (tele.pickup_establishment_name && String(tele.pickup_establishment_name).trim() !== '') {
    return tele.pickup_establishment_name;
  }

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
        .select('id, client_code, establishment_name, responsible_name, phone, lifecycle_status, is_internal, address, neighborhood, city, state, postal_code, pickup_latitude, pickup_longitude, pickup_place_id')
        .order('establishment_name', { ascending: true });

      if (!showInactive) {
        query = query.eq('lifecycle_status', 'ativo');
      }

      const { data, error } = await query;
      if (error) throw error;

      const normalized = (data || []).map(normalizeCommercialClient).filter(Boolean);
      commercialClientsForSelect = normalized;
      commercialClientsSelectCache = normalized;
      normalized.forEach(c => {
        if (c && c.id) {
          opClientsStoreMap.set(String(c.id), c);
        }
      });
    } else {
      // Dev local fallback from opClientsStoreMap / commercialClientsList
      const sourceList = commercialClientsList.length > 0 ? commercialClientsList : Array.from(opClientsStoreMap.values());
      commercialClientsForSelect = sourceList.filter(c => {
        return showInactive || (c.lifecycle_status || c.status || 'ativo') === 'ativo';
      });
      commercialClientsSelectCache = commercialClientsForSelect;
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
          ${escapeHtml(client.client_code || 'CLI-—')} ${client.responsible_name ? '¢ ' + escapeHtml(client.responsible_name) : ''}
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
  if (!client) return;
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

  // Integrar autoritativamente a seleção com o estado do Ponto de Coleta da Tele Manual
  if (typeof selectCommercialClientForTele === 'function') {
    selectCommercialClientForTele(client.id, client.establishment_name || client.name || '', client);
  }

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
    if (!q) {
      const hiddenInput = document.getElementById('selectedClientId');
      if (hiddenInput) hiddenInput.value = '';
      manualTelePickupState = {
        clientId: null,
        establishmentName: '',
        isCustom: false,
        defaultAddress: '',
        defaultLat: null,
        defaultLng: null,
        defaultPlaceId: '',
        customAddress: '',
        customLat: null,
        customLng: null,
        customPlaceId: ''
      };
      if (typeof updateManualTelePickupUI === 'function') updateManualTelePickupUI();
    }
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
    tele_code: (item.tele_code && !isUuidString(item.tele_code)) ? item.tele_code :
               ((item.code && !isUuidString(item.code)) ? item.code :
               ((item.teleCode && !isUuidString(item.teleCode)) ? item.teleCode : null)),
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
          #${escapeHtml(String(tele.tele_code || tele.id))} ¢ ${escapeHtml(clientName)}
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
        <div style="font-size: 0.72rem; color: var(--color-text-muted);">${escapeHtml(rider.vehicle || 'Moto')} ¢ ${escapeHtml(rider.status)}</div>
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
async function assignRiderToTele(teleId, riderId, expectedVersion, reason = '', reassignmentReason = '') {
  const payload = {
    tele_id: String(teleId),
    motoboy_id: String(riderId),
    expected_version: parseInt(expectedVersion, 10),
    reason: reason ? reason.trim() : null,
    reassignment_reason: reassignmentReason ? reassignmentReason.trim() : null
  };

  let data = null;
  let success = false;

  // Invocar Edge Function autoritativa server-side (assign-rider-with-push) se Supabase Client estiver ativo
  if (typeof db !== 'undefined' && db && typeof db.functions?.invoke === 'function') {
    try {
      const { data: edgeRes, error: edgeErr } = await db.functions.invoke('assign-rider-with-push', {
        body: payload
      });

      if (!edgeErr && edgeRes && edgeRes.success) {
        data = edgeRes;
        success = true;
      } else if (edgeErr || (edgeRes && !edgeRes.success)) {
        const errCode = edgeRes?.error || edgeErr?.message || 'ERROR';
        const errMsg = edgeRes?.message || 'Falha no despacho autoritativo.';
        return { success: false, errorCode: errCode, message: errMsg };
      }
    } catch (e) {
      console.warn('Fallback para RPC direta de atribuição:', e.message);
    }
  }

  // Fallback para RPC autoritativa assign_rider_to_tele
  if (!success && typeof db !== 'undefined' && db && typeof db.rpc === 'function') {
    const { data: rpcRes, error: rpcErr } = await db.rpc('assign_rider_to_tele', {
      p_tele_id: String(teleId),
      p_motoboy_id: String(riderId),
      p_expected_version: parseInt(expectedVersion, 10),
      p_reason: reason ? reason.trim() : null,
      p_reassignment_reason: reassignmentReason ? reassignmentReason.trim() : null
    });

    if (!rpcErr && rpcRes && rpcRes.success) {
      data = rpcRes;
      success = true;
    } else if (rpcErr || (rpcRes && !rpcRes.success)) {
      const errCode = rpcRes?.error || rpcErr?.code || 'ERROR';
      const errMsg = rpcRes?.message || rpcErr?.message || 'Falha no despacho.';
      return { success: false, errorCode: errCode, message: errMsg };
    }
  }

  if (!success) {
    try {
      const res = await fetch('/api/operations/assign-rider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      data = await res.json();
      if (res.ok && data.success) {
        success = true;
      } else {
        return { success: false, errorCode: data?.error_code || 'ERROR', message: data?.message || 'Falha no despacho.' };
      }
    } catch (err) {
      return { success: false, errorCode: 'CONNECTION_ERROR', message: 'Erro de conexão com o servidor de despacho.' };
    }
  }

  if (success && data) {
    // Sucesso — atualizar store em memória
    const tele = opTelesStoreMap.get(String(teleId));
    if (tele) {
      tele.motoboy_id = String(riderId);
      tele.rider = data.rider_name || tele.rider;
      tele.status = data.status || 'motoboy_designado';
      tele.version = data.version || tele.version;
      tele.updated_at = data.updated_at || new Date().toISOString();
    }

    if (typeof renderOperationsDashboard === 'function') renderOperationsDashboard();
    if (typeof openTeleOpDrawer === 'function' && document.getElementById('drawer-tele-op-details')?.classList.contains('active')) {
      openTeleOpDrawer(teleId);
    }

    return { success: true, data };
  }

  return { success: false, errorCode: 'UNKNOWN_ERROR', message: 'Falha desconhecida no despacho.' };
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

      const idx = mockData.fleet.findIndex(r => String(r.id) === riderId);
      if (idx !== -1) {
        const deletedRider = mockData.fleet[idx];
        const rName = deletedRider.name;
        mockData.fleet.splice(idx, 1);

        if (ownerFleetMarkers[riderId]) {
          if (ownerFleetMarkers[riderId].setMap) {
            ownerFleetMarkers[riderId].setMap(null);
          }
          delete ownerFleetMarkers[riderId];
        }
      }
    } else {
      const isValidCoord = (val) => val !== null && val !== undefined && val !== '' && !isNaN(parseFloat(val));

      const updatedRider = {
        ...(existingRider || {}),
        ...record,
        id: riderId,
        lat: isValidCoord(record.lat) ? record.lat : (existingRider ? existingRider.lat : record.lat),
        lng: isValidCoord(record.lng) ? record.lng : (existingRider ? existingRider.lng : record.lng)
      };
      opRidersStoreMap.set(riderId, updatedRider);

      const idx = mockData.fleet.findIndex(r => String(r.id) === riderId);
      if (idx !== -1) {
        const currentItem = mockData.fleet[idx];
        mockData.fleet[idx] = {
          ...currentItem,
          ...record,
          id: riderId,
          lat: isValidCoord(record.lat) ? record.lat : currentItem.lat,
          lng: isValidCoord(record.lng) ? record.lng : currentItem.lng,
          status: record.status !== undefined && record.status !== null ? record.status : currentItem.status,
          name: record.name || currentItem.name,
          vehicle: record.vehicle || currentItem.vehicle,
          plate: record.plate || currentItem.plate
        };
      } else {
        mockData.fleet.push({
          id: riderId,
          motoboy_code: record.motoboy_code || '',
          name: record.name || 'Motoboy',
          phone: record.phone || '',
          vehicle: record.vehicle || 'Moto',
          plate: record.plate || '',
          status: record.status || 'Disponível',
          battery: '🔋 Indisponível',
          battery_level: record.battery_level || null,
          is_charging: record.is_charging || null,
          battery_supported: record.battery_supported || false,
          last_seen_at: record.last_seen_at || null,
          is_stale: false,
          lat: record.lat,
          lng: record.lng
        });
      }
    }

    renderFleetBar();

    if (ownerFleetMap) {
      renderMapMarkers(ownerFleetCenterCoords);
    }
    if (typeof renderFleetTable === 'function') {
      renderFleetTable();
    }
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

// â”€â”€â”€ MÓDULO DE SUPORTE DOS MOTOBOYS (ADMINISTRATIVO) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    const { name: rName, code: rCode } = getRiderDisplayIdentity({ name: t.rider_display_name || t.rider_name, motoboy_code: t.motoboy_code || t.rider_code });
    const safeDisplayName = rCode ? `${rName} — ${rCode}` : rName;

    return `
      <div onclick="openAdminSupportTicketDetail('${t.ticket_id}')" style="padding: 12px; border-radius: 8px; margin-bottom: 6px; cursor: pointer; transition: background 0.15s; background: ${isSelected ? 'rgba(255, 183, 0, 0.12)' : 'var(--bg-card)'}; border: 1px solid ${isSelected ? 'var(--primary)' : 'var(--border-color)'}; display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <strong style="font-size: 0.82rem; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(safeDisplayName)}</strong>
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

  const { name: rName, code: rCode } = getRiderDisplayIdentity({ name: (rider && (rider.display_name || rider.name)) || 'Motoboy', motoboy_code: (rider && (rider.motoboy_code || rider.code)) || '' });
  const riderLabel = rCode ? `${rName} (${rCode})` : rName;
  const phoneStr = (rider && rider.phone) ? rider.phone : 'Não informado';

  if (subjectEl) subjectEl.textContent = ticket.subject;
  if (priorityEl) priorityEl.innerHTML = getAdminSupportPriorityBadge(ticket.priority);
  if (riderInfoEl) riderInfoEl.textContent = `Motoboy: ${riderLabel} • Tel: ${phoneStr} • Categoria: ${getAdminSupportCategoryLabel(ticket.category)}`;
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
          âš™ï¸ ${escapeHtml(msg.message)}
        </div>
      `;
    }

    if (isInternal) {
      return `
        <div style="align-self: flex-start; max-width: 88%; background: #2a220c; border: 1px solid #78350f; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.72rem; color: #fbbf24; font-weight: 700;">
            <span>🍔’ NOTA INTERNA — Visível Apenas para Administradores (${escapeHtml(msg.sender_name)})</span>
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
    riderSettlementState.startDate = null;
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
  riderSettlementState.startDate = null;
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
    const isCustom = riderSettlementState.periodShortcut === 'custom_week';
    const { data, error } = await supabaseClient.rpc('list_admin_rider_weekly_settlements', {
      p_period_start: isCustom ? riderSettlementState.startDate : null,
      p_workspace_id: null,
      p_status: riderSettlementState.statusFilter,
      p_rider_id: riderSettlementState.selectedRiderId,
      p_limit: riderSettlementState.limit,
      p_offset: offset,
      p_period_shortcut: isCustom ? null : (riderSettlementState.periodShortcut || 'current_week')
    });

    riderSettlementState.isLoading = false;

    if (error || !data || data.success === false) {
      const errMsg = error?.message || data?.message || 'Erro ao consultar repasses semanais.';
      console.error("[RPC list_admin_rider_weekly_settlements] Erro:", errMsg);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="15" style="text-align: center; padding: 40px 24px; color: #ef4444;">
          <i data-lucide="alert-triangle" style="width: 28px; height: 28px; margin-bottom: 8px;"></i>
          <div style="font-size: 1rem; font-weight: 600; margin-bottom: 6px;">Não foi possível carregar os repasses semanais.</div>
          <div style="font-size: 0.82rem; opacity: 0.8; margin-bottom: 12px;">${escapeHtml(String(errMsg))}</div>
          <button type="button" class="btn btn-sm btn-secondary" onclick="fetchAdminRiderWeeklySettlements(true)" style="border: 1px solid var(--border-color); background: var(--secondary); color: var(--color-text); font-weight: 600; padding: 8px 16px; cursor: pointer;">Tentar Novamente</button>
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
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="15" style="text-align: center; padding: 40px 24px; color: #ef4444;">
        <i data-lucide="alert-triangle" style="width: 28px; height: 28px; margin-bottom: 8px;"></i>
        <div style="font-size: 1rem; font-weight: 600; margin-bottom: 6px;">Não foi possível carregar os repasses semanais.</div>
        <div style="font-size: 0.82rem; opacity: 0.8; margin-bottom: 12px;">${escapeHtml(err.message || 'Falha na conexão com o servidor.')}</div>
        <button type="button" class="btn btn-sm btn-secondary" onclick="fetchAdminRiderWeeklySettlements(true)" style="border: 1px solid var(--border-color); background: var(--secondary); color: var(--color-text); font-weight: 600; padding: 8px 16px; cursor: pointer;">Tentar Novamente</button>
      </td></tr>`;
      if (window.lucide) window.lucide.createIcons();
    }
  }
}

function renderAdminRiderWeeklySettlements(settlements) {
  const tbody = document.getElementById('rider-payments-table-body');
  if (!tbody) return;

  if (!settlements || settlements.length === 0) {
    tbody.innerHTML = `<tr><td colspan="15" style="text-align: center; padding: 48px 24px; color: var(--color-text-muted);">
      <div style="font-size: 1.05rem; font-weight: 600; color: var(--color-text); margin-bottom: 6px;">Nenhum repasse semanal encontrado.</div>
      <div style="font-size: 0.85rem; color: var(--color-text-muted);">Cadastre um motoboy e conclua entregas para gerar o primeiro fechamento.</div>
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
    const cleanRiderName = (s.rider_name && !isUuidString(s.rider_name)) ? s.rider_name : 'Motoboy';
    const safeRiderName = cleanRiderName.replace(/'/g, "\\'");

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

    const displayCode = getRiderDisplayCode(s.rider_code);

    html += `<tr>
      <td><strong>${escapeHtml(cleanRiderName)}</strong></td>
      <td><code>${displayCode ? escapeHtml(displayCode) : '—'}</code></td>
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
    subtitleEl.textContent = `${settlement.rider_name} (${settlement.rider_code}) ¢ Período: ${periodStr} ¢ Versão v${settlement.version}`;
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
async function openPaySettlementModal(settlementId, expectedVersion, riderName, unpaidEligibleStr, blockedStr) {
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

  // Reset button states cleanly
  if (btnCreate) {
    btnCreate.disabled = false;
    btnCreate.innerHTML = '<i data-lucide="layers"></i> Criar Lote de Pagamento';
  }
  if (btnConfirm) {
    btnConfirm.disabled = false;
    btnConfirm.innerHTML = '<i data-lucide="check-check"></i> Confirmar Pagamento Realizado';
  }

  // Backend Recovery: Verificar se já existe um lote em status 'pending' para este fechamento
  const client = (typeof supabaseClient !== 'undefined' && supabaseClient) ? supabaseClient : (window.supabaseClient || (typeof global !== 'undefined' ? global.supabaseClient : null));
  if (client) {
    try {
      const { data: detailData } = await client.rpc('get_admin_rider_weekly_settlement_detail', {
        p_settlement_id: settlementId
      });
      if (detailData && Array.isArray(detailData.batches)) {
        const pendingBatch = detailData.batches.find(b => b.status === 'pending');
        if (pendingBatch) {
          activeSettlementOperationalState.batchId = pendingBatch.id;
          activeSettlementOperationalState.batchVersion = pendingBatch.version;
          activeSettlementOperationalState.createIdempotencyKey = pendingBatch.idempotency_key || `rps_create_${settlementId}`;
          activeSettlementOperationalState.payIdempotencyKey = `rps_pay_${pendingBatch.id}_${Date.now()}`;

          if (step1Box) step1Box.classList.add('hidden');
          if (step2Box) step2Box.classList.remove('hidden');
          if (btnCreate) btnCreate.classList.add('hidden');
          if (btnConfirm) { btnConfirm.classList.remove('hidden'); btnConfirm.disabled = false; }
          if (noticeEl) {
            noticeEl.textContent = 'Lote de pagamento pendente localizado no banco de dados. Por favor informe a forma de pagamento e o comprovante para concluir.';
            noticeEl.classList.remove('hidden');
          }
          if (modal) modal.classList.remove('hidden');
          if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
          return;
        }
      }
    } catch(e) {
      console.warn('[openPaySettlementModal] Falha ao verificar lote pendente existente:', e);
    }
  }

  if (step1Box) step1Box.classList.remove('hidden');
  if (step2Box) step2Box.classList.add('hidden');
  if (btnCreate) btnCreate.classList.remove('hidden');
  if (btnConfirm) btnConfirm.classList.add('hidden');
  if (noticeEl) { noticeEl.textContent = ''; noticeEl.classList.add('hidden'); }

  if (modal) modal.classList.remove('hidden');
  if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
}

function closeRiderPaySettlementModal() {
  const modal = document.getElementById('modal-pay-settlement');
  if (modal) modal.classList.add('hidden');

  const btnCreate = document.getElementById('btn-create-pay-batch');
  if (btnCreate) {
    btnCreate.disabled = false;
    btnCreate.innerHTML = '<i data-lucide="layers"></i> Criar Lote de Pagamento';
  }
  const btnConfirm = document.getElementById('btn-confirm-mark-batch-paid');
  if (btnConfirm) {
    btnConfirm.disabled = false;
    btnConfirm.innerHTML = '<i data-lucide="check-check"></i> Confirmar Pagamento Realizado';
  }
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
  const notesInput = document.getElementById('pay-modal-notes-input');

  const method = methodSelect ? methodSelect.value : '';
  const notes = notesInput ? notesInput.value.trim() : '';

  if (!method) {
    alert("Por favor selecione a forma de pagamento.");
    return;
  }

  const btnConfirm = document.getElementById('btn-confirm-mark-batch-paid');
  if (btnConfirm) { btnConfirm.disabled = true; btnConfirm.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Confirmando...'; }

  try {
    const client = (typeof supabaseClient !== 'undefined' && supabaseClient) ? supabaseClient : (window.supabaseClient || (typeof global !== 'undefined' ? global.supabaseClient : null));
    const { data, error } = await client.rpc('admin_mark_rider_payment_batch_paid', {
      p_batch_id: batchId,
      p_expected_version: batchVersion,
      p_payment_method: method,
      p_payment_reference: null,
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
          <span>⚠️ Restaurar Demonstração</span>
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
