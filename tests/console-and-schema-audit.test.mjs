import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlPath = new URL('../public/index.html', import.meta.url);
const appJsPath = new URL('../public/app.js', import.meta.url);
const motoboyHtmlPath = new URL('../public/motoboy.html', import.meta.url);
const motoboyJsPath = new URL('../public/motoboy.js', import.meta.url);
const swJsPath = new URL('../public/sw.js', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);
const supabaseReadmePath = new URL('../supabase/README.md', import.meta.url);
const bootstrapPath = new URL('../supabase/bootstrap_homologation.sql', import.meta.url);
const migration0001Path = new URL('../supabase/migrations/20260727000100_init_core_schema.sql', import.meta.url);

test('1. schema_garradelivery.sql não existe na pasta ativa supabase/', () => {
  const activeFileExists = existsSync(new URL('../supabase/schema_garradelivery.sql', import.meta.url));
  const archivedFileExists = existsSync(new URL('../docs/legacy/garra/schema_garradelivery.sql.txt', import.meta.url));

  assert.equal(activeFileExists, false, 'O arquivo SQL legado não deve existir na pasta ativa supabase/.');
  assert.equal(archivedFileExists, true, 'O arquivo legado deve estar arquivado como .txt em docs/legacy/garra/.');
});

test('2. Nenhuma UI contém "Garra Delivery"', async () => {
  const html = await readFile(htmlPath, 'utf8');
  const appJs = await readFile(appJsPath, 'utf8');
  const motoboyHtml = await readFile(motoboyHtmlPath, 'utf8');
  const readme = await readFile(readmePath, 'utf8');
  const supabaseReadme = await readFile(supabaseReadmePath, 'utf8');

  assert.doesNotMatch(html, /Garra Delivery/i);
  assert.doesNotMatch(appJs, /Garra Delivery/i);
  assert.doesNotMatch(motoboyHtml, /Garra Delivery/i);
  assert.match(readme, /Garra Delivery/i);
  assert.match(supabaseReadme, /Garra Delivery/i);
});

test('3. Nenhuma UI ou código de aplicação contém "Parceiro Dahora"', async () => {
  const html = await readFile(htmlPath, 'utf8');
  const appJs = await readFile(appJsPath, 'utf8');
  const motoboyHtml = await readFile(motoboyHtmlPath, 'utf8');
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');

  assert.doesNotMatch(html, /Parceiro Dahora/i);
  assert.doesNotMatch(appJs, /Parceiro Dahora/i);
  assert.doesNotMatch(motoboyHtml, /Parceiro Dahora/i);
  assert.doesNotMatch(motoboyJs, /Parceiro Dahora/i);
});

test('4. Nenhum mock "Burger do Chef" existe no código ativo', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');

  assert.doesNotMatch(appJs, /Burger do Chef/i);
  assert.doesNotMatch(motoboyJs, /Burger do Chef/i);
});

test('5. Nenhum código fixo #TELE-0001 existe no código ativo', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');

  assert.doesNotMatch(appJs, /#TELE-0001/i);
  assert.doesNotMatch(motoboyJs, /#TELE-0001/i);
});

test('6. Tabela pending_deliveries não é consultada no app.js ou motoboy.js', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');

  assert.doesNotMatch(appJs, /\.from\('pending_deliveries'\)/);
  assert.doesNotMatch(motoboyJs, /\.from\('pending_deliveries'\)/);
});

test('7. Tabela client_history não é consultada no app.js ou motoboy.js', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  const motoboyJs = await readFile(motoboyJsPath, 'utf8');

  assert.doesNotMatch(appJs, /\.from\('client_history'\)/);
  assert.doesNotMatch(motoboyJs, /\.from\('client_history'\)/);
});

test('8. READMEs orientam para a baseline de migrations em supabase/migrations/', async () => {
  const readme = await readFile(readmePath, 'utf8');
  const supabaseReadme = await readFile(supabaseReadmePath, 'utf8');

  assert.match(readme, /supabase\/migrations\//);
  assert.match(supabaseReadme, /supabase\/migrations\//);
  assert.doesNotMatch(readme, /schema_garradelivery\.sql/);
  assert.doesNotMatch(supabaseReadme, /schema_garradelivery\.sql/);
});

test('9. Aplicação utiliza exclusivamente public.teles e public.commercial_clients', async () => {
  const appJs = await readFile(appJsPath, 'utf8');
  assert.match(appJs, /\.from\('teles'\)/);
  assert.match(appJs, /\.from\('commercial_clients'\)/);
});

test('10. Service Worker atualiza a versão do cache para v3 e inclui motoboy assets', async () => {
  const swJs = await readFile(swJsPath, 'utf8');
  assert.match(swJs, /dahora-expresso-cache-v3/);
  assert.match(swJs, /motoboy\.html/);
  assert.match(swJs, /motoboy\.js/);
});

test('11. Baseline Migration 1 cria user_profiles com user_id UUID REFERENCES auth.users(id)', async () => {
  const sql0001 = await readFile(migration0001Path, 'utf8');
  assert.match(sql0001, /CREATE TABLE public\.user_profiles/);
  assert.match(sql0001, /user_id UUID NOT NULL UNIQUE REFERENCES auth\.users\(id\)/);
  assert.doesNotMatch(sql0001, /garra_perfis/);
});

test('12. bootstrap_homologation.sql gerado com sucesso sem comandos destrutivos', async () => {
  const bootstrapSql = await readFile(bootstrapPath, 'utf8');
  assert.match(bootstrapSql, /DAHORA EXPRESSO — HOMOLOGAÇÃO APENAS/);
  assert.match(bootstrapSql, /CREATE TABLE public\.user_profiles/);
  assert.match(bootstrapSql, /CREATE TABLE public\.teles/);
  assert.doesNotMatch(bootstrapSql, /garra_perfis/);
  assert.doesNotMatch(bootstrapSql, /DROP TABLE/i);
  assert.doesNotMatch(bootstrapSql, /TRUNCATE/i);
});
