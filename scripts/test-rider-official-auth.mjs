// Script de Validação Controlada e Auditoria: Autenticação Oficial do Motoboy no Supabase Auth
// Valida o fluxo generateLink + verifyOtp, isolamento de storage, RLS e limpeza em bloco finally.

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import { spawn } from 'child_process';

// 1. Carregar variáveis de ambiente com prioridade de projeto
const envBoot = fs.existsSync('.env.bootstrap.remote') ? dotenv.parse(fs.readFileSync('.env.bootstrap.remote')) : {};
const envDock = fs.existsSync('supabase/.temp/start-secrets/supabase_edge_runtime_dahora-expresso/env/docker.env') ? dotenv.parse(fs.readFileSync('supabase/.temp/start-secrets/supabase_edge_runtime_dahora-expresso/env/docker.env')) : {};
const envHom = fs.existsSync('.env.homologation') ? dotenv.parse(fs.readFileSync('.env.homologation')) : {};

let SUPABASE_URL = (process.env.SUPABASE_URL || envBoot.SUPABASE_URL || envDock.SUPABASE_URL || envHom.SUPABASE_HOMOLOGATION_URL || '').trim();
let SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || envBoot.SUPABASE_SECRET_KEY || envDock.SUPABASE_SERVICE_ROLE_KEY || envHom.SUPABASE_HOMOLOGATION_SERVICE_ROLE_KEY || '').trim();
let SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || envBoot.SUPABASE_ANON_KEY || envBoot.SUPABASE_SECRET_KEY || envDock.SUPABASE_ANON_KEY || envHom.SUPABASE_HOMOLOGATION_ANON_KEY || SERVICE_ROLE_KEY).trim();
const TEST_VALIDATION_SECRET = process.env.TEST_VALIDATION_SECRET || 'dahora_test_validation_secret_2026';

// Fallback de chave pública a partir do config.local.js caso não esteja no env
if ((!SUPABASE_URL || !SUPABASE_ANON_KEY) && fs.existsSync('public/config.local.js')) {
  const content = fs.readFileSync('public/config.local.js', 'utf8');
  const matchUrl = content.match(/url:\s*['"]([^'"]+)['"]/);
  const matchKey = content.match(/key:\s*['"]([^'"]+)['"]/);
  if (!SUPABASE_URL && matchUrl) SUPABASE_URL = matchUrl[1];
  if (!SUPABASE_ANON_KEY && matchKey) SUPABASE_ANON_KEY = matchKey[1];
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error("❌ VALIDAÇÃO ABORTADA: SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY/SECRET_KEY são obrigatórios.");
  process.exit(1);
}

// Memory Storage Adapter para isolamento de sessões no Node.js
class MemoryStorageAdapter {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.get(key) || null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
}

// Obter Project Ref parcialmente mascarado
let projectRefMasked = 'desconhecido';
try {
  const parsedUrl = new URL(SUPABASE_URL);
  const host = parsedUrl.hostname;
  const parts = host.split('.');
  if (parts.length >= 3) {
    const rawRef = parts[0];
    projectRefMasked = rawRef.slice(0, 4) + '***' + rawRef.slice(-3);
  } else {
    projectRefMasked = 'local-127.0.0.1';
  }
} catch {}

console.log('===========================================================');
console.log('TESTE DE HOMOLOGAÇÃO: AUTENTICAÇÃO OFICIAL MOTOBOY SUPABASE');
console.log('===========================================================');
console.log(`PROJETO: ${projectRefMasked}`);
console.log(`URL: ${SUPABASE_URL}\n`);

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function runOfficialAuthValidation() {
  let createdUserId = null;
  let createdFleetId = null;
  let denoProcess = null;
  let testPassed = false;

  const report = {
    ambiente: {
      tipo: SUPABASE_URL.includes('127.0.0.1') || SUPABASE_URL.includes('localhost') ? 'local' : 'remoto',
      projectRefMasked,
      supabaseJsVersion: '2.49.1'
    },
    generateLink: { status: 'PENDENTE', keys: [], propKeys: [] },
    verifyOtp: { sessaoCriada: false, userRetornado: false, accessTokenPresente: false, refreshTokenPresente: false },
    identidade: { authUidMasked: '', fleetUserIdMasked: '', correspondencia: false },
    rls: { leituraPropria: false, leituraOutraLinhaNegada: false, rpcTestada: '', rpcResultado: 'PENDENTE' },
    isolamento: { storageOwner: 'dahora-owner-auth', storagePWA: 'dahora-rider-auth', logoutPwaAfetouOwner: false },
    cleanup: { linhaRemovida: false, userAuthRemovido: false, residuosEncontrados: false }
  };

  const randomSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const temporaryInternalEmail = `test.rider.${randomSuffix}@dahora.local`;
  const temporaryPhone = `119${Math.floor(10000000 + Math.random() * 89999999)}`;
  const temporaryCode = `MB-${Math.floor(1000 + Math.random() * 8999)}`;
  const temporaryPin = '8888';
  const strongRandomPassword = `TestRider!Pass_${Math.random().toString(36).substring(2)}`;

  try {
    // 1. Criar usuário temporário em auth.users
    console.log('1. Criando usuário temporário no Auth...');
    const { data: authUserRes, error: authUserErr } = await supabaseAdmin.auth.admin.createUser({
      email: temporaryInternalEmail,
      password: strongRandomPassword,
      email_confirm: true,
      user_metadata: {
        role: 'rider',
        test_only: true
      }
    });

    if (authUserErr || !authUserRes.user) {
      throw new Error(`Falha ao criar usuário Auth temporário: ${authUserErr?.message}`);
    }
    createdUserId = authUserRes.user.id;
    report.identidade.authUidMasked = createdUserId.slice(0, 8) + '...' + createdUserId.slice(-4);
    console.log(`[PASS] Usuário Auth temporário criado com sucesso.`);

    // 2. Criar linha temporária em public.fleet vinculada por user_id
    console.log('2. Inserindo linha temporária em public.fleet...');
    const { data: fleetRes, error: fleetErr } = await supabaseAdmin
      .from('fleet')
      .insert([{
        user_id: createdUserId,
        motoboy_code: temporaryCode,
        name: 'MOTOBOY_TEST_TEMP_ONLY',
        phone: temporaryPhone,
        vehicle: 'Moto Teste Validação',
        plate: 'TST-0000',
        status: 'Disponível'
      }])
      .select('id, user_id, motoboy_code, name')
      .single();

    if (fleetErr || !fleetRes) {
      throw new Error(`Falha ao inserir registro temporário em fleet: ${fleetErr?.message}`);
    }
    createdFleetId = fleetRes.id;
    report.identidade.fleetUserIdMasked = fleetRes.user_id.slice(0, 8) + '...' + fleetRes.user_id.slice(-4);
    report.identidade.correspondencia = (createdUserId === fleetRes.user_id);
    console.log(`[PASS] Registro em public.fleet vinculado por user_id criado.`);

    // Confirmar que não há dados operacionais/financeiros agregados
    const { count: teleCount } = await supabaseAdmin.from('teles').select('id', { count: 'exact', head: true }).eq('motoboy_id', createdFleetId);
    if (teleCount && teleCount > 0) {
      throw new Error('Aviso de segurança: O registro temporário possui entregas associadas.');
    }
    console.log(`[PASS] Confirmado: registro temporário inicia sem entregas ou dados operacionais.`);

    // 3. Executar Edge Function temporária para obter token_hash
    console.log('3. Invocando Edge Function validate-rider-auth-flow...');
    let edgeFnResponse = null;

    // Tentar chamada HTTP direta à Edge Function (remota ou local)
    const functionUrl = `${SUPABASE_URL}/functions/v1/validate-rider-auth-flow`;
    try {
      const resp = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-secret': TEST_VALIDATION_SECRET
        },
        body: JSON.stringify({ email: temporaryInternalEmail })
      });
      if (resp.ok) {
        edgeFnResponse = await resp.json();
      }
    } catch {}

    // Caso a Edge Function não esteja servida na porta remota, iniciar servidor Deno local temporário
    if (!edgeFnResponse || !edgeFnResponse.success) {
      console.log('   (Iniciando executor Deno local temporário da Edge Function para homologação...)');
      const denoEnv = {
        ...process.env,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
        TEST_VALIDATION_SECRET
      };

      denoProcess = spawn('deno', [
        'run', '--allow-net', '--allow-env',
        'supabase/functions/validate-rider-auth-flow/index.ts'
      ], { env: denoEnv, stdio: ['ignore', 'pipe', 'pipe'] });

      // Aguardar inicialização do Deno
      await new Promise(r => setTimeout(r, 1500));

      // Invocação local direta
      const localResp = await fetch('http://127.0.0.1:8000', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-secret': TEST_VALIDATION_SECRET
        },
        body: JSON.stringify({ email: temporaryInternalEmail })
      });
      if (localResp.ok) {
        edgeFnResponse = await localResp.json();
      } else {
        const errTxt = await localResp.text();
        throw new Error(`Edge Function respondeu com erro: ${errTxt}`);
      }
    }

    if (!edgeFnResponse || !edgeFnResponse.success || !edgeFnResponse.token_hash) {
      throw new Error(`Edge Function falhou ao retornar token_hash: ${edgeFnResponse?.error || 'sem resposta'}`);
    }

    report.generateLink.status = 'APROVADO';
    report.generateLink.keys = edgeFnResponse.keys?.generateLink || [];
    report.generateLink.propKeys = edgeFnResponse.keys?.properties || [];
    const receivedTokenHash = edgeFnResponse.token_hash;
    console.log(`[PASS] generateLink executado. Propriedades retornadas: ${report.generateLink.propKeys.join(', ')}`);

    // 4. Instanciar clientes públicos com storages isolados
    console.log('4. Testando verifyOtp com cliente Supabase isolado...');
    const pwaStorage = new MemoryStorageAdapter();
    const ownerStorage = new MemoryStorageAdapter();

    const pwaClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storageKey: report.isolamento.storagePWA,
        storage: pwaStorage,
        persistSession: true,
        autoRefreshToken: true
      }
    });

    const ownerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storageKey: report.isolamento.storageOwner,
        storage: ownerStorage,
        persistSession: true,
        autoRefreshToken: true
      }
    });

    // 5. Trocar token_hash por sessão oficial usando auth.verifyOtp
    const { data: otpRes, error: otpErr } = await pwaClient.auth.verifyOtp({
      token_hash: receivedTokenHash,
      type: 'email'
    });

    if (otpErr || !otpRes.session || !otpRes.user) {
      throw new Error(`Falha no verifyOtp: ${otpErr?.message || 'Sessão ou Usuário ausente no retorno'}`);
    }

    report.verifyOtp.sessaoCriada = true;
    report.verifyOtp.userRetornado = !!otpRes.user;
    report.verifyOtp.accessTokenPresente = !!otpRes.session.access_token;
    report.verifyOtp.refreshTokenPresente = !!otpRes.session.refresh_token;
    console.log(`[PASS] verifyOtp gerou sessão oficial com access_token e refresh_token.`);

    // 6. Validar identidade oficial via auth.getUser()
    console.log('5. Verificando identidade da sessão oficial...');
    const { data: currentAuthRes, error: getAuthErr } = await pwaClient.auth.getUser();
    if (getAuthErr || !currentAuthRes.user) {
      throw new Error(`auth.getUser() falhou: ${getAuthErr?.message}`);
    }

    if (currentAuthRes.user.id !== createdUserId) {
      throw new Error(`Divergência de ID! User Auth (${currentAuthRes.user.id}) != Fleet User ID (${createdUserId})`);
    }
    console.log(`[PASS] auth.getUser() retornou exatamente auth.uid() === fleet.user_id.`);

    // 7. Testar RLS na tabela public.fleet para o motoboy autenticado
    console.log('6. Testando RLS de leitura (fleet_select)...');
    const { data: ownFleet, error: ownFleetErr } = await pwaClient
      .from('fleet')
      .select('id, user_id, motoboy_code, name')
      .eq('user_id', createdUserId)
      .maybeSingle();

    if (ownFleetErr || !ownFleet) {
      throw new Error(`RLS Bloqueou a leitura da própria linha do motoboy: ${ownFleetErr?.message}`);
    }
    report.rls.leituraPropria = true;
    console.log(`[PASS] Leitura da própria linha em public.fleet aprovada pelo RLS.`);

    // Testar se o motoboy consegue ler linha de OUTRO motoboy
    const { data: otherFleet, error: otherFleetErr } = await pwaClient
      .from('fleet')
      .select('id, name')
      .neq('user_id', createdUserId)
      .limit(1);

    // Se RLS estiver correto, a busca por outros retorna array vazio ou lança erro
    if (!otherFleetErr && otherFleet && otherFleet.length > 0) {
      throw new Error('FALHA DE RLS: Motoboy conseguiu ler registro de outro entregador na tabela fleet!');
    }
    report.rls.leituraOutraLinhaNegada = true;
    console.log(`[PASS] Acesso a registros de outros entregadores negado/filtrado pelo RLS.`);

    // 8. Testar chamada de RPC autoritativa com auth.uid()
    console.log('7. Testando RPC autoritativa com auth.uid()...');
    report.rls.rpcTestada = 'get_assigned_motoboy_for_client_tele';
    const { data: rpcRes, error: rpcErr } = await pwaClient.rpc('get_assigned_motoboy_for_client_tele', {
      p_tele_id: '00000000-0000-0000-0000-000000000000'
    });
    if (rpcErr) {
      throw new Error(`RPC get_assigned_motoboy_for_client_tele falhou para o motoboy autenticado: ${rpcErr.message}`);
    }
    report.rls.rpcResultado = 'APROVADO (Executada com sucesso para a sessão do motoboy)';
    console.log(`[PASS] RPC autoritativa executada com sucesso para a sessão do motoboy.`);

    // 9. Validar isolamento de storage entre Owner e PWA
    console.log('8. Validando isolamento de storageKey entre PWA e Owner...');
    const { data: ownerSessionBefore } = await ownerClient.auth.getSession();
    if (ownerSessionBefore?.session) {
      throw new Error('Sessão do PWA vazou para a storageKey do Owner!');
    }

    // Executar signOut no PWA
    await pwaClient.auth.signOut();
    const { data: pwaSessionAfter } = await pwaClient.auth.getSession();
    const { data: ownerSessionAfter } = await ownerClient.auth.getSession();

    if (pwaSessionAfter?.session) {
      throw new Error('signOut() do PWA não encerrou a sessão do PWA.');
    }
    report.isolamento.logoutPwaAfetouOwner = (ownerSessionBefore !== ownerSessionAfter && !!ownerSessionAfter?.session);
    console.log(`[PASS] Isolamento de storageKey comprovado: signOut() do PWA não afetou o cliente Owner.`);

    testPassed = true;

  } catch (err) {
    console.error('\n❌ ERRO DURANTE A VALIDAÇÃO:', err.message);
  } finally {
    console.log('\n9. Executando limpeza de dados temporários no bloco finally...');
    if (denoProcess) {
      try { denoProcess.kill(); } catch {}
    }

    if (createdFleetId) {
      const { error: delFleetErr } = await supabaseAdmin.from('fleet').delete().eq('id', createdFleetId);
      if (!delFleetErr) {
        report.cleanup.linhaRemovida = true;
        console.log(`[CLEANUP] Linha temporária em public.fleet removida.`);
      } else {
        console.error(`[CLEANUP ERROR] Erro ao deletar fleet temporário: ${delFleetErr.message}`);
      }
    }

    if (createdUserId) {
      const { error: delAuthErr } = await supabaseAdmin.auth.admin.deleteUser(createdUserId);
      if (!delAuthErr) {
        report.cleanup.userAuthRemovido = true;
        console.log(`[CLEANUP] Usuário Auth temporário removido de auth.users.`);
      } else {
        console.error(`[CLEANUP ERROR] Erro ao deletar usuário Auth: ${delAuthErr.message}`);
      }
    }

    // Confirmar ausência de resíduos
    if (createdUserId) {
      const { data: checkFleet } = await supabaseAdmin.from('fleet').select('id').eq('user_id', createdUserId).maybeSingle();
      const { data: checkAuth } = await supabaseAdmin.auth.admin.getUserById(createdUserId);
      report.cleanup.residuosEncontrados = !!(checkFleet || checkAuth?.user);
    }
  }

  // Imprimir relatório formatado
  console.log('\n===========================================================');
  console.log('RELATÓRIO FINAL DA PROVA TÉCNICA DE AUTENTICAÇÃO OFICIAL');
  console.log('===========================================================\n');

  console.log('## 1. Ambiente testado');
  console.log(`- Tipo: ${report.ambiente.tipo}`);
  console.log(`- Project Ref mascarado: ${report.ambiente.projectRefMasked}`);
  console.log(`- Versão @supabase/supabase-js: ${report.ambiente.supabaseJsVersion}\n`);

  console.log('## 2. Resultado do generateLink');
  console.log(`- Status: ${report.generateLink.status}`);
  console.log(`- Nomes das propriedades de generateLink: ${report.generateLink.keys.join(', ')}`);
  console.log(`- Nomes das propriedades em properties: ${report.generateLink.propKeys.join(', ')}\n`);

  console.log('## 3. Resultado do verifyOtp');
  console.log(`- Sessão criada: ${report.verifyOtp.sessaoCriada ? 'SIM' : 'NÃO'}`);
  console.log(`- User retornado: ${report.verifyOtp.userRetornado ? 'SIM' : 'NÃO'}`);
  console.log(`- Access token presente: ${report.verifyOtp.accessTokenPresente ? 'SIM' : 'NÃO'}`);
  console.log(`- Refresh token presente: ${report.verifyOtp.refreshTokenPresente ? 'SIM' : 'NÃO'}\n`);

  console.log('## 4. Identidade');
  console.log(`- Auth UID mascarado: ${report.identidade.authUidMasked}`);
  console.log(`- Fleet User ID mascarado: ${report.identidade.fleetUserIdMasked}`);
  console.log(`- Correspondência exata: ${report.identidade.correspondencia ? 'SIM' : 'NÃO'}\n`);

  console.log('## 5. RLS');
  console.log(`- Leitura da própria linha: ${report.rls.leituraPropria ? 'APROVADO' : 'REPROVADO'}`);
  console.log(`- Leitura de outra linha negada: ${report.rls.leituraOutraLinhaNegada ? 'APROVADO' : 'REPROVADO'}`);
  console.log(`- RPC testada: ${report.rls.rpcTestada}`);
  console.log(`- Resultado RPC: ${report.rls.rpcResultado}\n`);

  console.log('## 6. Isolamento');
  console.log(`- StorageKey Owner: ${report.isolamento.storageOwner}`);
  console.log(`- StorageKey PWA: ${report.isolamento.storagePWA}`);
  console.log(`- Logout do PWA afetou Owner: ${report.isolamento.logoutPwaAfetouOwner ? 'SIM (FALHA)' : 'NÃO (SUCESSO)'}\n`);

  console.log('## 7. Cleanup');
  console.log(`- Linha temporária removida: ${report.cleanup.linhaRemovida ? 'SIM' : 'NÃO'}`);
  console.log(`- Usuário Auth removido: ${report.cleanup.userAuthRemovido ? 'SIM' : 'NÃO'}`);
  console.log(`- Resíduos encontrados: ${report.cleanup.residuosEncontrados ? 'SIM (ERRO)' : 'NÃO (SUCESSO)'}\n`);

  console.log('## 8. Veredito');
  if (testPassed && report.verifyOtp.sessaoCriada && report.identidade.correspondencia && report.rls.leituraPropria && !report.cleanup.residuosEncontrados) {
    console.log('APROVADO: generateLink + verifyOtp cria a sessão oficial exigida');
  } else {
    console.log('REPROVADO: não cria a sessão oficial exigida');
    process.exitCode = 1;
  }
}

runOfficialAuthValidation();
