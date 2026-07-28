import { readFile, writeFile } from 'node:fs/promises';

async function main() {
  let app = await readFile('public/app.js', 'utf8');
  app = app.replaceAll(".from('lojas')", ".from('commercial_clients')");
  app = app.replaceAll("insert([{ nome }])", "insert([{ establishment_name: nome, lifecycle_status: 'ativo' }])");
  await writeFile('public/app.js', app, 'utf8');
  console.log('Fixed lojas in app.js');
}

main();
