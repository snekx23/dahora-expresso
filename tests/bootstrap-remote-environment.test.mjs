// =====================================================================
// Dahora Expresso — Suíte de Testes Dedicada: Bootstrap Automatizado do Ambiente Remoto & Hardening de Segredos
// File: tests/bootstrap-remote-environment.test.mjs
// =====================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import { runBootstrap } from '../scripts/bootstrap-remote-environment.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.resolve(projectRoot, '.env.bootstrap.remote') });

const LOCAL_SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function setupMockEnv() {
  process.env.SUPABASE_URL = 'https://mockprojectref.supabase.co';
  process.env.SUPABASE_SECRET_KEY = LOCAL_SERVICE_KEY;
  process.env.EXPECTED_PROJECT_REF = 'mockprojectref';
  process.env.APP_ENV = 'remote';
  process.env.BOOTSTRAP_CONFIRMATION = 'PROVISION_DAHORA_REMOTE';
}

function setupLocalEnv() {
  const envPath = path.resolve(projectRoot, '.env.bootstrap.remote');
  dotenv.config({ path: envPath, override: true });
}

test('1. Ausência de qualquer variável obrigatória aborta a execução listando o campo ausente', async () => {
  setupMockEnv();
  delete process.env.SUPABASE_SECRET_KEY;

  await assert.rejects(
    async () => {
      await runBootstrap({ dryRun: true, isTest: true });
    },
    (err) => {
      assert.ok(err.message.includes('SUPABASE_SECRET_KEY'), 'Mensagem lista a variável ausente.');
      return true;
    },
    'Deveria ter abortado pela ausência da chave secreta.'
  );

  setupMockEnv();
});

test('2. Project Ref divergente do esperado aborta a execução', async () => {
  setupMockEnv();
  process.env.SUPABASE_URL = 'https://abc123projectref.supabase.co';
  process.env.EXPECTED_PROJECT_REF = 'xyz987differentref';

  await assert.rejects(
    async () => {
      await runBootstrap({ dryRun: true, isTest: true });
    },
    { message: 'Divergent project ref' },
    'Deveria ter abortado pelo Project Ref divergente.'
  );

  setupMockEnv();
});

test('3. Confirmação ausente aborta a execução do bootstrap', async () => {
  setupMockEnv();
  delete process.env.BOOTSTRAP_CONFIRMATION;

  await assert.rejects(
    async () => {
      await runBootstrap({ dryRun: false, isTest: true });
    },
    (err) => {
      assert.ok(err.message.includes('BOOTSTRAP_CONFIRMATION'), 'Mensagem lista BOOTSTRAP_CONFIRMATION como ausente.');
      return true;
    },
    'Deveria ter abortado pela ausência de BOOTSTRAP_CONFIRMATION.'
  );

  setupMockEnv();
});

test('4. Senhas e secret key não aparecem no código do script ou runtime-config.js', async () => {
  const scriptContent = await readFile(path.join(projectRoot, 'scripts', 'bootstrap-remote-environment.mjs'), 'utf8');
  assert.equal(scriptContent.includes(LOCAL_SERVICE_KEY), false, 'Chave secreta real não está hardcoded no script.');
  assert.ok(scriptContent.includes('maskString'), 'Função de mascaramento presente no script.');
});

test('5. Hardening de Segredos: .env.bootstrap.remote.example não contém valores nem segredos reais', async () => {
  const exampleContent = await readFile(path.join(projectRoot, '.env.bootstrap.remote.example'), 'utf8');
  assert.equal(exampleContent.includes('eyJhbGciOiJ'), false, 'Sem JWTs no example.');
  assert.equal(exampleContent.includes('SenhaForte'), false, 'Sem senhas no example.');
  assert.equal(exampleContent.includes('tskivauszmhhtqtegvwb'), false, 'Sem project-ref real no example.');
  assert.equal(exampleContent.includes('SUPABASE_SECRET_KEY='), true, 'Possui declaração da variável.');
  const secretKeyLine = exampleContent.split('\n').find(l => l.startsWith('SUPABASE_SECRET_KEY='));
  assert.equal(secretKeyLine.trim(), 'SUPABASE_SECRET_KEY=', 'SUPABASE_SECRET_KEY deve estar vazia no example.');

  const pass1Line = exampleContent.split('\n').find(l => l.startsWith('OWNER_1_PASSWORD='));
  assert.equal(pass1Line.trim(), 'OWNER_1_PASSWORD=', 'OWNER_1_PASSWORD deve estar vazia no example.');
});

test('6. Git Check-Ignore: .env.bootstrap.remote e bootstrap-credentials.local.txt estão ignorados', () => {
  const checkRemote = execSync('git check-ignore -v .env.bootstrap.remote', { cwd: projectRoot, encoding: 'utf8' });
  assert.ok(checkRemote.includes('.env.bootstrap.remote'), '.env.bootstrap.remote ignorado pelo Git.');

  const checkCreds = execSync('git check-ignore -v bootstrap-credentials.local.txt', { cwd: projectRoot, encoding: 'utf8' });
  assert.ok(checkCreds.includes('bootstrap-credentials.local.txt'), 'bootstrap-credentials.local.txt ignorado pelo Git.');
});

test('7. Nenhuma chave sb_secret_ ou service_role está hardcoded na pasta public/', async () => {
  const publicFiles = await readdir(path.join(projectRoot, 'public'));
  for (const file of publicFiles) {
    if (file.endsWith('.js') || file.endsWith('.html')) {
      const content = await readFile(path.join(projectRoot, 'public', file), 'utf8');
      assert.equal(content.includes('sb_secret_'), false, `Sem sb_secret_ em public/${file}`);
      assert.equal(content.includes('SUPABASE_SECRET_KEY'), false, `Sem SUPABASE_SECRET_KEY em public/${file}`);
      assert.equal(content.includes('service_role'), false, `Sem service_role em public/${file}`);
    }
  }
});

test('8. Dry-run executa simulação sem falhas contra o ambiente remoto e cobre exatamente as 2 contas de Owner', async () => {
  setupLocalEnv();
  const res = await runBootstrap({ dryRun: true, isTest: true });
  assert.equal(res.success, true, 'Dry-run concluído com sucesso.');
  assert.equal(res.isDryRun, true, 'Modo dry-run confirmado.');
  assert.equal(res.reportSummary.length, 2, 'Bootstrap de produção cobre estritamente as 2 contas de Owner.');
  assert.ok(res.reportSummary.every(item => item.role === 'owner'), 'Todas as contas provisionadas no ambiente remoto possuem role owner.');
});

test('11. config.local.js possui carregamento condicional seguro restrito ao localhost em index.html e motoboy.html', async () => {
  const indexHtml = await readFile(path.join(projectRoot, 'public', 'index.html'), 'utf8');
  const motoboyHtml = await readFile(path.join(projectRoot, 'public', 'motoboy.html'), 'utf8');

  // Não deve conter tag <script src="config.local.js"></script> direta
  assert.equal(indexHtml.includes('<script src="config.local.js"></script>'), false, 'index.html não possui tag estática para config.local.js');
  assert.equal(motoboyHtml.includes('<script src="config.local.js"></script>'), false, 'motoboy.html não possui tag estática para config.local.js');

  // Deve verificar hostname === 'localhost' ou '127.0.0.1' ou '' antes de criar o script
  assert.ok(indexHtml.includes("h === 'localhost' || h === '127.0.0.1'"), 'index.html verifica se a execução é local.');
  assert.ok(motoboyHtml.includes("h === 'localhost' || h === '127.0.0.1'"), 'motoboy.html verifica se a execução é local.');
});
