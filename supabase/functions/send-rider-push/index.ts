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

    // 1. Segurança Estrita: Requer chave service_role ou JWT autenticado de Owner/Admin/Gerente/Operador
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
        JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Acesso negado à função de envio de notificações.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!vapidPublicKey || !vapidPrivateKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'VAPID keys missing on server.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    webpush.setVapidDetails(
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey
    );

    const body = await req.json().catch(() => ({}));
    const teleId = body.tele_id;

    if (!teleId) {
      return new Response(
        JSON.stringify({ success: false, error: 'tele_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Consulta autoritativa da Tele no banco de dados
    const { data: tele, error: teleErr } = await adminDb
      .from('teles')
      .select('id, tele_code, motoboy_id, status')
      .eq('id', teleId)
      .maybeSingle();

    if (teleErr || !tele || !tele.motoboy_id) {
      return new Response(
        JSON.stringify({ success: false, error: 'Tele not found or no motoboy assigned' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Buscar subscriptions ativas do motoboy
    const { data: subscriptions, error: subErr } = await adminDb
      .from('rider_push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('rider_id', tele.motoboy_id)
      .eq('is_active', true);

    if (subErr || !subscriptions || subscriptions.length === 0) {
      return new Response(
        JSON.stringify({ success: true, delivered: 0, message: 'No active push subscriptions found for this rider.' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Payload sanitizado sem informações sensíveis do cliente ou valores
    const payloadStr = JSON.stringify({
      title: 'Nova Tele recebida',
      body: `${tele.tele_code || 'TEL-XXXXXX'} — nova entrega atribuída`,
      data: {
        tele_id: tele.id,
        tele_code: tele.tele_code,
        action: 'open_tele'
      }
    });

    let successCount = 0;
    const expiredSubIds: string[] = [];

    await Promise.all(
      subscriptions.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };

        try {
          await webpush.sendNotification(pushSubscription, payloadStr);
          successCount++;
        } catch (err: any) {
          const statusCode = err.statusCode || err.status;
          console.warn(`WebPush response status ${statusCode} for sub ID ${sub.id}`);
          if (statusCode === 404 || statusCode === 410) {
            expiredSubIds.push(sub.id);
          }
        }
      })
    );

    // Desativar subscriptions que retornaram 404/410
    if (expiredSubIds.length > 0) {
      await adminDb
        .from('rider_push_subscriptions')
        .update({ is_active: false })
        .in('id', expiredSubIds);
    }

    return new Response(
      JSON.stringify({
        success: true,
        delivered: successCount,
        total: subscriptions.length,
        deactivated: expiredSubIds.length
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Error in send-rider-push:', err.message);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
