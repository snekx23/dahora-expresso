export default {
  async fetch(request, env, ctx) {
    const response = await env.ASSETS.fetch(request);
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Inject local environment variables dynamically into HTML entry points
    if (path === '/' || path === '/index.html' || path === '/motoboy.html') {
      let html = await response.text();
      
      const configScript = `
  <script>
    window.SUPABASE_CONFIG = {
      url: "${env.SUPABASE_URL || 'https://fajkqyapnycnnumpdwrr.supabase.co'}",
      key: "${env.SUPABASE_ANON_KEY || 'sb_publishable_zkb7DUOrpx9fiF6Af0cH8A_V8LrSb1a'}"
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
