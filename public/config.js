// Dahora Expresso — Resolvedor Dinâmico de Configuração por Ambiente
(function() {
  const isLocal = typeof window !== 'undefined' && (
    window.location.hostname === '127.0.0.1' || 
    window.location.hostname === 'localhost' ||
    window.location.hostname === ''
  );

  let config = {
    url: '',
    key: '',
    googleMapsApiKey: '',
    googleMapsMapId: 'DEMO_MAP_ID',
    vapidPublicKey: '',
    env: 'local',
    environmentKind: 'production',
    demoResetEnabled: false
  };

  if (isLocal) {
    if (window.LOCAL_SUPABASE_CONFIG && window.LOCAL_SUPABASE_CONFIG.url && window.LOCAL_SUPABASE_CONFIG.key) {
      config.url = window.LOCAL_SUPABASE_CONFIG.url;
      config.key = window.LOCAL_SUPABASE_CONFIG.key;
      config.googleMapsApiKey = window.LOCAL_SUPABASE_CONFIG.googleMapsApiKey || window.__ENV_GOOGLE_MAPS_API_KEY || '';
      config.googleMapsMapId = window.LOCAL_SUPABASE_CONFIG.googleMapsMapId || window.__ENV_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
      config.vapidPublicKey = window.LOCAL_SUPABASE_CONFIG.vapidPublicKey || window.__ENV_VAPID_PUBLIC_KEY || '';
      config.environmentKind = window.LOCAL_SUPABASE_CONFIG.environmentKind || window.__ENV_ENVIRONMENT_KIND || 'local';
      config.demoResetEnabled = window.LOCAL_SUPABASE_CONFIG.demoResetEnabled ?? (window.__ENV_DEMO_RESET_ENABLED === 'true');
    } else if (window.__ENV_SUPABASE_URL && window.__ENV_SUPABASE_KEY) {
      config.url = window.__ENV_SUPABASE_URL;
      config.key = window.__ENV_SUPABASE_KEY;
      config.googleMapsApiKey = window.__ENV_GOOGLE_MAPS_API_KEY || '';
      config.googleMapsMapId = window.__ENV_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
      config.vapidPublicKey = window.__ENV_VAPID_PUBLIC_KEY || '';
      config.environmentKind = window.__ENV_ENVIRONMENT_KIND || 'local';
      config.demoResetEnabled = window.__ENV_DEMO_RESET_ENABLED === 'true';
    } else {
      window.SUPABASE_CONFIG = null;
      window.__CONFIGURATION_ERROR = {
        code: 'LOCAL_CONFIGURATION_MISSING',
        message: 'Configuração local ausente. Forneça config.local.js ou variáveis de ambiente.'
      };
      console.error('[CONFIG ERROR] LOCAL_CONFIGURATION_MISSING: Forneça config.local.js no ambiente local.');
      return;
    }
  } else {
    // Domínio remoto (Staging / Production / Pages)
    const remoteUrl = window.__ENV_SUPABASE_URL || (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url);
    const remoteKey = window.__ENV_SUPABASE_KEY || (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.key);

    if (!remoteUrl || !remoteKey || !remoteUrl.startsWith('https://')) {
      window.SUPABASE_CONFIG = null;
      window.__CONFIGURATION_ERROR = {
        code: 'CONFIGURATION_MISSING',
        message: 'Ambiente não configurado. Entre em contato com o suporte do sistema.'
      };
      console.error('[CONFIG ERROR] CONFIGURATION_MISSING: Configurações do ambiente remoto ausentes ou inválidas.');
      return;
    }

    config.url = remoteUrl;
    config.key = remoteKey;
    config.googleMapsApiKey = window.__ENV_GOOGLE_MAPS_API_KEY || (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.googleMapsApiKey) || '';
    config.googleMapsMapId = window.__ENV_GOOGLE_MAPS_MAP_ID || (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.googleMapsMapId) || 'DEMO_MAP_ID';
    config.vapidPublicKey = window.__ENV_VAPID_PUBLIC_KEY || (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.vapidPublicKey) || '';
    config.env = window.__ENV_APP_ENV || 'production';
    config.environmentKind = window.__ENV_ENVIRONMENT_KIND || 'production';
    config.demoResetEnabled = window.__ENV_DEMO_RESET_ENABLED === 'true';
  }

  window.SUPABASE_CONFIG = config;
  window.__CONFIGURATION_ERROR = null;
})();
