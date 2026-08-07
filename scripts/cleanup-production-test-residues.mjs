import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.bootstrap.remote' });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltam variáveis SUPABASE_URL e SUPABASE_SECRET_KEY em .env.bootstrap.remote");
  process.exit(1);
}

const EXPECTED_PROJECT_REF = 'tskivauszmhhtqtegvwb';
if (!SUPABASE_URL.includes(EXPECTED_PROJECT_REF)) {
  console.error(`Project ref mismatch. Esperado: ${EXPECTED_PROJECT_REF}`);
  process.exit(1);
}

const isExecute = process.argv.includes('--execute');

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function cleanProductionTestResidues() {
  console.log('==================================================');
  console.log('CLEANUP CONTROLADO DE RESÍDUOS DE HOMOLOGAÇÃO/TESTE');
  console.log(`Modo: ${isExecute ? '⚡ EXECUÇÃO REAL DE REMOÇÃO' : '🔍 DRY-RUN (SOMENTE SIMULAÇÃO)'}`);
  console.log(`Project Ref: ${EXPECTED_PROJECT_REF}`);
  console.log('==================================================\n');

  // 1. Identificar auth.users de teste
  const { data: usersData } = await adminClient.auth.admin.listUsers();
  const allUsers = usersData?.users || [];
  const testUsers = allUsers.filter(u => 
    (u.email && u.email.includes('@auth.dahora.local')) ||
    (u.email && u.email.toLowerCase().includes('test')) ||
    (u.user_metadata && u.user_metadata.test_only)
  );

  // 2. Identificar user_profiles de teste
  const { data: profiles } = await adminClient.from('user_profiles').select('*');
  const testProfiles = (profiles || []).filter(p => 
    (p.email && p.email.includes('@auth.dahora.local')) ||
    (p.name && (p.name.includes('Test') || p.name.includes('Hardened') || p.name.includes('gui teste')))
  );

  // 3. Identificar motoboys (fleet) de teste
  const { data: fleet } = await adminClient.from('fleet').select('*');
  const testFleet = (fleet || []).filter(f => 
    (f.name && (f.name.includes('Test') || f.name.includes('Hardened') || f.name.includes('Motoboy A') || f.name.includes('Motoboy B') || f.name.toLowerCase().includes('gui teste'))) ||
    (f.motoboy_code && f.motoboy_code.startsWith('MB-')) ||
    (f.user_id && testUsers.some(u => u.id === f.user_id))
  );

  const testFleetIds = testFleet.map(f => f.id);

  // 4. Identificar teles de teste
  const { data: teles } = await adminClient.from('teles').select('*');
  const testTeles = (teles || []).filter(t => 
    (t.tele_code && t.tele_code.startsWith('TEL-')) ||
    (t.motoboy_id && testFleetIds.includes(t.motoboy_id)) ||
    (t.delivery_address && t.delivery_address.includes('Rua das Flores'))
  );

  const testTeleIds = testTeles.map(t => t.id);

  // 5. Identificar transações financeiras de teste
  const { data: txs } = await adminClient.from('rider_financial_transactions').select('*');
  const testTxs = (txs || []).filter(tx => 
    (tx.rider_id && testFleetIds.includes(tx.rider_id)) ||
    (tx.tele_id && testTeleIds.includes(tx.tele_id))
  );

  const { data: compTxs } = await adminClient.from('company_financial_transactions').select('*');
  const testCompTxs = (compTxs || []).filter(ctx => 
    (ctx.tele_id && testTeleIds.includes(ctx.tele_id))
  );

  // 6. Identificar subscrições de push de teste
  const { data: pushSubs } = await adminClient.from('rider_push_subscriptions').select('*');
  const testPushSubs = (pushSubs || []).filter(sub => 
    (sub.rider_id && testFleetIds.includes(sub.rider_id))
  );

  console.log('--- RESUMO DOS DADOS IDENTIFICADOS PARA REMOÇÃO ---');
  console.log(`• Subscrições Push de Teste: ${testPushSubs.length}`);
  console.log(`• Transações Financeiras de Entregadores de Teste: ${testTxs.length}`);
  console.log(`• Transações Financeiras da Empresa de Teste: ${testCompTxs.length}`);
  console.log(`• Teles de Teste: ${testTeles.length}`);
  console.log(`• Fleet (Motoboys) de Teste: ${testFleet.length}`);
  console.log(`• User Profiles de Teste: ${testProfiles.length}`);
  console.log(`• Auth Users de Teste: ${testUsers.length}\n`);

  if (!isExecute) {
    console.log('ℹ️ DRY-RUN Concluído. NENHUM DADO FOI REMOVIDO.');
    console.log('Para executar a limpeza real, rode: node scripts/cleanup-production-test-residues.mjs --execute');
    return;
  }

  console.log('⚡ Executando remoção em ordem reversa de chaves estrangeiras...\n');

  // Passo 1: Remover subscrições de push
  if (testPushSubs.length > 0) {
    const subIds = testPushSubs.map(s => s.id);
    const { error } = await adminClient.from('rider_push_subscriptions').delete().in('id', subIds);
    if (error) console.error("Erro ao remover push_subscriptions:", error.message);
    else console.log(`[OK] Removidas ${testPushSubs.length} subscrições de push.`);
  }

  // Passo 2A: Remover transações financeiras de entregadores de teste
  if (testTxs.length > 0) {
    const txIds = testTxs.map(t => t.id);
    const { error } = await adminClient.from('rider_financial_transactions').delete().in('id', txIds);
    if (error) console.error("Erro ao remover rider_financial_transactions:", error.message);
    else console.log(`[OK] Removidas ${testTxs.length} transações financeiras de entregadores.`);
  }

  // Passo 2B: Remover transações financeiras de empresa associadas às teles de teste
  if (testCompTxs.length > 0) {
    const compTxIds = testCompTxs.map(ct => ct.id);
    const { error } = await adminClient.from('company_financial_transactions').delete().in('id', compTxIds);
    if (error) console.error("Erro ao remover company_financial_transactions:", error.message);
    else console.log(`[OK] Removidas ${testCompTxs.length} transações financeiras de empresa.`);
  }

  // Passo 3: Remover Teles de teste
  if (testTeleIds.length > 0) {
    const { error } = await adminClient.from('teles').delete().in('id', testTeleIds);
    if (error) console.error("Erro ao remover teles:", error.message);
    else console.log(`[OK] Removidas ${testTeleIds.length} teles.`);
  }

  // Passo 4: Remover Fleet (Motoboys) de teste
  if (testFleetIds.length > 0) {
    const { error } = await adminClient.from('fleet').delete().in('id', testFleetIds);
    if (error) console.error("Erro ao remover fleet:", error.message);
    else console.log(`[OK] Removidos ${testFleetIds.length} motoboys de teste.`);
  }

  // Passo 5: Remover user_profiles de teste
  if (testProfiles.length > 0) {
    const profIds = testProfiles.map(p => p.id);
    const { error } = await adminClient.from('user_profiles').delete().in('id', profIds);
    if (error) console.error("Erro ao remover user_profiles:", error.message);
    else console.log(`[OK] Removidos ${testProfiles.length} perfis de teste.`);
  }

  // Passo 6: Remover auth.users de teste
  for (const u of testUsers) {
    const { error } = await adminClient.auth.admin.deleteUser(u.id);
    if (error) console.error(`Erro ao remover auth.user ${u.id}:`, error.message);
    else console.log(`[OK] Removido auth.user ${u.email}`);
  }

  // AUDITORIA FINAL DE VALIDAÇÃO ZERO RESÍDUOS
  console.log('\n==================================================');
  console.log('AUDITORIA DE CONFIRMAÇÃO — VERIFICANDO RESÍDUOS');
  console.log('==================================================');

  const { data: finalFleet } = await adminClient.from('fleet').select('id, name');
  const remTestFleet = (finalFleet || []).filter(f => f.name && (f.name.includes('Test') || f.name.includes('Hardened')));
  
  const { data: finalTeles } = await adminClient.from('teles').select('id, tele_code');
  const remTestTeles = (finalTeles || []).filter(t => t.tele_code && t.tele_code.startsWith('TEL-'));

  const { data: finalTxs } = await adminClient.from('rider_financial_transactions').select('id');
  
  const { data: finalUsers } = await adminClient.auth.admin.listUsers();
  const remTestUsers = (finalUsers?.users || []).filter(u => u.email && u.email.includes('@auth.dahora.local'));

  console.log(`Motoboys de teste restantes: ${remTestFleet.length}`);
  console.log(`Teles de teste restantes: ${remTestTeles.length}`);
  console.log(`Transações financeiras de teste restantes: ${finalTxs?.length || 0}`);
  console.log(`Auth Users de teste restantes: ${remTestUsers.length}`);

  if (remTestFleet.length === 0 && remTestTeles.length === 0 && (finalTxs?.length || 0) === 0 && remTestUsers.length === 0) {
    console.log('\n✨ AUDITORIA CONCLUÍDA COM SUCESSO: ZERO RESÍDUOS DE TESTE EM PRODUÇÃO!');
  } else {
    console.error('\n⚠️ ATENÇÃO: Ainda restam resíduos no banco!');
    process.exit(1);
  }
}

cleanProductionTestResidues().catch(err => {
  console.error("Erro na limpeza de resíduos:", err);
  process.exit(1);
});
