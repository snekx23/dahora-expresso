import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export const LOCAL_SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
export const LOCAL_SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzc4NzcsImV4cCI6MjEwMTU1Mzg3N30.1BoD7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw';

function generateServiceRoleKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY) {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  }
  const secretKey = 'super-secret-jwt-token-with-at-least-32-characters-long';
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iss: 'supabase', ref: 'tskivauszmhhtqtegvwb', role: 'service_role', iat: 1785977877, exp: 2101553877 };
  const hEnc = Buffer.from(JSON.stringify(header)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const pEnc = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = `${hEnc}.${pEnc}`;
  const sig = crypto.createHmac('sha256', secretKey).update(data).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sig}`;
}

export const LOCAL_SERVICE_ROLE_KEY = generateServiceRoleKey();

export const ADMIN_TEST_EMAIL = 'admin1@dahoraexpresso.com.br';
export const ADMIN_TEST_PASS = 'dahoraexpresso1';
export const ADMIN_USER_ID = '14620da0-6e08-488f-95ff-26f751785870';

export const CLIENT_TEST_EMAIL = 'padaria.central@homolog.test';
export const CLIENT_TEST_PASS = 'dahoraexpresso1';

export const RIDER_TEST_EMAIL = 'motoboy@dahora.local';
export const RIDER_TEST_PASS = 'dahoraexpresso1';
export const RIDER_TEST_ID = '7668596b-0444-4435-9f0c-8d0ad7ce7fb8';

export async function createAuthedTestClient(email = ADMIN_TEST_EMAIL, password = ADMIN_TEST_PASS) {
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY);
  let { data, error } = await client.auth.signInWithPassword({ email, password });
  
  if (error || !data?.session) {
    // Self-healing test fixture: reset user password via admin if sign in failed
    const adminClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: users } = await adminClient.from('user_profiles').select('user_id').eq('email', email);
    if (users && users.length > 0) {
      const { error: updateErr } = await adminClient.auth.admin.updateUserById(users[0].user_id, { password, email_confirm: true });
      if (updateErr) {
        await adminClient.auth.admin.createUser({ id: users[0].user_id, email, password, email_confirm: true });
      }
    } else {
      const targetId = email.includes('admin') ? ADMIN_USER_ID : email.includes('motoboy') ? RIDER_TEST_ID : undefined;
      const createOpts = { email, password, email_confirm: true };
      if (targetId) createOpts.id = targetId;
      const { data: newUser } = await adminClient.auth.admin.createUser(createOpts);
      if (newUser?.user) {
        const role = email.includes('admin') ? 'owner' : email.includes('motoboy') ? 'motoboy' : 'client_user';
        await adminClient.from('user_profiles').insert({ user_id: newUser.user.id, name: 'Test User', email, role, is_active: true });
      }
    }
    const retry = await client.auth.signInWithPassword({ email, password });
    data = retry.data;
    error = retry.error;
  }

  if (error || !data?.session) {
    throw new Error(`Auth failure for ${email}: ${error?.message}`);
  }

  // Ensure relational mappings exist for known test fixtures
  const adminClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const authUserId = data.session.user.id;

  if (email === CLIENT_TEST_EMAIL) {
    const padariaId = '8e40963a-9146-4bfd-9447-d8d373be7ca6';
    const { data: existingClient } = await adminClient.from('commercial_clients').select('id').eq('id', padariaId);
    if (!existingClient || existingClient.length === 0) {
      await adminClient.from('commercial_clients').insert({
        id: padariaId,
        client_code: 'CLI-000001',
        establishment_name: 'Padaria Central Homolog',
        responsible_name: 'João Da Silva',
        phone: '(51) 99999-8888',
        email: CLIENT_TEST_EMAIL,
        address: 'Av. Brasil, 1500',
        document: '11.222.333/0001-99',
        lifecycle_status: 'ativo',
        financial_status: 'em_dia'
      });
    }
    const { data: existingLink } = await adminClient.from('client_users').select('id').eq('user_id', authUserId).eq('client_id', padariaId);
    if (!existingLink || existingLink.length === 0) {
      await adminClient.from('client_users').insert({
        user_id: authUserId,
        client_id: padariaId,
        role: 'owner',
        status: 'ativo'
      });
    }
  }

  if (email === RIDER_TEST_EMAIL) {
    await adminClient.from('fleet').update({ user_id: authUserId }).eq('id', RIDER_TEST_ID);
  }

  return createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${data.session.access_token}`
      }
    }
  });
}
