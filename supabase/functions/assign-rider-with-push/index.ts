import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.6";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-service-key',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || '';
    const vapidPublicKey = (Deno.env.get('VAPID_PUBLIC_KEY') || Deno.env.get('PUSH_VAPID_PUBLIC_KEY') || '').trim();
    const vapidPrivateKey = (Deno.env.get('VAPID_PRIVATE_KEY') || Deno.env.get('PUSH_VAPID_PRIVATE_KEY') || '').trim();
    const vapidSubject = (Deno.env.get('VAPID_SUBJECT') || 'mailto:suporte@dahoraexpresso.com.br').trim();

    const authHeader = req.headers.get('Authorization') || '';
    const internalKeyHeader = req.headers.get('x-internal-service-key') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    const adminDb = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Validar autorização: Apenas Owner/Admin/Gerente/Operador autenticado ou chamada com service_role key
    let isAuthorized = false;
    if (token === supabaseServiceKey || internalKeyHeader === supabaseServiceKey) {
      isAuthorized = true;
    } else if (token) {
      const { data: userData, error: userErr } = await adminDb.auth.getUser(token);
      if (!userErr && userData && userData.user) {
        const { data: profile } = await adminDb
          .from('user_profiles')
          .select('role, is_active')
          .eq('user_id', userData.user.id)
          .maybeSingle();

        if (profile && profile.is_active !== false && ['owner', 'admin', 'gerente', 'operador'].includes(profile.role)) {
          isAuthorized = true;
        }
      }
    }

    if (!isAuthorized) {
      return new Response(
        JSON.stringify({ success: false, error: 'FORBIDDEN', message: 'Acesso negado. Requer perfil Owner/Admin.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Ler parâmetros de atribuição
    const body = await req.json().catch(() => ({}));
    const { tele_id, motoboy_id, rider_id, expected_version, reason, reassignment_reason } = body;
    const targetRiderId = motoboy_id || rider_id;

    if (!tele_id || !targetRiderId || expected_version === undefined) {
      return new Response(
        JSON.stringify({ success: false, error: 'INVALID_PARAMETERS', message: 'tele_id, motoboy_id e expected_version são obrigatórios.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Execução Autoritativa da Atribuição via RPC no banco relacional
    const { data: rpcRes, error: rpcErr } = await adminDb.rpc('assign_rider_to_tele', {
      p_tele_id: tele_id,
      p_motoboy_id: targetRiderId,
      p_expected_version: parseInt(expected_version, 10),
      p_reason: reason ? String(reason).trim() : null,
      p_reassignment_reason: reassignment_reason ? String(reassignment_reason).trim() : null
    });

    if (rpcErr || !rpcRes || !rpcRes.success) {
      const errCode = rpcRes?.error || rpcErr?.code || 'ASSIGNMENT_FAILED';
      const errMsg = rpcRes?.message || rpcErr?.message || 'Falha ao atribuir entregador no banco de dados.';
      return new Response(
        JSON.stringify({ success: false, error: errCode, message: errMsg }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ATRIBUIÇÃO NO BANCO CONCLUÍDA COM SUCESSO!
    const assignmentResult = rpcRes;
    let pushSent = false;
    let pushErrorMsg = null;

    // 4. Disparo Interno de Notificação Web Push Server-Side
    if (vapidPublicKey && vapidPrivateKey) {
      try {
        webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

        const { data: teleData } = await adminDb
          .from('teles')
          .select('id, tele_code, motoboy_id')
          .eq('id', tele_id)
          .maybeSingle();

        if (teleData && teleData.motoboy_id) {
          const { data: subscriptions } = await adminDb
            .from('rider_push_subscriptions')
            .select('id, endpoint, p256dh, auth')
            .eq('rider_id', teleData.motoboy_id)
            .eq('is_active', true);

          if (subscriptions && subscriptions.length > 0) {
            const payloadStr = JSON.stringify({
              title: 'Nova Tele recebida',
              body: `${teleData.tele_code || 'TEL-XXXXXX'} — nova entrega atribuída`,
              data: {
                tele_id: teleData.id,
                tele_code: teleData.tele_code,
                action: 'open_tele'
              }
            });

            const expiredSubIds: string[] = [];

            await Promise.all(
              subscriptions.map(async (sub) => {
                try {
                  await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    payloadStr
                  );
                  pushSent = true;
                } catch (err: any) {
                  const statusCode = err.statusCode || err.status;
                  console.warn(`[PUSH WARNING] Sub ${sub.id} returned status ${statusCode}: ${err.message}`);
                  if (statusCode === 404 || statusCode === 410) {
                    expiredSubIds.push(sub.id);
                  }
                }
              })
            );

            if (expiredSubIds.length > 0) {
              await adminDb
                .from('rider_push_subscriptions')
                .update({ is_active: false })
                .in('id', expiredSubIds);
            }
          }
        }
      } catch (pushErr: any) {
        pushErrorMsg = pushErr.message;
        console.error('[PUSH DISPATCH ERROR] Web Push dispatch failed, but assignment is preserved:', pushErr.message);
      }
    }

    return new Response(
      JSON.stringify({
        ...assignmentResult,
        push_sent: pushSent,
        push_error: pushErrorMsg
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    console.error('Error in assign-rider-with-push Edge Function:', err.message);
    return new Response(
      JSON.stringify({ success: false, error: 'INTERNAL_ERROR', message: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
