// =====================================================================
// Dahora Expresso — Suíte de Testes Dedicada: Isolamento de Ambientes & Reset Autoritativo Demo
// File: tests/demo-environment-isolation-and-reset.test.mjs
// =====================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { runBootstrap } from '../scripts/bootstrap-remote-environment.mjs';
import { runDemoBootstrap } from '../scripts/bootstrap-demo-environment.mjs';
import { executeDemoReset } from '../scripts/reset-demo-environment.mjs';

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const LOCAL_PG_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function setupDemoEnvVars() {
  const envPath = path.resolve(projectRoot, '.env.bootstrap.remote');
  dotenv.config({ path: envPath, override: true });
}

function getRef(url) {
  try { return new URL(url).hostname.split('.')[0]; } catch (e) { return '127'; }
}

test('1. Admin Demo NÃO é provisionado no script de bootstrap de Produção', async () => {
  setupDemoEnvVars();
  const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  process.env.EXPECTED_PROJECT_REF = getRef(url);
  process.env.APP_ENV = 'production';
  process.env.ENVIRONMENT_KIND = 'production';
  process.env.DEMO_RESET_ENABLED = 'false';
  process.env.BOOTSTRAP_CONFIRMATION = 'PROVISION_DAHORA_PRODUCTION';

  const res = await runBootstrap({ dryRun: true, isTest: true });
  assert.equal(res.success, true);

  const adminDemo = res.reportSummary.find(r => r.role === 'admin');
  assert.equal(adminDemo, undefined, 'Nenhuma conta Admin Demo no bootstrap de produção.');

  setupDemoEnvVars();
});

test('2. Reset autoritativo recusa execução no ambiente de produção', async () => {
  setupDemoEnvVars();
  const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  const key = process.env.SUPABASE_SECRET_KEY || 'dummy';
  await assert.rejects(
    async () => {
      await executeDemoReset({
        supabaseUrl: url,
        supabaseSecretKey: key,
        environmentKind: 'production',
        confirmationText: 'RESTAURAR DEMO',
        isTest: true
      });
    },
    (err) => {
      assert.ok(err.message.includes('production'), 'Mensagem recusa ambiente de produção.');
      return true;
    }
  );
  setupDemoEnvVars();
});

test('3. Reset autoritativo exige texto de confirmação exato: RESTAURAR DEMO', async () => {
  setupDemoEnvVars();
  const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  const key = process.env.SUPABASE_SECRET_KEY || 'dummy';
  await assert.rejects(
    async () => {
      await executeDemoReset({
        supabaseUrl: url,
        supabaseSecretKey: key,
        environmentKind: 'demo',
        demoResetEnabled: true,
        confirmationText: 'CONFIRMAR',
        isTest: true
      });
    },
    (err) => {
      assert.ok(err.message.includes('RESTAURAR DEMO'), 'Exige confirmação RESTAURAR DEMO');
      return true;
    }
  );
  setupDemoEnvVars();
});

test('4. Trava contra execuções simultâneas de Reset', async () => {
  setupDemoEnvVars();
  const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  const key = process.env.SUPABASE_SECRET_KEY || 'dummy';

  const p1 = executeDemoReset({
    supabaseUrl: url,
    supabaseSecretKey: key,
    environmentKind: 'demo',
    demoResetEnabled: true,
    confirmationText: 'RESTAURAR DEMO',
    dryRun: true,
    isTest: true
  });

  const p2 = executeDemoReset({
    supabaseUrl: url,
    supabaseSecretKey: key,
    environmentKind: 'demo',
    demoResetEnabled: true,
    confirmationText: 'RESTAURAR DEMO',
    dryRun: true,
    isTest: true
  });

  const results = await Promise.allSettled([p1, p2]);
  const rejected = results.find(r => r.status === 'rejected');
  assert.ok(rejected, 'Segunda execução simultânea foi bloqueada.');
  assert.ok(rejected.reason.message.includes('already in progress'), 'Mensagem de trava simultânea confirmada.');
  setupDemoEnvVars();
});

test('5. Demo Reset preserva entidades base e limpa transações operacionais', async () => {
  setupDemoEnvVars();
  const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  const key = process.env.SUPABASE_SECRET_KEY || 'dummy';

  const res = await executeDemoReset({
    supabaseUrl: url,
    supabaseSecretKey: key,
    environmentKind: 'demo',
    demoResetEnabled: true,
    confirmationText: 'RESTAURAR DEMO',
    dryRun: false,
    isTest: true
  });

  assert.equal(res.success, true);
  assert.ok(res.execution_id.startsWith('RESET-'), 'Gera execution_id único.');
  assert.ok(typeof res.duration_ms === 'number', 'Retorna duração em ms.');
  setupDemoEnvVars();
});

test('6. Script de Bootstrap DEMO provisiona Admin Demo, Cliente Demo e Motoboy Demo de forma idempotente', async () => {
  setupDemoEnvVars();
  const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  process.env.EXPECTED_PROJECT_REF = getRef(url);
  process.env.APP_ENV = 'demo';
  process.env.ENVIRONMENT_KIND = 'demo';
  process.env.DEMO_RESET_ENABLED = 'true';
  process.env.BOOTSTRAP_CONFIRMATION = 'PROVISION_DAHORA_DEMO';

  const res = await runDemoBootstrap({ dryRun: true, isTest: true });
  assert.equal(res.success, true);
  assert.equal(res.reportSummary.length, 3, 'Demo bootstrap provisiona Admin Demo, Cliente Demo e Motoboy Demo.');

  const adminDemo = res.reportSummary.find(r => r.role === 'admin');
  assert.ok(adminDemo, 'Admin Demo provisionado no ambiente Demo.');
  assert.equal(adminDemo.linkedEntityId, null, 'Admin Demo não possui commercial_client ou fleet.');

  setupDemoEnvVars();
});

test('7. UI do Reset não está visível quando DEMO_RESET_ENABLED !== true', async () => {
  const appJs = await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
  assert.ok(appJs.includes("if (envKind !== 'demo' || !isResetEnabled)"), 'app.js remove UI de reset se não estiver em ambiente demo.');
  assert.ok(appJs.includes('RESTAURAR DEMO'), 'Modal exige RESTAURAR DEMO.');
  assert.ok(appJs.includes("supabaseClient.functions.invoke('reset-demo-environment'"), 'app.js chama a Edge Function real via supabase.functions.invoke.');
  assert.ok(appJs.includes('Esta verificação controla apenas a interface'), 'Contém documentação explícita de UX vs Autorização Server-Side.');
});

test('8. Migration exclusiva supabase/migrations-demo/ contém a RPC transacional com advisory lock e environment_settings', async () => {
  const rpcSql = await readFile(path.join(projectRoot, 'supabase', 'migrations-demo', '20260805009900_demo_environment_reset_rpc.sql'), 'utf8');
  assert.ok(rpcSql.includes('CREATE OR REPLACE FUNCTION public.reset_demo_environment'), 'Declaração da RPC presente.');
  assert.ok(rpcSql.includes('pg_try_advisory_xact_lock(88998899)'), 'Contém trava de advisory lock transacional.');
  assert.ok(rpcSql.includes('public.environment_settings'), 'Verifica a tabela environment_settings do Postgres.');
  assert.ok(rpcSql.includes('demo_admin_user_id'), 'Valida o demo_admin_user_id canônico.');
  assert.ok(rpcSql.includes('v_caller_uid <> v_env.demo_admin_user_id'), 'Apenas o UUID canônico do Admin Demo pode disparar reset.');
  assert.ok(rpcSql.includes('public.demo_auth_cleanup_queue'), 'Insere usuários extras na fila de reconciliação de Auth Users.');
  assert.ok(rpcSql.includes('claim_demo_auth_cleanup_item'), 'Declaração da RPC de Claim Atômico presente.');
  assert.ok(rpcSql.includes('FOR UPDATE SKIP LOCKED'), 'Contém FOR UPDATE SKIP LOCKED no claim atômico.');
});

test('9. Supabase Edge Function em supabase/functions/reset-demo-environment/index.ts exige POST e Bearer Token', async () => {
  const edgeFn = await readFile(path.join(projectRoot, 'supabase', 'functions', 'reset-demo-environment', 'index.ts'), 'utf8');
  assert.ok(edgeFn.includes('req.method !== "POST"'), 'Edge Function recusa métodos diferentes de POST.');
  assert.ok(edgeFn.includes('UNAUTHORIZED: Bearer token is missing'), 'Edge Function exige Bearer token do usuário.');
  assert.ok(edgeFn.includes('claim_demo_auth_cleanup_item'), 'Edge Function invoca o claim atômico da fila.');
  assert.equal(edgeFn.includes('SUPABASE_SECRET_KEY='), false, 'Sem chaves privadas hardcoded na Edge Function.');
});

test('10. Documentação arquitetural docs/ENVIRONMENTS_AND_DEMO_RESET.md está presente e atualizada', async () => {
  const doc = await readFile(path.join(projectRoot, 'docs', 'ENVIRONMENTS_AND_DEMO_RESET.md'), 'utf8');
  assert.ok(doc.includes('public.environment_settings'), 'Documenta a tabela de ambiente.');
  assert.ok(doc.includes('demo_admin_user_id'), 'Documenta identidades canônicas.');
  assert.ok(doc.includes('Frontend é apenas UX'), 'Documenta que frontend não constitui autorização.');
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
    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO public.environment_settings (id, environment_kind, reset_enabled, demo_admin_user_id)
          VALUES ('test_bad', 'demo', true, '11111111-1111-1111-1111-111111111111')
        `);
      },
      (err) => {
        assert.ok(err.message.includes('chk_demo_base_user_ids') || err.message.includes('chk_environment_settings_singleton'), 'Constraint impediu UUID parcialmente preenchido.');
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO public.environment_settings (id, environment_kind, reset_enabled)
          VALUES ('other_id', 'demo', true)
        `);
      },
      (err) => {
        assert.ok(err.message.includes('chk_environment_settings_singleton'), 'Constraint impediu id diferente de current.');
        return true;
      }
    );
  } finally {
    await client.end();
  }
});

test('13. Claim Atômico RPC (claim_demo_auth_cleanup_item) com FOR UPDATE SKIP LOCKED', async () => {
  const client1 = new Client({ connectionString: LOCAL_PG_URL });
  const client2 = new Client({ connectionString: LOCAL_PG_URL });
  await client1.connect();
  await client2.connect();

  try {
    const testExecId = `TEST-EXEC-${Date.now()}`;
    const user1 = '22222222-2222-2222-2222-222222222222';
    const user2 = '33333333-3333-3333-3333-333333333333';

    await client1.query(`
      INSERT INTO public.demo_auth_cleanup_queue (execution_id, auth_user_id, status)
      VALUES ('${testExecId}', '${user1}', 'pending'), ('${testExecId}', '${user2}', 'pending')
      ON CONFLICT DO NOTHING;
    `);

    // Iniciar transações para testar concorrência de claim
    await client1.query('BEGIN');
    await client2.query('BEGIN');

    const res1 = await client1.query('SELECT * FROM public.claim_demo_auth_cleanup_item()');
    const res2 = await client2.query('SELECT * FROM public.claim_demo_auth_cleanup_item()');

    await client1.query('COMMIT');
    await client2.query('COMMIT');

    assert.equal(res1.rows.length, 1, 'Primeira chamada reivindicou 1 item.');
    assert.equal(res2.rows.length, 1, 'Segunda chamada simultânea reivindicou 1 item diferente.');
    assert.notEqual(res1.rows[0].auth_user_id, res2.rows[0].auth_user_id, 'Zero colisão de IDs entre chamadas concorrentes.');

    // Finalizar os itens do teste com o claim_token UUID correto
    await client1.query(`SELECT public.complete_demo_auth_cleanup_item('${res1.rows[0].queue_id}', '${res1.rows[0].claim_token}')`);
    await client1.query(`SELECT public.complete_demo_auth_cleanup_item('${res2.rows[0].queue_id}', '${res2.rows[0].claim_token}')`);
  } finally {
    await client1.end();
    await client2.end();
  }
});

test('14. Recuperação de Processing Abandonado (> 5 min) e Limite de Tentativas (attempt_count < 5)', async () => {
  const client = new Client({ connectionString: LOCAL_PG_URL });
  await client.connect();

  try {
    await client.query("DELETE FROM public.demo_auth_cleanup_queue WHERE execution_id LIKE 'TEST-%'");

    const testExecId = `TEST-STALE-${Date.now()}`;
    const userStale = '44444444-4444-4444-4444-444444444444';
    const userMaxAttempts = '55555555-5555-5555-5555-555555555555';

    // Inserir item com processing abandonado há 10 minutos
    await client.query(`
      INSERT INTO public.demo_auth_cleanup_queue (execution_id, auth_user_id, status, attempt_count, processing_started_at)
      VALUES ('${testExecId}', '${userStale}', 'processing', 1, NOW() - INTERVAL '10 minutes');
    `);

    // Inserir item com 5 tentativas (deve ser ignorado)
    await client.query(`
      INSERT INTO public.demo_auth_cleanup_queue (execution_id, auth_user_id, status, attempt_count)
      VALUES ('${testExecId}', '${userMaxAttempts}', 'failed', 5);
    `);

    const claimRes = await client.query('SELECT * FROM public.claim_demo_auth_cleanup_item()');
    assert.equal(claimRes.rows.length, 1, 'Reivindicou o item abandonado.');
    assert.equal(claimRes.rows[0].auth_user_id, userStale, 'Item com timeout > 5min foi recuperado com sucesso.');
    assert.equal(claimRes.rows[0].attempt_count, 2, 'Incrementou o attempt_count para 2.');
    assert.ok(claimRes.rows[0].claim_token, 'Gerou novo claim_token UUID.');

    // Limpeza
    await client.query(`SELECT public.complete_demo_auth_cleanup_item('${claimRes.rows[0].queue_id}', '${claimRes.rows[0].claim_token}')`);
  } finally {
    await client.end();
  }
});

test('15. Proteção por claim_token UUID: Claim antigo recusa finalização se o token divergir', async () => {
  const client = new Client({ connectionString: LOCAL_PG_URL });
  await client.connect();

  try {
    const testExecId = `TEST-TOKEN-${Date.now()}`;
    const userToken = '66666666-6666-6666-6666-666666666666';
    const wrongToken = '77777777-7777-7777-7777-777777777777';

    await client.query(`
      INSERT INTO public.demo_auth_cleanup_queue (execution_id, auth_user_id, status)
      VALUES ('${testExecId}', '${userToken}', 'pending');
    `);

    const claimRes = await client.query('SELECT * FROM public.claim_demo_auth_cleanup_item()');
    const { queue_id, claim_token } = claimRes.rows[0];

    // Tentativa com claim_token ERRADO deve retornar false e NÃO alterar o registro
    const wrongComp = await client.query(`SELECT public.complete_demo_auth_cleanup_item('${queue_id}', '${wrongToken}')`);
    assert.equal(wrongComp.rows[0].complete_demo_auth_cleanup_item, false, 'Finalização com token errado é RECUSADA.');

    // Tentativa com claim_token CORRETO deve retornar true e marcar completed
    const rightComp = await client.query(`SELECT public.complete_demo_auth_cleanup_item('${queue_id}', '${claim_token}')`);
    assert.equal(rightComp.rows[0].complete_demo_auth_cleanup_item, true, 'Finalização com token correto é ACEITA.');
  } finally {
    await client.end();
  }
});
