const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // correct client IPs behind tunnel/proxy for rate limiting
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');

// ---------- Security headers (CSP tuned for Tailwind CDN + fonts + uploads) ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'https:', 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false // allow CDN images/fonts without CORP headers
}));

// ---------- Abuse protection ----------
const apiLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 1200, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'too many PIN attempts — try again in 10 minutes' } });
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many orders — please wait a few minutes' },
  // Whole cafes share one WiFi IP: count per table, so one spammer can't
  // block the room and a full-house rush never trips the guard.
  keyGenerator: req => `${ipKeyGenerator(req.ip)}::${String((req.body && req.body.table) || '').toUpperCase().slice(0, 10)}`
});
app.use('/api/', apiLimiter);

app.use(cors());
app.use(express.json({ limit: '100kb' })); // reject giant payloads
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Strict input helpers ----------
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max);
const validImg = v => { const s = cleanText(v || '', 500); return /^(https?:\/\/|\/)/i.test(s) ? s : ''; };
const validPrice = v => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 100000 ? Math.round(n) : null; };
const cleanTable = v => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

// ---------- Storage ----------
function defaultMenu() {
  return [
    { id: 'c1', name: 'Espresso', category: 'Coffee', price: 99, desc: 'Bold single-origin shot, rich crema.', img: 'https://images.unsplash.com/photo-1510591509098-f4fdc6d0ff04?w=600&q=80', available: true, veg: true },
    { id: 'c2', name: 'Cappuccino', category: 'Coffee', price: 149, desc: 'Double shot, steamed milk, thick foam.', img: 'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=600&q=80', available: true, veg: true },
    { id: 'c3', name: 'Cafe Latte', category: 'Coffee', price: 159, desc: 'Silky milk, mellow espresso, latte art.', img: 'https://images.unsplash.com/photo-1561047029-3000c68339ca?w=600&q=80', available: true, veg: true },
    { id: 'c4', name: 'Cold Brew', category: 'Coffee', price: 179, desc: '18-hr slow steep, served over ice.', img: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=600&q=80', available: true, veg: true },
    { id: 'c5', name: 'Mocha Frappe', category: 'Coffee', price: 199, off: 20, desc: 'Chocolate + espresso blended with ice.', img: 'https://images.unsplash.com/photo-1577968897966-3d4325b36b61?w=600&q=80', available: true, veg: true },
    { id: 'b1', name: 'Masala Chai', category: 'Tea & More', price: 79, desc: 'Assam tea, ginger, cardamom, milk.', img: 'https://images.unsplash.com/photo-1571934811356-5cc061b6821f?w=600&q=80', available: true, veg: true },
    { id: 'b2', name: 'Fresh Lime Cooler', category: 'Tea & More', price: 99, desc: 'Mint, lime, soda — super refreshing.', img: 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=600&q=80', available: true, veg: true },
    { id: 'f1', name: 'Veg Club Sandwich', category: 'Fast Bites', price: 149, desc: 'Triple layer, mint mayo, fries side.', img: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=600&q=80', available: true, veg: true },
    { id: 'f2', name: 'Peri Peri Fries', category: 'Fast Bites', price: 129, desc: 'Crispy fries dusted with peri peri.', img: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=600&q=80', available: true, veg: true },
    { id: 'f3', name: 'Chicken Pesto Pasta', category: 'Fast Bites', price: 249, desc: 'Creamy pesto, grilled chicken, parmesan.', img: 'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=600&q=80', available: true, veg: false },
    { id: 'd1', name: 'Chocolate Truffle Cake', category: 'Desserts', price: 169, desc: 'Dark ganache, moist sponge slice.', img: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600&q=80', available: true, veg: true },
    { id: 'd2', name: 'Blueberry Cheesecake', category: 'Desserts', price: 199, off: 15, desc: 'Baked cheesecake, berry compote.', img: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=600&q=80', available: true, veg: true }
  ];
}

function loadDB() {
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  try {
    if (fs.existsSync(DB_FILE)) return read(DB_FILE);
  } catch (e) {
    console.error('main DB corrupt, trying backup…', e.message);
    try {
      if (fs.existsSync(DB_FILE + '.bak')) {
        const bak = read(DB_FILE + '.bak');
        console.error('backup restored ✔ (re-saving clean copy)');
        try { fs.writeFileSync(DB_FILE, JSON.stringify(bak, null, 2)); } catch (e2) { /* keep serving from memory */ }
        return bak;
      }
    } catch (e2) { console.error('backup also unreadable:', e2.message); }
  }
  const fresh = {
    cafeName: 'Brew & Bean Cafe',
    tables: ['T1','T2','T3','T4','T5','T6','T7','T8'],
    menu: defaultMenu(),
    orders: [],
    seq: 100
  };
  saveDB(fresh);
  return fresh;
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const data = JSON.stringify(db, null, 2);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, data); // crash before rename => previous good file untouched
  try {
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_FILE + '.bak');
  } catch (e) { /* backup is best-effort */ }
  fs.renameSync(tmp, DB_FILE); // atomic on the same filesystem
}
let db = loadDB();
// Migrade defaults for older db.json files
if (!db.adminPin) db.adminPin = process.env.ADMIN_PIN || '1234';
if (!db.cafeDetails) db.cafeDetails = { address: 'MG Road, Near City Mall', hours: '9 AM – 11 PM, all days', phone: '+91 98765 43210' };
if (!Array.isArray(db.happyHours)) db.happyHours = [];
// Discounts: every dish carries `off` = percent off (0–90). One-time demo seed.
db.menu.forEach(m => { if (m.off === undefined) m.off = 0; });
if (!db.dealsSeeded && !db.menu.some(m => m.off > 0)) {
  const f = db.menu.find(m => m.id === 'c5'); if (f) f.off = 20;
  const c = db.menu.find(m => m.id === 'd2'); if (c) c.off = 15;
  db.dealsSeeded = true;
}
saveDB(db);

// Effective price after discount
function effPrice(m) {
  const off = Math.max(0, Math.min(90, Number(m.off) || 0));
  return off > 0 ? Math.max(1, Math.round(m.price * (1 - off / 100))) : m.price;
}
const clampOff = v => Math.max(0, Math.min(90, Math.round(Number(v) || 0)));

// Happy Hours: time-based auto deals, e.g. {name, pct, categories:[] (=all), days:[0..6] ([]=all), start:'16:00', end:'19:00', active}
function hhActive(rule, at) {
  if (!rule || rule.active === false) return false;
  const d = at instanceof Date ? at : new Date(at);
  const days = Array.isArray(rule.days) && rule.days.length ? rule.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(d.getDay())) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  const toMin = s => { const [h, m] = String(s || '00:00').split(':').map(Number); return h * 60 + (m || 0); };
  const s = toMin(rule.start), e = toMin(rule.end);
  if (e <= s) return t >= s || t < e; // overnight window
  return t >= s && t < e;
}
function hhFor(m, at) { // best live rule for this dish (null when none)
  let best = null;
  for (const r of db.happyHours || []) {
    if (!hhActive(r, at)) continue;
    if (Array.isArray(r.categories) && r.categories.length && !r.categories.includes(m.category)) continue;
    if (!best || r.pct > best.pct) best = r;
  }
  return best;
}
function priceFor(m, at) { // final guest price: better of item deal vs happy hour
  const base = effPrice(m), itemOff = Math.max(0, Math.min(90, Number(m.off) || 0));
  const h = hhFor(m, at || new Date());
  if (h) {
    const cand = Math.max(1, Math.round(m.price * (1 - Math.min(90, h.pct) / 100)));
    if (cand < base) return { price: cand, off: Math.min(90, h.pct), hh: h.name };
  }
  return { price: base, off: itemOff, hh: null };
}
// Waiter calls: in-memory bells, auto-expire after 10 min
let assistCalls = [];
const assistLast = {};
function assistList() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  assistCalls = assistCalls.filter(a => a.at > cutoff);
  return assistCalls;
}

// Meals: menu items with kind:'meal' + contains:[{id,qty}]. Priced as a combo.
function mealSum(m) { // MRP = sum of current effective component prices
  if (!m || m.kind !== 'meal' || !Array.isArray(m.contains)) return 0;
  return m.contains.reduce((s, c) => {
    const d = db.menu.find(x => x.id === c.id && x.kind !== 'meal');
    return s + (d ? effPrice(d) * Math.max(1, Math.min(10, Number(c.qty) || 1)) : 0);
  }, 0);
}
function mealReady(m) { // every component exists & is available
  if (!m || m.kind !== 'meal' || !Array.isArray(m.contains) || !m.contains.length) return false;
  return m.contains.every(c => { const d = db.menu.find(x => x.id === c.id && x.kind !== 'meal'); return d && d.available !== false; });
}
function serveMeal(m) { // enriched meal for the public menu
  const mrp = mealSum(m);
  const off = mrp > m.price ? Math.max(1, Math.min(90, Math.round((1 - m.price / mrp) * 100))) : 0;
  const contains = (m.contains || []).map(c => {
    const d = db.menu.find(x => x.id === c.id);
    return { id: c.id, name: d ? d.name : 'Removed dish', qty: Math.max(1, Math.min(10, Number(c.qty) || 1)) };
  });
  const ready = m.available !== false && mealReady(m);
  return { ...m, mrp, off, contains, available: ready, mealBlocked: m.available !== false && !mealReady(m) };
}
function cleanContains(list) { // validate + dedupe component picks (no nested meals)
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const c of list.slice(0, 8)) {
    const d = db.menu.find(x => x && x.id === (c && c.id) && x.kind !== 'meal');
    if (!d || out.some(o => o.id === d.id)) continue;
    out.push({ id: d.id, qty: Math.max(1, Math.min(10, Number(c.qty) || 1)) });
  }
  return out;
}
// One-time demo meal so owners see the feature instantly
if (!db.mealsSeeded && !db.menu.some(m => m.kind === 'meal')) {
  db.menu.push({ id: 'meal' + crypto.randomBytes(4).toString('hex'), kind: 'meal', name: 'Morning Fuel Combo', category: 'Meals', price: 199, off: 0, desc: 'Espresso + Veg Club Sandwich — the perfect start.', img: 'https://images.unsplash.com/photo-1504754524776-8f4f37790ca0?w=600&q=80', available: true, veg: true, contains: [{ id: 'c1', qty: 1 }, { id: 'f1', qty: 1 }] });
  db.mealsSeeded = true;
  saveDB(db);
}
// One-time demo happy hour (starts OFF so it never surprises anyone)
if (!db.hhSeeded) {
  db.happyHours = db.happyHours || [];
  db.happyHours.push({ id: 'hh' + crypto.randomBytes(4).toString('hex'), name: 'Evening Brews', pct: 15, categories: ['Coffee'], days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', active: false });
  db.hhSeeded = true;
  saveDB(db);
}

// Owner auth: customer pages never need this; dashboard sends it as x-admin-token
let ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'owner login required' });
}

const STATUS_FLOW = ['pending', 'preparing', 'ready', 'served'];

// ---------- API (CUSTOMER — public) ----------
// Cafe info (public, no secrets)
app.get('/api/info', (req, res) => res.json({ cafeName: db.cafeName, tables: db.tables, details: db.cafeDetails }));

// ---------- API (OWNER — PIN protected) ----------
app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (String(req.body.pin || '') === String(db.adminPin))
    return res.json({ ok: true, token: ADMIN_TOKEN, pinDefault: String(db.adminPin) === '1234' && !process.env.ADMIN_PIN });
  return res.status(401).json({ error: 'wrong PIN' });
});
app.post('/api/info', requireAdmin, (req, res) => {
  if (req.body.cafeName) db.cafeName = cleanText(req.body.cafeName, 60) || db.cafeName;
  if (req.body.details) {
    db.cafeDetails = {
      address: cleanText(req.body.details.address || '', 120),
      hours: cleanText(req.body.details.hours || '', 120),
      phone: cleanText(req.body.details.phone || '', 40)
    };
  }
  if (req.body.adminPin && String(req.body.adminPin).length >= 4 && String(req.body.adminPin).length <= 20)
    db.adminPin = String(req.body.adminPin).slice(0, 20);
  saveDB(db); io.emit('info-updated', { cafeName: db.cafeName });
  res.json({ cafeName: db.cafeName, details: db.cafeDetails });
});
// Menu — reading is public (customers), changes need owner login
// (meals are enriched with live combo pricing + availability)
app.get('/api/menu', (req, res) => res.json(db.menu.map(m => m.kind === 'meal' ? serveMeal(m) : m)));
app.post('/api/menu', requireAdmin, (req, res) => {
  const { name, category, price, desc, img, veg, off, kind, contains } = req.body;
  const cleanPrice = validPrice(price);
  if (!cleanText(name, 1) || cleanPrice === null) return res.status(400).json({ error: 'valid name and price (1–100000) required' });
  const item = {
    id: 'm' + crypto.randomBytes(4).toString('hex'),
    name: cleanText(name, 80),
    category: cleanText(category || 'Misc', 40),
    price: cleanPrice,
    off: clampOff(off),
    desc: cleanText(desc || '', 200),
    img: validImg(img) || 'https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=600&q=80',
    available: true, veg: veg !== false
  };
  if (kind === 'meal') { // build a combo meal from existing dishes
    const parts = cleanContains(contains);
    if (!parts || parts.length < 2) return res.status(400).json({ error: 'a meal needs at least 2 dishes' });
    item.kind = 'meal'; item.category = 'Meals'; item.contains = parts; item.off = 0;
    item.veg = parts.every(p => { const d = db.menu.find(x => x.id === p.id); return d && d.veg !== false; });
  }
  db.menu.push(item); saveDB(db); io.emit('menu-updated', db.menu);
  res.json(item);
});
app.put('/api/menu/:id', requireAdmin, (req, res) => {
  const it = db.menu.find(m => m.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  Object.assign(it, {
    name: req.body.name !== undefined ? cleanText(req.body.name, 80) || it.name : it.name,
    category: it.kind === 'meal' ? 'Meals' : (req.body.category !== undefined ? cleanText(req.body.category, 40) || it.category : it.category),
    price: req.body.price !== undefined ? (validPrice(req.body.price) ?? it.price) : it.price,
    off: req.body.off !== undefined ? clampOff(req.body.off) : (it.off || 0),
    desc: req.body.desc !== undefined ? cleanText(req.body.desc, 200) : it.desc,
    img: req.body.img !== undefined ? (validImg(req.body.img) || it.img) : it.img,
    available: req.body.available ?? it.available,
    veg: req.body.veg ?? it.veg
  });
  if (it.kind === 'meal' && req.body.contains !== undefined) { // re-compose the meal
    const parts = cleanContains(req.body.contains);
    if (!parts || parts.length < 2) return res.status(400).json({ error: 'a meal needs at least 2 dishes' });
    it.contains = parts;
    it.veg = parts.every(p => { const d = db.menu.find(x => x.id === p.id); return d && d.veg !== false; });
  }
  saveDB(db); io.emit('menu-updated', db.menu);
  res.json(it);
});
app.delete('/api/menu/:id', requireAdmin, (req, res) => {
  const usedIn = db.menu.filter(m => m.kind === 'meal' && (m.contains || []).some(c => c.id === req.params.id)).length;
  db.menu = db.menu.filter(m => m.id !== req.params.id);
  saveDB(db); io.emit('menu-updated', db.menu);
  res.json({ ok: true, brokeMeals: usedIn });
});

// Tables — list is public (table picker), changes need owner login
app.get('/api/tables', (req, res) => res.json(db.tables));
app.post('/api/tables', requireAdmin, (req, res) => {
  const t = cleanTable(req.body.table);
  if (!t) return res.status(400).json({ error: 'table required (letters/numbers)' });
  if (!db.tables.includes(t)) { db.tables.push(t); saveDB(db); }
  res.json(db.tables);
});
app.delete('/api/tables/:id', requireAdmin, (req, res) => {
  db.tables = db.tables.filter(t => t !== cleanTable(req.params.id));
  saveDB(db); res.json(db.tables);
});

// Happy hours — list + "what's live now" are public (it's marketing); edits need owner login
app.get('/api/happyhours', (req, res) => {
  const now = new Date();
  res.json((db.happyHours || []).map(r => ({ ...r, live: hhActive(r, now) })));
});
app.get('/api/happyhours/now', (req, res) => {
  const now = new Date();
  const live = (db.happyHours || []).filter(r => hhActive(r, now)).sort((a, b) => b.pct - a.pct)[0];
  res.json(live ? { ...live, live: true } : null);
});
function cleanHH(b) {
  const raw = Math.round(Number(b.pct));
  if (!Number.isFinite(raw) || raw < 1 || raw > 90) return null; // garbage pct rejected, not silently coerced
  const pct = raw;
  let days = Array.isArray(b.days) ? b.days.map(Number).filter(d => d >= 0 && d <= 6) : [];
  const cats = Array.isArray(b.categories) ? b.categories.map(c => cleanText(c, 40)).filter(Boolean).slice(0, 10) : [];
  const okTime = s => /^\d{1,2}:\d{2}$/.test(String(s || ''));
  return {
    name: String(b.name || 'Happy Hour').slice(0, 40), pct, categories: cats, days,
    start: okTime(b.start) ? b.start : '16:00', end: okTime(b.end) ? b.end : '19:00',
    active: b.active !== false
  };
}
app.post('/api/happyhours', requireAdmin, (req, res) => {
  const r = cleanHH(req.body); if (!r) return res.status(400).json({ error: 'pct required' });
  r.id = 'hh' + crypto.randomBytes(4).toString('hex');
  db.happyHours.push(r); saveDB(db); res.json(r);
});
app.put('/api/happyhours/:id', requireAdmin, (req, res) => {
  const r = (db.happyHours || []).find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const c = cleanHH({ ...r, ...req.body });
  if (req.body.pct !== undefined && !c) return res.status(400).json({ error: 'pct must be 1–90' });
  Object.assign(r, c || {}, { id: r.id });
  if (req.body.active !== undefined) r.active = req.body.active !== false;
  saveDB(db); res.json(r);
});
app.delete('/api/happyhours/:id', requireAdmin, (req, res) => {
  db.happyHours = (db.happyHours || []).filter(x => x.id !== req.params.id);
  saveDB(db); res.json({ ok: true });
});

// Waiter calls — guests ring, owners see + resolve
app.post('/api/assistance', (req, res) => {
  const table = cleanTable(req.body.table);
  if (!table) return res.status(400).json({ error: 'table required' });
  if (Date.now() - (assistLast[table] || 0) < 90 * 1000)
    return res.status(429).json({ error: 'already called — help is coming!' });
  assistLast[table] = Date.now();
  const call = { table, at: Date.now() };
  assistCalls = assistList().filter(a => a.table !== table).concat([call]);
  io.to('owners').emit('assistance', assistList());
  res.json({ ok: true });
});
app.get('/api/assistance', requireAdmin, (req, res) => res.json(assistList()));
app.delete('/api/assistance/:table', requireAdmin, (req, res) => {
  assistCalls = assistList().filter(a => a.table !== req.params.table.toUpperCase());
  delete assistLast[req.params.table.toUpperCase()];
  io.to('owners').emit('assistance', assistCalls);
  res.json({ ok: true });
});

// Orders — placing + tracking your own order is public; the full list is OWNER ONLY
app.get('/api/orders', requireAdmin, (req, res) => {
  let orders = [...db.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (req.query.status) orders = orders.filter(o => o.status === req.query.status);
  res.json(orders);
});
app.get('/api/orders/:id', (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  // Privacy: owners pass the admin token; guests must present the secret
  // receipt token (?t=uuid) handed out once at order creation. IDs alone open nothing.
  if (req.headers['x-admin-token'] === ADMIN_TOKEN) return res.json(o);
  if (req.query.t && req.query.t === o.uuid) return res.json(o);
  return res.status(403).json({ error: 'private order — open it from the device that placed it' });
});
app.post('/api/orders', orderLimiter, (req, res) => {
  const { table, items, customerName, note } = req.body;
  const cleanT = cleanTable(table);
  if (!cleanT || !Array.isArray(items) || !items.length || items.length > 30)
    return res.status(400).json({ error: 'table and 1–30 items required' });

  const fullItems = [];
  let total = 0, mrpTotal = 0;
  for (const li of items) {
    if (!li || typeof li !== 'object') continue; // malformed line items skipped, never crash
    const m = db.menu.find(x => x.id === li.id);
    if (!m || m.available === false) continue;
    const qty = Math.max(1, Math.min(20, Number(li.qty) || 1));
    if (m.kind === 'meal') { // combo: guest pays meal price, saves vs component sum
      if (!mealReady(m)) continue;
      const mrp = mealSum(m);
      const off = mrp > m.price ? Math.max(1, Math.min(90, Math.round((1 - m.price / mrp) * 100))) : 0;
      fullItems.push({ id: m.id, name: '🍱 ' + m.name, price: m.price, mrp, off, qty, kind: 'meal', contains: serveMeal(m).contains, note: cleanText(li.note || '', 120) });
      total += m.price * qty; mrpTotal += mrp * qty;
      continue;
    }
    const pf = priceFor(m, new Date()); // best of item deal vs live happy hour
    fullItems.push({ id: m.id, name: m.name, price: pf.price, mrp: m.price, off: pf.off, hh: pf.hh, qty, note: cleanText(li.note || '', 120) });
    total += pf.price * qty; mrpTotal += m.price * qty;
  }
  if (!fullItems.length) return res.status(400).json({ error: 'no valid items' });

  db.seq += 1;
  const order = {
    id: 'ORD-' + db.seq,
    uuid: crypto.randomUUID(),
    table: cleanT,
    customerName: cleanText(customerName || 'Guest', 40) || 'Guest',
    note: cleanText(note || '', 200),
    items: fullItems,
    total,
    saved: mrpTotal - total, // total discount the customer got
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.orders.unshift(order);
  if (db.orders.length > 500) db.orders = db.orders.slice(0, 500);
  // auto-add unknown table
  if (!db.tables.includes(order.table)) db.tables.push(order.table);
  saveDB(db);
  io.to('owners').emit('new-order', order);
  io.to('owners').emit('orders-updated', db.orders.slice(0, 100));
  res.json(order);
});
app.delete('/api/orders/:id', requireAdmin, (req, res) => {
  const before = db.orders.length;
  db.orders = db.orders.filter(x => x.id !== req.params.id);
  if (db.orders.length === before) return res.status(404).json({ error: 'not found' });
  saveDB(db);
  io.to('owners').emit('orders-updated', db.orders.slice(0, 100));
  res.json({ ok: true });
});
app.patch('/api/orders/:id', requireAdmin, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  const { status } = req.body;
  if (status && [...STATUS_FLOW, 'cancelled'].includes(status)) o.status = status;
  o.updatedAt = new Date().toISOString();
  saveDB(db);
  io.to('owners').emit('order-updated', o);
  io.to('owners').emit('orders-updated', db.orders.slice(0, 100));
  io.to('order_' + o.id).emit('order-status', o); // live tracking for that customer only
  res.json(o);
});

// Stats — OWNER ONLY
app.get('/api/stats', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todays = db.orders.filter(o => o.createdAt.slice(0, 10) === today && o.status !== 'cancelled');
  const revenue = todays.reduce((s, o) => s + o.total, 0);
  res.json({
    todayOrders: todays.length,
    todayRevenue: revenue,
    pending: db.orders.filter(o => o.status === 'pending').length,
    preparing: db.orders.filter(o => o.status === 'preparing').length,
    ready: db.orders.filter(o => o.status === 'ready').length,
    total: db.orders.length
  });
});

// Socket — only logged-in owner dashboards receive order data.
// (Customers use plain polling for their own order id, so this breaks nothing.)
io.use((socket, next) => {
  socket.isOwner = socket.handshake.auth && socket.handshake.auth.token === ADMIN_TOKEN;
  next();
});
io.on('connection', (socket) => {
  socket.emit('menu-updated', db.menu);
  if (socket.isOwner) { socket.join('owners'); socket.emit('orders-updated', db.orders.slice(0, 100)); }
  // Customers join only their own order room for live status (nothing else leaks).
  // The room key is the secret receipt token — order IDs alone open nothing.
  const watch = socket.handshake.auth && socket.handshake.auth.watchOrder;
  const watchToken = socket.handshake.auth && socket.handshake.auth.watchToken;
  if (watch) {
    const o = db.orders.find(x => x.id === String(watch).slice(0, 20));
    if (o && watchToken && watchToken === o.uuid) socket.join('order_' + o.id);
  }
});

// SPA fallbacks
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));

// JSON 404 for unknown API routes + safe error handler (never leak stacks)
app.use('/api/', (req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large' });
  if (err && err instanceof SyntaxError) return res.status(400).json({ error: 'bad JSON' });
  console.error('request failed:', err && err.message);
  res.status(500).json({ error: 'something went wrong' });
});

server.listen(PORT, () => {
  console.log(`\n  ☕ Brew & Bean QR Ordering running!`);
  console.log(`  Customer menu : http://localhost:${PORT}/menu.html?table=T1`);
  console.log(`  Dashboard     : http://localhost:${PORT}/dashboard.html`);
  console.log(`  Landing       : http://localhost:${PORT}/\n`);
});

// Graceful shutdown (PaaS/Docker SIGTERM): finish requests, flush DB, exit
function shutdown(sig) {
  console.log(`\n${sig} received — flushing data and stopping…`);
  try { saveDB(db); } catch (e) { console.error('final save failed', e.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
