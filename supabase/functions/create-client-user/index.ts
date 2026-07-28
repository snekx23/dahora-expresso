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
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Configuração de ambiente inválida no Edge Function.');
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Validar autorização da requisição (somente Admin)
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
      .from('perfis')
      .select('papel')
      .eq('id', user.id)
      .single();

    if (!perfil || perfil.papel !== 'admin') {
      return new Response(JSON.stringify({ error: 'Acesso restrito a administradores.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Parsear body da requisição
    const payload = await req.json();
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
      document,
      map_color,
      notes
    } = payload;

    if (!establishment_name || !responsible_name || !phone || !email || !password || !address) {
      return new Response(JSON.stringify({ error: 'Campos obrigatórios ausentes.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const emailNorm = email.trim().toLowerCase();
    const phoneNorm = phone.replace(/\D/g, '');
    const docNorm = document ? document.replace(/\D/g, '') : null;

    // 3. Verificar duplicidades no banco relacional
    const { data: existingClient } = await supabaseAdmin
      .from('commercial_clients')
      .select('id')
      .or(`email_normalized.eq.${emailNorm}${docNorm ? `,document_normalized.eq.${docNorm}` : ''}`)
      .limit(1);

    if (existingClient && existingClient.length > 0) {
      return new Response(JSON.stringify({ error: 'Email ou Documento (CPF/CNPJ) já cadastrado.' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 4. Criar usuário no Supabase Auth via Admin API
    const { data: authUserData, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
      email: emailNorm,
      password: password,
      email_confirm: true,
      user_metadata: { establishment_name, responsible_name, role: 'client_admin' }
    });

    if (createAuthError || !authUserData.user) {
      return new Response(JSON.stringify({ error: `Erro ao criar conta de acesso: ${createAuthError?.message}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const newAuthUserId = authUserData.user.id;

    // 5. Inserir registros relacionais com bloco de compensação
    try {
      const { data: clientObj, error: clientError } = await supabaseAdmin
        .from('commercial_clients')
        .insert([{
          establishment_name,
          responsible_name,
          phone_normalized: phoneNorm,
          email_normalized: emailNorm,
          document_normalized: docNorm,
          address,
          complement,
          neighborhood,
          city,
          map_color,
          notes,
          lifecycle_status: 'ativo',
          financial_status: 'em_dia'
        }])
        .select()
        .single();

      if (clientError || !clientObj) throw clientError || new Error('Falha ao inserir cliente.');

      const { error: clientUserError } = await supabaseAdmin
        .from('client_users')
        .insert([{
          client_id: clientObj.id,
          user_id: newAuthUserId,
          role: 'client_admin',
          status: 'ativo'
        }]);

      if (clientUserError) throw clientUserError;

      // Registrar auditoria (SEM guardar senhas!)
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
      // Compensação: Rollback do Auth User se a gravação no banco falhar
      console.error('Erro relacional. Executando rollback do usuário Auth:', dbErr);
      await supabaseAdmin.auth.admin.deleteUser(newAuthUserId);

      return new Response(JSON.stringify({
        error: `Erro ao criar cadastro relacional: ${dbErr.message || dbErr}. Rollback executado.`
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
