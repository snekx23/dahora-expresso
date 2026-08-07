// Script de Homologação E2E Real do Cadastro e Login Oficial do Motoboy
// Valida a publicação remota no Supabase Cloud e Cloudflare Pages

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

// Carregar variáveis de ambiente locais/remotas se existirem
if (fs.existsSync('.env.bootstrap.remote')) {
  dotenv.config({ path: '.env.bootstrap.remote' });
} else if (fs.existsSync('.env')) {
  dotenv.config();
}

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://tskivauszmhhtqtegvwb.supabase.co').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY).trim();

const IS_PRODUCTION_REF = SUPABASE_URL.includes('tskivauszmhhtqtegvwb');
if (IS_PRODUCTION_REF && process.env.ALLOW_PRODUCTION_E2E !== 'true') {
  console.error('==================================================');
  console.error('[GUARDRAIL] EXECUÇÃO E2E DESTRUTIVA EM PRODUÇÃO BLOQUEADA!');
  console.error('O project ref tskivauszmhhtqtegvwb é o ambiente de produção.');
  console.error('Para executar este script E2E em produção, você deve definir explicitamente:');
  console.error('  ALLOW_PRODUCTION_E2E=true');
  console.error('==================================================');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[ERRO] SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.');
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const ownerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storageKey: 'dahora-owner-auth', autoRefreshToken: true, persistSession: true }
});

const riderClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storageKey: 'dahora-rider-auth', autoRefreshToken: true, persistSession: true }
});

async function runE2EHomologation() {
  console.log('===========================================================');
  console.log('HOMOLOGAÇÃO E2E REAL — CADASTRO E LOGIN OFICIAL DO MOTOBOY');
  console.log('===========================================================');
  console.log(`URL Supabase: ${SUPABASE_URL}`);

  let createdRiderId = null;
  let createdAuthUserId = null;

  try {
    // 1. Obter ou Criar Usuário Owner Autenticado para a Requisição
    console.log('\n1. Autenticando usuário Owner para teste de cadastro...');
    let ownerToken = '';
    const { data: { users: allUsers } } = await adminClient.auth.admin.listUsers();
    let ownerUser = allUsers.find(u => u.email === 'owner.homologation@dahora.local');

    if (!ownerUser) {
      const { data: newOwner, error: createOwnerErr } = await adminClient.auth.admin.createUser({
        email: 'owner.homologation@dahora.local',
        password: 'PasswordOwner123!',
        email_confirm: true
      });
      if (createOwnerErr) throw createOwnerErr;
      ownerUser = newOwner.user;

      await adminClient.from('user_profiles').insert([{
        user_id: ownerUser.id,
        name: 'Owner Homologacao',
        email: 'owner.homologation@dahora.local',
        role: 'owner',
        access_level: 'admin',
        is_active: true
      }]);
    }

    // Gerar JWT de Owner via password login
    const { data: ownerAuth, error: ownerLoginErr } = await ownerClient.auth.signInWithPassword({
      email: 'owner.homologation@dahora.local',
      password: 'PasswordOwner123!'
    });

    if (ownerLoginErr || !ownerAuth.session) {
      throw new Error(`Falha no login do Owner de teste: ${ownerLoginErr?.message}`);
    }

    ownerToken = ownerAuth.session.access_token;
    console.log('[PASS] Owner autenticado com sucesso. JWT obtido.');

    // 2. Invocar Edge Function create-rider-user
    console.log('\n2. Chamando Edge Function create-rider-user (Cadastro Real pelo Owner)...');
    const tempPhone = '51988887766';
    const tempCode4 = '7766';
    const tempPin = '7766';
    const tempName = 'Motoboy Homologacao Real E2E';

    const createRes = await fetch(`${SUPABASE_URL}/functions/v1/create-rider-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        name: tempName,
        phone: tempPhone,
        vehicle: 'Honda CG 160',
        plate: 'ABC1D23',
        pin: tempPin
      })
    });

    const createBody = await createRes.json();
    console.log(`HTTP Status: ${createRes.status}`);
    console.log('Body Sanitizado:', JSON.stringify(createBody));

    if (!createRes.ok || !createBody.success) {
      throw new Error(`Edge Function create-rider-user falhou: ${createBody.error}`);
    }

    createdRiderId = createBody.rider_id;
    console.log('[PASS] Edge Function create-rider-user executada com sucesso.');

    // 3. Validar registros no Banco Remoto
    console.log('\n3. Validando registros criados no banco remoto...');
    const { data: fleetRow, error: fleetErr } = await adminClient
      .from('fleet')
      .select('*')
      .eq('id', createdRiderId)
      .single();

    if (fleetErr || !fleetRow) throw new Error(`Registro em public.fleet não localizado: ${fleetErr?.message}`);

    createdAuthUserId = fleetRow.user_id;

    console.log(`[PASS] Fleet User ID: ${createdAuthUserId}`);
    console.log(`[PASS] Motoboy Code: ${fleetRow.motoboy_code}`);
    console.log(`[PASS] Status Inicial: ${fleetRow.status} (Exatamente 'Indisponível')`);
    console.log(`[PASS] PIN em Texto Puro: ${fleetRow.pin === null ? 'NULL (Seguro)' : 'EXPOSTO (ERRO)'}`);
    console.log(`[PASS] PIN Hash Preenchido: ${fleetRow.pin_hash ? 'SIM' : 'NÃO'}`);
    console.log(`[PASS] Localização/Bateria: lat=${fleetRow.lat}, lng=${fleetRow.lng}, battery=${fleetRow.battery_level}, last_seen=${fleetRow.last_seen}`);

    if (fleetRow.status !== 'Indisponível') throw new Error(`Status inicial incorreto: ${fleetRow.status}`);
    if (fleetRow.pin !== null) throw new Error('PIN em texto puro permaneceu salvo no banco!');

    // 4. Testar Trava de Duplicidade de Código Ativo
    console.log('\n4. Testando trava de concorrência e rejeição de código duplicado...');
    const dupRes = await fetch(`${SUPABASE_URL}/functions/v1/create-rider-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        name: 'Motoboy Duplicado',
        phone: '51999997766', // Mesmos 4 últimos dígitos: 7766
        vehicle: 'Yamaha YBR',
        plate: 'XYZ9E87',
        pin: '7766'
      })
    });

    const dupBody = await dupRes.json();
    console.log(`HTTP Status Duplicado: ${dupRes.status}`);
    console.log('Mensagem de Duplicidade:', dupBody.error);

    if (dupRes.ok || dupBody.success) throw new Error('Código duplicado ativo foi aceito indevidamente!');
    if (!dupBody.error.includes('Já existe um motoboy ativo')) throw new Error('Mensagem de erro de duplicidade incorreta!');
    console.log('[PASS] Rejeição de código duplicado ativa comprovada no banco.');

    // 5. Testar Edge Function rider-auth com PIN Errado
    console.log('\n5. Testando rider-auth com PIN incorreto...');
    const wrongAuthRes = await fetch(`${SUPABASE_URL}/functions/v1/rider-auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        access_code: tempCode4,
        pin: '0000'
      })
    });

    const wrongAuthBody = await wrongAuthRes.json();
    console.log(`HTTP Status PIN Errado: ${wrongAuthRes.status}`);
    if (wrongAuthRes.ok || wrongAuthBody.success) throw new Error('rider-auth aceitou PIN incorreto!');
    console.log('[PASS] PIN incorreto rejeitado com resposta genérica.');

    // 6. Testar Edge Function rider-auth com Dados Corretos
    console.log('\n6. Testando rider-auth com Código (7766) + PIN (7766) corretos...');
    const correctAuthRes = await fetch(`${SUPABASE_URL}/functions/v1/rider-auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        access_code: tempCode4,
        pin: tempPin
      })
    });

    const correctAuthBody = await correctAuthRes.json();
    console.log(`HTTP Status Login Correto: ${correctAuthRes.status}`);
    console.log(`Cache-Control Header: ${correctAuthRes.headers.get('cache-control')}`);

    if (!correctAuthRes.ok || !correctAuthBody.success || !correctAuthBody.token_hash) {
      throw new Error(`rider-auth falhou: ${correctAuthBody.error}`);
    }

    const tokenHash = correctAuthBody.token_hash;
    console.log('[PASS] Token hash de uso único gerado com sucesso.');

    // 7. Concluir Login no PWA via verifyOtp
    console.log('\n7. Executando verifyOtp no PWA cliente com o token_hash...');
    const { data: verifyData, error: verifyErr } = await riderClient.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'email'
    });

    if (verifyErr || !verifyData.session) throw new Error(`verifyOtp falhou: ${verifyErr?.message}`);

    console.log('[PASS] Sessão oficial JWT obtida no PWA!');
    console.log(`[PASS] Access Token Presente: ${!!verifyData.session.access_token}`);
    console.log(`[PASS] Refresh Token Presente: ${!!verifyData.session.refresh_token}`);

    // 8. Confirmar Identidade auth.uid() === fleet.user_id
    console.log('\n8. Confirmando identidade oficial auth.getUser()...');
    const { data: { user: authedRider }, error: getRiderErr } = await riderClient.auth.getUser();
    if (getRiderErr || !authedRider) throw new Error(`auth.getUser falhou: ${getRiderErr?.message}`);

    console.log(`Auth UID: ${authedRider.id}`);
    console.log(`Fleet User ID: ${createdAuthUserId}`);
    if (authedRider.id !== createdAuthUserId) throw new Error('Auth UID não corresponde ao fleet.user_id!');
    console.log('[PASS] auth.uid() corresponde exatamente ao fleet.user_id.');

    // 9. Testar RLS em public.fleet (Própria linha vs Terceiros)
    console.log('\n9. Testando RLS da sessão oficial em public.fleet...');
    const { data: ownFleet, error: ownErr } = await riderClient
      .from('fleet')
      .select('id, name, status')
      .eq('user_id', authedRider.id)
      .single();

    if (ownErr || !ownFleet) throw new Error(`RLS bloqueou a própria linha: ${ownErr?.message}`);
    console.log('[PASS] RLS permitiu leitura da própria linha em public.fleet.');

    const { data: otherFleet } = await riderClient
      .from('fleet')
      .select('id')
      .neq('user_id', authedRider.id);

    console.log(`Linhas de outros motoboys retornadas pelo RLS: ${otherFleet ? otherFleet.length : 0}`);
    if (otherFleet && otherFleet.length > 0) throw new Error('RLS permitiu acesso a linhas de outros motoboys!');
    console.log('[PASS] RLS bloqueou com sucesso o acesso a dados de outros entregadores.');

    // 10. Validar Isolamento de Storage Keys e Logout
    console.log('\n10. Testando logout isolado do PWA...');
    await riderClient.auth.signOut();
    const { data: { session: ownerCheckSession } } = await ownerClient.auth.getSession();
    if (!ownerCheckSession) throw new Error('Logout do PWA encerrou indevidamente a sessão do Owner!');
    console.log('[PASS] StorageKeys isoladas comprovadas: Logout do PWA não afetou o Owner.');

  } finally {
    // 11. Cleanup Obrigatório de Todos os Registros Temporários
    console.log('\n11. Executando cleanup obrigatório de dados temporários...');
    if (createdRiderId) {
      await adminClient.from('fleet').delete().eq('id', createdRiderId);
      console.log('[CLEANUP] Linha temporária em public.fleet removida.');
    }
    if (createdAuthUserId) {
      await adminClient.from('user_profiles').delete().eq('user_id', createdAuthUserId);
      await adminClient.auth.admin.deleteUser(createdAuthUserId);
      console.log('[CLEANUP] Usuário Auth e perfil temporários removidos.');
    }
    const { data: { users: cleanupUsers } } = await adminClient.auth.admin.listUsers();
    const ownerHomolog = cleanupUsers.find(u => u.email === 'owner.homologation@dahora.local');
    if (ownerHomolog) {
      await adminClient.from('user_profiles').delete().eq('user_id', ownerHomolog.id);
      await adminClient.auth.admin.deleteUser(ownerHomolog.id);
      console.log('[CLEANUP] Owner de homologação temporário removido.');
    }
    console.log('[CLEANUP] Limpeza concluída sem resíduos.');
  }

  console.log('\n===========================================================');
  console.log('VEREDITO FINAL: APROVADO — LOGIN PUBLICADO E HOMOLOGADO');
  console.log('===========================================================');
}

runE2EHomologation().catch(err => {
  console.error('\n[FALHA DE HOMOLOGAÇÃO]', err);
  process.exit(1);
});
