import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlPath = new URL('../public/index.html', import.meta.url);
const appJsPath = new URL('../public/app.js', import.meta.url);
const motoboyJsPath = new URL('../public/motoboy.js', import.meta.url);
const migration0006Path = new URL('../supabase/migrations/20260727000600_security_and_client_rpc.sql', import.meta.url);
const serveJsPath = new URL('../serve.js', import.meta.url);

test('1. Centro de Operações não possui estrutura ou elementos do Kanban', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.doesNotMatch(html, /id="col-solicitada"/);
  assert.doesNotMatch(html, /id="col-aguardando_despacho"/);
  assert.doesNotMatch(html, /id="col-coleta"/);
  assert.doesNotMatch(html, /id="col-em_rota"/);
  assert.doesNotMatch(html, /kanban-board-container/);
  assert.doesNotMatch(html, /Arraste uma tele/i);
});

test('2. Centro de Operações possui 7 KPIs e 3 listas resumidas com botão principal', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.match(html, /id="op-kpi-awaiting"/);
  assert.match(html, /id="op-kpi-in-progress"/);
  assert.match(html, /id="op-kpi-sla-critical"/);
  assert.match(html, /id="op-kpi-riders-avail"/);
  assert.match(html, /id="op-kpi-riders-max"/);
  assert.match(html, /id="op-kpi-completed-today"/);
  assert.match(html, /id="op-kpi-cancelled-today"/);

  assert.match(html, /id="op-summary-priorities-list"/);
  assert.match(html, /id="op-summary-fleet-list"/);
  assert.match(html, /id="op-summary-alerts-list"/);
  assert.match(html, /onclick="switchDashboardTab\('owner-teles'\)"/);
});

test('3. Estabelecimento no modal de Nova Tele não é input de texto livre com valor padrão', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.doesNotMatch(html, /id="manual-delivery-client"[\s\S]*?value="Parceiro Dahora"/);
  assert.match(html, /id="admin-client-search"/);
  assert.match(html, /id="selectedClientId"/);
});

test('4. Dropdown de clientes utiliza public.commercial_clients como fonte oficial', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.match(appJs, /fetchCommercialClientsForSelect/);
  assert.match(appJs, /\.from\('commercial_clients'\)/);
  assert.doesNotMatch(appJs, /\.from\('lojas'\)/);
});

test('5. public.lojas não é consultada nem modificada em app.js', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.doesNotMatch(appJs, /\.from\('lojas'\)/);
});

test('6. public.client_history não é consultada nem modificada em app.js ou motoboy.js', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');
  assert.doesNotMatch(appJs, /\.from\('client_history'\)/);
  assert.doesNotMatch(motoboyJs, /\.from\('client_history'\)/);
});

test('7. Filtro padrao de clientes no seletor busca apenas ativos', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.match(appJs, /lifecycle_status', 'ativo'/);
  assert.match(appJs, /show-inactive-clients-cb/);
});

test('8. Cliente não selecionado gera bloqueio com erro CLIENT_SELECTION_REQUIRED', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  const serveJs = await readFile(serveJsPath, 'utf8');
  const migration0006 = await readFile(migration0006Path, 'utf8');

  assert.match(appJs, /CLIENT_SELECTION_REQUIRED|Por favor, selecione um cliente comercial cadastrado/);
  assert.match(serveJs, /CLIENT_SELECTION_REQUIRED/);
  assert.match(migration0006, /CLIENT_SELECTION_REQUIRED/);
});

test('9. Nomes fictícios "Parceiro Dahora" e "Parceiro Garra" foram removidos da interface e fallbacks', async () => {
  const html = await readFile(htmlPath, 'utf8');
  const appJs = await readFile(appJsPath, 'utf8');

  assert.doesNotMatch(html, /Parceiro Garra/);
  assert.doesNotMatch(html, /Parceiro Dahora/);
  assert.doesNotMatch(appJs, /'Parceiro Garra'/);
  assert.doesNotMatch(appJs, /'Parceiro Dahora'/);
});

test('10. "Cliente informado" não é o valor fixo do destinatário', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.doesNotMatch(html, /id="manual-delivery-dest-name"[\s\S]*?value="Cliente informado"/);
  assert.match(html, /placeholder="Nome de quem receberá a entrega"/);
});

test('11. Cliente e destinatário são campos distintos no modal', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.match(html, /id="admin-client-search"/);
  assert.match(html, /id="manual-delivery-dest-name"/);
});

test('12. Idempotency key é gerada e enviada na criação manual de Tele', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.match(appJs, /idemp-admin-/);
  assert.match(appJs, /p_idempotency_key/);
});

test('13. Envio bloqueia o botão contra cliques duplicados', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.match(appJs, /btnSubmit\.disabled = true/);
});

test('14. Tele code é gerado de forma transacional no backend', async () => {
  const serveJs = await readFile(serveJsPath, 'utf8');
  const migration0006 = await readFile(migration0006Path, 'utf8');
  assert.match(serveJs, /TEL-\$\{String\(seq\)/);
  assert.match(migration0006, /create_admin_tele/);
});

test('15. Mapa não exige tecla Ctrl para aplicar zoom', async () => {
  const html = await readFile(htmlPath, 'utf8');
  const appJs = await readFile(appJsPath, 'utf8');
  assert.doesNotMatch(html, /Pressione Ctrl e role a tela simultaneamente/i);
  assert.match(appJs, /scrollZoom:\s*true/);
});

test('16. Concorrência e Realtime usam canal único realtime:operations sem loop de reconexão por erro secundário', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.match(appJs, /channel\('realtime:operations'\)/);
  assert.match(appJs, /Promise\.allSettled/);
  assert.doesNotMatch(appJs, /reconnect\(\)[\s\S]*?lojas/);
});

test('17. Resolução de cliente retorna "Cliente não vinculado" caso client_id seja ausente', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.match(appJs, /resolveClientDisplayName/);
  assert.match(appJs, /Cliente não vinculado/);
});

test('18. RPC create_admin_tele exige autenticação, valida cliente ativo e aplica SET search_path = ""', async () => {
  const sql = await readFile(migration0006Path, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.create_admin_tele/);
  assert.match(sql, /SET search_path = ''/);
  assert.match(sql, /lifecycle_status = 'ativo'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.create_admin_tele/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.create_admin_tele\([\s\S]*?\) TO authenticated/);
});

test('19. O arquivo index.html é válido e contém fechamento de tags', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /<\/html>/i);
});

test('20. Autorização centralizada via get_current_user_role e current_user_has_permission em SQL', async () => {
  const sql = await readFile(migration0006Path, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_current_user_role/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.current_user_has_permission/);
  assert.match(sql, /current_user_has_permission\('tele\.create_admin'\)/);
});

test('21. Status "rascunho" não é convertido automaticamente para "solicitada"', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.doesNotMatch(appJs, /'rascunho':\s*'solicitada'/);
});

test('22. tele_code possui sequence e geração única sem colisão', async () => {
  const sql = await readFile(migration0006Path, 'utf8');
  const serveJs = await readFile(serveJsPath, 'utf8');
  assert.match(sql, /tele_code_seq|tele_code TEXT UNIQUE/);
  assert.match(serveJs, /TEL-\$\{String\(seq\)\.padStart\(6, '0'\)\}/);
});

test('23. Cliente suspenso exibe aviso no seletor e bloqueia botão no frontend e backend', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  const sql = await readFile(migration0006Path, 'utf8');
  assert.match(appJs, /admin-client-inactive-warning/);
  assert.match(appJs, /submitBtn\.disabled = true/);
  assert.match(sql, /CLIENT_INACTIVE_OR_BLOCKED/);
});
