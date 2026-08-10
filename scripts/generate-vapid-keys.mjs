import crypto from 'node:crypto';

export function generateVapidKeyPair() {
  const ec = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });

  // Public key export as uncompressed 65-byte point
  const pubBuffer = ec.publicKey.export({ type: 'spki', format: 'der' });
  // In SPKI DER format for P-256, the last 65 bytes are the uncompressed point (0x04 + X + Y)
  const uncompressedPubKey = pubBuffer.subarray(pubBuffer.length - 65);
  const publicKeyBase64Url = uncompressedPubKey.toString('base64url');

  // Private key export as 32-byte scalar
  const privBuffer = ec.privateKey.export({ type: 'pkcs8', format: 'der' });
  // In PKCS8 DER format for P-256, the 32-byte private key scalar starts at offset (length - 32)
  const scalarPrivKey = privBuffer.subarray(privBuffer.length - 32);
  const privateKeyBase64Url = scalarPrivKey.toString('base64url');

  return {
    publicKey: publicKeyBase64Url,
    privateKey: privateKeyBase64Url
  };
}

if (process.argv[1] && process.argv[1].endsWith('generate-vapid-keys.mjs')) {
  const keys = generateVapidKeyPair();
  console.log('VAPID PUBLIC KEY:', keys.publicKey);
  console.log('VAPID PRIVATE KEY:', keys.privateKey);
}
