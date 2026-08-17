// =====================================================================
// Dahora Expresso — Integration Test Suite for Admin Rider Financial Operations
// File: tests/admin-rider-financial-operations-fix.test.mjs
// =====================================================================

import assert from 'assert';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Local test harness override
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzc4NzcsImV4cCI6MjEwMTU1Mzg3N30.1BoD7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw';
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long';

const ADMIN_USER_ID = '14620da0-6e08-488f-95ff-26f751785870';
const RIDER_USER_ID = '7668596b-0444-4435-9f0c-8d0ad7ce7fb8';

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function generateNativeAuthToken(userId, role = 'authenticated') {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: userId,
    aud: 'authenticated',
    role: role,
    exp: Math.floor(Date.now() / 1000) + 3600
  }));
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${header}.${payload}.${signature}`;
}

async function runNodeIntegrationTests() {
  console.log('🚀 Iniciando Suíte de Testes Node.js: Operações Financeiras Administrativas...');

  const adminToken = generateNativeAuthToken(ADMIN_USER_ID);
  const riderToken = generateNativeAuthToken(RIDER_USER_ID);

  const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${adminToken}` } },
    auth: { persistSession: false }
  });

  const riderClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${riderToken}` } },
    auth: { persistSession: false }
  });

  console.log('  ✅ 1. Tokens JWT gerados nativamente para Admin e Motoboy.');

  // Obter o fleet.id do motoboy
  const { data: fleetDataArr, error: fleetErr } = await adminClient
    .from('fleet')
    .select('id, name')
    .eq('user_id', RIDER_USER_ID);
  assert.ifError(fleetErr, 'Deve localizar o registro do motoboy em fleet');
  const fleetData = fleetDataArr && fleetDataArr.length > 0 ? fleetDataArr[0] : { id: RIDER_USER_ID, name: 'Motoboy Teste' };
  const fleetId = fleetData.id;
  console.log(`  ✅ 2. Motoboy localizado em fleet: ${fleetData.name} (${fleetId})`);

  // 2. Admin registra um Consumível via RPC admin_create_rider_consumable
  const { data: consRes, error: consErr } = await adminClient.rpc('admin_create_rider_consumable', {
    p_motoboy_id: fleetId,
    p_category: 'consumivel',
    p_item_name: `Óleo Sintético ${Date.now()}`,
    p_quantity: 1,
    p_unit_amount: 45.00,
    p_notes: 'Troca em posto credenciado',
    p_competency_date: new Date().toISOString().split('T')[0],
    p_request_idempotency_key: `node-test-cons-${Date.now()}-${Math.floor(Math.random()*100000)}`
  });
  assert.ifError(consErr, 'RPC admin_create_rider_consumable não deve retornar erro HTTP/RPC');
  assert.strictEqual(consRes.success, true, 'Resposta da RPC de consumível deve indicar sucesso');
  assert.strictEqual(consRes.purchase.amount, 45, 'Valor total do consumível deve ser R$ 45.00');
  const purchaseId = consRes.purchase.id;
  console.log('  ✅ 3. Consumível registrado via RPC administrativa.');

  // 3. Admin registra um Crédito via RPC admin_create_rider_adjustment
  const { data: credRes, error: credErr } = await adminClient.rpc('admin_create_rider_adjustment', {
    p_motoboy_id: fleetId,
    p_direction: 'credit',
    p_amount: 30.00,
    p_description: 'Bônus Pontualidade Node',
    p_target_date: new Date().toISOString().split('T')[0],
    p_request_idempotency_key: `node-test-cred-${Date.now()}-${Math.floor(Math.random()*100000)}`
  });
  assert.ifError(credErr, 'RPC admin_create_rider_adjustment não deve retornar erro');
  assert.strictEqual(credRes.success, true, 'Resposta da RPC de crédito deve indicar sucesso');
  const adjustmentId = credRes.adjustment.id;
  console.log('  ✅ 4. Crédito de bônus registrado via RPC administrativa.');

  // 4. Teste de Segurança: Motoboy tenta executar RPC administrativa -> Bloqueio ADMIN_ROLE_REQUIRED
  const { data: secRes } = await riderClient.rpc('admin_create_rider_consumable', {
    p_motoboy_id: fleetId,
    p_category: 'consumivel',
    p_item_name: 'Item Proibido Motoboy',
    p_quantity: 1,
    p_unit_amount: 100.00
  });
  assert.strictEqual(secRes?.success, false, 'Motoboy não pode executar RPC administrativa');
  assert.strictEqual(secRes?.error_code, 'ADMIN_ROLE_REQUIRED', 'Erro retornado deve ser ADMIN_ROLE_REQUIRED');
  console.log('  ✅ 5. Trava de segurança para motoboy validada com sucesso.');

  // 5. Admin estorna o Consumível via admin_reverse_rider_consumable
  const { data: revConsRes, error: revConsErr } = await adminClient.rpc('admin_reverse_rider_consumable', {
    p_purchase_id: purchaseId,
    p_reason: 'Lançamento efetuado por engano no teste Node'
  });
  assert.ifError(revConsErr, 'RPC admin_reverse_rider_consumable não deve falhar');
  assert.strictEqual(revConsRes.success, true, 'Estorno do consumível deve ser bem-sucedido');
  assert.strictEqual(revConsRes.purchase.status, 'reversed', 'Status do consumível deve mudar para reversed');
  console.log('  ✅ 6. Estorno lógico de consumível executado com sucesso.');

  // 6. Tentar estornar novamente deve retornar already_reversed de forma idempotente
  const { data: revConsDupRes } = await adminClient.rpc('admin_reverse_rider_consumable', {
    p_purchase_id: purchaseId,
    p_reason: 'Segunda tentativa'
  });
  assert.strictEqual(revConsDupRes.success, true, 'Segunda tentativa deve retornar true');
  assert.strictEqual(revConsDupRes.already_reversed, true, 'Deve indicar already_reversed = true');
  console.log('  ✅ 7. Idempotência de estorno duplicado validada com sucesso.');

  // 7. Admin consulta Extrato e Resumo do Motoboy
  const todayStr = new Date().toISOString().split('T')[0];
  const { data: adminSummary } = await adminClient.rpc('admin_get_rider_financial_summary', {
    p_motoboy_id: fleetId,
    p_start_date: todayStr,
    p_end_date: todayStr
  });
  assert.strictEqual(adminSummary.success, true, 'Resumo no admin deve ser retornado');

  // 8. Motoboy consulta seu próprio resumo no PWA via get_my_rider_financial_summary
  const { data: pwaSummary } = await riderClient.rpc('get_my_rider_financial_summary', {
    p_start_date: todayStr,
    p_end_date: todayStr
  });
  assert.strictEqual(pwaSummary.success, true, 'Resumo no PWA do motoboy deve ser retornado');
  assert.strictEqual(Number(pwaSummary.net_total), Number(adminSummary.net_total), 'Saldos líquidos no Admin e PWA devem ser 100% idênticos');
  console.log('  ✅ 8. Consistência financeira entre Admin e PWA do Motoboy validada com sucesso.');

  console.log('\n🎉 Todos os testes de integração Node.js foram concluídos com SUCESSO!');
}

runNodeIntegrationTests().catch(err => {
  console.error('❌ Erro na suíte de testes Node.js:', err);
  process.exit(1);
});
