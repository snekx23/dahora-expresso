// Dahora Expresso — Seed Local de Usuários de Autenticação (Node.js Nativo)
// Executado exclusivamente no ambiente de desenvolvimento 100% local (sem dependências externas).

import dotenv from 'dotenv';
dotenv.config({ path: '.env.bootstrap.remote' });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY é obrigatória.');
}

// Trava de Segurança Estrita: Abortar se tentar rodar em ambiente remoto
const parsedUrl = new URL(SUPABASE_URL);
if (parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== 'localhost') {
  console.error(`[ERRO DE SEGURANÇA] Tentativa de rodar seed-local-users em host não-local: ${parsedUrl.hostname}`);
  process.exit(1);
}

const authHeaders = {
  'apikey': SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json'
};

async function seedLocalUsers() {
  console.log('🌱 Iniciando seed de usuários locais via API Supabase Auth Admin...');

  // 0. Upsert do Cliente Comercial Fictício (Mercado Central)
  await fetch(`${SUPABASE_URL}/rest/v1/commercial_clients`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      id: 'c1111111-1111-4111-a111-111111111111',
      client_code: 'CLI-000101',
      establishment_name: 'Mercado Central',
      responsible_name: 'Carlos Silva',
      phone: '(51) 98888-1111',
      email: 'contato@mercadocentral.local',
      address: 'Rua São João, 125',
      document: '11.222.333/0001-44',
      rider_percentage: 85.00
    })
  });

  const usersToCreate = [
    {
      email: 'admin@dahora.local',
      password: 'senha123456',
      name: 'Administrador Dahora',
      role: 'admin'
    },
    {
      email: 'parceiro@mercadocentral.local',
      password: 'senha123456',
      name: 'Carlos - Mercado Central',
      role: 'client_user',
      clientId: 'c1111111-1111-4111-a111-111111111111'
    },
    {
      email: 'motoboy@dahora.local',
      password: 'senha123456',
      name: 'Guilherme Motoboy',
      role: 'motoboy'
    }
  ];

  // 1. Obter lista de usuários existentes no auth.users
  const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    headers: authHeaders
  });

  if (!listRes.ok) {
    console.error('Erro ao listar usuários auth:', await listRes.text());
    process.exit(1);
  }

  const listData = await listRes.json();
  const existingUsers = listData.users || [];

  for (const item of usersToCreate) {
    let user = existingUsers.find(u => u.email === item.email);

    if (!user) {
      const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          email: item.email,
          password: item.password,
          email_confirm: true,
          user_metadata: { name: item.name }
        })
      });

      if (!createRes.ok) {
        console.error(`Erro ao criar usuário ${item.email}:`, await createRes.text());
        process.exit(1);
      }

      user = await createRes.json();
      console.log(`✅ Usuário criado: ${item.email} (${user.id})`);
    } else {
      console.log(`ℹ️ Usuário já existe: ${item.email} (${user.id})`);
    }

    // 2. Upsert em user_profiles garantindo id == user.id == user_id
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify({
        id: user.id,
        user_id: user.id,
        name: item.name,
        email: item.email,
        role: item.role,
        is_active: true
      })
    });

    if (!profileRes.ok) {
      console.error(`Erro ao criar perfil de usuário para ${item.email}:`, await profileRes.text());
    } else {
      console.log(`  └─ Profile upserted (role: ${item.role})`);
    }

    // 3. Se for client_user, criar vínculo em client_users
    if (item.role === 'client_user' && item.clientId) {
      const cuRes = await fetch(`${SUPABASE_URL}/rest/v1/client_users`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Prefer': 'resolution=ignore-duplicates,return=representation'
        },
        body: JSON.stringify({
          client_id: item.clientId,
          user_id: user.id
        })
      });

      if (!cuRes.ok) {
        console.error(`Erro ao vincular client_user para ${item.email}:`, await cuRes.text());
      } else {
        console.log(`  └─ Client_user link upserted (client_id: ${item.clientId})`);
      }
    }

    // 4. Se for motoboy, criar vínculo em public.fleet
    if (item.role === 'motoboy') {
      const fleetRes = await fetch(`${SUPABASE_URL}/rest/v1/fleet?on_conflict=user_id`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify({
          user_id: user.id,
          motoboy_code: 'MB-0001',
          name: item.name,
          phone: '(51) 99999-1111',
          vehicle: 'Moto Honda CG 160',
          plate: 'ABC-1234',
          status: 'Disponível'
        })
      });

      if (!fleetRes.ok) {
        console.error(`Erro ao criar registro fleet para ${item.email}:`, await fleetRes.text());
      } else {
        console.log(`  └─ Fleet row upserted (motoboy_code: MB-0001)`);
      }
    }
  }


  console.log('🎉 Seed de usuários concluído com sucesso!');
}

seedLocalUsers().catch(err => {
  console.error('Fatal seed error:', err);
  process.exit(1);
});
