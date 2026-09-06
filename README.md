# ☕ Cafe QR Ordering Webapp

Customer scans a table QR → beautiful menu opens → order goes live to dashboard.

## Project structure (cafe only — nothing else lives here)
```
cafe-qr/
├── server.js          # backend: API + realtime + security (the whole brain)
├── public/
│   ├── index.html     # landing page (for customers to discover you)
│   ├── menu.html      # guest menu — what the table QR opens
│   ├── dashboard.html # owner studio — orders, history, menu, meals, QR, settings
│   ├── diag.html      # one-tap health check page
│   ├── manifest.json + sw.js + icons/  # installable-app (PWA) files
├── data/db.json       # your menu, orders, tables (auto-created + backed up)
├── tests/smoke.js     # 30 automated checks (`npm test`)
├── tests/load.js      # 100-order stampede test (`npm run loadtest`)
├── Dockerfile + .dockerignore + .env.example + .gitignore
```

## Run (on your own computer)
```bash
cd cafe-qr
npm install
npm start
```
Then open these **on that same computer only** (`localhost` always means "this device itself" — it will never work from another phone/laptop):
- Landing: http://localhost:3000/
- Customer menu: http://localhost:3000/menu.html?table=T1
- Dashboard: http://localhost:3000/dashboard.html

> Port 3000 busy (another app on your machine uses it)? Start with `PORT=3001 npm start` on Mac/Linux or `set PORT=3001 && npm start` on Windows, then use `http://localhost:3001/...`.

## The real app (for cafes & customers)
Deploy once (see **Deploy** below) and use your stable cloud URL everywhere — QR codes, phones, laptops:
- Menu: `https://YOUR-APP.onrender.com/menu.html?table=T1`
- Dashboard: `https://YOUR-APP.onrender.com/dashboard.html`

## How it works
1. Dashboard → **Tables & QR** → Print QRs, stick on tables.
2. Customer scans → `menu.html?table=T3` opens with table pre-filled.
3. Customer adds to cart → Place order → `POST /api/orders`.
4. Dashboard gets instant `new-order` via Socket.io + sound + badge. Click to advance: pending → preparing → ready → served.
5. Customer tracks status in **My orders**.

## API
- `GET /api/menu`, `POST /api/menu`, `PUT /api/menu/:id`, `DELETE /api/menu/:id`
- `GET /api/tables`, `POST /api/tables`
- `GET /api/orders`, `POST /api/orders`, `PATCH /api/orders/:id`, `GET /api/orders/:id`
- `GET /api/stats`, `GET/POST /api/info`

Data stored in `data/db.json` (no external DB needed, auto-backed-up to `db.json.bak` on every save).

## Deploy (production)
Pick one — no code changes needed (all config via env: `PORT`, `ADMIN_PIN`, `DATA_DIR`):

**Render / Railway / Fly.io (easiest):** push this folder to GitHub → New Web Service → build `npm ci`, start `npm start` → set env `ADMIN_PIN=<secret-pin>` → attach a disk/volume mounted at `/app/data` (or set `DATA_DIR` to it) so orders survive restarts. Health check path: `/api/info`.

**Docker/VPS:** `docker build -t cafe-qr .` → `docker run -d -p 3000:3000 -e ADMIN_PIN=... -v cafe-data:/app/data --restart unless-stopped cafe-qr`. Serve behind HTTPS (Caddy/Nginx/Cloudflare Tunnel).

**Verify any deploy:** `npm test` boots an isolated server and runs 30 security + flow assertions (must be all green).

Single instance only (orders live in one JSON file — do not run 2 replicas on the same data).
- Change the owner PIN from default `1234` (dashboard warns until you do), or set `ADMIN_PIN` in env / `.env`.
- Always serve behind HTTPS (Render/Railway/VPS + TLS, or a tunnel). The app sends `nosniff`, `SAMEORIGIN`, and a tight CSP by default.
- Built-in abuse protection: PIN brute-force lockout (20 tries/10 min), order spam limit (100/10 min/IP), 100 KB body cap, waiter-bell cooldown.
- Customer order tracking uses per-order secret receipt tokens — order IDs alone open nothing.
- Data: `data/db.json` (+ `.bak`). Back it up regularly if you care about history.
