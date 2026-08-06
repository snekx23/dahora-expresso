// =====================================================================
// Dahora Expresso — Suíte de Segurança: Ausência Total de Segredos e JWTs Hardcoded
// File: tests/no-hardcoded-supabase-secrets.test.mjs
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

test('1. Nenhum JWT de 3 segmentos (eyJ...) está hardcoded em arquivos rastreados pelo Git', () => {
  let output = '';
  try {
    output = execSync(
      'git grep -n -E "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"',
      { cwd: projectRoot, encoding: 'utf8' }
    ).trim();
  } catch (err) {
    if (err.status === 1) {
      output = '';
    } else {
      throw err;
    }
  }

  assert.equal(
    output,
    '',
    `[VIOLAÇÃO DE SEGURANÇA] JWT hardcoded encontrado nos arquivos rastreados:\n${output}`
  );
});

test('2. Nenhuma chave sb_secret_ está hardcoded em arquivos rastreados pelo Git', () => {
  let output = '';
  try {
    output = execSync(
      'git grep -n -E "sb_secret_[A-Za-z0-9_-]+"',
      { cwd: projectRoot, encoding: 'utf8' }
    ).trim();
  } catch (err) {
    if (err.status === 1) {
      output = '';
    } else {
      throw err;
    }
  }

  assert.equal(
    output,
    '',
    `[VIOLAÇÃO DE SEGURANÇA] sb_secret_ hardcoded encontrado nos arquivos rastreados:\n${output}`
  );
});

test('3. Nenhuma atribuição com fallback secreto existe em scripts, server ou frontend', async () => {
  const publicConfig = await readFile(path.join(projectRoot, 'public', 'config.js'), 'utf8');
  assert.equal(publicConfig.includes('eyJhbGci'), false, 'public/config.js não contém JWT hardcoded.');
  assert.equal(publicConfig.includes('sb_secret_'), false, 'public/config.js não contém sb_secret_.');

  const pushService = await readFile(path.join(projectRoot, 'server', 'push-service.mjs'), 'utf8');
  assert.equal(pushService.includes('eyJhbGci'), false, 'server/push-service.mjs não contém JWT hardcoded.');
  assert.equal(pushService.includes('sb_secret_'), false, 'server/push-service.mjs não contém sb_secret_.');
});

test('4. Arquivos .example possuem apenas variáveis com valores vazios ou placeholders genéricos', async () => {
  const exampleFiles = [
    '.env.bootstrap.remote.example',
    '.env.bootstrap.demo.example',
    '.env.bootstrap.production.example'
  ];

  for (const file of exampleFiles) {
    const content = await readFile(path.join(projectRoot, file), 'utf8');
    assert.equal(content.includes('eyJhbGci'), false, `${file} não contém JWT.`);
    assert.equal(content.includes('sb_secret_'), false, `${file} não contém sb_secret_.`);

    const lines = content.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#') && l.includes('='));

    for (const line of lines) {
      const parts = line.split('=');
      const val = parts.slice(1).join('=').trim();
      const isPlaceholder = val === '' || val.includes('<YOUR_PROJECT_REF>');
      assert.equal(isPlaceholder, true, `Linha no ${file} deve estar com valor vazio ou placeholder genérico: ${line}`);
    }
  }
});
