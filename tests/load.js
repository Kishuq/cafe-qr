/* Stampede test: N guests order at the SAME instant. Asserts no lost/dupe/
   mispriced orders and measures latency. Run: npm run loadtest (default 100) */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const N = Number(process.argv[2]) || 100;
const PORT = 3458;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-load-'));
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..', env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(BASE + '/api/info'); if (r.ok) up = true; } catch (e) {}
    if (!up) await new Promise(r => setTimeout(r, 500));
  }
  if (!up) { console.log('FAIL server did not boot'); child.kill(); process.exit(1); }
  let pass = 0, fail = 0;
  const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x && !c ? ' => ' + x : ''}`); };
  try {
    // price baseline: c1 Espresso on a FRESH db (no deals) = 99
    const menu = await (await fetch(BASE + '/api/menu')).json();
    const c1 = menu.find(m => m.id === 'c1');
    console.log(`firing ${N} simultaneous orders (1x Espresso @${c1.price} from 10 tables)…`);
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      (async () => {
        const t = Date.now();
        try {
          const r = await fetch(BASE + '/api/orders', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: 'T' + ((i % 10) + 1), items: [{ id: 'c1', qty: 1 }], customerName: 'Load' + i })
          });
          const ms = Date.now() - t;
          return { status: r.status, ms, body: await r.json().catch(() => null) };
        } catch (e) { return { status: -1, ms: Date.now() - t, err: e.message }; }
      })()
    ));
    const wall = Date.now() - t0;
    const good = results.filter(r => r.status === 200 && r.body && r.body.id);
    ok('zero failed orders', good.length === N, `${good.length}/${N} ok`);
    const ids = good.map(r => r.body.id);
    ok('all order IDs unique', new Set(ids).size === ids.length);
    const nums = ids.map(id => +id.split('-')[1]).sort((a, b) => a - b);
    ok('sequence gapless (no lost order)', nums.every((n, i) => n === nums[0] + i), nums.slice(0, 8).join(',') + '…');
    ok('every total exactly 99', good.every(r => r.body.total === c1.price), JSON.stringify(good.filter(r => r.body.total !== c1.price).slice(0, 3)));
    const ms = results.map(r => r.ms).sort((a, b) => a - b);
    console.log(`wall time: ${wall}ms for ${N} orders | p50 ${ms[Math.floor(ms.length / 2)]}ms | p95 ${ms[Math.floor(ms.length * 0.95)]}ms | max ${ms[ms.length - 1]}ms`);
    ok('p95 under 2s', ms[Math.floor(ms.length * 0.95)] < 2000);
    // DB file still valid JSON after the hammering?
    const raw = fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8');
    const db = JSON.parse(raw);
    ok('DB intact + all persisted', db.orders.length === N && db.seq === 100 + N, `orders=${db.orders.length} seq=${db.seq}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('LOAD CRASH', e); process.exit(1); });
