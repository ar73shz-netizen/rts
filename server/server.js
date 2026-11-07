// سرور همگام‌سازی برنامه مدیریت کالای جانبی (بدون نیاز به نصب پکیج اضافه)
const http = require('http'), fs = require('fs'), path = require('path');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const PORT = Number(CFG.port) || 3100;
const KEY = String(CFG.key || '');
if (!KEY || KEY === 'CHANGE-THIS-KEY') {
  console.log('خطا: ابتدا فایل config.json را باز کنید و به‌جای CHANGE-THIS-KEY یک کلید دلخواه بنویسید.');
  process.exit(1);
}
const DATA = path.join(__dirname, 'data'), IMG = path.join(DATA, 'img'), BAK = path.join(DATA, 'backups');
[DATA, IMG, BAK].forEach(d => fs.mkdirSync(d, { recursive: true }));
const DBF = path.join(DATA, 'db.json');
const COLL = ['cats', 'products', 'invoices', 'lots', 'outs', 'imgs', 'log', 'returns'];
let DB = { tomb: {} }; COLL.forEach(k => DB[k] = []);
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch (e) {}

function merge(a, b) {
  const r = { tomb: Object.assign({}, a.tomb || {}, b.tomb || {}) };
  for (const k of COLL) {
    const m = new Map();
    for (const x of [].concat(a[k] || [], b[k] || [])) {
      if (!x || !x.id || r.tomb[x.id]) continue;
      const o = m.get(x.id);
      if (!o || (x.u || 0) > (o.u || 0)) m.set(x.id, x);
    }
    r[k] = [...m.values()];
  }
  return r;
}
function saveDB() {
  const tmp = DBF + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB));
  fs.renameSync(tmp, DBF);
  const day = new Date().toISOString().slice(0, 10);
  const b = path.join(BAK, 'db-' + day + '.json');
  if (!fs.existsSync(b)) {
    fs.copyFileSync(DBF, b);
    const all = fs.readdirSync(BAK).sort();
    all.slice(0, Math.max(0, all.length - 30)).forEach(f => fs.unlinkSync(path.join(BAK, f)));
  }
}
function cleanImages() {
  for (const f of fs.readdirSync(IMG)) {
    const id = f.replace(/\.json$/, '');
    if (DB.tomb[id]) fs.unlinkSync(path.join(IMG, f));
  }
}
function body(req, limit) {
  return new Promise((res, rej) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > limit) { rej(new Error('big')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { res(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const okId = s => /^[a-zA-Z0-9]{3,40}$/.test(s);

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = req.url.split('?')[0];
  if (url === '/ping' || url === '/') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('ok'); }
  if (req.headers['x-key'] !== KEY) return send(res, 401, { error: 'bad key' });
  try {
    if (req.method === 'POST' && url === '/api/sync') {
      const b = await body(req, 60 * 1024 * 1024);
      if (b.db && typeof b.db === 'object') {
        DB = merge(DB, b.db);
        saveDB(); cleanImages();
      }
      return send(res, 200, { db: DB });
    }
    if (req.method === 'GET' && url === '/api/imgs') {
      return send(res, 200, { ids: fs.readdirSync(IMG).map(f => f.replace(/\.json$/, '')) });
    }
    let m = url.match(/^\/api\/img\/([^/]+)$/);
    if (m && okId(m[1])) {
      const f = path.join(IMG, m[1] + '.json');
      if (req.method === 'GET') return fs.existsSync(f) ? send(res, 200, JSON.parse(fs.readFileSync(f, 'utf8'))) : send(res, 404, {});
      if (req.method === 'PUT') {
        const b = await body(req, 20 * 1024 * 1024);
        if (typeof b.data !== 'string') return send(res, 400, {});
        fs.writeFileSync(f, JSON.stringify({ data: b.data }));
        return send(res, 200, { ok: 1 });
      }
    }
    send(res, 404, {});
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '0.0.0.0', () => console.log('سرور روشن شد. پورت: ' + PORT + '  (این پنجره را نبندید)'));
