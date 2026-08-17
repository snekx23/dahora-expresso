import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

import { processNotificationOutbox } from './server/push-service.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 8000;
const HOST = '127.0.0.1';

const ENABLE_PUSH_WORKER = false;

let pushWorkerRunning = false;

async function runPushWorker() {
  if (pushWorkerRunning) return;
  pushWorkerRunning = true;
  try {
    await processNotificationOutbox();
  } catch (error) {
    console.error('[PUSH WORKER] Falha resumida:', error.message);
  } finally {
    pushWorkerRunning = false;
  }
}

if (ENABLE_PUSH_WORKER) {
  setInterval(runPushWorker, 5000);
}




const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// In-memory store for dev mock mode when Supabase is disconnected
const devClientsStore = [];
const devAuditStore = [];
const devTelesStore = new Map();
const devRidersStore = new Map();
let devClientCodeSeq = 1;

const server = http.createServer((req, res) => {
  let reqUrl = req.url.split('?')[0];

  // Enable CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (reqUrl === '/api/vapid-public-key' && req.method === 'GET') {
    const publicKey = process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa40yY5z2L9n-0-0-0-0-0-0-0-0-0-0-0-0-0-0';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ publicKey }));
    return;
  }

  // Handle Secure Backend API Route (Dev Adapter & Real Local Provisioner)
  if (reqUrl === '/api/admin/create-client' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        // 1. Validar conexÃ£o estritamente loopback local (127.0.0.1 / ::1 / ::ffff:127.0.0.1)
        const remoteIp = req.socket.remoteAddress || req.connection?.remoteAddress || '';
        const allowedIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
        if (!allowedIps.includes(remoteIp)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Acesso negado: rota restrita a loopback local.' }));
          return;
        }

        // 2. Validar token Bearer JWT
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
        if (!token) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'NÃ£o autorizado: token Bearer JWT ausente ou malformado.' }));
          return;
        }

        const payload = JSON.parse(body || '{}');
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
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Campos obrigatÃ³rios ausentes (nome do estabelecimento, responsÃ¡vel, telefone, e-mail, senha, endereÃ§o).' }));
          return;
        }

        if (password.length < 6) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'A senha deve conter no mÃ­nimo 6 caracteres.' }));
          return;
        }

        const emailNorm = email.trim().toLowerCase();
        const phoneNorm = phone.replace(/\D/g, '');
        const docNorm = document ? document.replace(/\D/g, '') : null;

        // Provision directly into local Supabase GoTrue + DB
        try {
          const secretKey = 'super-secret-jwt-token-with-at-least-32-characters-long';
          const header = { alg: 'HS256', typ: 'JWT' };
          const jwtPayload = { iss: 'supabase', ref: 'tskivauszmhhtqtegvwb', role: 'service_role', iat: 1785977877, exp: 2101553877 };
          const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
          const encodedPayload = Buffer.from(JSON.stringify(jwtPayload)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
          const dataToSign = `${encodedHeader}.${encodedPayload}`;
          const sig = crypto.createHmac('sha256', secretKey).update(dataToSign).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
          const localServiceRoleKey = `${dataToSign}.${sig}`;

          const supabaseAdmin = createClient('http://127.0.0.1:54321', localServiceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false }
          });

          // 3. Validar token JWT do Admin via GoTrue auth.getUser(token)
          const { data: authUser, error: authErr } = await supabaseAdmin.auth.getUser(token);
          if (authErr || !authUser?.user) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'SessÃ£o administrativa invÃ¡lida ou expirada.' }));
            return;
          }

          const actorUserId = authUser.user.id;

          // 4. Validar perfil do Admin em user_profiles (is_active e roles permitidas)
          const { data: actorProfile } = await supabaseAdmin
            .from('user_profiles')
            .select('role, is_active')
            .eq('user_id', actorUserId)
            .maybeSingle();

          const allowedRoles = ['owner', 'admin', 'operador', 'gerente'];
          if (!actorProfile || !actorProfile.is_active || !allowedRoles.includes(actorProfile.role)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Acesso negado: permissÃ£o administrativa insuficiente.' }));
            return;
          }

          // 5. Pre-check de duplicidades no banco relacional
          const { data: existingClient } = await supabaseAdmin
            .from('commercial_clients')
            .select('id')
            .or(`email.eq.${emailNorm}${docNorm ? `,document.eq.${docNorm}` : ''}`)
            .limit(1);

          if (existingClient && existingClient.length > 0) {
            res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'E-mail ou Documento (CPF/CNPJ) jÃ¡ cadastrado para outro cliente.' }));
            return;
          }

          // 6. Criar usuÃ¡rio no Auth GoTrue via Admin API
          const { data: authUserData, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
            email: emailNorm,
            password: password,
            email_confirm: true,
            user_metadata: { establishment_name, responsible_name, role: 'client_user' }
          });

          if (createAuthError || !authUserData?.user) {
            const msg = (createAuthError?.message || '').toLowerCase();
            const isDup = msg.includes('already registered') || msg.includes('already been registered') || createAuthError?.status === 422;
            const statusCode = isDup ? 409 : 400;
            res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `E-mail ou Documento (CPF/CNPJ) jÃ¡ cadastrado para outro cliente.` }));
            return;
          }

          const newAuthUserId = authUserData.user.id;

          // 7. Chamada AtÃ´mica Ã  RPC provision_commercial_client_relational
          try {
            const { data: rpcClientObj, error: rpcError } = await supabaseAdmin.rpc('provision_commercial_client_relational', {
              p_actor_user_id: actorUserId,
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

            if (rpcError || !rpcClientObj) throw rpcError || new Error('Falha ao executar RPC relacional.');

            res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              message: 'Cliente e acesso criados com sucesso.',
              client: rpcClientObj
            }));
            return;

          } catch (dbErr) {
            console.error('Falha relacional. Executando rollback compensatÃ³rio do usuÃ¡rio Auth:', dbErr);
            const isConflict = dbErr.code === '23505' || (dbErr.message && dbErr.message.includes('duplicate key'));
            const statusCode = isConflict ? 409 : 500;
            const errorMsg = isConflict
              ? 'E-mail ou Documento (CPF/CNPJ) jÃ¡ cadastrado para outro cliente.'
              : `Erro ao criar cadastro relacional: ${dbErr.message || dbErr}. Rollback efetuado com sucesso.`;

            await supabaseAdmin.auth.admin.deleteUser(newAuthUserId);
            res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: errorMsg }));
            return;
          }

        } catch (sbErr) {
          console.warn('Fallback to devClientsStore mock adapter error:', sbErr);
          const publicCode = `CLI-${String(devClientCodeSeq++).padStart(6, '0')}`;
          const newClient = {
            id: `client-uuid-${Date.now()}`,
            client_code: publicCode,
            establishment_name,
            responsible_name,
            phone_normalized: phoneNorm,
            email_normalized: emailNorm,
            document_normalized: docNorm,
            lifecycle_status: 'ativo',
            financial_status: 'em_dia',
            address,
            complement: complement || '',
            neighborhood: neighborhood || '',
            city: city || '',
            map_color: map_color || '#3b82f6',
            notes: notes || '',
            created_at: new Date().toISOString()
          };
          devClientsStore.push(newClient);

          res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            message: 'Cliente e acesso criados com sucesso (mock).',
            client: newClient
          }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Erro no servidor: ${err.message}` }));
      }
    });
    return;
  }

  // GET Dev endpoint for clients list check in dev mode
  if (reqUrl === '/api/admin/clients' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ clients: devClientsStore, audit: devAuditStore }));
    return;
  }

  // RESET Dev endpoint for automated tests
  if (reqUrl === '/api/admin/reset-test-db' && (req.method === 'POST' || req.method === 'DELETE')) {
    devClientsStore.length = 0;
    devAuditStore.length = 0;
    devClientCodeSeq = 1;
    devTelesStore.clear();
    devRidersStore.clear();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Store de teste resetado com sucesso.' }));
    return;
  }

  // POST Dev Endpoint: CriaÃ§Ã£o de Tele Manual pelo Administrador
  if (reqUrl === '/api/admin/create-tele' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk.toString(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const { client_id, pickup_address, delivery_address, recipient_name, recipient_phone, idempotency_key, reference, notes, order_value } = body;

        if (!client_id) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'CLIENT_SELECTION_REQUIRED', message: 'Selecione um cliente comercial cadastrado.' }));
          return;
        }

        if (!delivery_address || !delivery_address.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'DELIVERY_ADDRESS_REQUIRED', message: 'EndereÃ§o de entrega Ã© obrigatÃ³rio.' }));
          return;
        }

        if (!recipient_name || !recipient_name.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'RECIPIENT_NAME_REQUIRED', message: 'Nome do destinatÃ¡rio Ã© obrigatÃ³rio.' }));
          return;
        }

        if (!recipient_phone || !recipient_phone.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'RECIPIENT_PHONE_REQUIRED', message: 'Telefone do destinatÃ¡rio Ã© obrigatÃ³rio.' }));
          return;
        }

        const val = Number(order_value || 0);
        if (val < 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'INVALID_ORDER_VALUE', message: 'Valor do pedido nÃ£o pode ser negativo.' }));
          return;
        }

        if (val > 50000) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'ORDER_VALUE_LIMIT_EXCEEDED', message: 'Valor do pedido excede o limite mÃ¡ximo de R$ 50.000,00.' }));
          return;
        }

        const teleId = `tele-uuid-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const seq = devTelesStore.size + 1;
        const teleCode = `TEL-${String(seq).padStart(6, '0')}`;

        const newTele = {
          id: teleId,
          tele_code: teleCode,
          client_id,
          status: 'solicitada',
          origin: (pickup_address || '').trim(),
          address: delivery_address.trim(),
          dest_name: recipient_name.trim(),
          dest_phone: recipient_phone.trim(),
          delivery_reference: (reference || '').trim() || null,
          notes: (notes || '').trim() || null,
          total_order_amount: val,
          valor: 15.00,
          delivery_charge: 15.00,
          pricing_rule_source: 'fallback_default',
          pricing_rule_version: 'v1_fallback',
          version: 1,
          client_request_idempotency_key: idempotency_key,
          created_at: new Date().toISOString()
        };

        devTelesStore.set(teleId, newTele);

        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          is_idempotent: false,
          tele_id: teleId,
          tele_code: teleCode,
          tele: newTele
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error_code: 'SERVER_ERROR', message: err.message }));
      }
    });
    return;
  }

  // POST Dev Endpoint: Despacho Seguro & ConcorrÃªncia Otimista (assign-rider)
  if (reqUrl === '/api/operations/assign-rider' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk.toString(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const { tele_id, rider_id, expected_version, reason } = body;

        // 1. Obter ou inicializar tele em devStore
        let tele = devTelesStore.get(String(tele_id));
        if (!tele) {
          tele = {
            id: String(tele_id),
            status: 'solicitada',
            version: 1,
            motoboy_id: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          devTelesStore.set(String(tele_id), tele);
        }

        // 2. Obter ou inicializar rider em devRidersStore
        let rider = devRidersStore.get(String(rider_id));
        if (!rider) {
          rider = {
            id: String(rider_id),
            name: 'Motoboy Dev ' + rider_id,
            status: 'DisponÃ­vel',
            simultaneous_limit: 3
          };
          devRidersStore.set(String(rider_id), rider);
        }

        // 3. Validar Status ImutÃ¡vel
        const currentNorm = (tele.status || '').toLowerCase();
        if (['concluido', 'concluida', 'entregue', 'cancelado', 'cancelada'].includes(currentNorm)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'TELE_STATUS_INVALID', message: 'NÃ£o Ã© possÃ­vel despachar uma Tele concluÃ­da ou cancelada.' }));
          return;
        }

        // 4. Validar VersÃ£o Otimista
        if (expected_version !== undefined && expected_version !== null && tele.version !== expected_version) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'TELE_VERSION_CONFLICT', message: 'Esta Tele foi atualizada por outro operador. Os dados serÃ£o recarregados.', current_version: tele.version }));
          return;
        }

        // 5. Validar Status do Motoboy
        if (['IndisponÃ­vel', 'Bloqueado', 'Inativo'].includes(rider.status)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'RIDER_UNAVAILABLE', message: 'Motoboy indisponÃ­vel para novos despachos.' }));
          return;
        }

        // 6. Validar ReatribuiÃ§Ã£o (Troca de Motoboy)
        const previousRiderId = tele.motoboy_id;
        if (previousRiderId && String(previousRiderId) !== String(rider_id)) {
          if (!reason || !reason.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error_code: 'REASSIGN_REASON_REQUIRED', message: 'Motivo obrigatÃ³rio para trocar de motoboy.' }));
            return;
          }
        }

        // 7. Validar Capacidade SimultÃ¢nea
        let activeCount = 0;
        devTelesStore.forEach(t => {
          if (String(t.motoboy_id) === String(rider_id) && !['concluido', 'concluida', 'cancelado', 'cancelada'].includes((t.status || '').toLowerCase())) {
            activeCount++;
          }
        });

        const limit = rider.simultaneous_limit || 3;
        if (activeCount >= limit) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: false,
            error_code: 'RIDER_CAPACITY_REACHED',
            message: `Capacidade limite atingida para ${rider.name} (${activeCount}/${limit}).`,
            rider_name: rider.name,
            active_count: activeCount,
            limit: limit
          }));
          return;
        }

        // 8. AtualizaÃ§Ã£o AtÃ´mica Em MemÃ³ria
        tele.version = (tele.version || 1) + 1;
        tele.motoboy_id = String(rider_id);
        tele.status = 'motoboy_designado';
        tele.updated_at = new Date().toISOString();

        devAuditStore.push({
          action: previousRiderId ? 'rider_reassigned' : 'rider_assigned',
          tele_id,
          rider_id,
          previous_rider_id: previousRiderId,
          reason,
          version: tele.version,
          created_at: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          tele_id,
          rider_id,
          rider_name: rider.name,
          status: 'motoboy_designado',
          version: tele.version,
          active_count: activeCount + 1,
          simultaneous_limit: limit,
          updated_at: tele.updated_at
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error_code: 'INTERNAL_ERROR', message: 'Erro interno ao processar despacho.' }));
      }
    });
    return;
  }

  // POST Dev Endpoint: ConclusÃ£o Idempotente da Tele (complete-tele)
  if (reqUrl === '/api/operations/complete-tele' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk.toString(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const { tele_id, expected_version, completion_source } = body;

        let tele = devTelesStore.get(String(tele_id));
        if (!tele) {
          tele = {
            id: String(tele_id),
            status: 'em_entrega',
            motoboy_id: String(tele_id).includes('SEM-MOTOBOY') ? null : 'MB-100',
            version: 1,
            valor: 15.00,
            created_at: new Date().toISOString()
          };
          devTelesStore.set(String(tele_id), tele);
        }

        const normStatus = (tele.status || '').toLowerCase();
        if (['concluido', 'concluida', 'entregue'].includes(normStatus)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            is_idempotent: true,
            tele_id,
            status: 'concluida',
            version: tele.version,
            message: 'Tele jÃ¡ havia sido concluÃ­da anteriormente.'
          }));
          return;
        }

        if (['cancelado', 'cancelada'].includes(normStatus)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'TELE_ALREADY_CANCELLED', message: 'NÃ£o Ã© possÃ­vel concluir uma Tele cancelada.' }));
          return;
        }

        if (expected_version !== undefined && expected_version !== null && tele.version !== expected_version) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'TELE_VERSION_CONFLICT', message: 'Esta Tele foi atualizada por outro operador. Os dados serÃ£o recarregados.', current_version: tele.version }));
          return;
        }

        if (!tele.motoboy_id) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'TELE_WITHOUT_RIDER', message: 'A Tele precisa ter um motoboy atribuÃ­do antes de ser concluÃ­da.' }));
          return;
        }

        // ResoluÃ§Ã£o Financeira no Backend (80% Motoboy, 20% Empresa)
        const rawPrice = typeof tele.valor === 'number' ? tele.valor : parseFloat(String(tele.price || '15').replace(/[^\d.,]/g, '').replace(',', '.') || '15');
        const valorCliente = isNaN(rawPrice) || rawPrice <= 0 ? 15.00 : rawPrice;
        const valorMotoboy = Math.round(valorCliente * 0.80 * 100) / 100;
        const taxaEmpresa = Math.round((valorCliente - valorMotoboy) * 100) / 100;

        tele.version = (tele.version || 1) + 1;
        tele.status = 'concluida';
        tele.completed_at = new Date().toISOString();
        tele.updated_at = new Date().toISOString();

        devAuditStore.push({
          action: 'tele_completed',
          tele_id,
          source: completion_source || 'operator',
          valor_cliente: valorCliente,
          valor_motoboy: valorMotoboy,
          taxa_empresa: taxaEmpresa,
          version: tele.version,
          created_at: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          tele_id,
          status: 'concluida',
          version: tele.version,
          valor_cliente: valorCliente,
          valor_motoboy: valorMotoboy,
          taxa_empresa: taxaEmpresa,
          completed_at: tele.completed_at
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error_code: 'INTERNAL_ERROR', message: 'Erro interno ao concluir Tele.' }));
      }
    });
    return;
  }

  // POST Dev Endpoint: Cancelamento Controlado da Tele (cancel-tele)
  if (reqUrl === '/api/operations/cancel-tele' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk.toString(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const { tele_id, expected_version, reason, charge_policy } = body;

        if (!reason || !reason.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'CANCELLATION_REASON_REQUIRED', message: 'Motivo do cancelamento Ã© obrigatÃ³rio.' }));
          return;
        }

        let tele = devTelesStore.get(String(tele_id));
        if (!tele) {
          tele = { id: String(tele_id), status: 'solicitada', version: 1, created_at: new Date().toISOString() };
          devTelesStore.set(String(tele_id), tele);
        }

        const normStatus = (tele.status || '').toLowerCase();
        if (['concluido', 'concluida', 'entregue'].includes(normStatus)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'TELE_ALREADY_COMPLETED', message: 'NÃ£o Ã© possÃ­vel cancelar uma Tele que jÃ¡ foi concluÃ­da.' }));
          return;
        }

        if (expected_version !== undefined && expected_version !== null && tele.version !== expected_version) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error_code: 'TELE_VERSION_CONFLICT', message: 'Esta Tele foi atualizada por outro operador. Os dados serÃ£o recarregados.' }));
          return;
        }

        tele.version = (tele.version || 1) + 1;
        tele.status = 'cancelada';
        tele.cancelled_at = new Date().toISOString();
        tele.cancellation_reason = reason;
        tele.updated_at = new Date().toISOString();

        devAuditStore.push({
          action: 'tele_cancelled',
          tele_id,
          reason,
          policy: charge_policy || 'sem_cobranca',
          version: tele.version,
          created_at: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          tele_id,
          status: 'cancelada',
          version: tele.version,
          cancelled_at: tele.cancelled_at
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error_code: 'INTERNAL_ERROR', message: 'Erro interno ao cancelar Tele.' }));
      }
    });
    return;
  }

  if (reqUrl === '/') reqUrl = '/index.html';

  const safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, 'public', safePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://localhost:${PORT}/ and http://192.168.1.13:${PORT}/`);
});
