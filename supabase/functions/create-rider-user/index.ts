// Supabase Edge Function: create-rider-user
// Contrato de produção para criação segura de motoboys no Supabase Auth + Postgres
// Executa exclusivamente no servidor Supabase (sem expor service_role no frontend)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let createdAuthUserId: string | null = null;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ success: false, error: 'Configuração de ambiente inválida no Edge Function.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Validar autorização do solicitante via JWT no header Authorization
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (!token) {
      return new Response(JSON.stringify({ success: false, error: 'Não autorizado. Token de sessão ausente.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: { user: requesterUser }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !requesterUser) {
      return new Response(JSON.stringify({ success: false, error: 'Não autorizado. Sessão do administrador inválida.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Confirmar role em public.user_profiles (Owner/Admin)
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('role')
      .eq('user_id', requesterUser.id)
      .maybeSingle();

    const allowedRoles = ['owner', 'admin'];
    if (!profile || !allowedRoles.includes(profile.role)) {
      return new Response(JSON.stringify({ success: false, error: 'Acesso restrito a administradores ou proprietários.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. Parsear e validar body da requisição
    let payload: any = {};
    try {
      payload = await req.json();
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'Body da requisição inválido (JSON malformado).' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { name, phone, vehicle, plate, pin } = payload;
    const nameNorm = String(name || '').trim();
    const phoneDigits = String(phone || '').replace(/\D/g, '');
    const vehicleNorm = String(vehicle || '').trim();
    const plateNorm = String(plate || '').trim().toUpperCase();
    const pinNorm = String(pin || '').trim();

    if (!nameNorm || !phoneDigits || !pinNorm) {
      return new Response(JSON.stringify({ success: false, error: 'Nome, Telefone e PIN são obrigatórios.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      return new Response(JSON.stringify({ success: false, error: 'Informe um telefone válido com DDD (10 ou 11 dígitos).' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!/^\d{4}$/.test(pinNorm)) {
      return new Response(JSON.stringify({ success: false, error: 'O PIN deve conter exatamente 4 números.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const code4 = phoneDigits.slice(-4);
    const motoboyCode = `MB-${code4}`;

    // 4. Pre-check de duplicidade concorrente de motoboy ativo
    const { data: existingActive } = await supabaseAdmin
      .from('fleet')
      .select('id, name')
      .or(`motoboy_code.eq.${motoboyCode},motoboy_code.eq.${code4}`)
      .not('status', 'in', '("Inativo","Suspenso","Bloqueado","inativo","suspenso","bloqueado")')
      .maybeSingle();

    if (existingActive) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Já existe um motoboy ativo utilizando os mesmos quatro últimos dígitos do telefone.'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 5. Gerar e-mail e senha aleatória para o Auth interno
    const internalEmail = `rider.${crypto.randomUUID()}@auth.dahora.local`;
    const strongPassword = `PassRider!${crypto.randomUUID()}${Math.random().toString(36).slice(2)}`;

    // 6. Criar Usuário no Supabase Auth
    const { data: authRes, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: internalEmail,
      password: strongPassword,
      email_confirm: true,
      user_metadata: {
        role: 'rider'
      }
    });

    if (authErr || !authRes.user) {
      return new Response(JSON.stringify({ success: false, error: `Falha ao criar credenciais Auth: ${authErr?.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    createdAuthUserId = authRes.user.id;

    // 7. Tentar escrita relacional com compensação em caso de erro
    try {
      // 7.1 Inserir perfil em user_profiles (role: 'motoboy')
      const { error: profileErr } = await supabaseAdmin
        .from('user_profiles')
        .insert([{
          user_id: createdAuthUserId,
          name: nameNorm,
          email: internalEmail,
          role: 'motoboy',
          access_level: 'operador',
          is_active: true
        }]);

      if (profileErr) throw profileErr;

      // 7.2 Inserir registro em public.fleet com status inicial 'Indisponível'
      const { data: newFleet, error: fleetErr } = await supabaseAdmin
        .from('fleet')
        .insert([{
          user_id: createdAuthUserId,
          motoboy_code: motoboyCode,
          name: nameNorm,
          phone: phoneDigits,
          vehicle: vehicleNorm,
          plate: plateNorm,
          status: 'Indisponível',
          simultaneous_limit: 3
        }])
        .select('id')
        .single();

      if (fleetErr) throw fleetErr;

      // 7.3 Definir PIN Hash via RPC autoritativa server-side
      const { error: pinErr } = await supabaseAdmin.rpc('set_rider_pin_hash', {
        p_rider_id: newFleet.id,
        p_pin: pinNorm
      });

      if (pinErr) throw pinErr;

      // 8. Resposta de Sucesso Sanitizada (Sem e-mail, sem senha, sem PIN hash)
      return new Response(JSON.stringify({
        success: true,
        rider_id: newFleet.id,
        motoboy_code: motoboyCode,
        name: nameNorm,
        message: 'Motoboy cadastrado com sucesso.'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (dbErr: any) {
      // 9. Compensação / Rollback em caso de erro relacional
      if (createdAuthUserId) {
        try {
          await supabaseAdmin.from('fleet').delete().eq('user_id', createdAuthUserId);
          await supabaseAdmin.from('user_profiles').delete().eq('user_id', createdAuthUserId);
          await supabaseAdmin.auth.admin.deleteUser(createdAuthUserId);
        } catch (cleanupErr) {
          console.error(`[COMPENSATION ERROR] Cleanup parcial falhou para ID ${createdAuthUserId}:`, cleanupErr);
        }
      }

      const errMsg = (dbErr.message || '').toLowerCase();
      if (errMsg.includes('unique') || dbErr.code === '23505') {
        return new Response(JSON.stringify({
          success: false,
          error: 'Já existe um motoboy ativo utilizando os mesmos quatro últimos dígitos do telefone.'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: false,
        error: `Erro ao salvar cadastro do motoboy: ${dbErr.message || String(dbErr)}`
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

  } catch (err: any) {
    if (createdAuthUserId) {
      try {
        const supabaseAdmin = createClient(
          Deno.env.get('SUPABASE_URL') || '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || '',
          { auth: { autoRefreshToken: false, persistSession: false } }
        );
        await supabaseAdmin.auth.admin.deleteUser(createdAuthUserId);
      } catch {}
    }

    return new Response(JSON.stringify({
      success: false,
      error: `Exceção no cadastro do motoboy: ${err.message || String(err)}`
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
