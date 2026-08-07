import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.bootstrap.remote' });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltam variáveis SUPABASE_URL e SUPABASE_SECRET_KEY em .env.bootstrap.remote");
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function runReadOnlyAudit() {
  console.log('==================================================');
  console.log('AUDITORIA SOMENTE LEITURA — RESÍDUOS DE HOMOLOGAÇÃO/TESTE');
  console.log(`URL Supabase: ${SUPABASE_URL}`);
  console.log('==================================================\n');

  // 1. Audit Auth Users
  const { data: usersData, error: usersErr } = await adminClient.auth.admin.listUsers();
  if (usersErr) console.error("Erro ao listar auth.users:", usersErr);
  const allUsers = usersData?.users || [];
  console.log(`Total de auth.users no banco: ${allUsers.length}`);
  
  const testUsers = allUsers.filter(u => 
    (u.email && u.email.includes('@auth.dahora.local')) ||
    (u.email && u.email.toLowerCase().includes('test')) ||
    (u.email && u.email.toLowerCase().includes('rider')) ||
    (u.email && u.email.toLowerCase().includes('owner')) ||
    (u.user_metadata && u.user_metadata.test_only)
  );

  console.log(`\n--- AUTH.USERS DE TESTE ENCONTRADOS (${testUsers.length}) ---`);
  testUsers.forEach(u => {
    console.log(`- ID: ${u.id.slice(0, 8)}... | Email: ${u.email} | Criado em: ${u.created_at}`);
  });

  // 2. Audit User Profiles
  const { data: profiles, error: profErr } = await adminClient.from('user_profiles').select('*');
  if (profErr) console.error("Erro ao consultar user_profiles:", profErr);
  const testProfiles = (profiles || []).filter(p => 
    (p.email && p.email.includes('@auth.dahora.local')) ||
    (p.name && (p.name.includes('Test') || p.name.includes('Hardened') || p.name.includes('Rider')))
  );

  console.log(`\n--- USER_PROFILES DE TESTE ENCONTRADOS (${testProfiles.length}) ---`);
  testProfiles.forEach(p => {
    console.log(`- ID: ${p.id} | UserID: ${p.user_id?.slice(0,8)}... | Nome: ${p.name} | Role: ${p.role}`);
  });

  // 3. Audit Fleet (Motoboys)
  const { data: fleet, error: fleetErr } = await adminClient.from('fleet').select('*');
  if (fleetErr) console.error("Erro ao consultar fleet:", fleetErr);

  console.log(`\n--- MOTOBOYS (FLEET) ENCONTRADOS NO BANCO TOTAL (${fleet?.length || 0}) ---`);
  
  for (const f of (fleet || [])) {
    const isTestMotoboy = 
      (f.name && (f.name.includes('Test') || f.name.includes('Hardened') || f.name.includes('Motoboy A') || f.name.includes('Motoboy B') || f.name.includes('MB-') || f.name.toLowerCase().includes('teste'))) ||
      (f.motoboy_code && f.motoboy_code.startsWith('MB-')) ||
      (f.user_id && testUsers.some(u => u.id === f.user_id));

    // Audit related dependencies for this motoboy
    const { count: telesCount } = await adminClient.from('teles').select('id', { count: 'exact', head: true }).eq('motoboy_id', f.id);
    const { count: txCount } = await adminClient.from('rider_financial_transactions').select('id', { count: 'exact', head: true }).eq('rider_id', f.id);
    const { count: consCount } = await adminClient.from('rider_consumables').select('id', { count: 'exact', head: true }).eq('rider_id', f.id);
    const { count: credCount } = await adminClient.from('rider_credits').select('id', { count: 'exact', head: true }).eq('rider_id', f.id);
    const { count: pushCount } = await adminClient.from('rider_push_subscriptions').select('id', { count: 'exact', head: true }).eq('rider_id', f.id);

    console.log(`[${isTestMotoboy ? 'DADO DE TESTE' : 'REAL/CONSERVAR'}] Fleet ID: ${f.id.slice(0, 8)}... | Code: ${f.motoboy_code} | Name: ${f.name} | Status: ${f.status} | UserID: ${f.user_id ? f.user_id.slice(0, 8) + '...' : 'NULL'}`);
    console.log(`   └─ Teles: ${telesCount || 0} | Financial Tx: ${txCount || 0} | Consumables: ${consCount || 0} | Credits: ${credCount || 0} | Push Subscriptions: ${pushCount || 0}`);
  }

  // 4. Audit Teles
  const { data: teles, error: telesErr } = await adminClient.from('teles').select('*');
  if (telesErr) console.error("Erro ao consultar teles:", telesErr);

  console.log(`\n--- TELES ENCONTRADAS NO BANCO TOTAL (${teles?.length || 0}) ---`);
  (teles || []).forEach(t => {
    const isTestTele = 
      (t.tele_code && t.tele_code.startsWith('TEL-')) ||
      (t.delivery_address && t.delivery_address.includes('Rua da Praia')) ||
      (t.delivery_address && t.delivery_address.includes('Farrapos')) ||
      (t.pickup_address && t.pickup_address.includes('Ipiranga')) ||
      (t.pickup_address && t.pickup_address.includes('Bento'));

    console.log(`[${isTestTele ? 'DADO DE TESTE' : 'REAL/CONSERVAR'}] Tele ID: ${t.id.slice(0, 8)}... | Code: ${t.tele_code} | Status: ${t.status} | MotoboyID: ${t.motoboy_id ? t.motoboy_id.slice(0, 8) + '...' : 'NULL'} | Pickup: ${t.pickup_address} | Delivery: ${t.delivery_address} | CompletedAt: ${t.completed_at || 'NULL'}`);
  });

  // 5. Audit Financial Transactions Total
  const { count: totalTx } = await adminClient.from('rider_financial_transactions').select('id', { count: 'exact', head: true });
  console.log(`\n--- TOTAL DE TRANSAÇÕES FINANCEIRAS DE ENTREGADORES NO BANCO: ${totalTx || 0} ---`);

  // 6. Audit Push Subscriptions Total
  const { count: totalSubs } = await adminClient.from('rider_push_subscriptions').select('id', { count: 'exact', head: true });
  console.log(`--- TOTAL DE PUSH SUBSCRIPTIONS NO BANCO: ${totalSubs || 0} ---`);
}

runReadOnlyAudit().catch(err => {
  console.error("Erro na auditoria:", err);
});
