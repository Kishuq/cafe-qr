/* Production smoke test: boots an ISOLATED server (temp DATA_DIR) and asserts
   security + business flows end to end. Run: npm test */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3457;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-smoke-'));
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra && !cond ? ' => ' + extra : ''}`); };

async function req(method, p, { body, headers = {}, raw } = {}) {
  const r = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..', env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  // wait for boot
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(BASE + '/api/info'); if (r.ok) up = true; } catch (e) {}
    if (!up) await new Promise(r => setTimeout(r, 500));
  }
  if (!up) { console.log('FAIL server did not boot'); child.kill(); process.exit(1); }
  try {
    // --- public reads ---
    let r = await req('GET', '/api/info');
    ok('info shape, no secrets', r.status === 200 && r.json.cafeName && Array.isArray(r.json.tables) && !('adminPin' in r.json));

    r = await req('GET', '/api/menu');
    ok('menu all valid prices', r.status === 200 && r.json.length >= 12 && r.json.every(m => m.price > 0));

    r = await req('GET', '/api/happyhours/now');
    ok('hh now endpoint', r.status === 200);

    // --- auth ---
    r = await req('POST', '/api/admin/login', { body: { pin: '0000' } });
    ok('wrong PIN 401', r.status === 401);
    r = await req('POST', '/api/admin/login', { body: { pin: '1234' } });
    ok('owner login + default-PIN flag', r.status === 200 && r.json.token && r.json.pinDefault === true);
    const T = { 'x-admin-token': r.json.token };

    r = await req('GET', '/api/orders');
    ok('order list needs token', r.status === 401);

    // --- validation attacks ---
    for (const p of [-5, 0, 'x', 1e12]) {
      r = await req('POST', '/api/menu', { body: { name: 'Hack', price: p }, headers: T });
      if (r.status !== 400) { ok(`bad price ${p} rejected`, false, r.status); break; }
      if (p === 1e12) ok('bad prices rejected', true);
    }
    r = await req('POST', '/api/orders', { body: '{oops', });
    ok('malformed JSON 400', r.status === 400);
    r = await req('POST', '/api/orders', { body: { table: 'T1', items: [], note: 'x'.repeat(120000) } });
    ok('oversize body 413', r.status === 413);
    r = await req('GET', '/api/definitely-not-here');
    ok('unknown API 404 JSON', r.status === 404 && r.json && r.json.error);

    // --- owner menu CRUD + discount math ---
    r = await req('POST', '/api/menu', { body: { name: 'Smoke Cola', category: 'Test', price: 100, off: 25 }, headers: T });
    ok('create dish w/ deal', r.status === 200 && r.json.off === 25);
    const dishId = r.json.id;
    r = await req('PUT', `/api/menu/${dishId}`, { body: { off: 150 }, headers: T });
    ok('discount clamped 0-90', r.status === 200 && r.json.off === 90);

    // --- guest order cycle (2x Espresso 99, no deal on fresh DB) ---
    r = await req('POST', '/api/orders', { body: { table: 't9', items: [{ id: 'c1', qty: 2 }], customerName: 'Smoke' } });
    ok('order totals', r.status === 200 && r.json.total === 198 && r.json.saved === 0 && r.json.table === 'T9' && !!r.json.uuid);
    const oid = r.json.id, uuid = r.json.uuid;

    r = await req('GET', `/api/orders/${oid}`);
    ok('order ID alone => 403', r.status === 403);
    r = await req('GET', `/api/orders/${oid}?t=nope`);
    ok('wrong receipt token => 403', r.status === 403);
    r = await req('GET', `/api/orders/${oid}?t=${uuid}`);
    ok('receipt token => 200', r.status === 200 && r.json.id === oid);

    r = await req('PATCH', `/api/orders/${oid}`, { body: { status: 'ready' } });
    ok('status change needs token', r.status === 401);
    r = await req('PATCH', `/api/orders/${oid}`, { body: { status: 'ready' }, headers: T });
    ok('owner advances status', r.status === 200 && r.json.status === 'ready');

    // --- deal math: Smoke Cola now 90% off => 10 ---
    r = await req('POST', '/api/orders', { body: { table: 'T1', items: [{ id: dishId, qty: 1 }] } });
    ok('discount applied at checkout', r.status === 200 && r.json.total === 10 && r.json.saved === 90);

    // --- combo meal order saves money ---
    r = await req('GET', '/api/menu');
    const meal = r.json.find(m => m.kind === 'meal');
    ok('demo meal seeded w/ live pricing', !!meal && meal.mrp > meal.price && meal.available === true);
    r = await req('POST', '/api/orders', { body: { table: 'T2', items: [{ id: meal.id, qty: 1 }] } });
    ok('meal order banks savings', r.status === 200 && r.json.saved > 0 && r.json.items[0].kind === 'meal');

    // --- waiter bell + cooldown ---
    r = await req('POST', '/api/assistance', { body: { table: 'T2' } });
    ok('waiter ring ok', r.status === 200 && r.json.ok === true);
    r = await req('POST', '/api/assistance', { body: { table: 'T2' } });
    ok('waiter ring cooldown 429', r.status === 429);
    r = await req('GET', '/api/assistance', { headers: T });
    ok('owner sees bell', r.status === 200 && r.json.some(a => a.table === 'T2'));
    r = await req('DELETE', '/api/assistance/T2', { headers: T });
    ok('bell resolved', r.status === 200);

    // --- pages + headers ---
    for (const p of ['/', '/menu.html?table=T1', '/dashboard.html']) {
      r = await req('GET', p);
      ok(`page ${p} 200`, r.status === 200);
    }
    r = await req('GET', '/');
    const csp = r.headers.get('content-security-policy') || '';
    ok('helmet headers + CSP', r.headers.get('x-content-type-options') === 'nosniff' && csp.includes("script-src") && csp.includes('cdn.tailwindcss.com'));

    r = await req('GET', '/api/stats', { headers: T });
    ok('owner stats shape', r.status === 200 && typeof r.json.todayRevenue === 'number');
  } finally {
    child.kill('SIGTERM');
    await new Promise(res => setTimeout(res, 1500));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('SMOKE CRASH', e); process.exit(1); });
