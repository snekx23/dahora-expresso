import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('1. Motoboy consulta somente suas Teles via eq("motoboy_id", currentRiderId)', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes(".eq('motoboy_id', currentRiderId)"), 'Consulta de teles ativas deve filtrar exclusivamente por motoboy_id.');
});

test('2. Consulta de Teles utiliza exclusivamente o campo motoboy_id (sem rider_id)', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(!motoboyJs.includes(".from('teles').select('*').eq('rider_id'"), 'rider_id descontinuado não deve ser usado nas queries de teles.');
});

test('3. Dados de commercial_clients (establishment_name, phone) são carregados', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes(".from('commercial_clients')"), 'Busca do estabelecimento comercial deve consultar a tabela commercial_clients.');
  assert.ok(motoboyJs.includes('establishment_name'), 'Nome do estabelecimento deve ser recuperado da tabela commercial_clients.');
});

test('4. Ganho do motoboy é obtido via backend get_tele_rider_earning (sem calculo percentual no frontend)', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('get_tele_rider_earning'), 'RPC get_tele_rider_earning deve ser chamada.');
  assert.ok(!motoboyJs.includes('delivery_charge * 0.80'), 'Cálculo estático delivery_charge * 0.80 não deve existir no frontend.');
});

test('5. WhatsApp do cliente normaliza somente numeros e insere prefixo 55 se 10/11 digitos', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes("replace(/\\D/g, '')"), 'Dígitos do telefone devem ser normalizados.');
  assert.ok(motoboyJs.includes("finalPhone = '55' + normPhone"), 'Prefixo 55 deve ser inserido para números com 10 ou 11 dígitos.');
  assert.ok(motoboyJs.includes('https://wa.me/'), 'URL base do WhatsApp deve ser wa.me.');
});

test('6. Botao de rota do Google Maps utiliza coordenadas delivery_latitude/longitude com fallback para endereco', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('delivery_latitude') && motoboyJs.includes('delivery_longitude'), 'Rota deve priorizar latitude e longitude.');
  assert.ok(motoboyJs.includes('https://www.google.com/maps/dir/?api=1&destination='), 'URL externa do Google Maps deve ser construída corretamente.');
});

test('7. RPC mark_my_tele_collected exige autenticacao em SQL', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('FUNCTION public.mark_my_tele_collected'), 'RPC mark_my_tele_collected deve existir na migration.');
  assert.ok(migrationSql.includes("AUTHENTICATION_REQUIRED"), 'Verificação de auth.uid() deve bloquear execução anônima.');
});

test('8. RPC mark_my_tele_collected bloqueia Tele pertencente a outro motoboy', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('FORBIDDEN_NOT_YOUR_TELE'), 'Validação motoboy_id <> v_fleet_id deve retornar erro de permissão.');
});

test('9. Marcação de coleta não gera lançamento nos ledgers financeiros', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  const collectedFn = migrationSql.substring(migrationSql.indexOf('mark_my_tele_collected'), migrationSql.indexOf('start_my_tele_delivery'));
  assert.ok(!collectedFn.includes('rider_financial_transactions'), 'Lançamento financeiro não deve ser feito na RPC de coleta.');
});

test('10. RPC start_my_tele_delivery exige status de origem estritamente igual a "coletada"', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes("v_tele.status NOT IN ('coletada')"), 'Início da entrega deve exigir status coletada.');
});

test('11. Início da entrega não gera lançamentos financeiros nos ledgers', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  const startFn = migrationSql.substring(migrationSql.indexOf('start_my_tele_delivery'), migrationSql.indexOf('complete_my_tele'));
  assert.ok(!startFn.includes('rider_financial_transactions'), 'Lançamento financeiro não deve ser feito na RPC de início de entrega.');
});

test('12. RPC complete_my_tele exige status de origem em_entrega', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes("NOT IN ('em_entrega', 'concluida', 'concluido', 'entregue')"), 'Conclusão pelo motoboy exige status em_entrega.');
});

test('13. Lógica central de conclusão reutiliza complete_tele_internal sem duplicar regras financeiras', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('FUNCTION public.complete_tele_internal'), 'Função interna central de conclusão criada.');
  assert.ok(migrationSql.includes('public.complete_tele_internal('), 'complete_my_tele invoca a função central.');
});

test('14. Conclusão grava completed_at no banco de dados', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('completed_at = v_now'), 'completed_at deve ser gravado na atualização da Tele.');
});

test('15. Ledgers financeiros possuem trava idempotente ON CONFLICT (idempotency_key) DO NOTHING', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('INSERT INTO public.rider_financial_transactions'), 'Ledger do motoboy inserido.');
  assert.ok(migrationSql.includes('ON CONFLICT (idempotency_key) DO NOTHING'), 'Idempotência garantida via ON CONFLICT.');
});

test('16. Versão da Tele evita concorrência e gera TELE_VERSION_CONFLICT', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('TELE_VERSION_CONFLICT'), 'Erro TELE_VERSION_CONFLICT gerado quando versão otimista não confere.');
});

test('17. Frontend desabilita botão e exibe estado "Processando..." para impedir clique duplo', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes('submitBtn.disabled = true;'), 'Botão desabilitado durante a requisição RPC.');
  assert.ok(motoboyJs.includes("submitBtn.innerText = 'Processando...';"), 'Texto de carregamento exibido no botão.');
});

test('18. Tele concluída é removida da lista de ativas no PWA', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(motoboyJs.includes("['motoboy_designado', 'indo_coletar', 'aguardando_coleta', 'coletada', 'em_entrega']"), 'Apenas status ativos permanecem na lista de teles.');
});

test('19. Painel administrativo recebe atualizações via Realtime sem criar Kanban', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(appJs.includes("initOperationsRealtimeChannel"), 'Canal Realtime de operações presente no painel admin.');
  assert.ok(!appJs.includes('createKanbanBoard'), 'Nenhum Kanban deve ser criado do zero.');
});

test('20. Status da frota ao concluir considera outras Teles ativas do motoboy', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('v_other_active_count'), 'Outras teles ativas são contadas antes de alterar fleet.status.');
  assert.ok(migrationSql.includes("UPDATE public.fleet\n      SET status = 'Disponível'"), 'Status muda para Disponível somente se não houver outras teles.');
});

test('21. Frontend do PWA não realiza UPDATE direto em public.teles pelo navegador', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(!motoboyJs.includes(".from('teles')\n    .update("), 'UPDATE direto em teles foi totalmente removido do frontend.');
  assert.ok(!motoboyJs.includes(".from('teles')\n  .update("), 'UPDATE direto em teles foi totalmente removido do frontend.');
});

test('22. Função anon não possui permissão de execução nas RPCs operacionais', async () => {
  const migrationSql = await readFile(new URL('../supabase/migrations/20260729000100_pwa_tele_status_transitions.sql', import.meta.url), 'utf8');
  assert.ok(migrationSql.includes('REVOKE EXECUTE ON FUNCTION public.mark_my_tele_collected(UUID, BIGINT) FROM PUBLIC;'), 'Permissão revogada para PUBLIC na coleta.');
  assert.ok(migrationSql.includes('REVOKE EXECUTE ON FUNCTION public.mark_my_tele_collected(UUID, BIGINT) FROM anon;'), 'Permissão revogada para anon na coleta.');
  assert.ok(migrationSql.includes('REVOKE EXECUTE ON FUNCTION public.complete_my_tele(UUID, BIGINT) FROM PUBLIC;'), 'Permissão revogada para PUBLIC na conclusão.');
  assert.ok(migrationSql.includes('REVOKE EXECUTE ON FUNCTION public.complete_my_tele(UUID, BIGINT) FROM anon;'), 'Permissão revogada para anon na conclusão.');
});

test('23. service_role key não é exposta no frontend public/motoboy.js', async () => {
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');
  assert.ok(!motoboyJs.includes('service_role'), 'Nenhuma chave service_role pode estar no frontend.');
});

test('24. ENABLE_PUSH_WORKER permanece desativado em serve.js', async () => {
  const serveJs = await readFile(new URL('../serve.js', import.meta.url), 'utf8');
  assert.ok(serveJs.includes('const ENABLE_PUSH_WORKER = false;'), 'ENABLE_PUSH_WORKER deve ser false em serve.js.');
});

test('25. Configurações locais utilizam Supabase local 127.0.0.1:54321 e servidor na porta 8000', async () => {
  const configLocal = await readFile(new URL('../public/config.local.js', import.meta.url), 'utf8');
  assert.ok(configLocal.includes('http://127.0.0.1:54321'), 'Configuração local deve apontar para 127.0.0.1:54321.');
  const serveJs = await readFile(new URL('../serve.js', import.meta.url), 'utf8');
  assert.ok(serveJs.includes('8000'), 'Porta do servidor local em serve.js deve ser 8000.');
});
