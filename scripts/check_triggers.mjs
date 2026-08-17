import pg from 'pg';
const client = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:54322/postgres' });
await client.connect();

const resFunc = await client.query("SELECT proname, proargnames FROM pg_proc WHERE proname LIKE '%pay%';");
console.log('Payment functions found:', resFunc.rows.map(r => ({ name: r.proname, args: r.proargnames })));

await client.end();
