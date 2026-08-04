// Dahora Expresso — Exemplo de Estrutura de Configuração Dinâmica em Build (NÃO USAR EM PRODUÇÃO)
(function() {
  if (typeof window === 'undefined') return;

  window.__ENV_SUPABASE_URL = "https://seu-projeto.supabase.co";
  window.__ENV_SUPABASE_KEY = "sua-chave-publica-anonima";
  window.__ENV_GOOGLE_MAPS_API_KEY = "sua-chave-google-maps-opcional";
  window.__ENV_GOOGLE_MAPS_MAP_ID = "seu-map-id-opcional";
  window.__ENV_VAPID_PUBLIC_KEY = "sua-chave-vapid-publica";
  window.__ENV_NAME = "staging";
  window.__ENV_COMMIT_SHA = "exemplo-sha";
  window.__ENV_DEPLOY_URL = "https://staging.dahora.pages.dev";
})();
