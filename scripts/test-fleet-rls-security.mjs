import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.bootstrap.remote' });

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const key = process.env.SUPABASE_ANON_KEY;

if (!key) {
  throw new Error('SUPABASE_ANON_KEY é obrigatória.');
}

const client = createClient(url, key);

async function run() {
  console.log('🔒 Auditoria e Testes Rigorosos de RLS na tabela public.fleet...');

  // Authenticate as Motoboy (Guilherme Motoboy, user_id: 7668596b-0444-4435-9f0c-8d0ad7ce7fb8)
  const { data: authData, error: authErr } = await client.auth.signInWithPassword({
    email: 'motoboy@dahora.local',
    password: 'senha123456'
  });
  if (authErr) {
    console.error('❌ Autenticação do Motoboy falhou:', authErr);
    process.exit(1);
  }
  const myUid = authData.user.id;
  console.log('✅ Motoboy autenticado com SUCESSO. auth.uid():', myUid);

  // TEST 1: Motoboy altera a própria linha
  console.log('\n--- TESTE 1: Motoboy atualiza seu próprio status em public.fleet ---');
  const { data: res1, error: err1 } = await client
    .from('fleet')
    .update({ status: 'Em Descanso' })
    .eq('user_id', myUid)
    .select('id, name, status, user_id');

  if (err1 || !res1 || res1.length === 0) {
    console.error('❌ TESTE 1 FALHOU:', err1 || 'Nenhuma linha retornada');
    process.exit(1);
  }
  console.log('✅ TESTE 1 PASSOU! Linha própria atualizada:', res1[0]);

  // TEST 2: Motoboy tenta alterar a linha de OUTRO usuário (João Entregador, id: f2222222-2222-4222-a222-222222222222)
  console.log('\n--- TESTE 2: Motoboy tenta alterar linha de outro motoboy (f2222222-2222-4222-a222-222222222222) ---');
  const { data: res2, error: err2 } = await client
    .from('fleet')
    .update({ status: 'Bloqueado' })
    .eq('id', 'f2222222-2222-4222-a222-222222222222')
    .select();

  if (err2) {
    console.log('✅ TESTE 2 PASSOU! Atualização de linha alheia foi bloqueada com erro Postgres RLS:', err2.message);
  } else if (!res2 || res2.length === 0) {
    console.log('✅ TESTE 2 PASSOU! RLS filtrou a operação e 0 linhas foram afetadas.');
  } else {
    console.error('❌ TESTE 2 FALHOU! Motoboy conseguiu alterar linha de outro usuário:', res2);
    process.exit(1);
  }

  // TEST 3: Motoboy tenta alterar o user_id da própria linha para se passar por Admin
  console.log('\n--- TESTE 3: Motoboy tenta alterar user_id da própria linha (usurpação de UID) ---');
  const { data: res3, error: err3 } = await client
    .from('fleet')
    .update({ user_id: '14620da0-6e08-488f-95ff-26f751785870' })
    .eq('user_id', myUid)
    .select();

  if (err3) {
    console.log('✅ TESTE 3 PASSOU! Alteração de user_id foi bloqueada pela cláusula WITH CHECK:', err3.message);
  } else if (!res3 || res3.length === 0) {
    console.log('✅ TESTE 3 PASSOU! Cláusula WITH CHECK (user_id = auth.uid()) rejeitou a linha alterada.');
  } else {
    console.error('❌ TESTE 3 FALHOU! Motoboy conseguiu alterar o user_id da própria linha:', res3);
    process.exit(1);
  }

  // Reverter status para 'Disponível'
  await client.from('fleet').update({ status: 'Disponível' }).eq('user_id', myUid);
  console.log('\n🎉 TODOS OS 3 TESTES DE SEGURANÇA E RLS EM public.fleet FORAM APROVADOS COM SUCESSO (100%)!');
}

run();
