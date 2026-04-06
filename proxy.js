/**
 * GEXRADAR — CBOE Proxy for Render.com
 * ──────────────────────────────────────────────────────────────
 * Fetches CBOE public delayed options data and serves it to the
 * gexradar.html dashboard with CORS headers.
 *
 * Deploy on Render.com:
 *   1. New Web Service → connect your GitHub repo
 *   2. Build command:  npm install
 *   3. Start command:  node proxy.js
 *   4. Copy the Render URL (e.g. https://gexradar-proxy.onrender.com)
 *   5. Paste it into gexradar.html as PROXY_URL
 *
 * Endpoints:
 *   GET /chain/SPX   → raw CBOE JSON for SPX (15-min delayed)
 *   GET /chain/NDX
 *   GET /chain/SPY
 *   GET /chain/QQQ
 *   GET /health      → {"ok":true}
 */
 
'use strict';
const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const PORT  = process.env.PORT || 3000;   // Render sets PORT env var
 
// ── Serve the dashboard HTML ──────────────────────────────────────
const HTML_PATH = path.join(__dirname, 'index.html');
function getDashboard() {
  try { return fs.readFileSync(HTML_PATH, 'utf8'); }
  catch (e) { console.error('getDashboard error:', e.message); return null; }
}
 
// CBOE ticker map
const CBOE = {
  SPX: '_SPX',
  NDX: '_NDX',
  SPY: 'SPY',
  QQQ: 'QQQ',
};
const CBOE_URL = t =>
  `https://cdn.cboe.com/api/global/delayed_quotes/options/${t}.json`;
 
// ── In-memory cache (15-minute TTL matching CBOE delay) ──────────
const CACHE   = new Map();
const CACHE_TTL = 15 * 60 * 1000;
 
function fromCache(key) {
  const e = CACHE.get(key);
  return (e && Date.now() - e.ts < CACHE_TTL) ? e.v : null;
}
function toCache(key, v) { CACHE.set(key, { v, ts: Date.now() }); }
 
// ── HTTPS fetch — handles gzip/deflate responses ────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120',
        'Accept':          'application/json, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Referer':         'https://www.cboe.com/',
        'Origin':          'https://www.cboe.com',
      },
      timeout: 20000,
    }, res => {
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
 
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        if (res.statusCode !== 200)
          return reject(new Error('CBOE HTTP ' + res.statusCode));
        const body = Buffer.concat(chunks).toString('utf8');
        try   { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse: ' + e.message + ' — starts: ' + body.slice(0,60))); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
 
// ── CORS + JSON response helper ───────────────────────────────────
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
    'Cache-Control':               'no-store',
  });
  res.end(body);
}
 
// ── REQUEST HANDLER ───────────────────────────────────────────────
async function handle(req, res) {
  const path   = req.url.split('?')[0].toLowerCase();
  const method = req.method.toUpperCase();
 
  console.log(`[${new Date().toISOString()}] ${method} ${req.url}`);
 
  // Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
 
  // Dashboard HTML
  if (path === '/' || path === '/index.html') {
    const html = getDashboard();
    if (!html) {
      console.error('  [ERR] index.html not found at:', HTML_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>index.html not found</h1><p>Make sure index.html is in the same directory as proxy.js</p><p>Looking at: ' + HTML_PATH + '</p>');
    }
    res.writeHead(200, {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(html);
  }
 
  // Health check
  if (path === '/health') {
    return send(res, 200, {
      ok:     true,
      port:   PORT,
      cached: [...CACHE.keys()],
      ts:     new Date().toISOString(),
    });
  }
 
  // /chain/:SYM
  const m = path.match(/^\/chain\/([a-z]+)$/);
  if (m) {
    const sym  = m[1].toUpperCase();
    const tick = CBOE[sym];
 
    if (!tick) {
      return send(res, 400, {
        error: `Unknown symbol: ${sym}. Valid: ${Object.keys(CBOE).join(', ')}`,
      });
    }
 
    // Serve from cache if fresh
    const cached = fromCache(sym);
    if (cached) {
      console.log(`  [CACHE] ${sym}`);
      return send(res, 200, cached);
    }
 
    // Fetch from CBOE
    try {
      console.log(`  [FETCH] ${sym} → ${CBOE_URL(tick)}`);
      const data = await fetchJSON(CBOE_URL(tick));
 
      // Validate response has options
      const opts = data?.data?.options;
      if (!Array.isArray(opts) || opts.length === 0) {
        throw new Error(`CBOE returned no options for ${sym}`);
      }
 
      const spot = parseFloat(data?.data?.current_price || 0);
      console.log(`  [OK] ${sym} spot=${spot} options=${opts.length}`);
 
      toCache(sym, data);
      return send(res, 200, data);
 
    } catch (e) {
      console.error(`  [ERR] ${sym}:`, e.message);
      return send(res, 502, { error: e.message });
    }
  }
 
  return send(res, 404, {
    error: 'Not found',
    routes: ['/health', '/chain/SPX', '/chain/NDX', '/chain/SPY', '/chain/QQQ'],
  });
}
 
// ── START ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error('Unhandled error:', e);
    try { send(res, 500, { error: e.message }); } catch (_) {}
  });
});
 
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   GEXRADAR Proxy — Render.com             ║
  ╠═══════════════════════════════════════════╣
  ║   Port: ${String(PORT).padEnd(33)}║
  ║   GET /health                             ║
  ║   GET /chain/SPX  (CBOE 15-min delayed)   ║
  ║   GET /chain/NDX                          ║
  ║   GET /chain/SPY                          ║
  ║   GET /chain/QQQ                          ║
  ╚═══════════════════════════════════════════╝
  Cache TTL: 15 min (matches CBOE delay)
`);
});
 
server.on('error', e => {
  console.error('Server error:', e.message);
  process.exit(1);
});
