// =====================================================================
// Dahora Expresso — Suíte de Testes do Build e Runtime Config (Cloudflare Pages)
// File: tests/cloudflare-pages-runtime-config.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const runtimeConfigPath = path.join(projectRoot, 'public', 'runtime-config.js');

test('Suíte de Testes de Preparação do Cloudflare Pages (Runtime Config & Segurança)', async (t) => {

  // 1. Geração bem-sucedida com variáveis HTTPS válidas
  await t.test('1. Build gera public/runtime-config.js com variáveis HTTPS válidas', async () => {
    try {
      execSync('node scripts/generate-runtime-config.mjs', {
        cwd: projectRoot,
        env: {
          ...process.env,
          SUPABASE_URL: 'https://test-project.supabase.co',
          SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testkey',
          APP_ENV: 'staging',
          GOOGLE_MAPS_API_KEY: 'AIzaTestKey',
          VAPID_PUBLIC_KEY: 'BElTestVapid'
        },
        stdio: 'pipe'
      });

      const content = await readFile(runtimeConfigPath, 'utf8');
      assert.ok(content.includes('window.__ENV_SUPABASE_URL = "https://test-project.supabase.co"'), 'Contém SUPABASE_URL remota');
      assert.ok(content.includes('window.__ENV_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testkey"'), 'Contém SUPABASE_KEY');
      assert.ok(content.includes('window.__ENV_NAME = "staging"'), 'Contém APP_ENV');
      assert.equal(content.includes('service_role'), false, 'Não contém service_role');
    } finally {
      try { await unlink(runtimeConfigPath); } catch (e) {}
    }
  });

  // 2. Falha quando SUPABASE_URL estiver ausente
  await t.test('2. Build falha quando SUPABASE_URL estiver ausente', async () => {
    let failed = false;
    try {
      execSync('node scripts/generate-runtime-config.mjs', {
        cwd: projectRoot,
        env: {
          ...process.env,
          SUPABASE_URL: '',
          SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testkey'
        },
        stdio: 'pipe'
      });
    } catch (err) {
      failed = true;
      assert.notEqual(err.status, 0, 'Código de saída diferente de zero');
    }
    assert.equal(failed, true, 'Build deve ter falhado sem SUPABASE_URL');
  });

  // 3. Falha quando SUPABASE_ANON_KEY estiver ausente
  await t.test('3. Build falha quando SUPABASE_ANON_KEY estiver ausente', async () => {
    let failed = false;
    try {
      execSync('node scripts/generate-runtime-config.mjs', {
        cwd: projectRoot,
        env: {
          ...process.env,
          SUPABASE_URL: 'https://test-project.supabase.co',
          SUPABASE_ANON_KEY: ''
        },
        stdio: 'pipe'
      });
    } catch (err) {
      failed = true;
      assert.notEqual(err.status, 0, 'Código de saída diferente de zero');
    }
    assert.equal(failed, true, 'Build deve ter falhado sem SUPABASE_ANON_KEY');
  });

  // 4. Rejeição de URL local no build do Pages
  await t.test('4. Build rejeita URL local (http://127.0.0.1:54321 ou localhost)', async () => {
    let failed = false;
    try {
      execSync('node scripts/generate-runtime-config.mjs', {
        cwd: projectRoot,
        env: {
          ...process.env,
          SUPABASE_URL: 'http://127.0.0.1:54321',
          SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testkey'
        },
        stdio: 'pipe'
      });
    } catch (err) {
      failed = true;
    }
    assert.equal(failed, true, 'Build deve ter falhado com URL local em staging');
  });

  // 5. Tentativa de exportar SUPABASE_SERVICE_ROLE_KEY é bloqueada
  await t.test('5. Rejeição explícita de tentativa de exportar SUPABASE_SERVICE_ROLE_KEY', async () => {
    let failed = false;
    try {
      execSync('node scripts/generate-runtime-config.mjs', {
        cwd: projectRoot,
        env: {
          ...process.env,
          SUPABASE_URL: 'https://test-project.supabase.co',
          SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testkey',
          SUPABASE_SERVICE_ROLE_KEY: 'secret-role-key',
          EXPORT_SUPABASE_SERVICE_ROLE_KEY: 'true'
        },
        stdio: 'pipe'
      });
    } catch (err) {
      failed = true;
    }
    assert.equal(failed, true, 'Build deve falhar se tentar exportar service_role');
  });

  // 6. Ausência de fallbacks remotos em app.js e motoboy.js
  await t.test('6. app.js e motoboy.js não possuem fallback inline para localhost', async () => {
    const appJs = await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
    const motoboyJs = await readFile(path.join(projectRoot, 'public', 'motoboy.js'), 'utf8');

    // Verificar se não há fallback solto fora de window.SUPABASE_CONFIG
    assert.equal(appJs.includes("const supabaseUrl = window.SUPABASE_CONFIG ? window.SUPABASE_CONFIG.url : 'http://127.0.0.1:54321'"), false);
    assert.equal(motoboyJs.includes("const SUPABASE_URL = (typeof window !== 'undefined' && window.SUPABASE_CONFIG) ? window.SUPABASE_CONFIG.url : 'https://fajkqyapnycnnumpdwrr.supabase.co'"), false);
  });

  // 7. Ordem exata dos scripts em index.html e motoboy.html
  await t.test('7. Ordem exata das tags script em index.html e motoboy.html', async () => {
    const indexHtml = await readFile(path.join(projectRoot, 'public', 'index.html'), 'utf8');
    const motoboyHtml = await readFile(path.join(projectRoot, 'public', 'motoboy.html'), 'utf8');

    const indexRuntimePos = indexHtml.indexOf('<script src="runtime-config.js"></script>');
    const indexLocalPos = indexHtml.indexOf('<script src="config.local.js"></script>');
    const indexConfigPos = indexHtml.indexOf('<script src="config.js"></script>');
    const indexAppPos = indexHtml.indexOf('<script src="app.js');

    assert.ok(indexRuntimePos !== -1 && indexLocalPos !== -1 && indexConfigPos !== -1 && indexAppPos !== -1, 'Todas as tags de script presentes em index.html');
    assert.ok(indexRuntimePos < indexLocalPos && indexLocalPos < indexConfigPos && indexConfigPos < indexAppPos, 'Ordem dos scripts em index.html está correta');

    const motoboyRuntimePos = motoboyHtml.indexOf('<script src="runtime-config.js"></script>');
    const motoboyLocalPos = motoboyHtml.indexOf('<script src="config.local.js"></script>');
    const motoboyConfigPos = motoboyHtml.indexOf('<script src="config.js"></script>');
    const motoboyAppPos = motoboyHtml.indexOf('<script src="motoboy.js');

    assert.ok(motoboyRuntimePos !== -1 && motoboyLocalPos !== -1 && motoboyConfigPos !== -1 && motoboyAppPos !== -1, 'Todas as tags de script presentes em motoboy.html');
    assert.ok(motoboyRuntimePos < motoboyLocalPos && motoboyLocalPos < motoboyConfigPos && motoboyConfigPos < motoboyAppPos, 'Ordem dos scripts em motoboy.html está correta');
  });

  // 8. Service Worker sw.js: network-only para runtime-config.js e purga em activate
  await t.test('8. sw.js possui regra network-only para runtime-config.js e purga no activate', async () => {
    const swJs = await readFile(path.join(projectRoot, 'public', 'sw.js'), 'utf8');

    assert.equal(swJs.includes("url.pathname.includes('runtime-config.js')"), true, 'Regra network-only inclui runtime-config.js');
    assert.equal(swJs.includes("cache.delete('/runtime-config.js')"), true, 'Evento activate purga runtime-config.js do cache');
    
    // Garantir que runtime-config.js NÃO está em ASSETS_TO_CACHE
    const assetsMatch = swJs.match(/const ASSETS_TO_CACHE = \[([\s\S]*?)\];/);
    assert.ok(assetsMatch, 'ASSETS_TO_CACHE localizado');
    assert.equal(assetsMatch[1].includes('runtime-config.js'), false, 'runtime-config.js ausente do precache');
  });

  // 9. public/_headers possui no-cache para runtime-config.js e html
  await t.test('9. public/_headers possui regras de no-cache', async () => {
    const headers = await readFile(path.join(projectRoot, 'public', '_headers'), 'utf8');

    assert.ok(headers.includes('/runtime-config.js'), 'Contém rota /runtime-config.js');
    assert.ok(headers.includes('Cache-Control: no-cache, no-store, must-revalidate'), 'Contém no-store para runtime-config.js');
    assert.ok(headers.includes('/*.html'), 'Contém regra no-cache para html');
  });

  // 10. gitignore possui public/runtime-config.js
  await t.test('10. .gitignore ignora public/runtime-config.js', async () => {
    const gitignore = await readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('public/runtime-config.js'), '.gitignore contém public/runtime-config.js');
  });
});
