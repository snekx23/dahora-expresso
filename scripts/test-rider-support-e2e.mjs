import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE1NzE4OTI0MDAsImV4cCI6MTg4NzQ2ODQwMH0.P8BbdN4E-b21_04p992i-k5b804-k25638-k25638';

console.log("🚀 Iniciando Teste de Validação E2E REST/RPC: Módulo de Suporte dos Motoboys...");

async function runE2ETests() {
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // 1. Login Motoboy
  console.log("\n1. Autenticando Motoboy (motoboy@dahora.local)...");
  const riderAuth = await anonClient.auth.signInWithPassword({
    email: 'motoboy@dahora.local',
    password: 'senha123456'
  });
  if (riderAuth.error) throw new Error(`Falha no login do Motoboy: ${riderAuth.error.message}`);
  console.log(`✅ Motoboy Autenticado com sucesso! (UID: ${riderAuth.data.user.id})`);

  const riderClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${riderAuth.data.session.access_token}` } }
  });

  // 2. Login Admin
  console.log("\n2. Autenticando Administrador (admin@dahora.local)...");
  const adminAuth = await anonClient.auth.signInWithPassword({
    email: 'admin@dahora.local',
    password: 'senha123456'
  });
  if (adminAuth.error) throw new Error(`Falha no login do Admin: ${adminAuth.error.message}`);
  console.log(`✅ Administrador Autenticado com sucesso! (UID: ${adminAuth.data.user.id})`);

  const adminClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${adminAuth.data.session.access_token}` } }
  });

  // 3. Criar Chamado pelo Motoboy via RPC create_my_rider_support_ticket
  console.log("\n3. Criando Chamado pelo Motoboy...");
  const createRes = await riderClient.rpc('create_my_rider_support_ticket', {
    p_subject: 'Dúvida sobre taxa de entrega na chuva',
    p_category: 'payment_question',
    p_priority: 'high',
    p_message: 'Olá suporte, gostaria de saber se o adicional noturno/chuva foi computado no repasse.'
  });

  if (createRes.error || !createRes.data.success) {
    throw new Error(`Falha ao criar chamado: ${createRes.error?.message || createRes.data?.message}`);
  }
  const ticketId = createRes.data.ticket_id;
  console.log(`✅ Chamado criado com SUCESSO! ID: ${ticketId}`);

  // 4. Motoboy Lista Seus Chamados
  console.log("\n4. Motoboy buscando lista de chamados via get_my_rider_support_tickets...");
  const listRes = await riderClient.rpc('get_my_rider_support_tickets', { p_status: null, p_limit: 10, p_offset: 0 });
  if (listRes.error || !listRes.data.success || listRes.data.total_count < 1) {
    throw new Error(`Falha ao listar chamados do motoboy: ${listRes.error?.message || listRes.data?.message}`);
  }
  console.log(`✅ Motoboy listou ${listRes.data.total_count} chamado(s).`);

  // 5. Admin Lista Todos os Chamados e Resumo
  console.log("\n5. Admin buscando resumo e lista global...");
  const summaryRes = await adminClient.rpc('admin_get_rider_support_summary');
  if (summaryRes.error || !summaryRes.data.success) {
    throw new Error(`Falha ao obter resumo admin: ${summaryRes.error?.message}`);
  }
  console.log(`✅ Resumo Admin: Novos: ${summaryRes.data.new_count}, Em Atendimento: ${summaryRes.data.in_progress_count}`);

  const adminListRes = await adminClient.rpc('admin_get_rider_support_tickets', { p_status: null, p_priority: null, p_motoboy_id: null, p_search: null, p_limit: 10, p_offset: 0 });
  if (adminListRes.error || !adminListRes.data.success) {
    throw new Error(`Falha ao listar chamados no admin: ${adminListRes.error?.message}`);
  }
  console.log(`✅ Admin listou ${adminListRes.data.total_count} chamado(s) com dados formatados (Motoboy: ${adminListRes.data.items[0].rider_display_name}).`);

  // 6. Admin envia Nota Interna
  console.log("\n6. Admin criando Nota Interna privada...");
  const noteRes = await adminClient.rpc('admin_reply_rider_support_ticket', {
    p_ticket_id: ticketId,
    p_message: 'Nota interna admin: Verificando relatório de adicionais no sistema de fechamento.',
    p_is_internal: true
  });
  if (noteRes.error || !noteRes.data.success) {
    throw new Error(`Falha ao criar nota interna: ${noteRes.error?.message}`);
  }
  console.log(`✅ Nota Interna criada com sucesso.`);

  // 7. Motoboy consulta chamado e VALIDA ISOLAMENTO DA NOTA INTERNA
  console.log("\n7. Motoboy consultando chamado (validando que nota interna está OCULTA)...");
  const detailRes = await riderClient.rpc('get_my_rider_support_ticket', { p_ticket_id: ticketId });
  if (detailRes.error || !detailRes.data.success) {
    throw new Error(`Falha ao consultar detalhes pelo motoboy: ${detailRes.error?.message}`);
  }
  const messages = detailRes.data.messages;
  console.log(`✅ Motoboy recebeu ${messages.length} mensagem(ns) (Nota interna ocultada com sucesso!).`);
  if (messages.length !== 1) {
    throw new Error(`ERRO DE SEGURANÇA: Nota interna vazou para o motoboy!`);
  }

  // 8. Admin envia Resposta Pública
  console.log("\n8. Admin enviando resposta pública...");
  const replyRes = await adminClient.rpc('admin_reply_rider_support_ticket', {
    p_ticket_id: ticketId,
    p_message: 'Olá Guilherme, os adicionais de chuva são apurados e creditados no fechamento de sexta-feira.',
    p_is_internal: false
  });
  if (replyRes.error || !replyRes.data.success || replyRes.data.status !== 'waiting_rider') {
    throw new Error(`Falha ao enviar resposta pública admin: ${replyRes.error?.message}`);
  }
  console.log(`✅ Resposta pública enviada. Status alterado para: ${replyRes.data.status}`);

  // 9. Motoboy responde ao chamado
  console.log("\n9. Motoboy respondendo chamado...");
  const riderReplyRes = await riderClient.rpc('reply_my_rider_support_ticket', {
    p_ticket_id: ticketId,
    p_message: 'Entendido, muito obrigado pelo esclarecimento!'
  });
  if (riderReplyRes.error || !riderReplyRes.data.success || riderReplyRes.data.status !== 'waiting_admin') {
    throw new Error(`Falha ao responder chamado pelo motoboy: ${riderReplyRes.error?.message}`);
  }
  console.log(`✅ Motoboy respondeu. Status alterado para: ${riderReplyRes.data.status}`);

  // 10. Admin Encerra o Chamado
  console.log("\n10. Admin encerrando chamado (status closed)...");
  const closeRes = await adminClient.rpc('admin_update_rider_support_ticket_status', {
    p_ticket_id: ticketId,
    p_status: 'closed',
    p_reason: 'Dúvida sanada'
  });
  if (closeRes.error || !closeRes.data.success || closeRes.data.new_status !== 'closed') {
    throw new Error(`Falha ao encerrar chamado: ${closeRes.error?.message}`);
  }
  console.log(`✅ Chamado encerrado com sucesso.`);

  // 11. Validação de bloqueio em chamado encerrado
  console.log("\n11. Validando bloqueio de envio de mensagem em chamado encerrado...");
  const blockedReply = await riderClient.rpc('reply_my_rider_support_ticket', {
    p_ticket_id: ticketId,
    p_message: 'Tentativa inválida em ticket fechado'
  });
  if (blockedReply.data?.error_code !== 'TICKET_CLOSED') {
    throw new Error(`Falha na segurança: Resposta em ticket fechado não foi bloqueada! Resposta: ${JSON.stringify(blockedReply)}`);
  }
  console.log(`✅ Resposta em chamado encerrado foi corretamente BLOQUEADA.`);

  console.log("\n🎉 TODAS AS VALIDAÇÕES E2E DO MÓDULO DE SUPORTE DOS MOTOBOYS PASSARAM COM SUCESSO 100%! 🎉\n");
}

runE2ETests().catch(err => {
  console.error("❌ ERRO NO TESTE E2E:", err);
  process.exit(1);
});
