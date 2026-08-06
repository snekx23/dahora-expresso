// =====================================================================
// Dahora Expresso — Automação de Provisionamento do Ambiente DEMO (Isolado)
// Arquivo: scripts/bootstrap-demo-environment.mjs
// Finalidade: Provisionar de forma isolada e idempotente o Supabase de Demonstração (Demo)
// =====================================================================

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function maskString(str, visibleChars = 4) {
  if (!str) return '[VAZIO]';
  if (str.length <= visibleChars * 2) return `${str.slice(0, 2)}***`;
  return `${str.slice(0, visibleChars)}...${str.slice(-visibleChars)}`;
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return '[EMAIL_INVALIDO]';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

// Carregar .env.bootstrap.demo da raiz do projeto
const bootstrapDemoEnvPath = path.resolve(projectRoot, '.env.bootstrap.demo');
if (existsSync(bootstrapDemoEnvPath)) {
  dotenv.config({ path: bootstrapDemoEnvPath, override: true });
} else {
  // Tentar fallback se .env.bootstrap.remote tiver sido usado
  const fallbackEnv = path.resolve(projectRoot, '.env.bootstrap.remote');
  if (existsSync(fallbackEnv)) {
    dotenv.config({ path: fallbackEnv, override: true });
  }
}

export async function runDemoBootstrap(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

  console.log('=====================================================================');
  console.log(`🚀 Dahora Expresso — Provisionamento do Ambiente DEMO (${isDryRun ? 'DRY-RUN Simulação' : 'EXECUÇÃO REAL'})`);
  console.log('=====================================================================');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  const expectedProjectRef = process.env.EXPECTED_PROJECT_REF;
  const appEnv = process.env.APP_ENV || 'demo';
  const environmentKind = process.env.ENVIRONMENT_KIND || 'demo';
  const demoResetEnabled = process.env.DEMO_RESET_ENABLED;
  const confirmation = process.env.BOOTSTRAP_CONFIRMATION;
  const prodProjectRef = process.env.PROD_PROJECT_REF;

  // 1. Travas Estritas de Segurança de Ambiente Demo
  if (!supabaseUrl || !supabaseSecretKey) {
    console.error('❌ [ERRO CRÍTICO] SUPABASE_URL ou SUPABASE_SECRET_KEY ausentes.');
    if (!options.isTest) process.exit(1);
    throw new Error('SUPABASE_URL or SUPABASE_SECRET_KEY missing');
  }

  if (environmentKind !== 'demo') {
    console.error(`❌ [ERRO DE SEGURANÇA] scripts/bootstrap-demo-environment.mjs exige ENVIRONMENT_KIND=demo. Recebido: ${environmentKind}`);
    if (!options.isTest) process.exit(1);
    throw new Error('Invalid ENVIRONMENT_KIND for demo bootstrap');
  }

  if (demoResetEnabled !== 'true') {
    console.error('❌ [ERRO DE SEGURANÇA] Ambiente DEMO exige DEMO_RESET_ENABLED=true.');
    if (!options.isTest) process.exit(1);
    throw new Error('DEMO_RESET_ENABLED must be true for demo bootstrap');
  }

  let actualProjectRef = '';
  try {
    const parsed = new URL(supabaseUrl);
    actualProjectRef = parsed.hostname.split('.')[0];
  } catch (err) {
    console.error('❌ [ERRO CRÍTICO] SUPABASE_URL é inválida.');
    if (!options.isTest) process.exit(1);
    throw new Error('Invalid SUPABASE_URL');
  }

  if (expectedProjectRef && actualProjectRef !== expectedProjectRef) {
    console.error(`❌ [ABORTADO] Project Ref extraído (${maskString(actualProjectRef)}) diverge do esperado (${maskString(expectedProjectRef)}).`);
    if (!options.isTest) process.exit(1);
    throw new Error('Divergent project ref');
  }

  if (prodProjectRef && actualProjectRef === prodProjectRef) {
    console.error('❌ [BLOQUEIO CRÍTICO] O ambiente DEMO recusou executar no Project Ref de Produção!');
    if (!options.isTest) process.exit(1);
    throw new Error('Demo script pointed to production project ref');
  }

  if (!isDryRun && confirmation !== 'PROVISION_DAHORA_DEMO') {
    console.error('❌ [ABORTADO] Execução real de Demo exige BOOTSTRAP_CONFIRMATION=PROVISION_DAHORA_DEMO.');
    if (!options.isTest) process.exit(1);
    throw new Error('Invalid BOOTSTRAP_CONFIRMATION');
  }

  console.log(`📍 Project Ref DEMO Validado: ${maskString(actualProjectRef)}`);
  console.log(`🌐 Ambiente: ${appEnv} (ENVIRONMENT_KIND: ${environmentKind})`);
  console.log(`🔄 Reset Autorizado: ${demoResetEnabled}`);
  console.log(`🛡️ Modo: ${isDryRun ? 'Simulação (Zero alterações no banco)' : 'Efetivo (Aplicar alterações)'}`);

  const adminClient = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const accountsToProvision = [
    {
      type: 'demo_admin',
      label: 'Admin Demo — demonstração do painel administrativo',
      email: process.env.DEMO_ADMIN_EMAIL || 'admin.demo@dahoraexpresso.local',
      password: process.env.DEMO_ADMIN_PASSWORD || 'SenhaForteAdminDemo#2026',
      name: process.env.DEMO_ADMIN_NAME || 'Administrador Demo',
      role: 'admin',
      accessLevel: 'gerente'
    },
    {
      type: 'demo_client',
      label: 'Cliente Demo — painel isolado do cliente',
      email: process.env.DEMO_CLIENT_EMAIL || 'cliente.demo@dahoraexpresso.local',
      password: process.env.DEMO_CLIENT_PASSWORD || 'SenhaForteClientDemo#2026',
      name: process.env.DEMO_CLIENT_NAME || 'Carlos Responsavel Demo',
      establishment: process.env.DEMO_CLIENT_ESTABLISHMENT || 'Restaurante Demo Dahora',
      document: process.env.DEMO_CLIENT_DOCUMENT || '00.111.222/0001-99',
      phone: process.env.DEMO_CLIENT_PHONE || '(51) 98888-0001',
      address: process.env.DEMO_CLIENT_ADDRESS || 'Av. Central, 500 - Centro, Sapucaia do Sul - RS',
      role: 'client_user',
      accessLevel: 'operador'
    },
    {
      type: 'demo_rider',
      label: 'Motoboy Demo — PWA do entregador',
      email: process.env.DEMO_RIDER_EMAIL || 'motoboy.demo@dahoraexpresso.local',
      password: process.env.DEMO_RIDER_PASSWORD || 'SenhaForteRiderDemo#2026',
      name: process.env.DEMO_RIDER_NAME || 'Joao Motoboy Demo',
      phone: process.env.DEMO_RIDER_PHONE || '(51) 97777-0001',
      vehicle: process.env.DEMO_RIDER_VEHICLE || 'Honda CG 160',
      plate: process.env.DEMO_RIDER_PLATE || 'DEM-1A23',
      role: 'motoboy',
      accessLevel: 'operador'
    }
  ];

  const { data: usersList, error: listErr } = await adminClient.auth.admin.listUsers();
  if (listErr) {
    console.error('❌ [ERRO] Falha ao consultar usuários no Supabase Auth Demo:', listErr.message);
    if (!options.isTest) process.exit(1);
    throw listErr;
  }

  const existingAuthUsers = usersList.users || [];
  const reportSummary = [];
  const createdAuthUserIdsToCleanup = [];

  try {
    for (const acc of accountsToProvision) {
      console.log(`\n---------------------------------------------------------------------`);
      console.log(`👤 Auditando Conta DEMO: ${acc.label} (${maskEmail(acc.email)})`);

      let authUserId = null;
      let actionTaken = '';
      const existingUser = existingAuthUsers.find(u => u.email && u.email.toLowerCase() === acc.email.toLowerCase());

      if (existingUser) {
        authUserId = existingUser.id;
        actionTaken = 'REUSE';
        console.log(`  └─ Auth User DEMO Existente (UUID: ${authUserId})`);
        if (!isDryRun && process.env.ROTATE_EXISTING_PASSWORD === 'true') {
          await adminClient.auth.admin.updateUserById(authUserId, { password: acc.password });
        }
      } else {
        actionTaken = 'CREATE';
        console.log(`  └─ Auth User DEMO não localizado. Criando...`);
        if (!isDryRun) {
          const { data: newAuthUser, error: createErr } = await adminClient.auth.admin.createUser({
            email: acc.email,
            password: acc.password,
            email_confirm: true,
            user_metadata: { name: acc.name, role: acc.role }
          });
          if (createErr) throw new Error(`Falha ao criar Auth User DEMO ${acc.email}: ${createErr.message}`);
          authUserId = newAuthUser.user.id;
          createdAuthUserIdsToCleanup.push(authUserId);
        } else {
          authUserId = `simulated-uuid-${acc.type}`;
        }
      }

      if (!isDryRun) {
        const { error: profileErr } = await adminClient.from('user_profiles').upsert({
          id: authUserId,
          user_id: authUserId,
          name: acc.name,
          email: acc.email,
          role: acc.role,
          access_level: acc.accessLevel,
          is_active: true,
          updated_at: new Date().toISOString()
        });
        if (profileErr) throw new Error(`Falha ao atualizar user_profiles DEMO: ${profileErr.message}`);
      }

      let linkedEntityId = null;
      if (acc.type === 'demo_client') {
        if (!isDryRun) {
          const { data: existingClient } = await adminClient.from('commercial_clients').select('id').eq('email', acc.email).maybeSingle();
          if (existingClient) {
            linkedEntityId = existingClient.id;
          } else {
            const { data: newClient, error: clientErr } = await adminClient.from('commercial_clients').insert({
              client_code: 'CLI-DEMO-001',
              establishment_name: acc.establishment,
              responsible_name: acc.name,
              phone: acc.phone,
              email: acc.email,
              address: acc.address,
              document: acc.document,
              rider_percentage: 85.00,
              lifecycle_status: 'ativo',
              financial_status: 'em_dia'
            }).select('id').single();
            if (clientErr) throw new Error(`Falha ao criar commercial_client DEMO: ${clientErr.message}`);
            linkedEntityId = newClient.id;
          }
          await adminClient.from('client_users').upsert({
            client_id: linkedEntityId,
            user_id: authUserId,
            role: 'owner',
            status: 'ativo'
          }, { onConflict: 'client_id,user_id' });
        } else {
          linkedEntityId = 'simulated-demo-client-id';
        }
      } else if (acc.type === 'demo_rider') {
        if (!isDryRun) {
          const { data: existingFleet } = await adminClient.from('fleet').select('id').eq('user_id', authUserId).maybeSingle();
          if (existingFleet) {
            linkedEntityId = existingFleet.id;
          } else {
            const { data: newFleet, error: fleetErr } = await adminClient.from('fleet').insert({
              user_id: authUserId,
              motoboy_code: 'MB-DEMO-001',
              name: acc.name,
              phone: acc.phone,
              vehicle: acc.vehicle,
              plate: acc.plate,
              status: 'Ativo',
              simultaneous_limit: 3
            }).select('id').single();
            if (fleetErr) throw new Error(`Falha ao criar fleet DEMO: ${fleetErr.message}`);
            linkedEntityId = newFleet.id;
          }
        } else {
          linkedEntityId = 'simulated-demo-fleet-id';
        }
      }

      reportSummary.push({
        label: acc.label,
        emailMasked: maskEmail(acc.email),
        authUserId,
        role: acc.role,
        linkedEntityId,
        status: actionTaken
      });
    }

    // Registrar UUIDs Canônicos em public.environment_settings
    if (!isDryRun) {
      const demoAdminAuth = reportSummary.find(r => r.role === 'admin')?.authUserId;
      const demoClientAuth = reportSummary.find(r => r.role === 'client_user')?.authUserId;
      const demoRiderAuth = reportSummary.find(r => r.role === 'motoboy')?.authUserId;
      const demoClientId = reportSummary.find(r => r.role === 'client_user')?.linkedEntityId;
      const demoRiderId = reportSummary.find(r => r.role === 'motoboy')?.linkedEntityId;

      const { data: sysClient } = await adminClient.from('commercial_clients').select('id').eq('client_code', 'SYS-DAHORA').maybeSingle();

      const { error: settingsErr } = await adminClient.from('environment_settings').upsert({
        id: 'current',
        environment_kind: 'demo',
        environment_version: 1,
        reset_enabled: true,
        demo_admin_user_id: demoAdminAuth,
        demo_client_user_id: demoClientAuth,
        demo_rider_user_id: demoRiderAuth,
        demo_client_id: demoClientId,
        demo_rider_id: demoRiderId,
        internal_client_id: sysClient?.id || null,
        demo_client_code: 'CLI-DEMO-001',
        demo_rider_code: 'MB-DEMO-001',
        internal_client_code: 'SYS-DAHORA',
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

      if (settingsErr) {
        console.warn('⚠️ [AVISO] Falha ao gravar environment_settings (Tabela demo ainda não criada por migration):', settingsErr.message);
      } else {
        console.log('📌 [IDENTIDADES CANÔNICAS] Registradas com sucesso em public.environment_settings.');
      }
    }

    console.log(`\n=====================================================================`);
    console.log(`📊 RESUMO DO BOOTSTRAP DEMO (${isDryRun ? 'DRY-RUN' : 'EFETIVO'})`);
    console.log('=====================================================================');
    console.table(reportSummary);

    return { success: true, isDryRun, reportSummary };
  } catch (err) {
    console.error(`❌ [ERRO DEMO BOOTSTRAP] ${err.message}`);
    if (!isDryRun && createdAuthUserIdsToCleanup.length > 0) {
      for (const uid of createdAuthUserIdsToCleanup) {
        try { await adminClient.auth.admin.deleteUser(uid); } catch (e) {}
      }
    }
    if (!options.isTest) process.exit(1);
    throw err;
  }
}

if (process.argv[1] && process.argv[1].endsWith('bootstrap-demo-environment.mjs')) {
  runDemoBootstrap().catch(err => {
    console.error('Falha fatal:', err.message);
    process.exit(1);
  });
}
