// Supabase Edge Function: create-client-user
// Contrato de produção para criação segura de clientes comerciais no Supabase Auth + Postgres
// Executa exclusivamente no servidor da Supabase (sem expor service_role no frontend)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: 'Configuração de ambiente inválida no Edge Function.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Validar autorização da requisição (somente Admin ou Owner)
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Não autorizado.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: perfil } = await supabaseAdmin
      .from('user_profiles')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();

    const allowedRoles = ['admin', 'owner'];
    if (!perfil || !allowedRoles.includes(perfil.role)) {
      return new Response(JSON.stringify({ error: 'Acesso restrito a administradores ou proprietários.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Parsear e validar body da requisição
    let payload: any = {};
    try {
      payload = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Corpo da requisição inválido (JSON malformado).' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const {
      establishment_name,
      responsible_name,
      phone,
      email,
      password,
      address,
      complement,
      neighborhood,
      city,
      postal_code,
      document,
      map_color,
      notes,
      pickup_latitude,
      pickup_longitude,
      pickup_place_id,
      street_number,
      route,
      state
    } = payload;

    if (!establishment_name || !responsible_name || !phone || !email || !password || !address) {
      return new Response(JSON.stringify({ error: 'Campos obrigatórios ausentes (nome do estabelecimento, responsável, telefone, e-mail, senha, endereço).' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const emailNorm = String(email).trim().toLowerCase();
    const phoneNorm = String(phone).replace(/\D/g, '');
    const docNorm = document ? String(document).replace(/\D/g, '') : null;

    // 3. Pre-check de duplicidades no banco relacional
    const { data: existingClient } = await supabaseAdmin
      .from('commercial_clients')
      .select('id')
      .or(`email.eq.${emailNorm}${docNorm ? `,document.eq.${docNorm}` : ''}`)
      .limit(1);

    if (existingClient && existingClient.length > 0) {
      return new Response(JSON.stringify({ error: 'E-mail ou Documento (CPF/CNPJ) já cadastrado para outro cliente.' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 4. Criar usuário no Supabase Auth via Admin API
    const { data: authUserData, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
      email: emailNorm,
      password: password,
      email_confirm: true,
      user_metadata: { establishment_name, responsible_name, role: 'client_user' }
    });

    if (createAuthError || !authUserData.user) {
      return new Response(JSON.stringify({ error: `Erro ao criar conta de acesso Auth: ${createAuthError?.message}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const newAuthUserId = authUserData.user.id;

    // 5. Inserir registros relacionais (user_profiles, commercial_clients, client_users) com compensação validada
    try {
      // 5a. Inserir user_profiles
      const { error: profileError } = await supabaseAdmin
        .from('user_profiles')
        .insert([{
          user_id: newAuthUserId,
          name: responsible_name,
          email: emailNorm,
          role: 'client_user',
          is_active: true
        }]);

      if (profileError) throw profileError;

      // 5b. Inserir commercial_clients
      const { data: clientObj, error: clientError } = await supabaseAdmin
        .from('commercial_clients')
        .insert([{
          establishment_name,
          responsible_name,
          phone: phoneNorm,
          email: emailNorm,
          document: docNorm || emailNorm,
          address,
          neighborhood: neighborhood || null,
          city: city || null,
          postal_code: postal_code || null,
          pickup_latitude: pickup_latitude !== undefined && pickup_latitude !== null ? Number(pickup_latitude) : null,
          pickup_longitude: pickup_longitude !== undefined && pickup_longitude !== null ? Number(pickup_longitude) : null,
          pickup_place_id: pickup_place_id || null,
          street_number: street_number || null,
          route: route || null,
          state: state || null,
          lifecycle_status: 'ativo',
          financial_status: 'em_dia'
        }])
        .select()
        .single();

      if (clientError || !clientObj) throw clientError || new Error('Falha ao inserir cliente comercial.');

      // 5c. Inserir client_users
      const { error: clientUserError } = await supabaseAdmin
        .from('client_users')
        .insert([{
          client_id: clientObj.id,
          user_id: newAuthUserId,
          role: 'admin',
          status: 'ativo'
        }]);

      if (clientUserError) throw clientUserError;

      // 5d. Registrar log de auditoria
      await supabaseAdmin.from('system_audit_logs').insert([{
        actor_type: 'admin',
        actor_id: user.id,
        action: 'commercial_client_created',
        details: {
          client_id: clientObj.id,
          public_code: clientObj.public_code,
          establishment_name: clientObj.establishment_name,
          email: clientObj.email_normalized
        }
      }]);

      return new Response(JSON.stringify({
        message: 'Cliente e acesso criados com sucesso.',
        client: clientObj
      }), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (dbErr: any) {
      // 6. Fluxo de Compensação: Excluir Auth User recém-criado em caso de falha relacional
      console.error('Falha relacional. Executando rollback compensatório do usuário Auth:', dbErr);
      const { error: rollbackError } = await supabaseAdmin.auth.admin.deleteUser(newAuthUserId);

      if (rollbackError) {
        console.error('CRITICAL: Erro de reconciliação durante o rollback compensatório:', rollbackError);
        return new Response(JSON.stringify({
          error: `Erro ao criar cadastro relacional (${dbErr.message || dbErr}) e falha ao reconciliar conta Auth (${rollbackError.message}).`,
          reconciliation_failed: true
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        error: `Erro ao criar cadastro relacional: ${dbErr.message || dbErr}. Rollback efetuado com sucesso.`
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Erro interno no servidor.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
