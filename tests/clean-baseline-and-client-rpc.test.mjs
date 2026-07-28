import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------
// 1. Validação da Estrutura de Migrations no Baseline Limpo
// ---------------------------------------------------------------------
test('Migrations seguem estritamente a nomenclatura timestamped única (20260727XXXXXX_...)', async () => {
  const files = await readdir(new URL('../supabase/migrations', import.meta.url));
  
  assert.ok(files.length >= 6, 'Devem existir pelo menos 6 migrations no baseline limpo.');

  let previousTimestamp = '';

  for (const file of files) {
    // Valida padrão de timestamp numérico no início do nome
    const match = file.match(/^(\d{14})_.+\.sql$/);
    assert.ok(match, `O arquivo ${file} não segue o padrão <timestamp_14_digitos>_<nome>.sql`);

    const timestamp = match[1];
    assert.ok(timestamp > previousTimestamp, `A migration ${file} não está em ordem estritamente crescente em relação a ${previousTimestamp}`);
    previousTimestamp = timestamp;

    // Verificar se nenhuma migration ativa contém resíduos de iFood / 99Food
    const content = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
    assert.equal(content.toLowerCase().includes('ifood'), false, `A migration ${file} contém o termo legado 'ifood'.`);
    assert.equal(content.toLowerCase().includes('99food'), false, `A migration ${file} contém o termo legado '99food'.`);
    assert.equal(content.toLowerCase().includes('food99'), false, `A migration ${file} contém o termo legado 'food99'.`);
    assert.equal(content.toLowerCase().includes('integration_targets'), false, `A migration ${file} contém a tabela removida 'integration_targets'.`);
  }
});

// ---------------------------------------------------------------------
// 2. Validação da RPC create_client_tele e Endurecimento de Segurança
// ---------------------------------------------------------------------
test('Migration 20260727000600 contém RPC create_client_tele, idempotência por cliente e search_path seguro', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000600_security_and_client_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.create_client_tele'), 'RPC create_client_tele ausente.');
  assert.ok(sql.includes('teles_client_idempotency_unique'), 'Constraint UNIQUE (client_id, client_request_idempotency_key) ausente.');
  assert.ok(sql.includes('resolve_delivery_charge'), 'Função resolve_delivery_charge ausente.');
  assert.ok(sql.includes("SET search_path = ''"), 'search_path seguro ausente na RPC.');
  assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.create_client_tele'), 'REVOKE ALL FROM PUBLIC ausente.');
  assert.ok(sql.includes('GRANT EXECUTE ON FUNCTION public.create_client_tele'), 'GRANT TO authenticated ausente.');

  // Prova de remoção de p_actor_id da assinatura pública da RPC
  assert.equal(sql.includes('p_actor_id'), false, 'A assinatura da RPC não pode aceitar p_actor_id vindo do cliente.');
});

// ---------------------------------------------------------------------
// 3. Ausência de Código Legado de Marketplace em app.js e motoboy.js
// ---------------------------------------------------------------------
test('public/app.js e public/motoboy.js foram limpos de regras de iFood e 99Food', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const motoboyJs = await readFile(new URL('../public/motoboy.js', import.meta.url), 'utf8');

  assert.equal(appJs.includes("displayId = item.id.replace(/iFood/gi, '')"), false);
  assert.equal(appJs.includes("displayId = item.id.replace(/99Food/gi, '')"), false);

  assert.ok(motoboyJs.includes('paymentBadge = \'Faturado\''), 'Badges de pagamento comercial devem incluir Faturado.');
  assert.equal(motoboyJs.includes('paymentBadge = \'iFood\''), false, 'Badge legada iFood deve estar ausente em motoboy.js');
  assert.equal(motoboyJs.includes('paymentBadge = \'99Food\''), false, 'Badge legada 99Food deve estar ausente em motoboy.js');
});
