import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const nodeCompatibleFiles = [
  'admin-panel-bugs-fix.test.mjs',
  'admin-rider-financial_operations_fix.test.mjs',
  'bootstrap-remote-environment.test.mjs',
  'cancel-tele-hardening.test.mjs',
  'clean-baseline-and-client-rpc.test.mjs',
  'cloudflare-pages-runtime-config.test.mjs',
  'commercial-client-access-recovery.test.mjs',
  'commercial-clients-fase1.test.mjs',
  'commercial-clients-full.test.mjs',
  'commercial-clients-loading.test.mjs',
  'console-and-schema-audit.test.mjs',
  'control-center-phase1-2.test.mjs',
  'control-center-phase3.test.mjs',
  'control-center-phase4.test.mjs',
  'control-center-phase5.test.mjs',
  'control-center-redesign-and-fixes.test.mjs',
  'demo-environment-isolation-and-reset.test.mjs',
  'fab-and-novo-cliente.test.mjs',
  'fab-e2e-visibility.test.mjs',
  'financial-phase3a-comprehensive.test.mjs',
  'financial-phase3a-real-concurrency.test.mjs',
  'financial-phase3a.test.mjs',
  'financial-phase3b-admin-actions-ui.test.mjs',
  'financial-phase3b-admin-read-ui.test.mjs',
  'financial-phase3b-read-rpcs.test.mjs',
  'fleet-disconnected-behavior.test.mjs',
  'fleet-map-realtime.test.mjs',
  'homologation-corrections.test.mjs',
  'html-hierarchy-validation.test.mjs',
  'html-structure.test.mjs',
  'idempotency-concurrency-and-rpc.test.mjs',
  'manual-tele-delivery-charge.test.mjs',
  'multi-tenant-rls-hardening.test.mjs',
  'no-demo-content.test.mjs',
  'no-hardcoded-supabase-secrets.test.mjs',
  'owner-financial-chart-lifecycle.test.mjs',
  'quick-action-drawer-phase2.test.mjs',
  'rider-official-login.test.mjs',
  'rider-registration-auth.test.mjs',
  'rls-motoboy-auth-rpc.test.mjs',
  'safari-mobile-login.test.mjs',
  'seed-homologation-safety-locks.test.mjs',
  'tele-manual-and-client-flow.test.mjs'
];

console.log('=====================================================================');
console.log('🚀 EXECUÇÃO DA SUÍTE NODE-COMPATÍVEL DO DA HORA EXPRESSO');
console.log('=====================================================================');

let passCount = 0;
let failCount = 0;
const failedFiles = [];

for (const file of nodeCompatibleFiles) {
  const filePath = path.resolve('tests', file);
  try {
    const start = Date.now();
    execSync(`node --test "${filePath}"`, {
      encoding: 'utf-8',
      env: {
        ...process.env,
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzc4NzcsImV4cCI6MjEwMTU1Mzg3N30.1BoD7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRza2l2YXVzem1oaHRxdGVndndiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTk3Nzg3NywiZXhwIjoyMTAxNTUzODc3fQ.hN8D7gQ7uHnndFSeTeilD90NrXKJX1KRp1WOSf0mdkw',
        DEMO_RESET_ENABLED: 'true'
      },
      stdio: 'pipe'
    });
    const elapsed = Date.now() - start;
    console.log(`✅ [PASS] ${file} (${elapsed}ms)`);
    passCount++;
  } catch (err) {
    console.log(`❌ [FAIL] ${file}`);
    failCount++;
    failedFiles.push({ file, err: err.stdout || err.stderr || err.message });
  }
}

console.log('=====================================================================');
console.log('📊 RESUMO DA SUÍTE NODE-COMPATÍVEL');
console.log('=====================================================================');
console.log(`Total Suítes Executadas: ${nodeCompatibleFiles.length}`);
console.log(`Suítes PASS: ${passCount}`);
console.log(`Suítes FAIL: ${failCount}`);

if (failCount > 0) {
  console.log('\nFailing details:');
  failedFiles.forEach(f => console.log(`- ${f.file}: ${f.err.slice(0, 300)}`));
  process.exit(1);
} else {
  console.log('\n🎉 TODAS AS SUÍTES NODE-COMPATÍVEIS PASSARAM COM SUCESSO!');
}
