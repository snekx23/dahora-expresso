import dotenv from 'dotenv';
import webpush from 'web-push';
import crypto from 'node:crypto';

dotenv.config({ path: '.env.bootstrap.remote' });

const pubKey = process.env.VAPID_PUBLIC_KEY;
const privKey = process.env.VAPID_PRIVATE_KEY;
const subject = process.env.VAPID_SUBJECT || 'mailto:suporte@dahoraexpresso.com.br';

console.log('Testing VAPID keypair verification...');

try {
  webpush.setVapidDetails(subject, pubKey, privKey);
  console.log('[PASS] webpush.setVapidDetails accepted the keypair without errors.');

  // Decodificação Base64URL da chave pública
  const cleanStr = pubKey.trim().replace(/^["']|["']$/g, '');
  const padding = '='.repeat((4 - (cleanStr.length % 4)) % 4);
  const base64 = (cleanStr + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Buffer.from(base64, 'base64');

  console.log('Public Key Base64URL length:', pubKey.length);
  console.log('Public Key byteLength:', bytes.length);
  console.log('First byte (hex):', '0x' + bytes[0].toString(16));

  if (bytes.length === 65 && bytes[0] === 0x04) {
    console.log('[PASS] Public Key is a valid 65-byte uncompressed EC P-256 key.');
  } else {
    console.error('[FAIL] Public Key structure is INVALID!');
  }
} catch (err) {
  console.error('[FAIL] VAPID Keypair is INVALID:', err.message);
}
