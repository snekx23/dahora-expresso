import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.bootstrap.remote' });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function urlBase64ToUint8Array(base64String) {
  if (!base64String || typeof base64String !== 'string') {
    return new Uint8Array(0);
  }
  const cleanStr = String(base64String).trim().replace(/^["']|["']$/g, '');
  if (!cleanStr) return new Uint8Array(0);
  const padding = '='.repeat((4 - (cleanStr.length % 4)) % 4);
  const base64 = (cleanStr + padding).replace(/-/g, '+').replace(/_/g, '/');
  try {
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
  } catch (e) {
    return new Uint8Array(0);
  }
}

async function runPushHardeningTestSuite() {
  console.log('==================================================');
  console.log('TESTE AUTOMATIZADO — HARDENING DO DISPARO DE PUSH E VALIDAÇÃO VAPID');
  console.log('==================================================\n');

  // 1. Testes Estritamente Estruturais de Validação de Chave VAPID P-256
  console.log('1. Testando Validação Estrutural VAPID (A, B, C, D)...');
  // A. VAPID válida
  const validKey = 'BEo-ivrbMWP4mK2syicv0ic_Wr2arC2LZBmtbtn2zHPzTbykpyJ22ETL2DX9t6bHFL5CGkMnTtAaq-2bcQ_sxYw';
  const arrValid = urlBase64ToUint8Array(validKey);
  assert.ok(arrValid instanceof Uint8Array, 'Deve converter para Uint8Array');
  assert.strictEqual(arrValid.byteLength, 65, 'VAPID pública P-256 descompactada deve possuir exatamente 65 bytes');
  assert.strictEqual(arrValid[0], 0x04, 'Primeiro byte deve ser 0x04 (uncompressed point format)');
  console.log('[PASS] A. VAPID pública válida decodifica para 65 bytes com primeiro byte 0x04.');

  // B. VAPID vazia
  const arrEmpty = urlBase64ToUint8Array('');
  assert.strictEqual(arrEmpty.byteLength, 0, 'VAPID vazia deve retornar Uint8Array de tamanho 0');
  console.log('[PASS] B. VAPID vazia não aciona subscrição.');

  // C. VAPID malformada (48 bytes)
  const malformedKey = 'BEl6MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6';
  const arrMalformed = urlBase64ToUint8Array(malformedKey);
  assert.notStrictEqual(arrMalformed.byteLength, 65, 'Chave malformada não deve ter 65 bytes');
  console.log(`[PASS] C. VAPID malformada rejeitada na validação estrutural (${arrMalformed.byteLength} bytes).`);

  // D. Chave com aspas externas
  const quotedKey = `"BEo-ivrbMWP4mK2syicv0ic_Wr2arC2LZBmtbtn2zHPzTbykpyJ22ETL2DX9t6bHFL5CGkMnTtAaq-2bcQ_sxYw"`;
  const arrQuoted = urlBase64ToUint8Array(quotedKey);
  assert.strictEqual(arrQuoted.byteLength, 65, 'Aspas externas devem ser sanitizadas');
  assert.strictEqual(arrQuoted[0], 0x04);
  console.log('[PASS] D. Chave com aspas sanitizada e decodificada com sucesso.');

  let userA = null, fleetA = null;
  let userB = null, fleetB = null;
  let ownerUser = null;
  let teleRow1 = null;
  let teleRow2 = null;

  try {
    // Criar Usuário Owner de Teste para autenticação autorizada
    const ownerEmail = `owner.push.${crypto.randomUUID()}@auth.dahora.local`;
    const { data: authOwner } = await adminClient.auth.admin.createUser({ email: ownerEmail, password: 'Password123!', email_confirm: true });
    ownerUser = authOwner.user;
    await adminClient.from('user_profiles').insert([{ user_id: ownerUser.id, name: 'Owner Push Test', email: ownerEmail, role: 'owner' }]);

    const linkOwner = await adminClient.auth.admin.generateLink({ type: 'magiclink', email: ownerEmail });
    const ownerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'test-push-owner', persistSession: false } });
    const { data: ownerSession } = await ownerClient.auth.verifyOtp({ token_hash: linkOwner.data.properties.hashed_token, type: 'email' });
    const ownerJwt = ownerSession.session.access_token;

    // Criar Motoboy A e Motoboy B
    const codeA = String(Math.floor(1000 + Math.random() * 8999));
    const codeB = String(Math.floor(1000 + Math.random() * 8999));
    const emailA = `riderA.hard.${crypto.randomUUID()}@auth.dahora.local`;
    const { data: authA } = await adminClient.auth.admin.createUser({ email: emailA, password: 'Password123!', email_confirm: true });
    userA = authA.user;
    const { data: flA } = await adminClient.from('fleet').insert([{ user_id: userA.id, motoboy_code: 'MB-' + codeA, name: 'Motoboy A Hardened', phone: '51987' + codeA, status: 'Disponível' }]).select().single();
    fleetA = flA;

    const emailB = `riderB.hard.${crypto.randomUUID()}@auth.dahora.local`;
    const { data: authB } = await adminClient.auth.admin.createUser({ email: emailB, password: 'Password123!', email_confirm: true });
    userB = authB.user;
    const { data: flB } = await adminClient.from('fleet').insert([{ user_id: userB.id, motoboy_code: 'MB-' + codeB, name: 'Motoboy B Hardened', phone: '51987' + codeB, status: 'Disponível' }]).select().single();
    fleetB = flB;

    const linkA = await adminClient.auth.admin.generateLink({ type: 'magiclink', email: emailA });
    const clientUserA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'test-push-hard-a', persistSession: false } });
    await clientUserA.auth.verifyOtp({ token_hash: linkA.data.properties.hashed_token, type: 'email' });

    // Cadastrar Push Subscription para Motoboy A
    const fakeEndpointA = `https://fcm.googleapis.com/fcm/send/fake-hardened-${crypto.randomUUID()}`;
    await clientUserA.rpc('register_my_push_subscription', {
      p_endpoint: fakeEndpointA,
      p_p256dh: 'BNcRdreA1K4bDCSbdawigD-P-g_fake_p256dh',
      p_auth: 'fakeAuthKey12345',
      p_user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    });

    // Teste C: Chamada pública arbitrária a send-rider-push sem token -> DEVE SER BLOQUEADA (403)
    console.log('\n2. Testando chamada pública arbitrária a send-rider-push sem autorização...');
    const anonPushRes = await fetch(`${SUPABASE_URL}/functions/v1/send-rider-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tele_id: crypto.randomUUID() })
    });
    assert.strictEqual(anonPushRes.status, 403, 'Chamada sem JWT autorizada deve retornar HTTP 403 Forbidden');
    console.log('[PASS] Chamada anônima a send-rider-push foi BLOQUEADA com HTTP 403 com sucesso.');

    // Teste A: Atribuição autoritativa pelo Owner via assign-rider-with-push
    console.log('\n3. Testando atribuição autoritativa server-side pelo Owner...');
    const { data: newTele1, error: errTele1 } = await adminClient.from('teles').insert([{
      status: 'solicitada',
      pickup_address: 'Av. Ipiranga, 1000',
      delivery_address: 'Rua da Praia, 500',
      total_order_amount: 50.00
    }]).select().single();
    assert.ifError(errTele1);
    teleRow1 = newTele1;

    const assignRes1 = await fetch(`${SUPABASE_URL}/functions/v1/assign-rider-with-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerJwt}`
      },
      body: JSON.stringify({
        tele_id: teleRow1.id,
        motoboy_id: fleetA.id,
        expected_version: teleRow1.version
      })
    });

    assert.strictEqual(assignRes1.status, 200, 'Atribuição autoritativa deve retornar HTTP 200');
    const assignData1 = await assignRes1.json();
    assert.strictEqual(assignData1.success, true, 'Atribuição deve retornar success: true');
    console.log('[PASS] Atribuição server-side e disparo de Push concluídos:', assignData1);

    const { data: updatedTele1 } = await adminClient.from('teles').select('motoboy_id, status').eq('id', teleRow1.id).single();
    assert.strictEqual(updatedTele1.motoboy_id, fleetA.id);
    assert.strictEqual(updatedTele1.status, 'motoboy_designado');
    console.log('[PASS] Registro no banco relacional confirmado.');

    // Teste D: Falha simulada no Push (Motoboy sem subscriptions) NÃO desfaz a atribuição
    console.log('\n4. Testando falha simulada no envio do Push (Motoboy B sem subscriptions)...');
    const { data: newTele2, error: errTele2 } = await adminClient.from('teles').insert([{
      status: 'solicitada',
      pickup_address: 'Rua Bento Goncalves, 300',
      delivery_address: 'Av. Farrapos, 1200',
      total_order_amount: 40.00
    }]).select().single();
    assert.ifError(errTele2);
    teleRow2 = newTele2;

    const assignRes2 = await fetch(`${SUPABASE_URL}/functions/v1/assign-rider-with-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerJwt}`
      },
      body: JSON.stringify({
        tele_id: teleRow2.id,
        motoboy_id: fleetB.id,
        expected_version: teleRow2.version
      })
    });

    assert.strictEqual(assignRes2.status, 200);
    const assignData2 = await assignRes2.json();
    assert.strictEqual(assignData2.success, true, 'Atribuição DEVE ter sucesso mesmo se Push não tiver assinantes');
    assert.strictEqual(assignData2.push_sent, false);
    console.log('[PASS] Tele permanece atribuída com sucesso mesmo sem envio de Push:', assignData2);

    const { data: updatedTele2 } = await adminClient.from('teles').select('motoboy_id, status').eq('id', teleRow2.id).single();
    assert.strictEqual(updatedTele2.motoboy_id, fleetB.id);
    console.log('[PASS] Integridade relacional mantida após falha do Push.');

    console.log('\n==================================================');
    console.log('RESULTADO FINAL: HARDENING E VALIDAÇÃO VAPID COMPLETO E APROVADO');
    console.log('==================================================');

  } finally {
    if (teleRow1) await adminClient.from('teles').delete().eq('id', teleRow1.id);
    if (teleRow2) await adminClient.from('teles').delete().eq('id', teleRow2.id);

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

    if (ownerUser) {
      await adminClient.from('user_profiles').delete().eq('user_id', ownerUser.id);
      await adminClient.auth.admin.deleteUser(ownerUser.id);
    }
  }
}

runPushHardeningTestSuite().catch(err => {
  console.error('[FAIL] Erro nos testes de Push Hardening:', err);
  process.exit(1);
});
