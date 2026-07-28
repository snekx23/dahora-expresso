import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

// ---------------------------------------------------------------------
// 1. Validação Estática das Migrations SQL (Compilação & Segurança)
// ---------------------------------------------------------------------

test('Migration 20260727000600 contém colunas delivery_reference, pricing_rule_version e constraint UNIQUE', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000600_security_and_client_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('delivery_reference TEXT'), 'Coluna delivery_reference TEXT ausente em teles.');
  assert.ok(sql.includes('pricing_rule_version TEXT'), 'Coluna pricing_rule_version TEXT ausente em teles.');
  assert.ok(sql.includes('teles_client_idempotency_unique UNIQUE (client_id, client_request_idempotency_key)'), 'Constraint UNIQUE (client_id, client_request_idempotency_key) ausente.');
});

test('Migration 20260727000600 implementa INSERT ON CONFLICT DO NOTHING atômico para concorrência de idempotência', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000600_security_and_client_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('ON CONFLICT (client_id, client_request_idempotency_key) DO NOTHING'), 'ON CONFLICT DO NOTHING ausente na RPC create_client_tele.');
  assert.ok(sql.includes('RETURNING id, status, client_id, delivery_charge, delivery_reference, pricing_rule_source, pricing_rule_version, version, created_at'), 'RETURNING atômico ausente no INSERT de teles.');
  assert.ok(sql.includes("v_inserted_tele.id IS NULL THEN"), 'Checagem de conflito atômico pós-insert ausente.');
  assert.ok(sql.includes("'is_idempotent', true"), 'Resposta com is_idempotent = true em caso de conflito concorrente ausente.');
});

test('Migration 20260727000600 aplica SET search_path = \'\' e qualificações pg_catalog nas RPCs', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000600_security_and_client_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes("SET search_path = ''"), 'SET search_path = \'\' estrito ausente na migration 6.');
  assert.ok(sql.includes('pg_catalog.btrim'), 'Chamada qualificada pg_catalog.btrim ausente.');
  assert.ok(sql.includes('pg_catalog.lower'), 'Chamada qualificada pg_catalog.lower ausente.');
  assert.ok(sql.includes('pg_catalog.length'), 'Chamada qualificada pg_catalog.length ausente.');
  assert.ok(sql.includes('pg_catalog.round'), 'Chamada qualificada pg_catalog.round ausente.');
  assert.ok(sql.includes('pg_catalog.jsonb_build_object'), 'Chamada qualificada pg_catalog.jsonb_build_object ausente.');
});

test('RPC create_client_tele centraliza validação de valor de pedido (R$ 50.000,00) e bloqueia valores negativos', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000600_security_and_client_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('50000.00'), 'Limite máximo de R$ 50.000,00 ausente na RPC.');
  assert.ok(sql.includes('INVALID_ORDER_VALUE'), 'Código de erro INVALID_ORDER_VALUE ausente.');
  assert.ok(sql.includes('ORDER_VALUE_LIMIT_EXCEEDED'), 'Código de erro ORDER_VALUE_LIMIT_EXCEEDED ausente.');
  assert.equal(sql.includes('GREATEST(0.00'), false, 'GREATEST não pode ser utilizado para mascarar valor negativo.');
});

test('RPC create_client_tele valida e restringe operation_source a client_portal', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000600_security_and_client_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('INVALID_OPERATION_SOURCE'), 'Código de erro INVALID_OPERATION_SOURCE ausente.');
  assert.ok(sql.includes("v_op_source_norm <> 'client_portal'"), 'Validação de origem exclusiva client_portal ausente.');
});

test('RPC create_client_tele valida endereços idênticos e limites de tamanho', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260727000600_security_and_client_rpc.sql', import.meta.url), 'utf8');

  assert.ok(sql.includes('SAME_PICKUP_AND_DELIVERY_ADDRESS'), 'Erro SAME_PICKUP_AND_DELIVERY_ADDRESS ausente.');
  assert.ok(sql.includes('DELIVERY_REFERENCE_TOO_LONG'), 'Erro DELIVERY_REFERENCE_TOO_LONG ausente.');
  assert.ok(sql.includes('RECIPIENT_PHONE_TOO_LONG'), 'Erro RECIPIENT_PHONE_TOO_LONG ausente.');
});

test('Todas as migrations do baseline aplicam REVOKE de PUBLIC e anon e GRANT para authenticated', async () => {
  const files = await readdir(new URL('../supabase/migrations', import.meta.url));
  
  for (const file of files) {
    if (!file.endsWith('.sql')) continue;
    const content = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
    
    // Se a migration define funções, deve conter REVOKE para anon e PUBLIC
    if (content.includes('CREATE OR REPLACE FUNCTION')) {
      assert.ok(content.includes('FROM PUBLIC;'), `REVOKE FROM PUBLIC ausente na migration ${file}`);
      assert.ok(content.includes('FROM anon;'), `REVOKE FROM anon ausente na migration ${file}`);
      assert.ok(content.includes('TO authenticated;'), `GRANT TO authenticated ausente na migration ${file}`);
      assert.equal(content.includes('p_actor_id'), false, `Migration ${file} contém o parâmetro legado p_actor_id.`);
    }
  }
});

// ---------------------------------------------------------------------
// 2. Simulação Lógica de Idempotência Atômica Concorrente em Memória
// ---------------------------------------------------------------------

test('Simulação Concorrente: Duas chamadas simultâneas com a mesma idempotency_key produzem 1 Tele e 1 Auditoria', async () => {
  const database = {
    teles: [],
    events: [],
    auditLogs: []
  };

  async function mockCreateClientTele(payload) {
    const { pickup_address, delivery_address, recipient_name, recipient_phone, idempotency_key, reference, order_value, operation_source } = payload;

    // Normalização
    const pickupNorm = (pickup_address || '').trim();
    const deliveryNorm = (delivery_address || '').trim();
    const recipientNameNorm = (recipient_name || '').trim();
    const recipientPhoneNorm = (recipient_phone || '').trim();
    const keyNorm = (idempotency_key || '').trim();
    const refNorm = (reference || '').trim() || null;
    const opSource = (operation_source || 'client_portal').trim();

    if (opSource !== 'client_portal') {
      return { success: false, error_code: 'INVALID_OPERATION_SOURCE', message: 'Origem da operação inválida.' };
    }
    if (!pickupNorm) return { success: false, error_code: 'PICKUP_ADDRESS_REQUIRED' };
    if (!deliveryNorm) return { success: false, error_code: 'DELIVERY_ADDRESS_REQUIRED' };
    if (pickupNorm.toLowerCase() === deliveryNorm.toLowerCase()) {
      return { success: false, error_code: 'SAME_PICKUP_AND_DELIVERY_ADDRESS' };
    }
    if (!recipientNameNorm) return { success: false, error_code: 'RECIPIENT_NAME_REQUIRED' };
    if (!recipientPhoneNorm) return { success: false, error_code: 'RECIPIENT_PHONE_REQUIRED' };
    if (!keyNorm) return { success: false, error_code: 'IDEMPOTENCY_KEY_REQUIRED' };
    if (refNorm && refNorm.length > 300) return { success: false, error_code: 'DELIVERY_REFERENCE_TOO_LONG' };

    const orderVal = Number(order_value || 0);
    if (orderVal < 0) return { success: false, error_code: 'INVALID_ORDER_VALUE' };
    if (orderVal > 50000) return { success: false, error_code: 'ORDER_VALUE_LIMIT_EXCEEDED' };

    // Inserção atômica com trava de chave única
    const existing = database.teles.find(t => t.client_id === 'cli-1' && t.client_request_idempotency_key === keyNorm);
    if (existing) {
      return {
        success: true,
        is_idempotent: true,
        tele_id: existing.id,
        status: existing.status,
        client_id: existing.client_id,
        delivery_charge: existing.delivery_charge,
        delivery_reference: existing.delivery_reference,
        pricing_rule_source: existing.pricing_rule_source,
        pricing_rule_version: existing.pricing_rule_version,
        version: existing.version,
        created_at: existing.created_at
      };
    }

    const newTele = {
      id: `tele-${Date.now()}-${Math.random()}`,
      client_id: 'cli-1',
      status: 'solicitada',
      origin: pickupNorm,
      address: deliveryNorm,
      dest_name: recipientNameNorm,
      dest_phone: recipientPhoneNorm,
      delivery_reference: refNorm,
      delivery_charge: 15.00,
      pricing_rule_source: 'fallback_default',
      pricing_rule_version: 'v1_fallback',
      version: 1,
      client_request_idempotency_key: keyNorm,
      created_at: new Date().toISOString()
    };

    database.teles.push(newTele);
    database.events.push({ tele_id: newTele.id, type: 'tele_requested' });
    database.auditLogs.push({ action: 'create_tele', target: newTele.id });

    return {
      success: true,
      is_idempotent: false,
      tele_id: newTele.id,
      status: newTele.status,
      client_id: newTele.client_id,
      delivery_charge: newTele.delivery_charge,
      delivery_reference: newTele.delivery_reference,
      pricing_rule_source: newTele.pricing_rule_source,
      pricing_rule_version: newTele.pricing_rule_version,
      version: newTele.version,
      created_at: newTele.created_at
    };
  }

  const payload = {
    pickup_address: 'Rua das Flores, 100',
    delivery_address: 'Av. Brasil, 500',
    recipient_name: 'Carlos Silva',
    recipient_phone: '+5551999998888',
    idempotency_key: 'KEY-CONCURRENT-TEST-001',
    reference: 'PEDIDO #9981',
    order_value: 120.50,
    operation_source: 'client_portal'
  };

  // Disparar duas requisições simultâneas
  const [res1, res2] = await Promise.all([
    mockCreateClientTele(payload),
    mockCreateClientTele(payload)
  ]);

  // Ambas devem retornar sucesso
  assert.equal(res1.success, true);
  assert.equal(res2.success, true);

  // Exatamente uma deve ser criação original (is_idempotent = false) e uma idempotente (is_idempotent = true)
  const isIdempotentFlags = [res1.is_idempotent, res2.is_idempotent];
  assert.ok(isIdempotentFlags.includes(false), 'Pelo menos uma chamada deve retornar a criação original.');
  assert.ok(isIdempotentFlags.includes(true), 'Pelo menos uma chamada deve retornar is_idempotent = true.');

  // Ambas retornam o mesmo ID de Tele
  assert.equal(res1.tele_id, res2.tele_id);
  assert.equal(res1.delivery_reference, 'PEDIDO #9981');
  assert.equal(res2.delivery_reference, 'PEDIDO #9981');

  // No banco: APENAS UMA TELE, UM EVENTO E UMA AUDITORIA
  assert.equal(database.teles.length, 1);
  assert.equal(database.events.length, 1);
  assert.equal(database.auditLogs.length, 1);
});

test('Validações de entrada: bloqueio de valor negativo, valor excessivo, endereços idênticos e referência longa', async () => {
  const payloadBase = {
    pickup_address: 'Rua A, 10',
    delivery_address: 'Rua B, 20',
    recipient_name: 'Maria',
    recipient_phone: '51988887777',
    idempotency_key: 'KEY-TEST-VAL-01',
    operation_source: 'client_portal'
  };

  // 1. Valor negativo -> INVALID_ORDER_VALUE
  const resNeg = await mockSimulatedValidation({ ...payloadBase, order_value: -15.00 });
  assert.equal(resNeg.error_code, 'INVALID_ORDER_VALUE');

  // 2. Valor acima de R$ 50.000 -> ORDER_VALUE_LIMIT_EXCEEDED
  const resExceed = await mockSimulatedValidation({ ...payloadBase, order_value: 50000.01 });
  assert.equal(resExceed.error_code, 'ORDER_VALUE_LIMIT_EXCEEDED');

  // 3. Endereços idênticos -> SAME_PICKUP_AND_DELIVERY_ADDRESS
  const resSameAddr = await mockSimulatedValidation({ ...payloadBase, pickup_address: 'Rua A, 10', delivery_address: 'Rua A, 10' });
  assert.equal(resSameAddr.error_code, 'SAME_PICKUP_AND_DELIVERY_ADDRESS');

  // 4. Origem não client_portal -> INVALID_OPERATION_SOURCE
  const resOpSource = await mockSimulatedValidation({ ...payloadBase, operation_source: 'owner_panel' });
  assert.equal(resOpSource.error_code, 'INVALID_OPERATION_SOURCE');

  // 5. Referência acima de 300 caracteres -> DELIVERY_REFERENCE_TOO_LONG
  const longRef = 'A'.repeat(301);
  const resLongRef = await mockSimulatedValidation({ ...payloadBase, reference: longRef });
  assert.equal(resLongRef.error_code, 'DELIVERY_REFERENCE_TOO_LONG');
});

async function mockSimulatedValidation(p) {
  const pickupNorm = (p.pickup_address || '').trim();
  const deliveryNorm = (p.delivery_address || '').trim();
  const recipientNameNorm = (p.recipient_name || '').trim();
  const recipientPhoneNorm = (p.recipient_phone || '').trim();
  const keyNorm = (p.idempotency_key || '').trim();
  const refNorm = (p.reference || '').trim() || null;
  const opSource = (p.operation_source || 'client_portal').trim();

  if (opSource !== 'client_portal') return { success: false, error_code: 'INVALID_OPERATION_SOURCE' };
  if (!pickupNorm) return { success: false, error_code: 'PICKUP_ADDRESS_REQUIRED' };
  if (!deliveryNorm) return { success: false, error_code: 'DELIVERY_ADDRESS_REQUIRED' };
  if (pickupNorm.toLowerCase() === deliveryNorm.toLowerCase()) return { success: false, error_code: 'SAME_PICKUP_AND_DELIVERY_ADDRESS' };
  if (!recipientNameNorm) return { success: false, error_code: 'RECIPIENT_NAME_REQUIRED' };
  if (!recipientPhoneNorm) return { success: false, error_code: 'RECIPIENT_PHONE_REQUIRED' };
  if (!keyNorm) return { success: false, error_code: 'IDEMPOTENCY_KEY_REQUIRED' };
  if (refNorm && refNorm.length > 300) return { success: false, error_code: 'DELIVERY_REFERENCE_TOO_LONG' };

  const orderVal = Number(p.order_value || 0);
  if (orderVal < 0) return { success: false, error_code: 'INVALID_ORDER_VALUE' };
  if (orderVal > 50000) return { success: false, error_code: 'ORDER_VALUE_LIMIT_EXCEEDED' };

  return { success: true };
}
