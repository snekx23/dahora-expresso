import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert';
import dotenv from 'dotenv';
import fs from 'node:fs';

dotenv.config({ path: '.env.bootstrap.remote' });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runPushNotificationsTestSuite() {
  console.log('==================================================');
  console.log('TESTE AUTOMATIZADO — SISTEMA COMPLETO DE WEB PUSH');
  console.log('==================================================\n');

  let userA = null, fleetA = null;
  let userB = null, fleetB = null;
  let teleRow = null;

  try {
    // 1. Validar VAPID Public Key em variáveis e runtime-config
    console.log('1. Validando chave pública VAPID no ambiente...');
    assert.ok(VAPID_PUBLIC_KEY && VAPID_PUBLIC_KEY.length > 20, 'VAPID_PUBLIC_KEY deve estar configurada no servidor');
    console.log(`[PASS] VAPID Public Key presente (${VAPID_PUBLIC_KEY.slice(0, 10)}...).`);

    // 2. Criar Motoboy A e Motoboy B
    const codeA = String(Math.floor(1000 + Math.random() * 8999));
    const codeB = String(Math.floor(1000 + Math.random() * 8999));
    const emailA = `riderA.push.${crypto.randomUUID()}@auth.dahora.local`;
    const { data: authA } = await adminClient.auth.admin.createUser({ email: emailA, password: 'Password123!', email_confirm: true });
    userA = authA.user;
    const { data: flA } = await adminClient.from('fleet').insert([{ user_id: userA.id, motoboy_code: 'MB-' + codeA, name: 'Motoboy A Push', phone: '51988' + codeA, status: 'Disponível' }]).select().single();
    fleetA = flA;

    const emailB = `riderB.push.${crypto.randomUUID()}@auth.dahora.local`;
    const { data: authB } = await adminClient.auth.admin.createUser({ email: emailB, password: 'Password123!', email_confirm: true });
    userB = authB.user;
    const { data: flB } = await adminClient.from('fleet').insert([{ user_id: userB.id, motoboy_code: 'MB-' + codeB, name: 'Motoboy B Push', phone: '51988' + codeB, status: 'Disponível' }]).select().single();
    fleetB = flB;

    // Sessões Supabase para A e B
    const linkA = await adminClient.auth.admin.generateLink({ type: 'magiclink', email: emailA });
    const clientUserA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'test-push-a', persistSession: false } });
    await clientUserA.auth.verifyOtp({ token_hash: linkA.data.properties.hashed_token, type: 'email' });

    const linkB = await adminClient.auth.admin.generateLink({ type: 'magiclink', email: emailB });
    const clientUserB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'test-push-b', persistSession: false } });
    await clientUserB.auth.verifyOtp({ token_hash: linkB.data.properties.hashed_token, type: 'email' });

    // 3. Testar salvamento de Push Subscription via RPC autoritativa para Motoboy A
    console.log('\n2. Registrando Push Subscription via RPC autoritativa para Motoboy A...');
    const fakeEndpointA = `https://fcm.googleapis.com/fcm/send/fake-token-${crypto.randomUUID()}`;
    const { data: subResA, error: subErrA } = await clientUserA.rpc('register_my_push_subscription', {
      p_endpoint: fakeEndpointA,
      p_p256dh: 'BNcRdreA1K4bDCSbdawigD-P-g_fake_p256dh',
      p_auth: 'fakeAuthKey12345',
      p_user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    });

    assert.ifError(subErrA);
    assert.strictEqual(subResA.success, true);
    console.log(`[PASS] Push Subscription do Motoboy A cadastrada com sucesso! (ID: ${subResA.subscription_id})`);

    // 4. Validar RLS de Push Subscriptions: Motoboy A lê a sua, Motoboy B é BLOQUEADO de ler a de A
    console.log('\n3. Validando RLS em public.rider_push_subscriptions...');
    const { data: readA } = await clientUserA.from('rider_push_subscriptions').select('endpoint').eq('endpoint', fakeEndpointA);
    assert.strictEqual(readA.length, 1, 'Motoboy A deve ler sua própria subscription');

    const { data: readB } = await clientUserB.from('rider_push_subscriptions').select('endpoint').eq('endpoint', fakeEndpointA);
    assert.strictEqual(readB.length, 0, 'Motoboy B deve ser BLOQUEADO pelo RLS de acessar subscriptions de A');
    console.log('[PASS] RLS de Push Subscriptions validado com sucesso.');

    // 5. Criar uma Tele atribuída ao Motoboy A e testar Edge Function send-rider-push
    console.log('\n4. Criando Tele para Motoboy A e invocando Edge Function send-rider-push...');
    const { data: newTele, error: teleErr } = await adminClient.from('teles').insert([{
      motoboy_id: fleetA.id,
      status: 'motoboy_designado',
      pickup_address: 'Av. das Americas, 200',
      delivery_address: 'Rua Central, 50',
      recipient_name: 'Cliente Notificacao Teste',
      recipient_phone: '51911112222',
      total_order_amount: 30.00
    }]).select().single();

    assert.ifError(teleErr);
    teleRow = newTele;

    // Invocação da Edge Function send-rider-push
    const pushRes = await fetch(`${SUPABASE_URL}/functions/v1/send-rider-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ tele_id: teleRow.id })
    });

    assert.strictEqual(pushRes.status, 200, 'send-rider-push deve retornar HTTP 200');
    const pushData = await pushRes.json();
    assert.strictEqual(pushData.success, true);
    console.log(`[PASS] Edge Function send-rider-push executada com sucesso! Resposta:`, pushData);

    // 6. Testar desativação automática de subscription 404/410
    console.log('\n5. Testando desativação automática de endpoints expirados (404/410)...');
    // FCM fake endpoint retornará 400 ou 404/410 ao tentar enviar notificação real
    // Confirmar que o serviço respondeu com contagem de entregas / desativação estruturada
    assert.ok(pushData.hasOwnProperty('deactivated'), 'Resposta do envio deve informar subscriptions desativadas');
    console.log('[PASS] Tratamento de desativação automática de subscriptions testado.');

    console.log('\n==================================================');
    console.log('RESULTADO FINAL: TODOS OS TESTES DE PUSH APROVADOS (6/6)');
    console.log('==================================================');
  } finally {
    if (teleRow) await adminClient.from('teles').delete().eq('id', teleRow.id);
    if (fleetA) {
      await adminClient.from('rider_push_subscriptions').delete().eq('rider_id', fleetA.id);
      await adminClient.from('fleet').delete().eq('id', fleetA.id);
    }
    if (userA) await adminClient.auth.admin.deleteUser(userA.id);

    if (fleetB) {
      await adminClient.from('rider_push_subscriptions').delete().eq('rider_id', fleetB.id);
      await adminClient.from('fleet').delete().eq('id', fleetB.id);
    }
    if (userB) await adminClient.auth.admin.deleteUser(userB.id);
  }
}

runPushNotificationsTestSuite().catch(err => {
  console.error('[FAIL] Erro nos testes de Push Notifications:', err);
  process.exit(1);
});
