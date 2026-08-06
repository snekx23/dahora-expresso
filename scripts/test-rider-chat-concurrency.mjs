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
  console.log('🚀 Testando RPC de Chat Operacional Direto e Concorrência...');

  // Authenticate Motoboy
  const { data: authData, error: authErr } = await client.auth.signInWithPassword({
    email: 'motoboy@dahora.local',
    password: 'senha123456'
  });
  if (authErr) {
    console.error('❌ Autenticação falhou:', authErr);
    process.exit(1);
  }
  console.log('✅ Motoboy autenticado! UID:', authData.user.id);

  // TEST 1: Chamadas concorrentes paralelas simultâneas (Promise.all)
  console.log('\n--- TESTE 1: Chamadas Concorrentes Simultâneas (Promise.all) ---');
  const [res1, res2] = await Promise.all([
    client.rpc('get_or_create_my_active_rider_chat'),
    client.rpc('get_or_create_my_active_rider_chat')
  ]);

  if (res1.error || res2.error) {
    console.error('❌ Erro na RPC concorrente:', res1.error || res2.error);
    process.exit(1);
  }

  const ticket1 = res1.data.ticket_id;
  const ticket2 = res2.data.ticket_id;

  console.log(`RPC 1 Ticket ID: ${ticket1}`);
  console.log(`RPC 2 Ticket ID: ${ticket2}`);

  if (ticket1 !== ticket2) {
    console.error('❌ FALHA DE CONCORRÊNCIA! As chamadas criaram tickets diferentes!');
    process.exit(1);
  }
  console.log('✅ SUCESSO! Ambas as chamadas simultâneas retornaram exatamente o MESMO ticket_id por causa do lock FOR UPDATE.');

  // TEST 2: Enviar mensagem do motoboy usando reply_my_rider_support_ticket
  console.log('\n--- TESTE 2: Enviar mensagem do motoboy via RPC oficial ---');
  const { data: sendRes, error: sendErr } = await client.rpc('reply_my_rider_support_ticket', {
    p_ticket_id: ticket1,
    p_message: 'Olá suporte, preciso de auxílio no meu trajeto!'
  });

  if (sendErr || !sendRes?.success) {
    console.error('❌ Envio de mensagem falhou:', sendErr || sendRes);
    process.exit(1);
  }
  console.log('✅ Envio de mensagem do motoboy com SUCESSO!');

  // TEST 3: Admin cria nota interna e motoboy busca histórico via get_my_rider_support_ticket
  console.log('\n--- TESTE 3: Admin cria nota interna e validação de ocultação ---');
  const adminClient = createClient(url, key);
  await adminClient.auth.signInWithPassword({ email: 'admin@dahora.local', password: 'senha123456' });

  // Admin insere nota interna
  await adminClient.rpc('reply_admin_support_ticket', {
    p_ticket_id: ticket1,
    p_message_text: '[NOTA INTERNA PRIVADA DE TESTE AUDITADA]',
    p_is_internal: true
  });

  // Admin insere resposta pública
  await adminClient.rpc('reply_admin_support_ticket', {
    p_ticket_id: ticket1,
    p_message_text: 'Olá motoboy! Estamos acompanhando sua rota.',
    p_is_internal: false
  });

  // Motoboy busca histórico via get_my_rider_support_ticket
  const { data: historyRes, error: histErr } = await client.rpc('get_my_rider_support_ticket', {
    p_ticket_id: ticket1
  });

  if (histErr || !historyRes?.success) {
    console.error('❌ Busca de histórico falhou:', histErr || historyRes);
    process.exit(1);
  }

  const messages = historyRes.ticket?.messages || [];
  const foundInternal = messages.some(m => m.text && m.text.includes('NOTA INTERNA PRIVADA'));

  if (foundInternal) {
    console.error('❌ FALHA DE SEGURANÇA! Nota interna vazou no histórico do motoboy:', messages);
    process.exit(1);
  }

  console.log(`✅ Motoboy recebeu ${messages.length} mensagens públicas. Nota interna mantida 100% OCULTA!`);
  console.log('🎉 TODOS OS TESTES DE CHAT OPERACIONAL DIRETO, CONCORRÊNCIA E RLS PASSARAM COM SUCESSO 100%!');
}

run();
