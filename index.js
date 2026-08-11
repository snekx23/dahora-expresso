export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const defaultUrl = "https://tskivauszmhhtqtegvwb.supabase.co";
    const defaultAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzc4NzcsImV4cCI6MjEwMTU1Mzg3N30.1BoD7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw";
    const defaultVapidKey = "BEo-ivrbMWP4mK2syicv0ic_Wr2arC2LZBmtbtn2zHPzTbykpyJ22ETL2DX9t6bHFL5CGkMnTtAaq-2bcQ_sxYw";
    const defaultGoogleMapsKey = "AIzaSyBkwbG65d17USn4PLxNzyPN7QODNaWWZ0k";

    // 1. Interceptação direta para /runtime-config.js (Garante JS válido sempre)
    if (path === '/runtime-config.js') {
      const supabaseUrl = (env.SUPABASE_URL || defaultUrl).trim();
      const supabaseKey = (env.SUPABASE_ANON_KEY || defaultAnonKey).trim();
      const vapidKey = (env.VAPID_PUBLIC_KEY || defaultVapidKey).trim();
      const googleMapsApiKey = (env.GOOGLE_MAPS_API_KEY || defaultGoogleMapsKey).trim();

      const js = `(function() {
  if (typeof window === 'undefined') return;
  window.__ENV_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
  window.__ENV_SUPABASE_KEY = ${JSON.stringify(supabaseKey)};
  window.__ENV_GOOGLE_MAPS_API_KEY = ${JSON.stringify(googleMapsApiKey)};
  window.__ENV_GOOGLE_MAPS_MAP_ID = ${JSON.stringify(env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID')};
  window.__ENV_VAPID_PUBLIC_KEY = ${JSON.stringify(vapidKey)};
  window.__ENV_NAME = "production";
  window.__ENV_ENVIRONMENT_KIND = "production";
  window.__ENV_DEMO_RESET_ENABLED = "false";
})();`;

      return new Response(js, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    }

    const response = await env.ASSETS.fetch(request);
    
    // Injetar variáveis de ambiente nas páginas HTML
    if (path === '/' || path === '/index.html' || path === '/motoboy.html') {
      let html = await response.text();
      
      const supabaseUrl = (env.SUPABASE_URL || defaultUrl).trim();
      const supabaseKey = (env.SUPABASE_ANON_KEY || defaultAnonKey).trim();
      const googleMapsApiKey = (env.GOOGLE_MAPS_API_KEY || defaultGoogleMapsKey).trim();

      const configScript = `
  <script>
    window.__ENV_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
    window.__ENV_SUPABASE_KEY = ${JSON.stringify(supabaseKey)};
    window.__ENV_GOOGLE_MAPS_API_KEY = ${JSON.stringify(googleMapsApiKey)};
    window.SUPABASE_CONFIG = {
      url: ${JSON.stringify(supabaseUrl)},
      key: ${JSON.stringify(supabaseKey)},
      googleMapsApiKey: ${JSON.stringify(googleMapsApiKey)}
    };
    window.MAPBOX_ACCESS_TOKEN = "${env.MAPBOX_ACCESS_TOKEN || ''}";
  </script>
`;
      html = html.replace('<head>', '<head>' + configScript);
      
      return new Response(html, {
        headers: {
          ...Object.fromEntries(response.headers.entries()),
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    }

    // Clone response to modify headers for assets/scripts
    const newResponse = new Response(response.body, response);
    
    // Disable caching for developments
    if (
      path.endsWith('.html') ||
      path.endsWith('.js') ||
      path.endsWith('.css') ||
      path.endsWith('.json')
    ) {
      newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      newResponse.headers.set('Pragma', 'no-cache');
      newResponse.headers.set('Expires', '0');
    }
    
    return newResponse;
  }
};
