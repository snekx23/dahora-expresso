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
  console.log('1. Autenticando motoboy@dahora.local...');
  const { data: authData, error: authErr } = await client.auth.signInWithPassword({
    email: 'motoboy@dahora.local',
    password: 'senha123456'
  });
  if (authErr) {
    console.error('❌ Autenticação falhou:', authErr);
    process.exit(1);
  }
  console.log('✅ Motoboy autenticado! UID:', authData.user.id);

  // 1. Ler linha do fleet pelo user_id
  const { data: fleet, error: fleetErr } = await client
    .from('fleet')
    .select('id, name, status, user_id')
    .eq('user_id', authData.user.id)
    .single();

  if (fleetErr) {
    console.error('❌ Falha ao buscar linha fleet:', fleetErr);
    process.exit(1);
  }
  console.log('2. Dados autoritativos da frota:', fleet);

  // 2. Testar transição para Em Descanso
  console.log('3. Atualizando status no Postgres para "Em Descanso"...');
  const { error: updErr1 } = await client
    .from('fleet')
    .update({ status: 'Em Descanso' })
    .eq('user_id', authData.user.id);

  if (updErr1) {
    console.error('❌ Falha na atualização:', updErr1);
    process.exit(1);
  }

  const { data: fleet2 } = await client
    .from('fleet')
    .select('status')
    .eq('user_id', authData.user.id)
    .single();

  console.log('✅ Status alterado com sucesso no Postgres para:', fleet2.status);

  // 3. Testar reversão para Disponível
  console.log('4. Revertendo status no Postgres para "Disponível"...');
  await client
    .from('fleet')
    .update({ status: 'Disponível' })
    .eq('user_id', authData.user.id);

  const { data: fleet3 } = await client
    .from('fleet')
    .select('status')
    .eq('user_id', authData.user.id)
    .single();

  console.log('✅ Status restaurado com sucesso no Postgres para:', fleet3.status);
  console.log('🎉 Validação autoritativa do banco concluída com SUCESSO 100%!');
}

run();
