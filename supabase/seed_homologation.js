// Seed script for local development and staging/homologation ONLY.
// BLOCKED in production environment.

if (process.env.NODE_ENV === 'production') {
  console.error("ERRO DE SEGURANÇA: O script de seed de homologação NÃO PODE ser executado em ambiente de PRODUÇÃO!");
  process.exit(1);
}

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'http://localhost:54321';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const TEST_CLIENT_EMAIL = process.env.LOCAL_TEST_CLIENT_EMAIL || 'cliente.teste@local.test';
const TEST_CLIENT_PASS = process.env.LOCAL_TEST_CLIENT_PASS || 'teste123';

async function runSeed() {
  console.log("Iniciando seed de homologação local para o Cliente Teste...");

  if (!serviceRoleKey) {
    console.log("Aviso: SUPABASE_SERVICE_ROLE_KEY não fornecida. Seed relacional local via Dev API.");
  }

  const testPayload = {
    establishment_name: 'Cliente Teste',
    responsible_name: 'Usuário Teste',
    phone: '(11) 99999-0000',
    email: TEST_CLIENT_EMAIL,
    password: TEST_CLIENT_PASS,
    address: 'Av. Teste de Homologação, 100',
    complement: 'Bloco A',
    neighborhood: 'Centro',
    city: 'Porto Alegre',
    document: '00.000.000/0001-99',
    notes: 'Cliente fictício para testes automatizados e homologação.'
  };

  try {
    const res = await fetch('http://localhost:8000/api/admin/create-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });

    if (res.status === 201 || res.status === 409) {
      console.log("Seed de homologação concluído com sucesso.");
    } else {
      const err = await res.json();
      console.error("Falha no seed de homologação:", err);
    }
  } catch (err) {
    console.error("Erro ao rodar seed:", err.message);
  }
}

runSeed();
