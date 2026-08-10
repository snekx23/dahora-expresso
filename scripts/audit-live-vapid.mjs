import https from 'node:https';

https.get('https://dahora-expresso.pages.dev/runtime-config.js', (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Status code:', res.statusCode);
    const match = body.match(/window\.__ENV_VAPID_PUBLIC_KEY\s*=\s*["']([^"']*)["']/);
    if (match) {
      const key = match[1].trim();
      console.log('Key exists:', Boolean(key));
      console.log('Key length:', key.length);
      console.log('Masked start:', key.slice(0, 4) + '***');
      console.log('Masked end:', '***' + key.slice(-4));
      
      const cleanStr = key.replace(/^["']|["']$/g, '');
      const padding = '='.repeat((4 - (cleanStr.length % 4)) % 4);
      const base64 = (cleanStr + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = Buffer.from(base64, 'base64');
      console.log('Decoded Byte Length:', rawData.length);
      console.log('First byte:', rawData[0] !== undefined ? '0x' + rawData[0].toString(16) : 'N/A');
    } else {
      console.log('VAPID_PUBLIC_KEY match not found in body.');
      console.log('Full body:', body);
    }
  });
});
