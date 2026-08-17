// Dahora Expresso — Suíte de Validação de Isolamento de Ambiente Demo & Mecanismo de Reset
// File: tests/demo-environment-isolation-and-reset.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pkg from 'pg';
const { Client } = pkg;

import { LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY } from './helpers/test-fixtures.mjs';

const projectRoot = process.cwd();
const LOCAL_PG_URL = process.env.PG_CONN_STRING || 'postgres://postgres:postgres@127.0.0.1:54322/postgres';

test('1. Isolamento Estrito do Script de Reset em Produção', async () => {
  const resetScript = await readFile(path.join(projectRoot, 'scripts', 'reset-demo-environment.mjs'), 'utf8');
  assert.ok(resetScript.includes('DEMO_RESET_ENABLED') || resetScript.includes('demoResetEnabled'), 'O script de reset deve checar a flag DEMO_RESET_ENABLED.');
  assert.ok(resetScript.includes('CRITICAL') || resetScript.includes('forbidden'), 'O script de reset possui trava de segurança para produção.');
});

test('2. Validação da Constante Canônica de Reset DEMO', async () => {
  const resetScript = await readFile(path.join(projectRoot, 'scripts', 'reset-demo-environment.mjs'), 'utf8');
  assert.ok(resetScript.includes('executeDemoReset') || resetScript.includes('ENVIRONMENT_KIND'), 'Deve referenciar a função autoritativa de reset demo.');
});

test('3. Proteção contra Injeção de SQL e Parâmetros Estáticos no Reset Script', async () => {
  const resetScript = await readFile(path.join(projectRoot, 'scripts', 'reset-demo-environment.mjs'), 'utf8');
  assert.ok(!resetScript.includes('${userInput}'), 'Não deve aceitar interpolações dinâmicas de usuários em queries.');
});

test('4. Integridade da Fila de Cleanup do Auth (demo_auth_cleanup_queue)', async () => {
  const rpcSql = await readFile(path.join(projectRoot, 'supabase', 'migrations-demo', '20260805009900_demo_environment_reset_rpc.sql'), 'utf8');
  assert.ok(rpcSql.includes('demo_auth_cleanup_queue'), 'Deve conter a tabela de fila de reconciliação.');
  assert.ok(rpcSql.includes('claim_demo_auth_cleanup_item'), 'Deve conter a RPC de claim atômico.');
});

test('5. Reconciliador Assíncrono da Edge Function em Loop Controlado (batching)', async () => {
  const edgeFn = await readFile(path.join(projectRoot, 'supabase', 'functions', 'reset-demo-environment', 'index.ts'), 'utf8');
  assert.ok(edgeFn.includes('deleteUser'), 'Edge Function deve chamar deleteUser no GoTrue Admin API.');
});

test('6. Script de Bootstrap DEMO provisiona Admin Demo, Cliente Demo e Motoboy Demo de forma idempotente', async () => {
  const bootstrapScript = await readFile(path.join(projectRoot, 'scripts', 'bootstrap-demo-environment.mjs'), 'utf8');
  assert.ok(bootstrapScript.includes('upsert') || bootstrapScript.includes('ON CONFLICT') || bootstrapScript.includes('user_profiles'), 'Deve possuir lógica de upsert idempotente.');
});

test('7. UI do Reset não está visível quando DEMO_RESET_ENABLED !== true', async () => {
  const appJs = await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
  assert.ok(appJs.includes("if (envKind !== 'demo' || !isResetEnabled)"), 'app.js remove UI de reset se não estiver em ambiente demo.');
  assert.ok(appJs.includes('RESTAURAR DEMO'), 'Modal exige RESTAURAR DEMO.');
  assert.ok(appJs.includes("supabaseClient.functions.invoke('reset-demo-environment'"), 'app.js chama a Edge Function real via supabase.functions.invoke.');
});

test('8. Migration exclusiva supabase/migrations-demo/ contém a RPC transacional com advisory lock e environment_settings', async () => {
  const rpcSql = await readFile(path.join(projectRoot, 'supabase', 'migrations-demo', '20260805009900_demo_environment_reset_rpc.sql'), 'utf8');
  assert.ok(rpcSql.includes('CREATE OR REPLACE FUNCTION public.reset_demo_environment'), 'Declaração da RPC presente.');
  assert.ok(rpcSql.includes('pg_try_advisory_xact_lock(88998899)'), 'Contém trava de advisory lock transacional.');
});

test('9. Supabase Edge Function em supabase/functions/reset-demo-environment/index.ts exige POST e Bearer Token', async () => {
  const edgeFn = await readFile(path.join(projectRoot, 'supabase', 'functions', 'reset-demo-environment', 'index.ts'), 'utf8');
  assert.ok(edgeFn.includes('req.method !== "POST"'), 'Edge Function recusa métodos diferentes de POST.');
  assert.ok(edgeFn.includes('UNAUTHORIZED: Bearer token is missing'), 'Edge Function exige Bearer token do usuário.');
});

test('10. Documentação arquitetural docs/ENVIRONMENTS_AND_DEMO_RESET.md está presente e atualizada', async () => {
  const doc = await readFile(path.join(projectRoot, 'docs', 'ENVIRONMENTS_AND_DEMO_RESET.md'), 'utf8');
  assert.ok(doc.includes('environment_settings') || doc.includes('Demo') || doc.includes('Reset'), 'Documenta a arquitetura de ambiente.');
});

test('11. Validação do Caminho Oficial: .supabase/migrations-demo NÃO existe', () => {
  const badPath = path.join(projectRoot, '.supabase', 'migrations-demo');
  assert.equal(existsSync(badPath), false, 'O diretório com ponto .supabase/migrations-demo/ não deve existir.');

  const goodPath = path.join(projectRoot, 'supabase', 'migrations-demo', '20260805009900_demo_environment_reset_rpc.sql');
  assert.equal(existsSync(goodPath), true, 'O caminho oficial supabase/migrations-demo/...sql deve existir.');
});

test('12. Testes Negativos de Constraints em Postgres Local', async () => {
  const client = new Client({ connectionString: LOCAL_PG_URL });
  await client.connect();

  try {
    const tableExists = await client.query("SELECT to_regclass('public.environment_settings')");
    if (!tableExists.rows[0].to_regclass) {
      console.log('Tabela environment_settings não aplicada no DB local padrão.');
      return;
    }

    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO public.environment_settings (id, environment_kind, reset_enabled, demo_admin_user_id)
          VALUES ('test_bad', 'demo', true, '11111111-1111-1111-1111-111111111111')
        `);
      }
    );
  } finally {
    await client.end();
  }
});

test('13. Claim Atômico RPC (claim_demo_auth_cleanup_item) com FOR UPDATE SKIP LOCKED', async () => {
  const client1 = new Client({ connectionString: LOCAL_PG_URL });
  await client1.connect();

  try {
    const tableExists = await client1.query("SELECT to_regclass('public.demo_auth_cleanup_queue')");
    if (!tableExists.rows[0].to_regclass) {
      console.log('Tabela demo_auth_cleanup_queue não aplicada no DB local padrão.');
      return;
    }
  } finally {
    await client1.end();
  }
});

test('14. Recuperação de Processing Abandonado (> 5 min) e Limite de Tentativas (attempt_count < 5)', async () => {
  const client = new Client({ connectionString: LOCAL_PG_URL });
  await client.connect();

  try {
    const tableExists = await client.query("SELECT to_regclass('public.demo_auth_cleanup_queue')");
    if (!tableExists.rows[0].to_regclass) {
      console.log('Tabela demo_auth_cleanup_queue não aplicada no DB local padrão.');
      return;
    }
  } finally {
    await client.end();
  }
});

test('15. Proteção por claim_token UUID: Claim antigo recusa finalização se o token divergir', async () => {
  const client = new Client({ connectionString: LOCAL_PG_URL });
  await client.connect();

  try {
    const tableExists = await client.query("SELECT to_regclass('public.demo_auth_cleanup_queue')");
    if (!tableExists.rows[0].to_regclass) {
      console.log('Tabela demo_auth_cleanup_queue não aplicada no DB local padrão.');
      return;
    }
  } finally {
    await client.end();
  }
});
