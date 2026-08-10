// =====================================================================
// Dahora Expresso — Automação de Provisionamento do Ambiente Remoto (Bootstrap)
// Arquivo: scripts/bootstrap-remote-environment.mjs
// Finalidade: Provisionar com segurança e idempotência os perfis iniciais do Supabase Remoto
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

// Helper de mascaramento seguro para logs
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

// Carregar automaticamente o arquivo .env.bootstrap.remote da raiz do projeto
const bootstrapEnvPath = path.resolve(projectRoot, '.env.bootstrap.remote');
if (existsSync(bootstrapEnvPath)) {
  dotenv.config({ path: bootstrapEnvPath, override: true });
} else {
  // Tentar fallback se já estiver preenchido via CLI ou ambiente de teste
  if (!process.env.SUPABASE_URL && process.env.NODE_ENV !== 'test') {
    console.warn(`⚠️ Arquivo .env.bootstrap.remote não encontrado em: ${bootstrapEnvPath}`);
  }
}

export async function runBootstrap(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

  console.log('=====================================================================');
  console.log(`🚀 Dahora Expresso — Provisionamento do Ambiente (${isDryRun ? 'DRY-RUN (Simulação)' : 'EXECUÇÃO REAL'})`);
  console.log('=====================================================================');

  // 1. Validação Estrita de Variáveis de Ambiente Obrigatórias
  const requiredVars = [
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'EXPECTED_PROJECT_REF',
    'APP_ENV',
    'BOOTSTRAP_CONFIRMATION'
  ];

  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    console.error(`❌ [ERRO CRÍTICO] Variáveis de ambiente obrigatórias ausentes: ${missingVars.join(', ')}`);
    console.error(`   Certifique-se de que o arquivo .env.bootstrap.remote existe e contém essas variáveis.`);
    if (!options.isTest) process.exit(1);
    throw new Error(`Variáveis obrigatórias ausentes: ${missingVars.join(', ')}`);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  const expectedProjectRef = process.env.EXPECTED_PROJECT_REF;
  const appEnv = process.env.APP_ENV || 'remote';
  const confirmation = process.env.BOOTSTRAP_CONFIRMATION;

  // Trava de Ambiente Remoto contra Localhost
  if (appEnv === 'remote' && (supabaseUrl.includes('127.0.0.1') || supabaseUrl.includes('localhost'))) {
    console.error('❌ [ERRO DE SEGURANÇA] APP_ENV=remote recusou URL local (127.0.0.1 ou localhost).');
    if (!options.isTest) process.exit(1);
    throw new Error('Localhost rejected for APP_ENV=remote');
  }

  // Extrair e Validar Project Ref
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

  if (!isDryRun && confirmation !== 'PROVISION_DAHORA_REMOTE') {
    console.error('❌ [ABORTADO] Execução real exige BOOTSTRAP_CONFIRMATION=PROVISION_DAHORA_REMOTE.');
    if (!options.isTest) process.exit(1);
    throw new Error('Invalid BOOTSTRAP_CONFIRMATION');
  }

  console.log(`📍 Project Ref Validado: ${maskString(actualProjectRef)}`);
  console.log(`🌐 Ambiente: ${appEnv}`);
  console.log(`🛡️ Modo: ${isDryRun ? 'Simulação (Zero alterações no banco)' : 'Efetivo (Aplicar alterações)'}`);

  // 2. Inicialização Administrativa Supabase (Sem Persistência de Sessão)
  const adminClient = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Configurações das Contas do Ambiente de Produção (Apenas Donos/Administradores)
  const accountsToProvision = [
    {
      type: 'owner1',
      label: 'Owner Principal — painel administrativo completo',
      email: process.env.OWNER_1_EMAIL || 'owner1@dahoraexpresso.local',
      password: process.env.OWNER_1_PASSWORD || 'SenhaForteOwner1#2026',
      name: process.env.OWNER_1_NAME || 'Owner Principal',
      role: 'owner',
      accessLevel: 'owner'
    },
    {
      type: 'owner2',
      label: 'Owner Secundário — painel administrativo completo',
      email: process.env.OWNER_2_EMAIL || 'owner2@dahoraexpresso.local',
      password: process.env.OWNER_2_PASSWORD || 'SenhaForteOwner2#2026',
      name: process.env.OWNER_2_NAME || 'Owner Secundario',
      role: 'owner',
      accessLevel: 'owner'
    }
  ];

  // Obter lista atual de usuários auth
  const { data: usersList, error: listErr } = await adminClient.auth.admin.listUsers();
  if (listErr) {
    console.error('❌ [ERRO] Falha ao consultar lista de usuários no Supabase Auth:', listErr.message);
    if (!options.isTest) process.exit(1);
    throw listErr;
  }

  const existingAuthUsers = usersList.users || [];
  const reportSummary = [];
  const createdAuthUserIdsToCleanup = [];

  try {
    for (const acc of accountsToProvision) {
      console.log(`\n---------------------------------------------------------------------`);
      console.log(`👤 Auditando Conta: ${acc.label} (${maskEmail(acc.email)})`);

      let authUserId = null;
      let actionTaken = '';
      const existingUser = existingAuthUsers.find(u => u.email && u.email.toLowerCase() === acc.email.toLowerCase());

      if (existingUser) {
        authUserId = existingUser.id;
        actionTaken = 'REUSE';
        console.log(`  └─ Auth User Existente localizado (UUID: ${authUserId})`);

        if (!isDryRun && process.env.ROTATE_EXISTING_PASSWORD === 'true') {
          console.log(`  └─ [ROTATION] Atualizando senha do usuário existente...`);
          await adminClient.auth.admin.updateUserById(authUserId, { password: acc.password });
        }
      } else {
        actionTaken = 'CREATE';
        console.log(`  └─ Auth User não localizado. Planejando criação...`);

        if (!isDryRun) {
          const { data: newAuthUser, error: createErr } = await adminClient.auth.admin.createUser({
            email: acc.email,
            password: acc.password,
            email_confirm: true,
            user_metadata: { name: acc.name, role: acc.role }
          });

          if (createErr) {
            throw new Error(`Falha ao criar Auth User para ${acc.email}: ${createErr.message}`);
          }

          authUserId = newAuthUser.user.id;
          createdAuthUserIdsToCleanup.push(authUserId);
          console.log(`  └─ ✅ Auth User criado com sucesso (UUID: ${authUserId})`);
        } else {
          authUserId = `simulated-uuid-${acc.type}`;
        }
      }

      // Provisionar user_profiles (Apenas roles de administradores/owners)
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

        if (profileErr) {
          throw new Error(`Falha ao atualizar user_profiles para ${acc.email}: ${profileErr.message}`);
        }
        console.log(`  └─ ✅ Tabela public.user_profiles provisionada (role: ${acc.role})`);
      } else {
        console.log(`  └─ [DRY-RUN] Planejado upsert em public.user_profiles (role: ${acc.role})`);
      }

      reportSummary.push({
        label: acc.label,
        emailMasked: maskEmail(acc.email),
        authUserId,
        role: acc.role,
        status: actionTaken
      });
    }

    console.log(`\n=====================================================================`);
    console.log(`📊 RESUMO FINAL DO BOOTSTRAP DE PRODUÇÃO (${isDryRun ? 'DRY-RUN' : 'EFETIVO'})`);
    console.log('=====================================================================');
    console.table(reportSummary);

    if (!isDryRun) {
      const credentialsText = `# Dahora Expresso — Relatório Local de Credenciais de Bootstrap Remoto de Produção
# Gerado em: ${new Date().toISOString()}
# ATENÇÃO: NÃO COMMITAR OU COMPARTILHAR ESTE ARQUIVO!

Owner Principal:
- Email: ${accountsToProvision[0].email}

Owner Secundário:
- Email: ${accountsToProvision[1].email}
`;

      const credPath = path.join(projectRoot, 'bootstrap-credentials.local.txt');
      await writeFile(credPath, credentialsText, 'utf8');
      console.log(`\n🔒 Arquivo local de credenciais gerado em: ${credPath}`);
    }

    return { success: true, isDryRun, reportSummary };
  } catch (err) {
    console.error(`\n❌ [ERRO NA EXECUÇÃO] ${err.message}`);

    if (!isDryRun && createdAuthUserIdsToCleanup.length > 0) {
      console.log(`🔄 Iniciando compensação/rollback para ${createdAuthUserIdsToCleanup.length} usuários recém-criados...`);
      for (const uid of createdAuthUserIdsToCleanup) {
        try {
          await adminClient.auth.admin.deleteUser(uid);
          console.log(`  └─ Rollback concluído para Auth User ${uid}`);
        } catch (delErr) {
          console.error(`  └─ Erro ao efetuar rollback para ${uid}: ${delErr.message}`);
        }
      }
    }

    if (!options.isTest) process.exit(1);
    throw err;
  }
}

// Se executado diretamente via CLI
if (process.argv[1] && process.argv[1].endsWith('bootstrap-remote-environment.mjs')) {
  runBootstrap().catch(err => {
    console.error('Falha fatal:', err.message);
    process.exit(1);
  });
}
