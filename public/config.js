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
    env: 'local'
  };

  if (isLocal) {
    const defaultLocalUrl = 'http://127.0.0.1:54321';
    const defaultLocalKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

    if (window.LOCAL_SUPABASE_CONFIG) {
      config.url = window.LOCAL_SUPABASE_CONFIG.url || defaultLocalUrl;
      config.key = window.LOCAL_SUPABASE_CONFIG.key || defaultLocalKey;
      config.googleMapsApiKey = window.LOCAL_SUPABASE_CONFIG.googleMapsApiKey || '';
      config.googleMapsMapId = window.LOCAL_SUPABASE_CONFIG.googleMapsMapId || 'DEMO_MAP_ID';
      config.vapidPublicKey = window.LOCAL_SUPABASE_CONFIG.vapidPublicKey || window.__ENV_VAPID_PUBLIC_KEY || '';
    } else {
      config.url = defaultLocalUrl;
      config.key = defaultLocalKey;
      config.googleMapsApiKey = window.__ENV_GOOGLE_MAPS_API_KEY || '';
      config.googleMapsMapId = window.__ENV_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
      config.vapidPublicKey = window.__ENV_VAPID_PUBLIC_KEY || '';
    }
  } else {
    // Domínio remoto (Staging / Production / Pages)
    const remoteUrl = window.__ENV_SUPABASE_URL;
    const remoteKey = window.__ENV_SUPABASE_KEY;

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
    config.googleMapsApiKey = window.__ENV_GOOGLE_MAPS_API_KEY || '';
    config.googleMapsMapId = window.__ENV_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
    config.vapidPublicKey = window.__ENV_VAPID_PUBLIC_KEY || '';
    config.env = window.__ENV_NAME || 'staging';
    config.commitSha = window.__ENV_COMMIT_SHA || '';
    config.deployUrl = window.__ENV_DEPLOY_URL || '';
  }

  window.SUPABASE_CONFIG = config;
})();
