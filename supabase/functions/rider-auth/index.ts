// Supabase Edge Function: rider-auth
// Função autoritativa de autenticação do motoboy no Supabase Auth por Código de 4 dígitos + PIN
// Gera token hash de uso único para verifyOtp no PWA sem expor e-mail ou senhas.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Cache-Control': 'no-store'
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Método não permitido.' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

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

    // 1. Parsear e validar body da requisição
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'Código ou PIN inválido, ou acesso indisponível.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const accessCode = String(body.access_code || body.p_access_code || '').replace(/\D/g, '').trim();
    const pin = String(body.pin || body.p_pin || '').trim();

    if (accessCode.length < 4 || !/^\d{4}$/.test(pin)) {
      return new Response(JSON.stringify({ success: false, error: 'Código ou PIN inválido, ou acesso indisponível.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const code4 = accessCode.slice(-4);

    // 2. Executar validação SQL Server-Side via RPC autoritativa
    const { data: valRes, error: valErr } = await supabaseAdmin.rpc('validate_rider_pin_and_get_auth', {
      p_access_code: code4,
      p_pin: pin
    });

    if (valErr || !valRes || !valRes.success || !valRes.user_id) {
      return new Response(JSON.stringify({ success: false, error: 'Código ou PIN inválido, ou acesso indisponível.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const userId = valRes.user_id;

    // 3. Obter e-mail Auth interno EXCLUSIVAMENTE server-side via Admin API (Sem expor no SQL nem no response)
    const { data: authUserData, error: authUserErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (authUserErr || !authUserData?.user?.email) {
      return new Response(JSON.stringify({ success: false, error: 'Código ou PIN inválido, ou acesso indisponível.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const internalEmail = authUserData.user.email;

    // 4. Gerar Magic Link e extrair hashed_token (sem enviar e-mail externo)
    const { data: linkRes, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: internalEmail
    });

    if (linkErr || !linkRes || !linkRes.properties) {
      return new Response(JSON.stringify({ success: false, error: 'Código ou PIN inválido, ou acesso indisponível.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const props = linkRes.properties as Record<string, any>;
    const tokenHash = props.hashed_token || props.token_hash || null;

    if (!tokenHash) {
      return new Response(JSON.stringify({ success: false, error: 'Código ou PIN inválido, ou acesso indisponível.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 5. Retornar resposta sanitizada contendo somente o token_hash de uso único
    return new Response(JSON.stringify({
      success: true,
      token_hash: tokenHash,
      verification_type: 'email'
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Código ou PIN inválido, ou acesso indisponível.'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
