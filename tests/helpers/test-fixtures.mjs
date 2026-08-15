import { createClient } from '@supabase/supabase-js';

export const LOCAL_SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
export const LOCAL_SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzc4NzcsImV4cCI6MjEwMTU1Mzg3N30.1BoD7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw';
export const LOCAL_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTk3Nzg3NywiZXhwIjoyMTAxNTUzODc3fQ.hN8D7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw';

export const ADMIN_TEST_EMAIL = 'admin1@dahoraexpresso.com.br';
export const ADMIN_TEST_PASS = 'dahoraexpresso1';

export const CLIENT_TEST_EMAIL = 'padaria.central@homolog.test';
export const CLIENT_TEST_PASS = 'dahoraexpresso1';

export const RIDER_TEST_EMAIL = 'motoboy@dahora.local';
export const RIDER_TEST_PASS = 'dahoraexpresso1';
export const RIDER_TEST_ID = '7668596b-0444-4435-9f0c-8d0ad7ce7fb8';

export async function createAuthedTestClient(email = ADMIN_TEST_EMAIL, password = ADMIN_TEST_PASS) {
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`Auth failure for ${email}: ${error.message}`);
  }
  return createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${data.session.access_token}`
      }
    }
  });
}
