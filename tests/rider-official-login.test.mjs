import fs from 'fs';
import assert from 'assert';

console.log('==================================================');
console.log('TESTE AUTOMATIZADO — CONTRATO DE LOGIN OFICIAL DO MOTOBOY (RIDER-AUTH & VERIFYOTP)');
console.log('==================================================\n');

const riderAuthCode = fs.readFileSync('supabase/functions/rider-auth/index.ts', 'utf8');
const motoboyJsCode = fs.readFileSync('public/motoboy.js', 'utf8');

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

// 1. Validar validação SQL e leitura de e-mail server-side
run('1. rider-auth usa RPC validate_rider_pin_and_get_auth e lê e-mail via getUserById server-side', () => {
  assert.ok(riderAuthCode.includes("validate_rider_pin_and_get_auth"), 'Deve chamar RPC validate_rider_pin_and_get_auth');
  assert.ok(riderAuthCode.includes("auth.admin.getUserById"), 'Deve obter e-mail Auth via Admin API getUserById');
  assert.ok(!riderAuthCode.includes("SELECT email FROM auth.users"), 'Não deve consultar schema auth via SQL direto');
});

// 2. Validar generateLink e retorno sanitizado
run('2. Executa generateLink e retorna token_hash com Cache-Control no-store sem logar segredos', () => {
  assert.ok(riderAuthCode.includes("auth.admin.generateLink"), 'Deve chamar generateLink');
  assert.ok(riderAuthCode.includes("type: 'magiclink'"), 'Deve usar type magiclink');
  assert.ok(riderAuthCode.includes("token_hash: tokenHash"), 'Deve retornar token_hash no JSON');
  assert.ok(riderAuthCode.includes("'Cache-Control': 'no-store'"), 'Deve incluir Cache-Control no-store');
  assert.ok(!riderAuthCode.includes("console.log(tokenHash"), 'NUNCA logar o token_hash');
});

// 3. Validar fluxo do PWA no motoboy.js
run('3. motoboy.js executa verifyOtp, auth.getUser() e consulta fleet.user_id', () => {
  assert.ok(motoboyJsCode.includes("functions.invoke('rider-auth'"), 'PWA deve invocar Edge Function rider-auth');
  assert.ok(motoboyJsCode.includes("auth.verifyOtp"), 'PWA deve executar verifyOtp');
  assert.ok(motoboyJsCode.includes("auth.getUser()"), 'PWA deve obter identidade oficial');
  assert.ok(motoboyJsCode.includes(".eq('user_id', user.id)"), 'PWA deve consultar fleet por user_id');
});

// 4. Validar isolamento de storage e remoção de chave informal
run('4. PWA utiliza storageKey isolada e desativa detectSessionInUrl', () => {
  assert.ok(motoboyJsCode.includes("storageKey: 'dahora-rider-auth'"), 'Deve usar storageKey dahora-rider-auth');
  assert.ok(motoboyJsCode.includes("detectSessionInUrl: false"), 'Deve desativar detectSessionInUrl');
  assert.ok(motoboyJsCode.includes("safeRemoveStorage('speedMotoSession')"), 'Deve remover speedMotoSession');
});

console.log('\n==================================================');
console.log(`RESULTADO FINAL: ${passed}/${total} testes aprovados.`);
console.log('==================================================');
