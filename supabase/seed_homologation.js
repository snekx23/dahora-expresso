// =====================================================================
// Dahora Expresso — Script de Seed Local Exclusivo
// Arquivo: supabase/seed_homologation.js
// ATENÇÃO: EXCLUSIVO PARA O SUPABASE LOCAL (127.0.0.1:54321 / localhost:54321).
// ESTRITAMENTE BLOQUEADO EM PRODUÇÃO E PROJETOS REMOTOS.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
const appEnv = process.env.APP_ENV || 'local';
const nodeEnv = process.env.NODE_ENV || 'development';
const environmentKind = process.env.ENVIRONMENT_KIND || 'local';
const seedKind = process.env.SEED_ENVIRONMENT_KIND || '';
const seedConfirmation = process.env.SEED_CONFIRMATION || '';
const expectedRef = process.env.EXPECTED_PROJECT_REF || 'local';

// 1. Bloqueio Estrito contra Ambiência Remota ou Produção
if (nodeEnv === 'production' || appEnv === 'production' || environmentKind === 'production' || appEnv === 'remote') {
  throw new Error('ERRO CRÍTICO DE SEGURANÇA: seed_homologation.js NUNCA pode ser executado em ambiente de Produção ou Remoto.');
}

// 2. Trava por Domínio da URL (Permitir exclusivamente localhost ou 127.0.0.1)
const isLocalUrl = supabaseUrl.includes('127.0.0.1') || supabaseUrl.includes('localhost');
if (!isLocalUrl || supabaseUrl.includes('supabase.co')) {
  throw new Error(`ERRO DE SEGURANÇA: URL remota detectada (${supabaseUrl}). seed_homologation.js aceita exclusivamente conexões locais (http://127.0.0.1:54321 ou http://localhost:54321).`);
}

// 3. Validação da Trava de Confirmação Local
if (seedKind !== 'local' || seedConfirmation !== 'SEED_DAHORA_LOCAL_ONLY') {
  throw new Error('ERRO DE CONFIRMAÇÃO: Requer SEED_ENVIRONMENT_KIND=local e SEED_CONFIRMATION=SEED_DAHORA_LOCAL_ONLY.');
}

// 4. Validação de Project Ref
let extractedRef = 'local';
try {
  const parsed = new URL(supabaseUrl);
  extractedRef = parsed.hostname.split('.')[0];
} catch {}

if (expectedRef !== 'local' && expectedRef !== '127.0.0.1' && expectedRef !== 'localhost' && extractedRef !== expectedRef) {
  throw new Error(`ERRO DE PROJECT_REF: Project Ref extraído (${extractedRef}) diverge do esperado (${expectedRef}).`);
}

// 5. Validação da Service Role Key
if (!serviceRoleKey) {
  throw new Error('ERRO DE CREDENCIAL: SUPABASE_SERVICE_ROLE_KEY é obrigatória.');
}

// 6. Inicialização do Cliente Supabase Administrativo
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const TEST_CLIENT_EMAIL = process.env.LOCAL_TEST_CLIENT_EMAIL || 'cliente.teste@local.test';
const TEST_CLIENT_PASS = process.env.LOCAL_TEST_CLIENT_PASS || 'teste123';

async function runSeed() {
  console.log("🚀 Iniciando seed de homologação local para o Cliente Teste...");

  try {
    // Localizar ou criar usuário de teste no Supabase Auth
    let authUserId = null;
    const { data: userList, error: listErr } = await supabase.auth.admin.listUsers();
    if (listErr) throw new Error(`Falha ao listar usuários do Auth: ${listErr.message}`);

    const existingAuthUser = userList.users.find(u => u.email === TEST_CLIENT_EMAIL);

    if (existingAuthUser) {
      authUserId = existingAuthUser.id;
      console.log(`  └─ Usuário Auth existente localizado (UUID: ${authUserId})`);
    } else {
      const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
        email: TEST_CLIENT_EMAIL,
        password: TEST_CLIENT_PASS,
        email_confirm: true,
        user_metadata: { full_name: 'Usuário Teste' }
      });
      if (createErr) throw new Error(`Falha ao criar usuário no Auth: ${createErr.message}`);
      authUserId = newUser.user.id;
      console.log(`  └─ Usuário Auth de teste criado (UUID: ${authUserId})`);
    }

    // Garantir o perfil do usuário em public.user_profiles usando o access_level canônico 'operador'
    const { error: profileErr } = await supabase.from('user_profiles').upsert({
      id: authUserId,
      user_id: authUserId,
      name: 'Usuário Teste',
      email: TEST_CLIENT_EMAIL,
      role: 'client_user',
      access_level: 'operador',
      is_active: true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

    if (profileErr) throw new Error(`Falha ao atualizar user_profiles: ${profileErr.message}`);
    console.log("  └─ Perfil em public.user_profiles configurado com sucesso (access_level: operador).");

    // Localizar ou criar registro em public.commercial_clients
    let clientId = null;
    const { data: existingClient, error: clientSelectErr } = await supabase
      .from('commercial_clients')
      .select('id')
      .eq('email', TEST_CLIENT_EMAIL)
      .maybeSingle();

    if (clientSelectErr) throw new Error(`Falha ao buscar commercial_client: ${clientSelectErr.message}`);

    if (existingClient) {
      clientId = existingClient.id;
      console.log(`  └─ Registro em commercial_clients existente localizado (ID: ${clientId})`);
    } else {
      const { data: newClient, error: clientInsertErr } = await supabase
        .from('commercial_clients')
        .insert({
          client_code: 'CLI-HOMOLOG-001',
          establishment_name: 'Cliente Teste',
          responsible_name: 'Usuário Teste',
          phone: '(11) 99999-0000',
          email: TEST_CLIENT_EMAIL,
          address: 'Av. Teste de Homologação, 100',
          document: '00.000.000/0001-99',
          rider_percentage: 85.00,
          lifecycle_status: 'ativo',
          financial_status: 'em_dia'
        })
        .select('id')
        .single();

      if (clientInsertErr) throw new Error(`Falha ao inserir em commercial_clients: ${clientInsertErr.message}`);
      clientId = newClient.id;
      console.log(`  └─ Registro em commercial_clients criado com sucesso (ID: ${clientId})`);
    }

    // Garantir o vínculo na tabela public.client_users
    const { error: linkErr } = await supabase.from('client_users').upsert({
      client_id: clientId,
      user_id: authUserId,
      role: 'owner',
      status: 'ativo'
    }, { onConflict: 'client_id,user_id' });

    if (linkErr) throw new Error(`Falha ao vincular em client_users: ${linkErr.message}`);

    console.log("  └─ Vínculo em public.client_users configurado com sucesso.");
    console.log("✅ Seed de homologação local concluído com sucesso (Zero dados financeiros ou Teles criadas).");
  } catch (err) {
    console.error("❌ Falha no seed de homologação local:", err.message);
    process.exit(1);
  }
}

runSeed();
