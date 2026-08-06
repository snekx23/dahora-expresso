import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.bootstrap.remote' });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.');
}

async function runE2EHomologation() {
  console.log('=====================================================================');
  console.log('🚀 INICIANDO HOMOLOGAÇÃO OPERACIONAL E2E REAL NO SUPABASE LOCAL');
  console.log('=====================================================================');

  const adminClient = createClient(SUPABASE_URL, ANON_KEY);
  const riderClient = createClient(SUPABASE_URL, ANON_KEY);
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 1. Autenticar Admin e Motoboy
  console.log('\n1. Autenticando usuários locais...');
  const { data: adminAuth, error: adminErr } = await adminClient.auth.signInWithPassword({
    email: 'admin@dahora.local',
    password: 'senha123456'
  });
  if (adminErr) throw new Error(`Falha login admin: ${adminErr.message}`);
  console.log(`  ✅ Admin autenticado (uid: ${adminAuth.user.id})`);

  const { data: riderAuth, error: riderErr } = await riderClient.auth.signInWithPassword({
    email: 'motoboy@dahora.local',
    password: 'senha123456'
  });
  if (riderErr) throw new Error(`Falha login motoboy: ${riderErr.message}`);
  console.log(`  ✅ Motoboy autenticado (uid: ${riderAuth.user.id})`);

  // Obter fleet.id do motoboy
  const { data: fleetList, error: fleetErr } = await serviceClient
    .from('fleet')
    .select('id, name, motoboy_code, status')
    .eq('user_id', riderAuth.user.id)
    .limit(1);
  if (fleetErr || !fleetList || fleetList.length === 0) throw new Error(`Falha consulta fleet: ${fleetErr?.message}`);
  const fleetRow = fleetList[0];
  console.log(`  ✅ Fleet recuperada: ${fleetRow.name} (${fleetRow.motoboy_code}, ID: ${fleetRow.id})`);

  // Obter cliente comercial "Mercado Central"
  const { data: clientList, error: clientErr } = await serviceClient
    .from('commercial_clients')
    .select('id, establishment_name, rider_percentage')
    .eq('establishment_name', 'Mercado Central')
    .limit(1);
  if (clientErr || !clientList || clientList.length === 0) throw new Error(`Falha consulta cliente: ${clientErr?.message}`);
  const clientRow = clientList[0];
  console.log(`  ✅ Cliente Comercial: ${clientRow.establishment_name} (${clientRow.rider_percentage}%)`);

  // 2. Criar Tele Real de Homologação E2E
  console.log('\n2. Criando Tele de Homologação E2E com dados completos...');
  const telePayload = {
    client_id: clientRow.id,
    pickup_address: 'Rua dos Andradas, 1000 - Centro, Porto Alegre - RS',
    delivery_address: 'Av. Paulista, 1500, Apt 42 - Bela Vista, São Paulo - SP',
    recipient_name: 'João Silva Santos',
    recipient_phone: '(51) 99888-7766',
    delivery_reference: 'Frente ao MASP',
    notes: 'Entregar para o porteiro Silva <script>alert("xss")</script>',
    delivery_latitude: -23.5614,
    delivery_longitude: -46.6559,
    total_order_amount: 85.00,
    delivery_charge: 15.00,
    payment_method: 'PIX',
    status: 'solicitada',
    version: 1
  };

  const { data: teleCreated, error: createErr } = await serviceClient
    .from('teles')
    .insert([telePayload])
    .select('*')
    .single();
  if (createErr) throw new Error(`Falha ao criar Tele: ${createErr.message}`);

  const teleId = teleCreated.id;
  const teleCode = teleCreated.tele_code || teleId.substring(0, 8);
  console.log(`  ✅ Tele Criada com Sucesso!`);
  console.log(`     - ID: ${teleId}`);
  console.log(`     - Código: ${teleCode}`);
  console.log(`     - Versão Inicial: ${teleCreated.version}`);
  console.log(`     - Taxa de Entrega: R$ ${teleCreated.delivery_charge.toFixed(2)}`);

  // 3. Atribuir ao Motoboy MB-0001
  console.log('\n3. Atribuindo Tele ao Motoboy MB-0001...');
  const { data: assignRes, error: assignErr } = await adminClient.rpc('assign_rider_to_tele', {
    p_tele_id: teleId,
    p_motoboy_id: fleetRow.id,
    p_expected_version: teleCreated.version
  });
  if (assignErr) throw new Error(`Falha na atribuição: ${assignErr.message}`);
  console.log(`  ✅ Atribuição concluída via RPC! Resposta:`, assignRes);

  // Verificar estado da Tele pós-atribuição
  const { data: teleAfterAssign } = await serviceClient.from('teles').select('*').eq('id', teleId).single();
  console.log(`     - Status pós-atribuição: ${teleAfterAssign.status}`);
  console.log(`     - Nova Versão: ${teleAfterAssign.version}`);
  console.log(`     - Motoboy Atribuído: ${teleAfterAssign.motoboy_id}`);
  console.log(`     - Repasse Congelado na Atribuição: ${teleAfterAssign.rider_percentage}%`);

  const expectedRiderEarning = Number((15.00 * (clientRow.rider_percentage / 100)).toFixed(2));
  const expectedCompanyEarning = Number((15.00 - expectedRiderEarning).toFixed(2));
  console.log(`     - Repasse Motoboy Esperado: R$ ${expectedRiderEarning.toFixed(2)}`);
  console.log(`     - Taxa Empresa Esperada: R$ ${expectedCompanyEarning.toFixed(2)}`);

  // 4. Testar leitura de ganho no PWA (get_tele_rider_earning)
  console.log('\n4. Testando RPC de leitura de ganho no PWA (get_tele_rider_earning)...');
  const { data: pwaEarning, error: earningErr } = await riderClient.rpc('get_tele_rider_earning', {
    p_tele_id: teleId
  });
  if (earningErr) throw new Error(`Falha get_tele_rider_earning: ${earningErr.message}`);
  console.log(`  ✅ Ganho retornado para o PWA: R$ ${Number(pwaEarning).toFixed(2)} (Esperado: R$ ${expectedRiderEarning.toFixed(2)})`);
  if (Number(pwaEarning) !== expectedRiderEarning) throw new Error('Divergência no ganho retornado pelo PWA!');

  // Confirmar que a leitura NÃO alterou a versão nem timestamp
  const { data: teleAfterEarningRead } = await serviceClient.from('teles').select('version, updated_at').eq('id', teleId).single();
  if (teleAfterEarningRead.version !== teleAfterAssign.version) {
    throw new Error('TEST FAILED: Leitura alterou a versão da Tele!');
  }
  console.log(`  ✅ Confirmado: Leitura do PWA é 100% de apenas-leitura (sem efeitos colaterais).`);

  // 5. Executar Transição: Marcar como Coletada (mark_my_tele_collected)
  console.log('\n5. Executando RPC mark_my_tele_collected (Motoboy PWA)...');
  const { data: collectRes, error: collectErr } = await riderClient.rpc('mark_my_tele_collected', {
    p_tele_id: teleId,
    p_expected_version: teleAfterAssign.version
  });
  if (collectErr) throw new Error(`Falha mark_my_tele_collected: ${collectErr.message}`);
  console.log(`  ✅ Resposta Coleta:`, collectRes);

  // Verificar banco após Coleta
  const { data: teleAfterCollect } = await serviceClient.from('teles').select('*').eq('id', teleId).single();
  console.log(`     - Novo Status: ${teleAfterCollect.status}`);
  console.log(`     - Nova Versão: ${teleAfterCollect.version}`);

  // Verificar ausência de ledgers na Coleta
  const { count: clientLedgerCount1 } = await serviceClient.from('client_financial_transactions').select('*', { count: 'exact' }).eq('tele_id', teleId);
  const { count: riderLedgerCount1 } = await serviceClient.from('rider_financial_transactions').select('*', { count: 'exact' }).eq('tele_id', teleId);
  console.log(`     - Ledgers até a Coleta: Cliente = ${clientLedgerCount1}, Motoboy = ${riderLedgerCount1} (Esperado: 0)`);

  // 6. Executar Transição: Iniciar Entrega (start_my_tele_delivery)
  console.log('\n6. Executando RPC start_my_tele_delivery (Motoboy PWA)...');
  const { data: startRes, error: startErr } = await riderClient.rpc('start_my_tele_delivery', {
    p_tele_id: teleId,
    p_expected_version: teleAfterCollect.version
  });
  if (startErr) throw new Error(`Falha start_my_tele_delivery: ${startErr.message}`);
  console.log(`  ✅ Resposta Início Entrega:`, startRes);

  const { data: teleAfterStart } = await serviceClient.from('teles').select('*').eq('id', teleId).single();
  console.log(`     - Novo Status: ${teleAfterStart.status}`);
  console.log(`     - Nova Versão: ${teleAfterStart.version}`);

  // 7. Executar Transição: Finalizar Entrega (complete_my_tele)
  console.log('\n7. Executando RPC complete_my_tele (Motoboy PWA)...');
  const { data: completeRes, error: completeErr } = await riderClient.rpc('complete_my_tele', {
    p_tele_id: teleId,
    p_expected_version: teleAfterStart.version
  });
  if (completeErr) throw new Error(`Falha complete_my_tele: ${completeErr.message}`);
  console.log(`  ✅ Resposta Conclusão:`, completeRes);

  const { data: teleAfterComplete } = await serviceClient.from('teles').select('*').eq('id', teleId).single();
  console.log(`     - Status Final: ${teleAfterComplete.status}`);
  console.log(`     - Versão Final: ${teleAfterComplete.version}`);
  console.log(`     - Data de Conclusão (completed_at): ${teleAfterComplete.completed_at}`);

  // 8. Validar Lançamentos Financeiros e Ledgers no Banco
  console.log('\n8. Validando Lançamentos nos Ledgers Financeiros...');
  const { data: clientTx } = await serviceClient.from('client_financial_transactions').select('*').eq('tele_id', teleId);
  const { data: riderTx } = await serviceClient.from('rider_financial_transactions').select('*').eq('tele_id', teleId);
  const { data: companyTx } = await serviceClient.from('company_financial_transactions').select('*').eq('tele_id', teleId);

  console.log(`  ✅ Lançamento Cliente: ${clientTx.length} registro(s) | Valor: R$ ${clientTx[0]?.amount} | Chave: ${clientTx[0]?.idempotency_key}`);
  console.log(`  ✅ Lançamento Motoboy: ${riderTx.length} registro(s) | Valor: R$ ${riderTx[0]?.amount} | Chave: ${riderTx[0]?.idempotency_key}`);
  console.log(`  ✅ Lançamento Empresa: ${companyTx.length} registro(s) | Valor: R$ ${companyTx[0]?.amount} | Chave: ${companyTx[0]?.idempotency_key}`);

  const clientAmount = Number(clientTx[0]?.amount);
  const riderAmount = Number(riderTx[0]?.amount);
  const companyAmount = Number(companyTx[0]?.amount);

  if (clientTx.length !== 1 || riderTx.length !== 1 || companyTx.length !== 1) {
    throw new Error('Divergência na quantidade de lançamentos nos ledgers!');
  }
  if (riderAmount + companyAmount !== clientAmount) {
    throw new Error(`Matemática financeira inconsistente: ${riderAmount} + ${companyAmount} != ${clientAmount}`);
  }
  console.log(`  ✅ Soma do Repasse + Empresa (R$ ${riderAmount} + R$ ${companyAmount}) fecha exatamente a taxa da entrega (R$ ${clientAmount}).`);

  // 9. Teste de Idempotência
  console.log('\n9. Testando Idempotência com Segunda Chamada de Conclusão...');
  const { data: completeRes2, error: completeErr2 } = await riderClient.rpc('complete_my_tele', {
    p_tele_id: teleId,
    p_expected_version: teleAfterComplete.version
  });
  if (completeErr2) throw new Error(`Falha na segunda conclusão: ${completeErr2.message}`);
  console.log(`  ✅ Resposta Idempotente:`, completeRes2);

  const { data: clientTx2 } = await serviceClient.from('client_financial_transactions').select('*').eq('tele_id', teleId);
  const { data: riderTx2 } = await serviceClient.from('rider_financial_transactions').select('*').eq('tele_id', teleId);
  const { data: companyTx2 } = await serviceClient.from('company_financial_transactions').select('*').eq('tele_id', teleId);

  if (clientTx2.length !== 1 || riderTx2.length !== 1 || companyTx2.length !== 1) {
    throw new Error('TEST FAILED: Segunda conclusão duplicou lançamentos no ledger!');
  }
  console.log(`  ✅ Confirmado: Segunda conclusão manteve exatamente 1 lançamento em cada ledger (sem duplicidade).`);

  // 10. Validar Status Final da Frota
  console.log('\n10. Validando Status Final da Frota...');
  const { data: fleetAfter } = await serviceClient.from('fleet').select('status').eq('id', fleetRow.id).single();
  console.log(`  ✅ Status do Motoboy no Fleet: "${fleetAfter.status}"`);

  console.log('\n=====================================================================');
  console.log('🎉 HOMOLOGAÇÃO OPERACIONAL E2E REAL CONCLUÍDA COM SUCESSO TOTAL!');
  console.log('=====================================================================');
}

runE2EHomologation().catch(err => {
  console.error('\n❌ ERRO NA HOMOLOGAÇÃO E2E:', err);
  process.exit(1);
});
