// script: scripts/reconcile-orphan-auth-users.mjs
// Purpose: Detect and reconcile orphan Auth users (present in auth.users but missing from user_profiles).
// Default mode: READ-ONLY (safe). Pass --apply explicitly to delete orphans.

import crypto from 'node:crypto';

async function main() {
  const args = process.argv.slice(2);
  const applyFix = args.includes('--apply');

  const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  
  if (!supabaseUrl.includes('127.0.0.1') && !supabaseUrl.includes('localhost') && !args.includes('--force-remote')) {
    console.error('ERRO DE SEGURANÇA: Execução contra Supabase remoto bloqueada por padrão. Use --force-remote para ignorar.');
    process.exit(1);
  }

  let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!serviceKey) {
    const secretKey = 'super-secret-jwt-token-with-at-least-32-characters-long';
    const header = { alg: 'HS256', typ: 'JWT' };
    const jwtPayload = { iss: 'supabase', ref: 'tskivauszmhhtqtegvwb', role: 'service_role', iat: 1785977877, exp: 2101553877 };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const encodedPayload = Buffer.from(JSON.stringify(jwtPayload)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const dataToSign = `${encodedHeader}.${encodedPayload}`;
    const sig = crypto.createHmac('sha256', secretKey).update(dataToSign).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    serviceKey = `${dataToSign}.${sig}`;
  }

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };

  console.log(`=== RECONCILIADOR DE USUÁRIOS AUTH ÓRFÃOS ===`);
  console.log(`Modo: ${applyFix ? 'APLICAÇÃO DE REPARO (--apply)' : 'SOMENTE LEITURA (READ-ONLY)'}`);
  console.log(`Alvo: ${supabaseUrl}\n`);

  // 1. Fetch all Auth users via GoTrue Admin REST endpoint
  const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, { headers });
  if (!authRes.ok) {
    console.error(`Falha ao listar usuários Auth (HTTP ${authRes.status}):`, await authRes.text());
    process.exit(1);
  }

  const authBody = await authRes.json();
  const authUsers = authBody.users || authBody || [];

  // 2. Fetch all user_profiles via PostgREST endpoint
  const profRes = await fetch(`${supabaseUrl}/rest/v1/user_profiles?select=user_id`, { headers });
  if (!profRes.ok) {
    console.error(`Falha ao consultar user_profiles (HTTP ${profRes.status}):`, await profRes.text());
    process.exit(1);
  }

  const profilesData = await profRes.json();
  const profileUserIds = new Set(profilesData.map(p => p.user_id));

  // 3. Identify orphans
  const orphans = authUsers.filter(u => !profileUserIds.has(u.id));

  console.log(`Total de usuários Auth: ${authUsers.length}`);
  console.log(`Total de user_profiles: ${profileUserIds.size}`);
  console.log(`Usuários Auth órfãos detectados: ${orphans.length}\n`);

  if (orphans.length === 0) {
    console.log('Nenhum usuário órfão encontrado. Base 100% consistente.');
    return;
  }

  orphans.forEach((u, i) => {
    console.log(`[ÓRFÃO #${i + 1}] ID: ${u.id} | Email: ${u.email} | Criado em: ${u.created_at}`);
  });

  if (!applyFix) {
    console.log('\nNENHUMA ALTERAÇÃO REALIZADA. Para remover usuários órfãos, execute com a flag --apply.');
    return;
  }

  console.log('\nExecutando limpeza de usuários órfãos...');
  for (const orphan of orphans) {
    const delRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${orphan.id}`, {
      method: 'DELETE',
      headers
    });
    if (!delRes.ok) {
      console.error(`[FALHA DE REMOÇÃO] Usuário ${orphan.id} (${orphan.email}): HTTP ${delRes.status}`);
    } else {
      console.log(`[REMOVIDO] Usuário ${orphan.id} (${orphan.email}) excluído com sucesso.`);
    }
  }

  console.log('\nProcesso de reconciliação finalizado.');
}

main().catch(console.error);
