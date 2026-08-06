// =====================================================================
// Dahora Expresso — Módulo Autoritativo de Reset do Ambiente DEMO
// Arquivo: scripts/reset-demo-environment.mjs
// Finalidade: Restaurar integralmente o Supabase de Demonstração ao estado inicial zerado
// =====================================================================

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Trava de Concorrência Global para evitar resets simultâneos
let isResetInProgress = false;

function maskString(str, visibleChars = 4) {
  if (!str) return '[VAZIO]';
  if (str.length <= visibleChars * 2) return `${str.slice(0, 2)}***`;
  return `${str.slice(0, visibleChars)}...${str.slice(-visibleChars)}`;
}

// Carregar .env.bootstrap.demo se existir
const demoEnvPath = path.resolve(projectRoot, '.env.bootstrap.demo');
if (existsSync(demoEnvPath)) {
  dotenv.config({ path: demoEnvPath, override: true });
}

export async function executeDemoReset(options = {}) {
  const startTime = Date.now();
  const executionId = `RESET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

  console.log('=====================================================================');
  console.log(`🔄 Dahora Expresso — Reset do Ambiente DEMO (Execution ID: ${executionId})`);
  console.log('=====================================================================');

  // Trava de Concorrência
  if (isResetInProgress) {
    console.error('❌ [BLOQUEIO] Uma operação de reset já está em andamento.');
    if (!options.isTest) process.exit(1);
    throw new Error('Reset already in progress');
  }

  isResetInProgress = true;
  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
    const supabaseSecretKey = options.supabaseSecretKey || process.env.SUPABASE_SECRET_KEY;
    const environmentKind = options.environmentKind || process.env.ENVIRONMENT_KIND || 'demo';
    const demoResetEnabled = options.demoResetEnabled ?? process.env.DEMO_RESET_ENABLED;
    const confirmationText = options.confirmationText || process.env.RESET_CONFIRMATION_TEXT;
    const prodProjectRef = process.env.PROD_PROJECT_REF;

    // 1. Travas Rígidas de Segurança
    if (!supabaseUrl || !supabaseSecretKey) {
      throw new Error('SUPABASE_URL or SUPABASE_SECRET_KEY missing');
    }

    if (environmentKind === 'production' || process.env.APP_ENV === 'production') {
      throw new Error('CRITICAL: Reset operation is forbidden on production environment!');
    }

    if (environmentKind !== 'demo') {
      throw new Error(`Reset requires ENVIRONMENT_KIND=demo (Received: ${environmentKind})`);
    }

    if (String(demoResetEnabled) !== 'true') {
      throw new Error('Reset operation requires DEMO_RESET_ENABLED=true');
    }

    let actualProjectRef = '';
    try {
      actualProjectRef = new URL(supabaseUrl).hostname.split('.')[0];
    } catch (e) {
      throw new Error('Invalid SUPABASE_URL');
    }

    if (prodProjectRef && actualProjectRef === prodProjectRef) {
      throw new Error('CRITICAL: Reset script blocked because target project-ref matches production!');
    }

    if (confirmationText !== 'RESTAURAR DEMO') {
      throw new Error('Reset requires exact confirmation string: RESTAURAR DEMO');
    }

    console.log(`📍 Project Ref DEMO Validado: ${maskString(actualProjectRef)}`);
    console.log(`🛡️ Trava de Produção: APROVADA (Projeto Demo Isolado)`);

    const adminClient = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Validar JWT se informado
    if (options.userJwt) {
      const { data: userData, error: userErr } = await adminClient.auth.getUser(options.userJwt);
      if (userErr || !userData.user) {
        throw new Error('Unauthorized: Invalid user JWT');
      }

      const { data: profile } = await adminClient
        .from('user_profiles')
        .select('role')
        .eq('user_id', userData.user.id)
        .single();

      if (!profile || !['owner', 'admin'].includes(profile.role)) {
        throw new Error('Forbidden: User does not have admin permissions for demo reset');
      }
    }

    const deleteCounts = {
      removed_clients: 0,
      removed_riders: 0,
      removed_teles: 0,
      removed_transactions: 0,
      removed_users: 0
    };

    if (!options.dryRun) {
      // 2. Apagar em ordem segura respeitando FKs
      console.log('🧹 1. Limpando fechamentos semanais e lotes de pagamento...');
      await adminClient.from('rider_payment_batch_items').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await adminClient.from('rider_payment_batches').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await adminClient.from('rider_weekly_settlement_items').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await adminClient.from('rider_weekly_settlements').delete().neq('id', '00000000-0000-0000-0000-000000000000');

      console.log('🧹 2. Limpando ledgers e alocações financeiras...');
      await adminClient.from('client_payment_allocations').delete().neq('id', '00000000-0000-0000-0000-000000000000');

      const { count: rTxCount } = await adminClient.from('rider_financial_transactions').delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
      const { count: cTxCount } = await adminClient.from('company_financial_transactions').delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
      const { count: clTxCount } = await adminClient.from('client_financial_transactions').delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
      deleteCounts.removed_transactions = (rTxCount || 0) + (cTxCount || 0) + (clTxCount || 0);

      await adminClient.from('rider_credits_ledger').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await adminClient.from('rider_consumable_purchases').delete().neq('id', '00000000-0000-0000-0000-000000000000');

      console.log('🧹 3. Limpando eventos e solicitações de Teles...');
      await adminClient.from('tele_eventos').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      const { count: teleCount } = await adminClient.from('teles').delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
      deleteCounts.removed_teles = teleCount || 0;

      console.log('🧹 4. Limpando módulo de suporte e notificações...');
      await adminClient.from('rider_support_message_reads').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await adminClient.from('rider_support_messages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await adminClient.from('rider_support_tickets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await adminClient.from('rider_device_status').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await adminClient.from('rider_push_subscriptions').delete().neq('id', '00000000-0000-0000-0000-000000000000');

      console.log('🧹 5. Limpando motoboys e clientes extras...');
      const { count: fleetCount } = await adminClient.from('fleet').delete({ count: 'exact' }).neq('motoboy_code', 'MB-DEMO-001');
      deleteCounts.removed_riders = fleetCount || 0;

      const { count: clientCount } = await adminClient.from('commercial_clients').delete({ count: 'exact' }).not('client_code', 'in', '("CLI-DEMO-001","SYS-DAHORA")');
      deleteCounts.removed_clients = clientCount || 0;

      // Resetar saldos e status das entidades base preservadas
      await adminClient.from('fleet').update({ status: 'Ativo', lat: null, lng: null }).eq('motoboy_code', 'MB-DEMO-001');
      await adminClient.from('commercial_clients').update({ financial_status: 'em_dia', lifecycle_status: 'ativo' }).eq('client_code', 'CLI-DEMO-001');
    }

    const durationMs = Date.now() - startTime;
    console.log(`✅ [SUCESSO] Reset concluído em ${durationMs}ms (Execution ID: ${executionId})`);

    return {
      success: true,
      execution_id: executionId,
      duration_ms: durationMs,
      summary: deleteCounts
    };
  } finally {
    isResetInProgress = false;
  }
}
