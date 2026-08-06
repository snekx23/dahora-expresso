// =====================================================================
// Dahora Expresso — Suíte de Testes de Segurança do Seed de Homologação
// File: tests/seed-homologation-safety-locks.test.mjs
// =====================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

test('1. seed_homologation.js recusa URLs com domínio supabase.co', () => {
  let failed = false;
  try {
    execSync('node supabase/seed_homologation.js', {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPABASE_URL: 'https://tskivauszmhhtqtegvwb.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-key',
        SEED_ENVIRONMENT_KIND: 'local',
        SEED_CONFIRMATION: 'SEED_DAHORA_LOCAL_ONLY'
      }
    });
  } catch (err) {
    failed = true;
    assert.ok(err.stderr.includes('URL remota detectada') || err.stderr.includes('ERRO DE SEGURANÇA'), 'Mensagem indica bloqueio de URL remota.');
  }
  assert.equal(failed, true, 'Seed deve abortar ao receber URL com supabase.co.');
});

test('2. seed_homologation.js recusa confirmação ausente (SEED_CONFIRMATION)', () => {
  let failed = false;
  try {
    execSync('node supabase/seed_homologation.js', {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-key',
        SEED_ENVIRONMENT_KIND: 'local',
        SEED_CONFIRMATION: ''
      }
    });
  } catch (err) {
    failed = true;
    assert.ok(err.stderr.includes('ERRO DE CONFIRMAÇÃO'), 'Mensagem indica confirmação ausente.');
  }
  assert.equal(failed, true, 'Seed deve abortar sem SEED_CONFIRMATION.');
});

test('3. seed_homologation.js recusa SEED_ENVIRONMENT_KIND diferente de local', () => {
  let failed = false;
  try {
    execSync('node supabase/seed_homologation.js', {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-key',
        SEED_ENVIRONMENT_KIND: 'remote',
        SEED_CONFIRMATION: 'SEED_DAHORA_LOCAL_ONLY'
      }
    });
  } catch (err) {
    failed = true;
    assert.ok(err.stderr.includes('ERRO DE CONFIRMAÇÃO'), 'Mensagem indica ambiente inválido.');
  }
  assert.equal(failed, true, 'Seed deve abortar se SEED_ENVIRONMENT_KIND não for local.');
});

test('4. seed_homologation.js recusa execução sem Service Role Key', () => {
  let failed = false;
  try {
    execSync('node supabase/seed_homologation.js', {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: '',
        SUPABASE_SECRET_KEY: '',
        SEED_ENVIRONMENT_KIND: 'local',
        SEED_CONFIRMATION: 'SEED_DAHORA_LOCAL_ONLY'
      }
    });
  } catch (err) {
    failed = true;
    assert.ok(err.stderr.includes('SUPABASE_SERVICE_ROLE_KEY é obrigatória'), 'Mensagem indica chave ausente.');
  }
  assert.equal(failed, true, 'Seed deve abortar sem Service Role Key.');
});

test('5. seed_homologation.js utiliza o access_level canônico "operador"', async () => {
  const seedContent = await readFile(path.join(projectRoot, 'supabase', 'seed_homologation.js'), 'utf8');
  assert.ok(seedContent.includes("access_level: 'operador'"), 'Deve utilizar access_level: operador');
  assert.equal(seedContent.includes("access_level: 'full'"), false, 'Não deve utilizar access_level: full');
});

test('6. Nenhuma credencial ou JWT está hardcoded no seed_homologation.js', async () => {
  const seedContent = await readFile(path.join(projectRoot, 'supabase', 'seed_homologation.js'), 'utf8');
  assert.equal(seedContent.includes('eyJhbGci'), false, 'Sem JWT hardcoded.');
  assert.equal(seedContent.includes('sb_secret_'), false, 'Sem sb_secret_ hardcoded.');
});
