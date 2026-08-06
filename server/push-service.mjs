// =====================================================================
// Dahora Expresso — Módulo Backend de Emissão de Web Push (Node.js)
// Arquivo: server/push-service.mjs
// =====================================================================

import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carregar variáveis do .env local
dotenv.config({ path: join(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  throw new Error('PUSH_SERVICE_ERROR: A variável SUPABASE_SERVICE_ROLE_KEY é obrigatória.');
}

// TRAVA OBRIGATÓRIA DE AMBIENTE LOCAL
if (!SUPABASE_URL.includes('localhost') && !SUPABASE_URL.includes('127.0.0.1')) {
  throw new Error('PUSH_SERVICE_SAFETY_LOCK: O serviço de Push somente pode ser executado em ambiente local!');
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa40yY5z2L9n-0-0-0-0-0-0-0-0-0-0-0-0-0-0';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'local_vapid_private_key_secret_for_backend_push';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:suporte@dahora.local';

// Validação do VAPID_SUBJECT na inicialização
if (!VAPID_SUBJECT.startsWith('mailto:') && !VAPID_SUBJECT.startsWith('https:')) {
  throw new Error("VAPID_SUBJECT inválido: deve começar com 'mailto:' ou 'https:'");
}

// Inicializar cliente Supabase exclusivo de servidor (com Service Role e sem sessão compartilhada)
const dbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

// Configurar WebPush VAPID no servidor
try {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} catch (err) {
  console.warn("⚠️ Aviso ao configurar VAPID no WebPush backend:", err.message);
}

// Tabela de backoff progressivo em segundos (15s, 30s, 60s, 120s)
const BACKOFF_INTERVALS = [15, 30, 60, 120];

/**
 * Processa a fila de outbox pendente com claim atômico e worker token
 */
export async function processNotificationOutbox() {
  try {
    // 1. Recuperar itens abandonados em processing por workers anteriores
    await dbAdmin.rpc('recover_stale_notification_outbox', { p_stale_after: '2 minutes' }).catch(() => null);

    // 2. Gerar token único deste worker para este lote
    const workerToken = crypto.randomUUID();

    // 3. Claim atômico via RPC backend-only (FOR UPDATE SKIP LOCKED)
    const { data: claimedItems, error: claimErr } = await dbAdmin.rpc('claim_rider_notification_outbox', {
      p_limit: 20,
      p_worker_token: workerToken
    });

    if (claimErr || !claimedItems || claimedItems.length === 0) {
      return { processed: 0 };
    }

    let processedCount = 0;

    for (const item of claimedItems) {
      // Buscar subscrições ativas do entregador
      const { data: subs, error: subErr } = await dbAdmin
        .from('rider_push_subscriptions')
        .select('*')
        .eq('rider_id', item.rider_id)
        .eq('is_active', true);

      // Tratamento quando não houver subscrições ativas
      if (subErr || !subs || subs.length === 0) {
        await dbAdmin
          .from('rider_notification_outbox')
          .update({
            status: 'failed',
            processed_at: new Date().toISOString(),
            last_error: 'no_active_subscription',
            worker_token: null,
            processing_started_at: null
          })
          .eq('id', item.id)
          .eq('status', 'processing')
          .eq('worker_token', workerToken);
        continue;
      }

      let sendSuccessCount = 0;
      let expiredCount = 0;
      let lastErrorMessage = null;

      for (const sub of subs) {
        // Validar formato exato exigido pelo web-push
        if (!sub.endpoint || !sub.p256dh || !sub.auth) {
          continue;
        }

        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };

        const pushPayload = JSON.stringify(item.payload || {});

        try {
          await webpush.sendNotification(pushSubscription, pushPayload);
          sendSuccessCount++;

          // Atualizar subscrição bem-sucedida
          await dbAdmin
            .from('rider_push_subscriptions')
            .update({
              last_used_at: new Date().toISOString(),
              failure_count: 0,
              last_error: null,
              updated_at: new Date().toISOString()
            })
            .eq('id', sub.id);

        } catch (pushErr) {
          const statusCode = pushErr.statusCode || pushErr.status;
          lastErrorMessage = `HTTP ${statusCode || 'ERR'}: ${pushErr.message || String(pushErr)}`;

          // Tratar endpoints expirados ou removidos (404 / 410 Gone)
          if (statusCode === 404 || statusCode === 410) {
            expiredCount++;
            await dbAdmin
              .from('rider_push_subscriptions')
              .update({
                is_active: false,
                failure_count: (sub.failure_count || 0) + 1,
                last_error: 'subscription_expired',
                updated_at: new Date().toISOString()
              })
              .eq('id', sub.id);
          } else {
            // Falhas temporárias (429, 5xx, timeout, rede)
            await dbAdmin
              .from('rider_push_subscriptions')
              .update({
                failure_count: (sub.failure_count || 0) + 1,
                last_error: lastErrorMessage.substring(0, 100),
                updated_at: new Date().toISOString()
              })
              .eq('id', sub.id);
          }
        }
      }

      // Finalização segura filtrando por id + status + worker_token
      if (sendSuccessCount > 0) {
        // Sucesso em ao menos um aparelho -> outbox sent
        await dbAdmin
          .from('rider_notification_outbox')
          .update({
            status: 'sent',
            processed_at: new Date().toISOString(),
            last_error: null,
            worker_token: null,
            processing_started_at: null
          })
          .eq('id', item.id)
          .eq('status', 'processing')
          .eq('worker_token', workerToken);
        processedCount++;
      } else if (expiredCount === subs.length) {
        // Todas as subscrições do entregador expiraram
        await dbAdmin
          .from('rider_notification_outbox')
          .update({
            status: 'failed',
            processed_at: new Date().toISOString(),
            last_error: 'all_subscriptions_expired',
            worker_token: null,
            processing_started_at: null
          })
          .eq('id', item.id)
          .eq('status', 'processing')
          .eq('worker_token', workerToken);
      } else {
        // Falha temporária -> aplicar retry com backoff progressivo
        const newAttempt = (item.attempt_count || 0) + 1;
        if (newAttempt >= 5) {
          await dbAdmin
            .from('rider_notification_outbox')
            .update({
              status: 'failed',
              attempt_count: newAttempt,
              processed_at: new Date().toISOString(),
              last_error: lastErrorMessage ? lastErrorMessage.substring(0, 100) : 'Limite de 5 tentativas atingido.',
              worker_token: null,
              processing_started_at: null
            })
            .eq('id', item.id)
            .eq('status', 'processing')
            .eq('worker_token', workerToken);
        } else {
          const backoffSec = BACKOFF_INTERVALS[newAttempt - 1] || 120;
          const nextTime = new Date(Date.now() + backoffSec * 1000).toISOString();
          await dbAdmin
            .from('rider_notification_outbox')
            .update({
              status: 'pending',
              attempt_count: newAttempt,
              next_attempt_at: nextTime,
              last_error: lastErrorMessage ? lastErrorMessage.substring(0, 100) : 'Falha temporária de envio.',
              worker_token: null,
              processing_started_at: null
            })
            .eq('id', item.id)
            .eq('status', 'processing')
            .eq('worker_token', workerToken);
        }
      }
    }

    return { processed: processedCount };
  } catch (err) {
    console.error("Erro no processamento do outbox push:", err.message);
    return { error: err.message };
  }
}
