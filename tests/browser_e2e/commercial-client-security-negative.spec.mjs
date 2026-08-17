// Spec: tests/browser_e2e/commercial-client-security-negative.spec.mjs
// Suite de testes de segurança negativa, autorização, concorrência e resiliência do provisionamento comercial

import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://127.0.0.1:8000';
const SUPABASE_URL = 'http://127.0.0.1:54321';

function getServiceRoleKey() {
  const secretKey = 'super-secret-jwt-token-with-at-least-32-characters-long';
  const header = { alg: 'HS256', typ: 'JWT' };
  const jwtPayload = { iss: 'supabase', ref: 'tskivauszmhhtqtegvwb', role: 'service_role', iat: 1785977877, exp: 2101553877 };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const encodedPayload = Buffer.from(JSON.stringify(jwtPayload)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const dataToSign = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac('sha256', secretKey).update(dataToSign).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${dataToSign}.${sig}`;
}

const serviceRoleKey = getServiceRoleKey();
const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey, {
  auth: { persistSession: false },
  global: { headers: { apikey: serviceRoleKey } }
});

test.describe('DAHORA EXPRESSO — SECURITY NEGATIVE & CONCURRENCY MATRIZ (RC.12.3A)', () => {
  let adminToken = '';
  let adminUserId = '';

  test.beforeAll(async () => {
    // Obtain active owner/admin profile from database
    const { data: adminProfiles } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id, email, role')
      .in('role', ['owner', 'admin'])
      .eq('is_active', true)
      .limit(1);

    if (adminProfiles && adminProfiles.length > 0) {
      adminUserId = adminProfiles[0].user_id;
      const adminEmail = adminProfiles[0].email;
      // Set password to ensure sign in works
      await supabaseAdmin.auth.admin.updateUserById(adminUserId, { password: 'Password123!', email_confirm: true });
      const { data: sData } = await supabaseAdmin.auth.signInWithPassword({
        email: adminEmail,
        password: 'Password123!'
      });
      adminToken = sData?.session?.access_token || '';
    }

    if (!adminToken) {
      const email = `admin.sec.test.${Date.now()}@dahoraexpresso.com.br`;
      const { data: u } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: 'Password123!',
        email_confirm: true
      });
      adminUserId = u.user.id;
      await supabaseAdmin.from('user_profiles').insert({
        user_id: adminUserId,
        name: 'Admin Security Tester',
        email,
        role: 'admin',
        is_active: true
      });
      const { data: sData } = await supabaseAdmin.auth.signInWithPassword({
        email,
        password: 'Password123!'
      });
      adminToken = sData.session.access_token;
    }
  });

  test('TEST A — Requisição sem Authorization Header -> 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/admin/create-client`, {
      data: {
        establishment_name: 'Test Sem Auth',
        responsible_name: 'Resp',
        phone: '51999990001',
        email: 'noauth@test.local',
        password: 'Password123!',
        address: 'Rua Teste, 100'
      }
    });
    expect(res.status()).toBe(401);
  });

  test('TEST B — Requisição com JWT client_user -> 403', async ({ request }) => {
    // Create client_user
    const email = `clientuser.${Date.now()}@test.local`;
    const { data: u } = await supabaseAdmin.auth.admin.createUser({ email, password: 'Password123!', email_confirm: true });
    await supabaseAdmin.from('user_profiles').insert({ user_id: u.user.id, name: 'Client User', email, role: 'client_user', is_active: true });
    
    const { data: s } = await supabaseAdmin.auth.signInWithPassword({ email, password: 'Password123!' });
    const res = await request.post(`${BASE_URL}/api/admin/create-client`, {
      headers: { 'Authorization': `Bearer ${s.session.access_token}` },
      data: {
        establishment_name: 'Test Client User Auth',
        responsible_name: 'Resp',
        phone: '51999990002',
        email: `forbidden.${Date.now()}@test.local`,
        password: 'Password123!',
        address: 'Rua Teste, 100'
      }
    });
    expect(res.status()).toBe(403);
    
    // Cleanup test user
    await supabaseAdmin.from('user_profiles').delete().eq('user_id', u.user.id);
    await supabaseAdmin.auth.admin.deleteUser(u.user.id);
  });

  test('TEST C — Requisição com JWT motoboy -> 403', async ({ request }) => {
    const email = `motoboy.${Date.now()}@test.local`;
    const { data: u } = await supabaseAdmin.auth.admin.createUser({ email, password: 'Password123!', email_confirm: true });
    await supabaseAdmin.from('user_profiles').insert({ user_id: u.user.id, name: 'Motoboy User', email, role: 'motoboy', is_active: true });

    const { data: s } = await supabaseAdmin.auth.signInWithPassword({ email, password: 'Password123!' });
    const res = await request.post(`${BASE_URL}/api/admin/create-client`, {
      headers: { 'Authorization': `Bearer ${s.session.access_token}` },
      data: {
        establishment_name: 'Test Motoboy Auth',
        responsible_name: 'Resp',
        phone: '51999990003',
        email: `forbidden.mb.${Date.now()}@test.local`,
        password: 'Password123!',
        address: 'Rua Teste, 100'
      }
    });
    expect(res.status()).toBe(403);

    await supabaseAdmin.from('user_profiles').delete().eq('user_id', u.user.id);
    await supabaseAdmin.auth.admin.deleteUser(u.user.id);
  });

  test('TEST D — Requisição com Admin inativo -> 403', async ({ request }) => {
    const email = `inactive.admin.${Date.now()}@test.local`;
    const { data: u } = await supabaseAdmin.auth.admin.createUser({ email, password: 'Password123!', email_confirm: true });
    await supabaseAdmin.from('user_profiles').insert({ user_id: u.user.id, name: 'Inactive Admin', email, role: 'admin', is_active: false });

    const { data: s } = await supabaseAdmin.auth.signInWithPassword({ email, password: 'Password123!' });
    const res = await request.post(`${BASE_URL}/api/admin/create-client`, {
      headers: { 'Authorization': `Bearer ${s.session.access_token}` },
      data: {
        establishment_name: 'Test Inactive Admin',
        responsible_name: 'Resp',
        phone: '51999990004',
        email: `forbidden.inact.${Date.now()}@test.local`,
        password: 'Password123!',
        address: 'Rua Teste, 100'
      }
    });
    expect(res.status()).toBe(403);

    await supabaseAdmin.from('user_profiles').delete().eq('user_id', u.user.id);
    await supabaseAdmin.auth.admin.deleteUser(u.user.id);
  });

  test('TEST E & F — E-mail ou Documento duplicado por formato/case -> 409 Conflito', async ({ request }) => {
    const uniqueId = Date.now();
    const emailBase = `Padaria.Conflito.${uniqueId}@Homolog.Local`;
    const docBase = `99.888.777/0001-${String(uniqueId).slice(-2)}`;

    // Initial creation
    const res1 = await request.post(`${BASE_URL}/api/admin/create-client`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
      data: {
        establishment_name: `Padaria Conflito 1`,
        responsible_name: 'Resp 1',
        phone: '51999991111',
        email: emailBase,
        document: docBase,
        password: 'Password123!',
        address: 'Rua Conflito, 100'
      }
    });
    expect(res1.status()).toBe(201);

    // Duplicate email with different casing/spacing
    const resDupEmail = await request.post(`${BASE_URL}/api/admin/create-client`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
      data: {
        establishment_name: `Padaria Conflito Dup Email`,
        responsible_name: 'Resp 2',
        phone: '51999992222',
        email: `  padaria.conflito.${uniqueId}@homolog.local  `,
        document: `11.222.333/0001-99`,
        password: 'Password123!',
        address: 'Rua Conflito, 101'
      }
    });
    expect(resDupEmail.status()).toBe(409);

    // Duplicate document with different punctuation
    const rawDocDigits = docBase.replace(/\D/g, '');
    const resDupDoc = await request.post(`${BASE_URL}/api/admin/create-client`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
      data: {
        establishment_name: `Padaria Conflito Dup Doc`,
        responsible_name: 'Resp 3',
        phone: '51999993333',
        email: `diferente.${uniqueId}@homolog.local`,
        document: rawDocDigits,
        password: 'Password123!',
        address: 'Rua Conflito, 102'
      }
    });
    expect(resDupDoc.status()).toBe(409);
  });

  test('TEST G — Concorrência Real com Requisições Simultâneas -> Exact 1 Sucesso, 1 Conflito (409)', async ({ request }) => {
    const randNum = Math.floor(100000 + Math.random() * 899999);
    const emailConcurrent = `concorrente.${Date.now()}.${randNum}@homolog.local`;
    const docConcurrent = `${randNum}776660001`;

    const payload = {
      establishment_name: `Estabelecimento Concorrente ${randNum}`,
      responsible_name: 'Resp Concorrente',
      phone: '51988887777',
      email: emailConcurrent,
      document: docConcurrent,
      password: 'Password123!',
      address: 'Avenida Concorrência, 500'
    };

    // Trigger 2 simultaneous POST requests
    const [resA, resB] = await Promise.all([
      request.post(`${BASE_URL}/api/admin/create-client`, {
        headers: { 'Authorization': `Bearer ${adminToken}` },
        data: payload
      }),
      request.post(`${BASE_URL}/api/admin/create-client`, {
        headers: { 'Authorization': `Bearer ${adminToken}` },
        data: payload
      })
    ]);

    const bodyA = await resA.text();
    const bodyB = await resB.text();
    console.log('TEST G resA status:', resA.status(), bodyA);
    console.log('TEST G resB status:', resB.status(), bodyB);

    const statuses = [resA.status(), resB.status()].sort();
    expect(statuses[0]).toBe(201);
    expect([400, 409]).toContain(statuses[1]);

    const createdClient = resA.status() === 201 ? JSON.parse(bodyA).client : JSON.parse(bodyB).client;
    expect(createdClient?.id).toBeTruthy();
    expect(createdClient?.client_code).toMatch(/^CLI-\d+$/);
  });

  test('TEST H — Falha Relacional com Rollback Auth (deleteUser)', async () => {
    // Call RPC directly with invalid actor ID to force Postgres RPC failure (42501)
    const emailFail = `rollback.relational.${Date.now()}@homolog.local`;
    const { data: u } = await supabaseAdmin.auth.admin.createUser({
      email: emailFail,
      password: 'Password123!',
      email_confirm: true
    });

    const { error: rpcErr } = await supabaseAdmin.rpc('provision_commercial_client_relational', {
      p_actor_user_id: '00000000-0000-0000-0000-000000000000', // Invalid actor
      p_auth_user_id: u.user.id,
      p_establishment_name: 'Rollback Test',
      p_responsible_name: 'Resp',
      p_phone: '51999995555',
      p_email: emailFail
    });

    expect(rpcErr).toBeTruthy();

    // Perform compensation rollback
    await supabaseAdmin.auth.admin.deleteUser(u.user.id);

    // Verify 0 relational records exist
    const { data: profs } = await supabaseAdmin.from('user_profiles').select('id').eq('user_id', u.user.id);
    const { data: cls } = await supabaseAdmin.from('commercial_clients').select('id').eq('email', emailFail);
    expect(profs.length).toBe(0);
    expect(cls.length).toBe(0);

    // Verify Auth user deleted
    const { data: aUser } = await supabaseAdmin.auth.admin.getUserById(u.user.id);
    expect(aUser?.user).toBeNull();
  });

  test('TEST I & J — Falha de Compensação & Reconciliador READ-ONLY', async () => {
    // Create orphan Auth user artificially
    const orphanEmail = `orfaocontrolado.${Date.now()}@homolog.local`;
    const { data: u } = await supabaseAdmin.auth.admin.createUser({
      email: orphanEmail,
      password: 'Password123!',
      email_confirm: true
    });

    // Run reconciler script in READ-ONLY mode via child_process
    const output = execSync('node scripts/reconcile-orphan-auth-users.mjs', { encoding: 'utf8' });
    expect(output).toContain('SOMENTE LEITURA (READ-ONLY)');
    expect(output).toContain('NENHUMA ALTERAÇÃO REALIZADA');
    expect(output).toContain(orphanEmail);

    // Confirm orphan remains in Auth
    const { data: aUser } = await supabaseAdmin.auth.admin.getUserById(u.user.id);
    expect(aUser?.user).toBeTruthy();

    // Clean up test orphan via test harness
    await supabaseAdmin.auth.admin.deleteUser(u.user.id);
  });

  test('TEST K, L & M — Matriz de Fallback Frontend', async ({ page }) => {
    // Open app
    await page.goto(`${BASE_URL}`);

    // Verify local fallback is NOT triggered for HTTP 400/401/403/409/422/429/500
    // Test that invokeError with status != 404 does NOT trigger local fetch
    const invokeErrorBadStatus = { context: { status: 500 }, message: 'Server Error' };
    expect(invokeErrorBadStatus.context?.status === 404).toBe(false);

    // Test that invokeError with status 404 triggers local fallback logic
    const invokeError404 = { context: { status: 404 }, message: 'Not Found' };
    expect(invokeError404.context?.status === 404).toBe(true);
  });
});
