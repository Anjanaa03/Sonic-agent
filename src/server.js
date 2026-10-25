'use strict';
// Zero dependency server. Node 18+.  Run: node src/server.js   (PORT default 3000)
// Env: GROQ_API_KEY or ANTHROPIC_API_KEY (LLM mode), GROQ_MODEL, LLM_PROVIDER,
//      ACCESS_CODE (optional shared password for /api, recommended on a public URL),
//      PERSIST=1 (save the two default windows to data/state.json, local use only)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine');
const llm = require('./llm');

const engine = new Engine();
const PUBLIC = path.join(__dirname, '..', 'public');
const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');
const PERSIST = process.env.PERSIST === '1';
const ACCESS_CODE = process.env.ACCESS_CODE || '';

if (PERSIST) {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      for (const k of ['new', 'existing']) if (saved[k]) engine.stores[k] = saved[k];
    }
  } catch (e) { console.warn('Could not load saved state, starting fresh:', e.message); }
}
function save() {
  if (!PERSIST) return;
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify({ new: engine.stores.new, existing: engine.stores.existing })); } catch (e) { /* non critical */ }
}

// Simple per IP rate limit on the endpoint that spends LLM tokens.
const hits = new Map();
function limited(ip) {
  const now = Date.now(); const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 40;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain; charset=utf-8' };
function body(req) {
  return new Promise((res, rej) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const prof = url.searchParams.get('profile') === 'new' ? 'new' : 'existing';
    const sid = (url.searchParams.get('sid') || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
    const profile = sid ? prof + ':' + sid : prof; // private memory per visitor when a visitor id is sent
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p.startsWith('/api/') && ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return send(res, 401, { error: 'access code required' });

    if (req.method === 'GET' && p === '/api/state') return send(res, 200, engine.publicState(profile));
    if (req.method === 'GET' && p === '/api/metrics') return send(res, 200, engine.metrics(profile));
    if (req.method === 'POST' && p.startsWith('/api/')) {
      if (p === '/api/call/message' && limited(ip)) return send(res, 429, { error: 'Too many messages, wait a minute.' });
      const b = await body(req);
      let out;
      if (p === '/api/call/start') out = engine.startCall(profile, b);
      else if (p === '/api/call/message') out = await engine.message(profile, b.callId, b.text, b.mode);
      else if (p === '/api/call/end') out = engine.endCall(profile, b.callId, 'caller');
      else if (p === '/api/approval') out = { notification: engine.decideApproval(profile, b.notificationId, b.decision) };
      else if (p === '/api/feedback') out = engine.feedback(profile, b.notificationId, b.type, b.detail);
      else if (p === '/api/memory') out = engine.memory(profile, b);
      else return send(res, 404, { error: 'not found' });
      save();
      return send(res, 200, out);
    }
    const f = p === '/' ? '/index.html' : p;
    const full = path.normalize(path.join(PUBLIC, f));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Sonic prototype on port ${port}. LLM: ${llm.available() ? llm.provider() + ' / ' + llm.modelName() : 'off, rule based fallback'}. Access code: ${ACCESS_CODE ? 'required' : 'none'}.`));
}
module.exports = { server, engine };
