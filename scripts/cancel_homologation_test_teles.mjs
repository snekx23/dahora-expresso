// =====================================================================
// Dahora Expresso — Script de Cancelamento Autenticado das Teles de Teste Antigas
// File: scripts/cancel_homologation_test_teles.mjs
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dahora.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'senha123456';

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('[ERRO CRÍTICO] As variáveis de ambiente ADMIN_EMAIL e ADMIN_PASSWORD são OBRIGATÓRIAS.');
  process.exit(1);
}

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function runCancelHomologationTeles() {
  console.log('\n=== INICIANDO CANCELAMENTO CONTROLADO E AUDITADO DAS TELES DE TESTE ===');

  // 1. Login Administrativo Autêntico via Supabase Auth
  const adminClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: authData, error: authErr } = await adminClient.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD
  });

  if (authErr || !authData.session) {
    console.error('[ERRO DE AUTENTICAÇÃO] Falha ao autenticar o administrador:', authErr?.message || authErr);
    process.exit(1);
  }

  const adminUserId = authData.session.user.id;
  console.log(`[AUTH LOG] Administrador autenticado com sucesso.`);
  console.log(`  - Admin user_id (auth.uid): ${adminUserId}`);

  // Confirmar perfil administrativo na tabela user_profiles
  const { data: adminProfile, error: profileErr } = await serviceClient
    .from('user_profiles')
    .select('id, user_id, role, is_active')
    .eq('user_id', adminUserId)
    .single();

  if (profileErr || !adminProfile || !adminProfile.is_active || !['owner', 'admin', 'operador', 'gerente'].includes(adminProfile.role)) {
    console.error('[ERRO DE PERMISSÃO] O usuário autenticado não possui papel administrativo ativo:', profileErr?.message || adminProfile);
    process.exit(1);
  }

  console.log(`  - Perfil administrativo confirmado: role = "${adminProfile.role}", ativo = ${adminProfile.is_active}`);

  const targetCodes = ['TEL-100001', 'TEL-100002', 'TEL-100004', 'TEL-100005'];
  const resultsAudit = [];

  for (const teleCode of targetCodes) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`Auditando e cancelando Tele de teste: ${teleCode}...`);

    // A. Buscar a Tele no banco
    const { data: tele, error: fetchErr } = await serviceClient
      .from('teles')
      .select('id, tele_code, status, version, created_at, client_id, delivery_address')
      .eq('tele_code', teleCode)
      .maybeSingle();

    if (fetchErr || !tele) {
      console.warn(`[AVISO] Tele ${teleCode} não encontrada no banco de dados. Pulando.`);
      continue;
    }

    console.log(`  - Dados Reais Encontrados:`);
    console.log(`    • ID: ${tele.id}`);
    console.log(`    • Status Atual: "${tele.status}"`);
    console.log(`    • Versão Real no Banco: ${tele.version}`);
    console.log(`    • Data de Criação (created_at): ${tele.created_at}`);

    // B. Snapshot Financeiro Antes
    const { data: finBefore, error: finBeforeErr } = await serviceClient
      .from('rider_financial_transactions')
      .select('id, amount, transaction_type')
      .eq('tele_id', tele.id);

    const countBefore = (finBefore || []).length;
    const totalAmountBefore = (finBefore || []).reduce((acc, curr) => acc + Number(curr.amount || 0), 0);
    console.log(`  - Snapshot Financeiro (ANTES): ${countBefore} transações | Total: R$ ${totalAmountBefore.toFixed(2)}`);

    // Se já estiver cancelada, testar a idempotência da RPC
    const isAlreadyCancelled = tele.status === 'cancelada';
    const expectedVersionToPass = Number(tele.version);

    // C. Chamada Oficial da RPC cancel_tele na sessão do Admin Autenticado
    console.log(`  - Executando RPC public.cancel_tele(p_tele_id: "${tele.id}", p_expected_version: ${expectedVersionToPass})...`);
    const { data: rpcRes, error: rpcErr } = await adminClient.rpc('cancel_tele', {
      p_tele_id: tele.id,
      p_expected_version: expectedVersionToPass,
      p_reason: 'Teste de Homologação / Cleanup de Testes',
      p_charge_policy: 'sem_cobranca'
    });

    if (rpcErr) {
      console.error(`  - [ERRO RPC] Falha ao cancelar Tele ${teleCode}:`, rpcErr.message);
      resultsAudit.push({ teleCode, success: false, error: rpcErr.message });
      continue;
    }

    console.log(`  - Resposta da RPC:`, rpcRes);

    // D. Snapshot Financeiro Depois & Validações Pós-Cancelamento
    const { data: finAfter, error: finAfterErr } = await serviceClient
      .from('rider_financial_transactions')
      .select('id, amount, transaction_type')
      .eq('tele_id', tele.id);

    const countAfter = (finAfter || []).length;
    const totalAmountAfter = (finAfter || []).reduce((acc, curr) => acc + Number(curr.amount || 0), 0);
    const diffFinanceira = totalAmountAfter - totalAmountBefore;

    console.log(`  - Snapshot Financeiro (DEPOIS): ${countAfter} transações | Total: R$ ${totalAmountAfter.toFixed(2)}`);
    console.log(`  - Diferença Financeira Gerada: R$ ${diffFinanceira.toFixed(2)}`);

    // E. Consultar estado final da Tele no banco
    const { data: teleFinal } = await serviceClient
      .from('teles')
      .select('status, version, cancelled_at, cancellation_reason')
      .eq('id', tele.id)
      .single();

    // F. Consultar Eventos e Auditoria
    const { data: eventos } = await serviceClient
      .from('tele_eventos')
      .select('id, tipo, idempotency_key, created_at')
      .eq('tele_id', tele.id)
      .eq('tipo', 'tele_cancelled');

    const { data: auditLogs } = await serviceClient
      .from('system_audit_logs')
      .select('id, actor_id, action, target_resource')
      .eq('target_resource', `teles:${tele.id}`)
      .eq('action', 'tele_cancelled');

    const auditActorMatch = auditLogs && auditLogs.some(log => log.actor_id === adminUserId);

    resultsAudit.push({
      tele_code: teleCode,
      id: tele.id,
      success: rpcRes.success,
      previous_status: tele.status,
      final_status: teleFinal.status,
      previous_version: tele.version,
      final_version: teleFinal.version,
      cancelled_at: teleFinal.cancelled_at,
      cancellation_reason: teleFinal.cancellation_reason,
      financial_diff_amount: diffFinanceira,
      events_recorded: (eventos || []).length,
      audit_logs_recorded: (auditLogs || []).length,
      actor_id_matched: auditActorMatch
    });
  }

  console.log(`\n=================== SUMÁRIO DA AUDITORIA DE CANCELAMENTO ===================`);
  console.table(resultsAudit);
  console.log(`============================================================================\n`);
}

runCancelHomologationTeles();
