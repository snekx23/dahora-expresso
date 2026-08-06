// =====================================================================
// Dahora Expresso — Supabase Edge Function: Reset Autoritativo do Ambiente DEMO
// File: supabase/functions/reset-demo-environment/index.ts
// =====================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MAX_CLEANUP_BATCH = 50;

function isUserNotFoundError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  const code = (err.code || "").toLowerCase();
  const status = err.status || err.statusCode;
  return (
    status === 404 ||
    code === "user_not_found" ||
    msg.includes("user not found") ||
    msg.includes("user does not exist")
  );
}

function sanitizeErrorCode(err: any): string {
  if (!err) return "UNKNOWN";
  const str = err.code || err.message || "UNKNOWN";
  return String(str).replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 100);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, message: "Method not allowed. Only POST is accepted." }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ success: false, message: "UNAUTHORIZED: Bearer token is missing." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const body = await req.json().catch(() => ({}));
    const confirmation = body.confirmation || body.confirmationText;

    if (confirmation !== "RESTAURAR DEMO") {
      return new Response(
        JSON.stringify({ success: false, message: "INVALID_CONFIRMATION: Exact string RESTAURAR DEMO required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({ success: false, message: "Server environment misconfigured." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false }
    });

    // 1. Invocar RPC Transacional no Postgres
    const { data: rpcResult, error: rpcError } = await userClient.rpc("reset_demo_environment", {
      p_confirmation: confirmation
    });

    if (rpcError) {
      const status = rpcError.message.includes("UNAUTHORIZED") ? 401 :
                     rpcError.message.includes("FORBIDDEN") ? 403 :
                     rpcError.message.includes("RESET_NOT_ALLOWED") ? 403 :
                     rpcError.message.includes("DEMO_BASE_IDENTITIES_INVALID") ? 422 :
                     rpcError.message.includes("RESET_ALREADY_RUNNING") ? 409 : 400;

      return new Response(
        JSON.stringify({ success: false, message: rpcError.message }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Limpeza Server-Side Autoritativa com Claim Atômico via RPC (FOR UPDATE SKIP LOCKED + claim_token)
    if (rpcResult && supabaseServiceRoleKey) {
      const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });

      // Carregar UUIDs canônicos das contas base para dupla validação server-side
      const { data: envSettings, error: envErr } = await adminClient
        .from("environment_settings")
        .select("demo_admin_user_id, demo_client_user_id, demo_rider_user_id")
        .eq("id", "current")
        .maybeSingle();

      if (envErr) {
        return new Response(
          JSON.stringify({ success: false, message: "Failed to read environment settings." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const baseUserIds = new Set([
        envSettings?.demo_admin_user_id,
        envSettings?.demo_client_user_id,
        envSettings?.demo_rider_user_id
      ].filter(Boolean));

      let processedCount = 0;

      while (processedCount < MAX_CLEANUP_BATCH) {
        // Claim atômico autoritativo via Postgres RPC (Retorna claim_token)
        const { data: claimedRows, error: claimErr } = await adminClient.rpc("claim_demo_auth_cleanup_item");

        if (claimErr || !claimedRows || claimedRows.length === 0) {
          break; // Zero itens disponíveis para claim
        }

        const claimedItem = claimedRows[0];
        const queueId = claimedItem.queue_id;
        const authUserId = claimedItem.auth_user_id;
        const claimToken = claimedItem.claim_token;

        // Dupla validação de segurança: Usuário base NUNCA é excluído
        if (baseUserIds.has(authUserId)) {
          await adminClient.rpc("fail_demo_auth_cleanup_item", {
            p_queue_id: queueId,
            p_claim_token: claimToken,
            p_error_code: "CANONICAL_USER_PROTECTED"
          });
          processedCount++;
          continue;
        }

        // Deleção do usuário no Supabase Auth com validação explícita dos retornos
        const { data: deleteData, error: deleteError } = await adminClient.auth.admin.deleteUser(authUserId);

        if (deleteError) {
          // Tratar "User Not Found" como sucesso idempotente
          if (isUserNotFoundError(deleteError)) {
            const { data: isCompleted, error: completeErr } = await adminClient.rpc("complete_demo_auth_cleanup_item", {
              p_queue_id: queueId,
              p_claim_token: claimToken
            });
            if (completeErr || isCompleted !== true) {
              await adminClient.rpc("fail_demo_auth_cleanup_item", {
                p_queue_id: queueId,
                p_claim_token: claimToken,
                p_error_code: "CLAIM_TOKEN_CONFLICT"
              });
            }
          } else {
            await adminClient.rpc("fail_demo_auth_cleanup_item", {
              p_queue_id: queueId,
              p_claim_token: claimToken,
              p_error_code: sanitizeErrorCode(deleteError)
            });
          }
          processedCount++;
          continue;
        }

        // Sucesso na exclusão do Auth -> Marcar completed exigindo o claim_token UUID
        const { data: isCompleted, error: completeErr } = await adminClient.rpc("complete_demo_auth_cleanup_item", {
          p_queue_id: queueId,
          p_claim_token: claimToken
        });

        if (completeErr || isCompleted !== true) {
          await adminClient.rpc("fail_demo_auth_cleanup_item", {
            p_queue_id: queueId,
            p_claim_token: claimToken,
            p_error_code: "CLAIM_TOKEN_CONFLICT"
          });
        }

        processedCount++;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        execution_id: rpcResult.execution_id,
        duration_ms: rpcResult.duration_ms,
        summary: rpcResult.summary
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, message: (err as Error).message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
