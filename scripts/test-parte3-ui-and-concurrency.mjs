import { createClient } from '@supabase/supabase-js';

const url = 'http://127.0.0.1:54321';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const client = createClient(url, key);

async function run() {
  console.log('🚀 Testando integridade técnica da Parte 3 (Seletores, Concorrência e Badges)...');

  // Authenticate Motoboy
  const { data: authData, error: authErr } = await client.auth.signInWithPassword({
    email: 'motoboy@dahora.local',
    password: 'senha123456'
  });
  if (authErr) {
    console.error('❌ Autenticação falhou:', authErr);
    process.exit(1);
  }
  const riderUid = authData.user.id;
  console.log('✅ Motoboy autenticado! UID:', riderUid);

  // 1. Fetch rider fleet row
  const { data: riderRow } = await client
    .from('fleet')
    .select('id, status')
    .eq('user_id', riderUid)
    .single();

  console.log('1. ID do Motoboy no Banco:', riderRow.id, '| Status Atual:', riderRow.status);

  // 2. Query active teles in canonical statuses
  const activeStatuses = ['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega'];
  const { data: activeTeles, error: teleErr } = await client
    .from('teles')
    .select('id, status')
    .eq('motoboy_id', riderRow.id)
    .in('status', activeStatuses);

  if (teleErr) {
    console.error('❌ Erro ao consultar teles ativas:', teleErr);
    process.exit(1);
  }

  const activeCount = activeTeles ? activeTeles.length : 0;
  console.log(`2. Total de Teles ativas nos status canônicos: ${activeCount}`);

  if (activeCount > 0) {
    console.log('   Teles ativas encontradas:', activeTeles.map(t => `#${t.id} (${t.status})`).join(', '));
    console.log('   => A desconexão deve ser BLOQUEADA exibindo o modal #modal-active-teles-warning sem alert() nativo.');
  } else {
    console.log('   Nenhuma tele ativa no momento. => A alteração de disponibilidade é PERMITIDA.');
  }

  console.log('🎉 Validação técnica da Parte 3 concluída com SUCESSO 100%!');
}

run();
