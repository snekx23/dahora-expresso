// Supabase Edge Function: create-client-user
// Contrato de produÃ§Ã£o para criaÃ§Ã£o segura de clientes comerciais no Supabase Auth + Postgres
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
      return new Response(JSON.stringify({ error: 'ConfiguraÃ§Ã£o de ambiente invÃ¡lida no Edge Function.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Validar autorizaÃ§Ã£o da requisiÃ§Ã£o (somente Admin ou Owner)
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'NÃ£o autorizado.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: perfil } = await supabaseAdmin
      .from('user_profiles')
      .select('role, is_active')
      .eq('user_id', user.id)
      .maybeSingle();

    const allowedRoles = ['admin', 'owner', 'operador', 'gerente'];
    if (!perfil || !perfil.is_active || !allowedRoles.includes(perfil.role)) {
      return new Response(JSON.stringify({ error: 'Acesso restrito a administradores ou proprietÃ¡rios.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Parsear e validar body da requisiÃ§Ã£o
    let payload: any = {};
    try {
      payload = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Corpo da requisiÃ§Ã£o invÃ¡lido (JSON malformado).' }), {
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
      return new Response(JSON.stringify({ error: 'Campos obrigatÃ³rios ausentes (nome do estabelecimento, responsÃ¡vel, telefone, e-mail, senha, endereÃ§o).' }), {
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
      return new Response(JSON.stringify({ error: 'E-mail ou Documento (CPF/CNPJ) jÃ¡ cadastrado para outro cliente.' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 4. Criar usuÃ¡rio no Supabase Auth via Admin API
    const { data: authUserData, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
      email: emailNorm,
      password: password,
      email_confirm: true,
      user_metadata: { establishment_name, responsible_name, role: 'client_user' }
    });

    if (createAuthError || !authUserData.user) {
      const isDup = createAuthError?.message?.includes('already registered') || createAuthError?.status === 422;
      const status = isDup ? 409 : 400;
      return new Response(JSON.stringify({ error: `E-mail ou Documento (CPF/CNPJ) jÃ¡ cadastrado para outro cliente.` }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const newAuthUserId = authUserData.user.id;

    // 5. InserÃ§Ã£o Relacional AtÃ´mica via RPC transacional Ãºnica
    try {
      const { data: rpcClientObj, error: rpcError } = await supabaseAdmin.rpc('provision_commercial_client_relational', {
        p_actor_user_id: user.id,
        p_auth_user_id: newAuthUserId,
        p_establishment_name: establishment_name,
        p_responsible_name: responsible_name,
        p_phone: phoneNorm,
        p_email: emailNorm,
        p_document: docNorm || emailNorm,
        p_address: address,
        p_complement: complement || null,
        p_neighborhood: neighborhood || null,
        p_city: city || null,
        p_postal_code: postal_code || null,
        p_pickup_latitude: pickup_latitude !== undefined && pickup_latitude !== null ? Number(pickup_latitude) : null,
        p_pickup_longitude: pickup_longitude !== undefined && pickup_longitude !== null ? Number(pickup_longitude) : null,
        p_pickup_place_id: pickup_place_id || null,
        p_street_number: street_number || null,
        p_route: route || null,
        p_state: state || null,
        p_map_color: map_color || '#ffb700',
        p_notes: notes || null,
        p_lifecycle_status: 'ativo',
        p_financial_status: 'em_dia'
      });

      if (rpcError || !rpcClientObj) {
        throw rpcError || new Error('Falha ao executar RPC de provisionamento relacional.');
      }

      return new Response(JSON.stringify({
        message: 'Cliente e acesso criados com sucesso.',
        client: rpcClientObj
      }), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (dbErr: any) {
      // 6. Fluxo de CompensaÃ§Ã£o: Excluir Auth User recÃ©m-criado em caso de falha relacional
      console.error('Falha relacional. Executando rollback compensatÃ³rio do usuÃ¡rio Auth:', dbErr);
      const { error: rollbackError } = await supabaseAdmin.auth.admin.deleteUser(newAuthUserId);

      const isConflict = dbErr.code === '23505' || (dbErr.message && dbErr.message.includes('duplicate key'));
      const status = isConflict ? 409 : 500;
      const errorMsg = isConflict
        ? 'E-mail ou Documento (CPF/CNPJ) jÃ¡ cadastrado para outro cliente.'
        : `Erro ao criar cadastro relacional: ${dbErr.message || dbErr}. Rollback efetuado com sucesso.`;

      if (rollbackError) {
        console.error('CRITICAL: Erro de reconciliaÃ§Ã£o durante o rollback compensatÃ³rio:', rollbackError);
        return new Response(JSON.stringify({
          error: `Erro ao criar cadastro relacional (${dbErr.message || dbErr}) e falha ao reconciliar conta Auth (${rollbackError.message}).`,
          reconciliation_failed: true
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ error: errorMsg }), {
        status,
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
