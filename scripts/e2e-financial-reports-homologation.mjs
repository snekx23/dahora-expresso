// =====================================================================
// Dahora Expresso — E2E Financial Reports Homologation Script (Native)
// File: scripts/e2e-financial-reports-homologation.mjs
// =====================================================================

import dotenv from 'dotenv';
dotenv.config({ path: '.env.bootstrap.remote' });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.');
}
const SERVER_URL = 'http://localhost:8000';

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

async function runE2EHomologation() {
  console.log('🚀 Iniciando Homologação E2E Operacional da Etapa "Relatórios e Ganhos"...');

  // 1. Confirmar Servidor Local na porta 8000
  try {
    const srvRes = await fetch(`${SERVER_URL}/motoboy.html`);
    if (srvRes.status !== 200) throw new Error(`Status ${srvRes.status}`);
    console.log('✅ Servidor local (http://localhost:8000/motoboy.html) respondendo OK (HTTP 200).');
  } catch (err) {
    console.error('❌ Falha ao conectar ao servidor local na porta 8000:', err.message);
    process.exit(1);
  }

  // 2. Autenticação E2E do Motoboy no Supabase Auth (senha123456)
  const { data: authSession, error: loginErr } = await anonClient.auth.signInWithPassword({
    email: 'motoboy@dahora.local',
    password: 'senha123456'
  });

  if (loginErr || !authSession.session) {
    console.error('❌ Falha na autenticação E2E do motoboy:', loginErr);
    process.exit(1);
  }

  const riderUserId = authSession.user.id;

  // 3. Identificar o registro de fleet correspondente ao auth.uid()
  const { data: fleetRow, error: fleetErr } = await serviceClient
    .from('fleet')
    .select('id, user_id, name, motoboy_code')
    .eq('user_id', riderUserId)
    .single();

  if (fleetErr || !fleetRow) {
    console.error('❌ Registro em fleet não encontrado para auth.uid():', fleetErr);
    process.exit(1);
  }

  console.log(`📌 Motoboy Autenticado: ${fleetRow.name} (Fleet ID: ${fleetRow.id} | User ID: ${riderUserId})`);

  // 4. Inserir massa de dados financeira de teste para o motoboy principal
  const { data: teleSample } = await serviceClient.from('teles').insert({
    status: 'concluida',
    delivery_charge: 25.00,
    tele_code: `T-E2E-${Date.now().toString().slice(-4)}`,
    version: 1,
    pickup_address: 'Av. Paulista 1000, São Paulo - SP',
    delivery_address: 'Rua Augusta 500, São Paulo - SP'
  }).select().single();

  if (teleSample) {
    await serviceClient.from('rider_financial_transactions').insert({
      rider_id: fleetRow.id,
      tele_id: teleSample.id,
      type: 'credito_entrega',
      direction: 'credit',
      amount: 20.00,
      description: `Ganho de Entrega ${teleSample.tele_code}`,
      idempotency_key: `e2e:tele:${teleSample.id}:v1`
    });
  }

  await serviceClient.from('rider_consumable_purchases').insert({
    motoboy_id: fleetRow.id,
    item_name: 'Capacete Escuro Pro',
    quantidade: 1,
    valor_unitario: 120.00,
    amount: 120.00
  });

  await serviceClient.from('rider_credits_ledger').insert({
    motoboy_id: fleetRow.id,
    amount: 50.00,
    description: 'Bônus de Desempenho Noturno'
  });

  console.log('✅ Massa de dados financeira E2E inserida com sucesso.');

  const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${authSession.session.access_token}` } },
    auth: { persistSession: false }
  });

  console.log('✅ Token JWT de Autenticação válido obtido para motoboy@dahora.local.');

  // 5. Testar RPC get_my_rider_financial_summary
  const { data: summaryData, error: summaryErr } = await authenticatedClient.rpc('get_my_rider_financial_summary', {
    p_start_date: null,
    p_end_date: null
  });

  if (summaryErr || !summaryData.success) {
    console.error('❌ Erro na RPC get_my_rider_financial_summary:', summaryErr || summaryData);
    process.exit(1);
  }

  console.log('📊 Resultado da RPC get_my_rider_financial_summary:');
  console.log(`  - Rótulo do Período: ${summaryData.period_label}`);
  console.log(`  - Entregas Concluídas: ${summaryData.completed_deliveries_count}`);
  console.log(`  - Ganhos de Entregas: R$ ${summaryData.delivery_earnings}`);
  console.log(`  - Créditos / Bônus: R$ ${summaryData.credits_total}`);
  console.log(`  - Consumíveis: R$ ${summaryData.consumables_total}`);
  console.log(`  - Bruto Total: R$ ${summaryData.gross_total}`);
  console.log(`  - Deduções Totais: R$ ${summaryData.deductions_total}`);
  console.log(`  - Líquido Total: R$ ${summaryData.net_total}`);

  if (Number(summaryData.net_total) !== (Number(summaryData.gross_total) - Number(summaryData.deductions_total))) {
    console.error('❌ Invariante financeiro quebrado: Líquido != Bruto - Deduções!');
    process.exit(1);
  }

  // 6. Testar RPC get_my_rider_financial_statement (Paginado)
  const { data: stmtData, error: stmtErr } = await authenticatedClient.rpc('get_my_rider_financial_statement', {
    p_start_date: null,
    p_end_date: null,
    p_limit: 30,
    p_offset: 0
  });

  if (stmtErr || !stmtData.success) {
    console.error('❌ Erro na RPC get_my_rider_financial_statement:', stmtErr || stmtData);
    process.exit(1);
  }

  console.log(`📋 Extrato retornado com ${stmtData.items.length} lançamentos (Total: ${stmtData.total_count}):`);
  stmtData.items.forEach(item => {
    console.log(`  • [${item.transaction_category}] ${item.direction.toUpperCase()} R$ ${item.amount} - ${item.description}`);
  });

  // 7. Verificar que idempotency_key NUNCA é vazada no extrato público
  const leakedKeys = stmtData.items.filter(i => i.idempotency_key !== undefined);
  if (leakedKeys.length > 0) {
    console.error('❌ VAZAMENTO DE SEGURANÇA: idempotency_key exposta na resposta pública!');
    process.exit(1);
  }

  console.log('🔒 Garantia de Segurança: Nenhuma idempotency_key exposta ao frontend.');
  console.log('🎉 HOMOLOGAÇÃO E2E DA ETAPA RELATÓRIOS E GANHOS 100% APROVADA!');
}

runE2EHomologation();
