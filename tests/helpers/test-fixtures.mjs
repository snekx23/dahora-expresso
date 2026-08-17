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
      await adminClient.auth.admin.updateUserById(users[0].user_id, { password, email_confirm: true });
    } else {
      const { data: newUser } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true });
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

  return createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${data.session.access_token}`
      }
    }
  });
}
