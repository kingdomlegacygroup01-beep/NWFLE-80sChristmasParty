const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const QUESTIONS_EMAIL = process.env.QUESTIONS_EMAIL || 'info.nwfle@gmail.com';

/* ---------------- Storage: Postgres on Railway, JSON file locally ---------------- */
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /railway\.internal/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  store = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS rsvps (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        headcount INTEGER NOT NULL,
        dish_type TEXT NOT NULL,
        dish TEXT NOT NULL,
        notes TEXT,
        kids_count INTEGER NOT NULL DEFAULT 0,
        kids_ages TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query('ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS kids_count INTEGER NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS kids_ages TEXT');
    },
    async upsert(r) {
      const { rows } = await pool.query(
        `INSERT INTO rsvps (name, email, phone, headcount, dish_type, dish, notes, kids_count, kids_ages)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone,
           headcount=EXCLUDED.headcount, dish_type=EXCLUDED.dish_type, dish=EXCLUDED.dish,
           notes=EXCLUDED.notes, kids_count=EXCLUDED.kids_count, kids_ages=EXCLUDED.kids_ages, updated_at=now()
         RETURNING (xmax <> 0) AS updated`,
        [r.name, r.email, r.phone, r.headcount, r.dish_type, r.dish, r.notes, r.kids_count, r.kids_ages]
      );
      return { updated: rows[0].updated };
    },
    async all() {
      const { rows } = await pool.query('SELECT * FROM rsvps ORDER BY created_at ASC');
      return rows;
    },
    async remove(id) {
      await pool.query('DELETE FROM rsvps WHERE id=$1', [id]);
    },
  };
} else {
  const file = path.join(__dirname, 'data', 'rsvps.json');
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  const write = (d) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 2)); };
  store = {
    async init() {},
    async upsert(r) {
      const d = read();
      const now = new Date().toISOString();
      const i = d.findIndex((x) => x.email === r.email);
      if (i >= 0) { d[i] = { ...d[i], ...r, updated_at: now }; write(d); return { updated: true }; }
      d.push({ id: d.reduce((m, x) => Math.max(m, x.id), 0) + 1, ...r, created_at: now, updated_at: now });
      write(d);
      return { updated: false };
    },
    async all() { return read(); },
    async remove(id) { write(read().filter((x) => x.id !== Number(id))); },
  };
  console.warn('DATABASE_URL not set — using local JSON file (data/rsvps.json).');
}

/* ---------------- App ---------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
// Static files live at the repo root; only these are served.
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/flyer.jpg': 'flyer.jpg' };
app.get(Object.keys(STATIC), (req, res, next) => {
  const f = path.join(__dirname, STATIC[req.path]);
  if (!fs.existsSync(f)) return next();
  res.set('Cache-Control', 'public, max-age=300').sendFile(f);
});

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

app.get('/api/config', (req, res) => res.json({ questionsEmail: QUESTIONS_EMAIL }));

app.post('/api/rsvp', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot for bots
  const r = {
    name: clean(b.name, 100),
    email: clean(b.email, 200).toLowerCase(),
    phone: clean(b.phone, 30) || null,
    headcount: parseInt(b.headcount, 10),
    dish_type: clean(b.dish_type, 20),
    dish: clean(b.dish, 200),
    notes: clean(b.notes, 500) || null,
    kids_count: b.kids_count === undefined || b.kids_count === '' ? 0 : parseInt(b.kids_count, 10),
    kids_ages: clean(b.kids_ages, 200) || null,
  };
  if (r.kids_count === 0) r.kids_ages = null;
  const errors = [];
  if (!r.name) errors.push('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) errors.push('Please enter a valid email address.');
  if (!Number.isInteger(r.headcount) || r.headcount < 1 || r.headcount > 30) errors.push('Headcount must be between 1 and 30.');
  if (!['Side dish', 'Dessert', 'Both'].includes(r.dish_type)) errors.push('Please choose side dish, dessert, or both.');
  if (!r.dish) errors.push('Please tell us what you are bringing.');
  if (!Number.isInteger(r.kids_count) || r.kids_count < 0 || r.kids_count > 15) errors.push('Number of children for daycare must be between 0 and 15.');
  else if (r.kids_count > r.headcount) errors.push('Children for daycare cannot be more than your total party size.');
  else if (r.kids_count > 0 && !r.kids_ages) errors.push("Please list the ages of the children you're bringing to daycare.");
  if (errors.length) return res.status(400).json({ ok: false, errors });
  try {
    const { updated } = await store.upsert(r);
    res.json({ ok: true, updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, errors: ['Something went wrong saving your RSVP. Please try again.'] });
  }
});

/* ---------------- Organizer view (HTTP Basic auth, password = ADMIN_PASSWORD) ---------------- */
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Organizer page is disabled until ADMIN_PASSWORD is set.');
  const hdr = req.headers.authorization || '';
  const pass = hdr.startsWith('Basic ') ? Buffer.from(hdr.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="NWFLE RSVP Organizers"').status(401).send('Login required');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

app.get('/admin', requireAdmin, async (req, res) => {
  const rows = await store.all();
  const total = rows.reduce((s, r) => s + Number(r.headcount), 0);
  const kids = rows.reduce((s, r) => s + Number(r.kids_count || 0), 0);
  const count = (t) => rows.filter((r) => r.dish_type === t || r.dish_type === 'Both').length;
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RSVPs · 80s Christmas Party</title><link rel="stylesheet" href="/style.css"></head>
<body class="admin"><main class="wrap">
<h1 class="neon-pink">RSVP Dashboard</h1>
<div class="stats">
  <div class="stat"><span>${total}</span>Total headcount</div>
  <div class="stat"><span>${rows.length}</span>RSVPs</div>
  <div class="stat"><span>${kids}</span>Children in daycare</div>
  <div class="stat"><span>${count('Side dish')}</span>Bringing sides</div>
  <div class="stat"><span>${count('Dessert')}</span>Bringing desserts</div>
</div>
<p><a class="btn small" href="/admin/export.csv">Download CSV</a></p>
<div class="table-wrap"><table>
<thead><tr><th>Name</th><th>Count</th><th>Bringing</th><th>Daycare</th><th>Contact</th><th>Notes</th><th>Updated</th><th></th></tr></thead>
<tbody>${rows.map((r) => `<tr>
<td>${esc(r.name)}</td><td class="num">${r.headcount}</td>
<td><b>${esc(r.dish_type)}:</b> ${esc(r.dish)}</td>
<td>${Number(r.kids_count) ? `<b>${r.kids_count}</b> (ages ${esc(r.kids_ages)})` : '—'}</td>
<td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.phone ? `<br>${esc(r.phone)}` : ''}</td>
<td>${esc(r.notes || '')}</td><td>${fmt(r.updated_at)}</td>
<td><form method="post" action="/admin/delete/${r.id}" onsubmit="return confirm('Delete RSVP from ${esc(r.name).replace(/'/g, '')}?')"><button class="link">Delete</button></form></td>
</tr>`).join('') || '<tr><td colspan="8">No RSVPs yet.</td></tr>'}</tbody></table></div>
</main></body></html>`);
});

app.get('/admin/export.csv', requireAdmin, async (req, res) => {
  const rows = await store.all();
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Name', 'Email', 'Phone', 'Headcount', 'Bringing (type)', 'Bringing (dish)', 'Daycare children', 'Daycare ages', 'Notes', 'Submitted', 'Updated'];
  const csv = [head.map(q).join(',')]
    .concat(rows.map((r) => [r.name, r.email, r.phone, r.headcount, r.dish_type, r.dish, r.kids_count || 0, r.kids_ages, r.notes, fmt(r.created_at), fmt(r.updated_at)].map(q).join(',')))
    .join('\r\n');
  res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="christmas-party-rsvps.csv"').send(csv);
});

app.post('/admin/delete/:id', requireAdmin, async (req, res) => {
  await store.remove(Number(req.params.id));
  res.redirect('/admin');
});

app.get('/healthz', (req, res) => res.send('ok'));

store.init()
  .then(() => app.listen(PORT, () => console.log(`RSVP site listening on ${PORT}`)))
  .catch((e) => { console.error('Database init failed', e); process.exit(1); });
