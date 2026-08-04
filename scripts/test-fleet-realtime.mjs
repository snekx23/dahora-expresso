import { createClient } from '@supabase/supabase-js';

const url = 'http://127.0.0.1:54321';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const adminClient = createClient(url, key);
const riderClient = createClient(url, key);

async function run() {
  console.log('🚀 Testando transmissão em tempo real (Realtime) da tabela fleet...');

  // Authenticate Admin
  const { data: adminAuth } = await adminClient.auth.signInWithPassword({
    email: 'admin@dahora.local',
    password: 'senha123456'
  });
  console.log('1. Admin autenticado! UID:', adminAuth.user.id);

  // Authenticate Motoboy
  const { data: riderAuth } = await riderClient.auth.signInWithPassword({
    email: 'motoboy@dahora.local',
    password: 'senha123456'
  });
  console.log('2. Motoboy autenticado! UID:', riderAuth.user.id);

  // Setup Realtime listener on Admin client
  let realtimeReceived = false;
  let receivedPayload = null;

  const channel = adminClient.channel('realtime:test_fleet')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'fleet' }, (payload) => {
      console.log('📡 REALTIME RECEBIDO PELO PAINEL ADMIN:', payload.new);
      realtimeReceived = true;
      receivedPayload = payload.new;
    })
    .subscribe((status) => {
      console.log('3. Status do canal Realtime Admin:', status);
    });

  // Wait for subscription to be SUBSCRIBED
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Motoboy updates status to 'Em Descanso'
  console.log('4. Motoboy alterando status no banco para "Em Descanso"...');
  await riderClient
    .from('fleet')
    .update({ status: 'Em Descanso' })
    .eq('user_id', riderAuth.user.id);

  // Wait for Realtime event arrival
  await new Promise(resolve => setTimeout(resolve, 2500));

  if (!realtimeReceived) {
    console.error('❌ ERRO: Evento Realtime não foi recebido no cliente Admin dentro do tempo esperado.');
    process.exit(1);
  }

  console.log('✅ SUCESSO: Evento Realtime transmitido instantaneamente!');
  console.log('   Motoboy:', receivedPayload.name, '| Novo Status:', receivedPayload.status);

  // Clean up: Revert status to 'Disponível'
  await riderClient
    .from('fleet')
    .update({ status: 'Disponível' })
    .eq('user_id', riderAuth.user.id);

  await new Promise(resolve => setTimeout(resolve, 1000));
  adminClient.removeChannel(channel);
  console.log('🎉 Validação do Realtime sem F5 concluída com SUCESSO 100%!');
  process.exit(0);
}

run();
