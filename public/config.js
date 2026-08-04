// Dahora Expresso — Resolvedor Dinâmico de Configuração por Ambiente
(function() {
  const isLocal = typeof window !== 'undefined' && (
    window.location.hostname === '127.0.0.1' || 
    window.location.hostname === 'localhost' ||
    window.location.hostname === ''
  );

  let config = {
    url: 'http://127.0.0.1:54321',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    googleMapsApiKey: '',
    googleMapsMapId: 'DEMO_MAP_ID',
    env: 'local'
  };

  if (isLocal) {
    if (window.LOCAL_SUPABASE_CONFIG) {
      config.url = window.LOCAL_SUPABASE_CONFIG.url || config.url;
      config.key = window.LOCAL_SUPABASE_CONFIG.key || config.key;
      config.googleMapsApiKey = window.LOCAL_SUPABASE_CONFIG.googleMapsApiKey || '';
      config.googleMapsMapId = window.LOCAL_SUPABASE_CONFIG.googleMapsMapId || 'DEMO_MAP_ID';
    }
  } else {
    // Homologação ou Produção - resolvido por variáveis injetadas pelo servidor/proxy
    config.url = window.__ENV_SUPABASE_URL || config.url;
    config.key = window.__ENV_SUPABASE_KEY || config.key;
    config.googleMapsApiKey = window.__ENV_GOOGLE_MAPS_API_KEY || '';
    config.googleMapsMapId = window.__ENV_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
    config.env = window.__ENV_NAME || 'homologation';
  }

  window.SUPABASE_CONFIG = config;
})();
