import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.bootstrap.remote' });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;

const IS_PRODUCTION_REF = (SUPABASE_URL || '').includes('tskivauszmhhtqtegvwb');
if (IS_PRODUCTION_REF && process.env.ALLOW_PRODUCTION_E2E !== 'true') {
  console.log('[GUARDRAIL] Execução de testes de escrita remota em produção ignorada. (ALLOW_PRODUCTION_E2E!=true)');
  process.exit(0);
}

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runMyTelesFlowTest() {
  console.log('==================================================');
  console.log('TESTE AUTOMATIZADO — FLUXO COMPLETO MINHAS TELES E RLS');
  console.log('==================================================\n');

  let userA = null, fleetA = null, clientA = null;
  let userB = null, fleetB = null, clientB = null;
  let teleRow = null;

  try {
    // 1. Criar Motoboy A e Motoboy B
    const codeA = String(Math.floor(1000 + Math.random() * 8999));
    const codeB = String(Math.floor(1000 + Math.random() * 8999));
    const emailA = `riderA.${crypto.randomUUID()}@auth.dahora.local`;
    const { data: authA } = await adminClient.auth.admin.createUser({ email: emailA, password: 'Password123!', email_confirm: true });
    userA = authA.user;
    const { data: flA } = await adminClient.from('fleet').insert([{ user_id: userA.id, motoboy_code: 'MB-' + codeA, name: 'Motoboy A Teste', phone: '51987' + codeA, status: 'Disponível' }]).select().single();
    fleetA = flA;

    const emailB = `riderB.${crypto.randomUUID()}@auth.dahora.local`;
    const { data: authB } = await adminClient.auth.admin.createUser({ email: emailB, password: 'Password123!', email_confirm: true });
    userB = authB.user;
    const { data: flB } = await adminClient.from('fleet').insert([{ user_id: userB.id, motoboy_code: 'MB-' + codeB, name: 'Motoboy B Teste', phone: '51987' + codeB, status: 'Disponível' }]).select().single();
    fleetB = flB;

    // Obter sessões do Supabase Client para Motoboy A e B
    const linkA = await adminClient.auth.admin.generateLink({ type: 'magiclink', email: emailA });
    const clientUserA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'test-flow-a', persistSession: false } });
    await clientUserA.auth.verifyOtp({ token_hash: linkA.data.properties.hashed_token, type: 'email' });

    const linkB = await adminClient.auth.admin.generateLink({ type: 'magiclink', email: emailB });
    const clientUserB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'test-flow-b', persistSession: false } });
    await clientUserB.auth.verifyOtp({ token_hash: linkB.data.properties.hashed_token, type: 'email' });

    // 2. Criar uma Tele atribuída ao Motoboy A
    console.log('1. Criando Tele atribuída ao Motoboy A...');
    const { data: newTele, error: errTele } = await adminClient.from('teles').insert([{
      status: 'motoboy_designado',
      motoboy_id: fleetA.id,
      pickup_address: 'Av. Brasil, 100 - Esteio',
      delivery_address: 'Rua das Flores, 500 - Sapucaia',
      total_order_amount: 35.00
    }]).select().single();

    assert.ifError(errTele);
    teleRow = newTele;
    console.log(`[PASS] Tele criada com sucesso! ID: ${teleRow.id}, tele_code: ${teleRow.tele_code}`);

    // 3. Testar RLS de leitura de Teles
    console.log('\n2. Testando RLS de leitura...');
    const { data: listA } = await clientUserA.from('teles').select('*');
    assert.strictEqual(listA.length, 1);
    assert.strictEqual(listA[0].id, teleRow.id);

    const { data: listB } = await clientUserB.from('teles').select('*');
    assert.strictEqual(listB.length, 0);
    console.log('[PASS] RLS de leitura isolado por entregador com sucesso.');

    // 4. Testar RPCs com Motoboy B tentando operar a Tele de Motoboy A (Deve FALHAR)
    console.log('\n3. Testando segurança das RPCs (Motoboy B tentando operar Tele de A)...');
    const { data: resIllegal, error: errIllegal } = await clientUserB.rpc('mark_my_tele_collected', { p_tele_id: teleRow.id, p_expected_version: teleRow.version });
    console.log('resIllegal data:', resIllegal, 'error:', errIllegal);
    assert.strictEqual(resIllegal.success, false);
    assert.strictEqual(resIllegal.error_code, 'FORBIDDEN_NOT_YOUR_TELE');
    console.log('[PASS] Motoboy B bloqueado com FORBIDDEN_NOT_YOUR_TELE em mark_my_tele_collected.');

    // 5. Motoboy A executa mark_my_tele_collected -> status 'coletada'
    console.log('\n4. Motoboy A executando mark_my_tele_collected...');
    const { data: resCollect } = await clientUserA.rpc('mark_my_tele_collected', { p_tele_id: teleRow.id, p_expected_version: teleRow.version });
    assert.strictEqual(resCollect.success, true);
    assert.strictEqual(resCollect.status, 'coletada');
    console.log(`[PASS] Transição para 'coletada' concluída com sucesso (Versão ${resCollect.version}).`);

    // 6. Motoboy A executa start_my_tele_delivery -> status 'em_entrega'
    console.log('\n5. Motoboy A executando start_my_tele_delivery...');
    const { data: resStart } = await clientUserA.rpc('start_my_tele_delivery', { p_tele_id: teleRow.id, p_expected_version: resCollect.version });
    assert.strictEqual(resStart.success, true);
    assert.strictEqual(resStart.status, 'em_entrega');
    console.log(`[PASS] Transição para 'em_entrega' concluída com sucesso (Versão ${resStart.version}).`);

    // 7. Motoboy A executa complete_my_tele -> status 'concluido'
    console.log('\n6. Motoboy A executando complete_my_tele...');
    const { data: resComplete } = await clientUserA.rpc('complete_my_tele', { p_tele_id: teleRow.id, p_expected_version: resStart.version });
    assert.strictEqual(resComplete.success, true);
    console.log(`[PASS] Transição para 'concluido' concluída com sucesso.`);

    // 8. Confirmar no banco que a Tele está concluída e não aparece mais na lista de ativas
    const { data: finalTele } = await adminClient.from('teles').select('status').eq('id', teleRow.id).single();
    assert.ok(['concluido', 'concluida', 'entregue'].includes(finalTele.status), 'Status final deve ser concluído');
    console.log('[PASS] Status final relacional auditado.');

    console.log('\n==================================================');
    console.log('RESULTADO FINAL: TODOS OS TESTES DE MINHAS TELES APROVADOS (6/6)');
    console.log('==================================================');
  } finally {
    if (teleRow) {
      await adminClient.from('rider_financial_transactions').delete().eq('tele_id', teleRow.id);
      await adminClient.from('company_financial_transactions').delete().eq('tele_id', teleRow.id);
      await adminClient.from('teles').delete().eq('id', teleRow.id);
    }
    if (fleetA) {
      await adminClient.from('rider_push_subscriptions').delete().eq('rider_id', fleetA.id);
      await adminClient.from('rider_financial_transactions').delete().eq('rider_id', fleetA.id);
      await adminClient.from('fleet').delete().eq('id', fleetA.id);
    }
    if (userA) {
      await adminClient.from('user_profiles').delete().eq('user_id', userA.id);
      await adminClient.auth.admin.deleteUser(userA.id);
    }
    if (fleetB) {
      await adminClient.from('rider_push_subscriptions').delete().eq('rider_id', fleetB.id);
      await adminClient.from('rider_financial_transactions').delete().eq('rider_id', fleetB.id);
      await adminClient.from('fleet').delete().eq('id', fleetB.id);
    }
    if (userB) {
      await adminClient.from('user_profiles').delete().eq('user_id', userB.id);
      await adminClient.auth.admin.deleteUser(userB.id);
    }
  }
}

runMyTelesFlowTest().catch(err => {
  console.error('[FAIL] Erro no teste de Minhas Teles:', err);
  process.exit(1);
});
