// =====================================================================
// Dahora Expresso — Gerador de Runtime Config para Cloudflare Pages
// File: scripts/generate-runtime-config.mjs
// =====================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputFile = path.join(projectRoot, 'public', 'runtime-config.js');

function fail(message) {
  console.error(`❌ [BUILD ERROR] ${message}`);
  process.exit(1);
}

// 1. Validação de Segurança contra Vazamento de Segredos
const forbiddenKeys = ['SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY', 'DATABASE_URL', 'DB_PASSWORD', 'JWT_SECRET', 'VAPID_PRIVATE_KEY'];
forbiddenKeys.forEach(key => {
  if (process.env[key] && process.env[`EXPORT_${key}`] === 'true') {
    fail(`Tentativa explícita de exportar segredo confidencial "${key}" para o frontend detectada. Build abortado.`);
  }
});

// 2. Validação Obrigatória das Variáveis de Conexão Remota
const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!supabaseUrl) {
  fail('A variável de ambiente SUPABASE_URL é obrigatória para o build do Cloudflare Pages.');
}

if (!supabaseKey) {
  fail('A variável de ambiente SUPABASE_ANON_KEY é obrigatória para o build do Cloudflare Pages.');
}

// 3. Validação de URL Remota HTTPS (Rejeitar URLs locais em staging/pages)
if (!supabaseUrl.startsWith('https://')) {
  fail(`SUPABASE_URL inválida ("${supabaseUrl}"). No build do Cloudflare Pages, a URL do Supabase deve obrigatoriamente usar HTTPS.`);
}

if (supabaseUrl.includes('127.0.0.1') || supabaseUrl.includes('localhost') || supabaseUrl.includes(':54321')) {
  fail('URLs locais (localhost / 127.0.0.1 / :54321) são proibidas no build do Cloudflare Pages.');
}

// 4. Mapeamento Estrito e Sanitizado das Variáveis Públicas
const DEFAULT_VAPID_PUBLIC_KEY = 'BEo-ivrbMWP4mK2syicv0ic_Wr2arC2LZBmtbtn2zHPzTbykpyJ22ETL2DX9t6bHFL5CGkMnTtAaq-2bcQ_sxYw';
let rawVapidKey = (process.env.VAPID_PUBLIC_KEY || process.env.PUSH_VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY).trim();

if (rawVapidKey) {
  const cleanStr = rawVapidKey.replace(/^["']|["']$/g, '');
  const padding = '='.repeat((4 - (cleanStr.length % 4)) % 4);
  const base64 = (cleanStr + padding).replace(/-/g, '+').replace(/_/g, '/');
  try {
    const rawData = Buffer.from(base64, 'base64');
    if (rawData.length !== 65 || rawData[0] !== 0x04) {
      console.warn(`⚠️ [BUILD WARNING] VAPID_PUBLIC_KEY fornecida ("${rawVapidKey.slice(0, 8)}...") é inválida (${rawData.length} bytes). Usando chave VAPID oficial validada.`);
      rawVapidKey = DEFAULT_VAPID_PUBLIC_KEY;
    }
  } catch (e) {
    rawVapidKey = DEFAULT_VAPID_PUBLIC_KEY;
  }
} else {
  rawVapidKey = DEFAULT_VAPID_PUBLIC_KEY;
}

const publicEnv = {
  "window.__ENV_SUPABASE_URL": supabaseUrl,
  "window.__ENV_SUPABASE_KEY": supabaseKey,
  "window.__ENV_GOOGLE_MAPS_API_KEY": (process.env.GOOGLE_MAPS_API_KEY || '').trim(),
  "window.__ENV_GOOGLE_MAPS_MAP_ID": (process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID').trim(),
  "window.__ENV_VAPID_PUBLIC_KEY": rawVapidKey,
  "window.__ENV_NAME": (process.env.APP_ENV || 'staging').trim(),
  "window.__ENV_ENVIRONMENT_KIND": (process.env.ENVIRONMENT_KIND || 'production').trim(),
  "window.__ENV_DEMO_RESET_ENABLED": (process.env.DEMO_RESET_ENABLED || 'false').trim(),
  "window.__ENV_COMMIT_SHA": (process.env.CF_PAGES_COMMIT_SHA || '').trim(),
  "window.__ENV_DEPLOY_URL": (process.env.CF_PAGES_URL || '').trim()
};

// 5. Geração Determinística via JSON.stringify
let fileContent = `// Dahora Expresso — Configuração Gerada no Build (Cloudflare Pages)\n`;
fileContent += `// Gerado em: ${new Date().toISOString()}\n`;
fileContent += `(function() {\n`;
fileContent += `  if (typeof window === 'undefined') return;\n`;

for (const [key, val] of Object.entries(publicEnv)) {
  fileContent += `  ${key} = ${JSON.stringify(val)};\n`;
}

fileContent += `})();\n`;

try {
  fs.writeFileSync(outputFile, fileContent, 'utf8');
  console.log(`✅ [BUILD SUCCESS] Configuração de runtime gerada com sucesso em public/runtime-config.js (Ambiente: "${publicEnv['window.__ENV_NAME']}").`);
} catch (err) {
  fail(`Falha ao escrever runtime-config.js: ${err.message}`);
}
