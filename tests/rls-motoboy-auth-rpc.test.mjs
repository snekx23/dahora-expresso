import fs from 'fs';
import assert from 'assert';

console.log('==================================================');
console.log('TESTE DE HOMOLOGAÇÃO — MIGRATION AUTENTICAÇÃO OFICIAL MOTOBOY & RLS');
console.log('==================================================\n');

const motoboyJsCode = fs.readFileSync('public/motoboy.js', 'utf8');
const migrationSql = fs.readFileSync('supabase/migrations/20260806000200_motoboy_official_auth_flow.sql', 'utf8');

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

// 1. Validar migration SQL da RPC autoritativa
run('1. Migration possui SECURITY DEFINER, search_path="", REVOKE de PUBLIC e executa via service_role', () => {
  assert.ok(migrationSql.includes('SECURITY DEFINER'), 'Deve conter SECURITY DEFINER');
  assert.ok(migrationSql.includes("SET search_path = ''"), 'Deve redefinir search_path');
  assert.ok(migrationSql.includes('REVOKE ALL ON FUNCTION public.validate_rider_pin_and_get_auth'), 'Deve revogar validate_rider_pin_and_get_auth de PUBLIC');
  assert.ok(migrationSql.includes('GRANT EXECUTE ON FUNCTION public.validate_rider_pin_and_get_auth(TEXT, TEXT) TO service_role;'), 'Deve conceder EXECUTE apenas para service_role');
  assert.ok(migrationSql.includes('REVOKE ALL ON FUNCTION public.authenticate_rider_access'), 'Deve revogar authenticate_rider_access antiga de PUBLIC/anon');
  assert.ok(!migrationSql.includes("GRANT SELECT ON public.fleet TO anon;"), 'NUNCA conceder SELECT em fleet para anon');
});

// 2. Resposta da RPC e índices únicos
run('2. Resposta da RPC é genérica para código/PIN inválido, sem e-mail ou PIN e índices de duplicidade existem', () => {
  assert.ok(migrationSql.includes("'Código ou PIN inválido, ou acesso indisponível.'"), 'Deve retornar erro genérico');
  assert.ok(!migrationSql.includes("'internal_email'"), 'Não deve retornar e-mail Auth por RPC');
  assert.ok(!migrationSql.includes("'pin_hash'"), 'Não deve incluir pin_hash no payload retornado');
  assert.ok(migrationSql.includes('fleet_active_code_unique_idx'), 'Deve possuir índice único para código ativo');
  assert.ok(migrationSql.includes('fleet_user_id_unique_idx'), 'Deve possuir índice único em fleet.user_id');
});

// 3. Simular login do motoboy no frontend public/motoboy.js via rider-auth Edge Function + verifyOtp
run('3. handleMotoLogin chama exclusivo rider-auth Edge Function e verifyOtp', () => {
  assert.ok(motoboyJsCode.includes("db.functions.invoke('rider-auth'"), 'Deve chamar a Edge Function rider-auth');
  assert.ok(motoboyJsCode.includes("db.auth.verifyOtp"), 'Deve concluir o login via verifyOtp');
  assert.ok(!motoboyJsCode.includes("db.rpc('authenticate_rider_access'"), 'Não deve mais chamar a RPC antiga no frontend');
});

// 4. Coexistência de sessão Owner e PWA com storageKeys isoladas
run('4. Sessão do PWA utiliza storageKey isolada e ignora chave informal antiga', () => {
  assert.ok(motoboyJsCode.includes("storageKey: 'dahora-rider-auth'"), 'PWA deve usar storageKey isolada');
  assert.ok(motoboyJsCode.includes("safeRemoveStorage('speedMotoSession')"), 'Deve remover chave informal antiga');
});

console.log('\n==================================================');
console.log(`RESULTADO FINAL: ${passed}/${total} testes aprovados.`);
console.log('==================================================');
