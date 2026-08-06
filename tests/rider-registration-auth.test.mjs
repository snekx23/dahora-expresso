import fs from 'fs';
import assert from 'assert';

console.log('==================================================');
console.log('TESTE AUTOMATIZADO — CONTRATO DE CADASTRO DO MOTOBOY (EDGE FUNCTION & DB)');
console.log('==================================================\n');

const createRiderCode = fs.readFileSync('supabase/functions/create-rider-user/index.ts', 'utf8');
const migrationSql = fs.readFileSync('supabase/migrations/20260806000200_motoboy_official_auth_flow.sql', 'utf8');
const appJsCode = fs.readFileSync('public/app.js', 'utf8');

let passed = 0;
let total = 0;

function run(desc, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${desc}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

// 1. Validar autorização por perfil Owner/Admin em user_profiles
run('1. create-rider-user exige JWT no header Authorization e valida role owner/admin em user_profiles', () => {
  assert.ok(createRiderCode.includes("req.headers.get('Authorization')"), 'Deve extrair token do header Authorization');
  assert.ok(createRiderCode.includes(".from('user_profiles')"), 'Deve consultar a tabela user_profiles');
  assert.ok(createRiderCode.includes("allowedRoles = ['owner', 'admin']"), 'Deve permitir apenas owner ou admin');
  assert.ok(!createRiderCode.includes("req.headers.get('x-role')"), 'Não deve confiar em header de role do cliente');
});

// 2. Validar criação no Auth e atribuição de role em user_profiles
run('2. Cria usuário em auth.users com e-mail interno e cria user_profiles com role="motoboy"', () => {
  assert.ok(createRiderCode.includes("supabaseAdmin.auth.admin.createUser"), 'Deve chamar createUser no Auth');
  assert.ok(createRiderCode.includes("@auth.dahora.local"), 'E-mail Auth deve ser no formato interno @auth.dahora.local');
  assert.ok(createRiderCode.includes("role: 'motoboy'"), 'Em user_profiles a role deve ser "motoboy" conforme o CHECK constraint');
});

// 3. Validar status inicial e vinculação em fleet
run('3. Novo motoboy é criado em public.fleet com status="Indisponível" e user_id preenchido', () => {
  assert.ok(createRiderCode.includes("status: 'Indisponível'"), 'Status inicial do motoboy deve ser "Indisponível"');
  assert.ok(createRiderCode.includes("user_id: createdAuthUserId"), 'fleet.user_id deve receber o ID do Auth');
  assert.ok(createRiderCode.includes("set_rider_pin_hash"), 'PIN deve ser gravado via set_rider_pin_hash');
});

// 4. Validar compensação em caso de falha relacional
run('4. Possui mecanismo de compensação/rollback para apagar auth.users se a inserção relacional falhar', () => {
  assert.ok(createRiderCode.includes("deleteUser(createdAuthUserId)"), 'Deve deletar usuário Auth em caso de rollback');
  assert.ok(createRiderCode.includes("Já existe um motoboy ativo utilizando os mesmos quatro últimos dígitos do telefone"), 'Deve retornar erro amigável de duplicidade');
});

// 5. Validar resposta sanitizada e integração do frontend Painel
run('5. Resposta do cadastro é sanitizada e public/app.js invoca a Edge Function com storageKey de Owner', () => {
  const successResponseBlock = createRiderCode.match(/return new Response\(JSON\.stringify\(\{\s*success: true,[\s\S]*?\}\)/)[0];
  assert.ok(!successResponseBlock.includes('email'), 'Resposta de sucesso da Edge Function não deve retornar e-mail Auth');
  assert.ok(!successResponseBlock.includes('password'), 'Resposta de sucesso da Edge Function não deve retornar senha Auth');
  assert.ok(appJsCode.includes("functions.invoke('create-rider-user'"), 'app.js deve invocar a Edge Function create-rider-user');
  assert.ok(appJsCode.includes("storageKey: 'dahora-owner-auth'"), 'app.js deve usar storageKey isolada para Owner');
});

console.log('\n==================================================');
console.log(`RESULTADO FINAL: ${passed}/${total} testes aprovados.`);
console.log('==================================================');
