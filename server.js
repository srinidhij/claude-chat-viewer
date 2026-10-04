#!/usr/bin/env node
// Claude Code Viewer: zero-dependency local server for ~/.claude/projects sessions.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = path.resolve(opt('--dir') || process.env.CLAUDE_PROJECTS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'));
const PORT = Number(opt('--port') || process.env.PORT || 3456);
const HOST = opt('--host') || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');

const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
const isNoise = t => /^<(command-|local-command|system-reminder|ide_)/.test(t.trim()) || t.startsWith('Caveat:');

// $/MTok [input, output, cacheRead]; cache writes are 1.25x input (5m) or 2x (1h). First match wins.
const PRICES = [
  [/fable|mythos/, [10, 50, 0.25]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-(5|4-[5-9])/, [5, 25, 0.5]],
  [/opus/, [15, 75, 1.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-4/, [1, 5, 0.1]],
  [/haiku-3-5/, [0.8, 4, 0.08]],
  [/haiku/, [0.25, 1.25, 0.03]],
];
const priceOf = m => (PRICES.find(([re]) => re.test(m || '')) || [])[1];
const contextWindow = m => /haiku|opus-4-[15]\b|opus-4-2|sonnet-4-[25]|sonnet-4-2|3-[57]/.test(m || '') ? 200000 : 1000000;

// Cache summaries by file path + mtime so rescans are cheap.
const cache = new Map();

function parseFile(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip partial line */ }
  }
  return entries;
}

function summarize(project, name, file, mtimeMs) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const entries = parseFile(file);
  let title = '', ts = 0, count = 0, cwd = '', model = '';
  const texts = [];
  const usageByReq = new Map();   // streamed entries repeat a message id; keep the last (complete) one
  let ctx = 0, ctxModel = '';
  for (const e of entries) {
    const u = e.message?.usage;
    if (e.type === 'assistant' && u && e.message.model && e.message.model !== '<synthetic>') {
      usageByReq.set(e.message.id || e.requestId || e.uuid, { u, model: e.message.model });
      if (!e.isSidechain) { ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); ctxModel = e.message.model; }
    }
    if (e.timestamp) ts = Math.max(ts, Date.parse(e.timestamp) || 0);
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!model && e.message?.model) model = e.message.model;
    if (e.type === 'summary' && e.summary && !title) title = e.summary;
    if (e.message) {
      count++;
      const t = textOf(e.message.content);
      texts.push(t);
      if (!title && e.type === 'user' && !e.isMeta && t && !isNoise(t)) title = t.trim().slice(0, 140);
    }
  }
  let cost = 0, unpriced = false;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const { u, model: m } of usageByReq.values()) {
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    const w = u.cache_creation_input_tokens || 0;
    tokens.input += u.input_tokens || 0; tokens.output += u.output_tokens || 0;
    tokens.cacheRead += u.cache_read_input_tokens || 0; tokens.cacheWrite += w;
    const p = priceOf(m);
    if (!p) { unpriced = true; continue; }
    cost += ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2]
      + (w - w1h) * p[0] * 1.25 + w1h * p[0] * 2) / 1e6;
  }
  const window = Math.max(contextWindow(ctxModel || model), ctx > 200000 ? 1000000 : 0);
  const s = count || title
    ? { id: `${project}/${name.replace(/\.jsonl$/, '')}`, project, title: title || '(untitled)', ts: ts || mtimeMs, count, cwd, model,
        cost, unpriced, tokens, context: ctx, contextWindow: window, mtimeMs, search: (title + '\n' + texts.join('\n')).toLowerCase() }
    : null;
  const rec = Object.assign({ mtimeMs, s }, {});
  cache.set(file, rec);
  return rec;
}

function listSessions() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const p of projects) {
    const dir = path.join(ROOT, p.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try {
        const { s } = summarize(p.name, f, file, fs.statSync(file).mtimeMs);
        if (s) out.push(s);
      } catch { /* unreadable file */ }
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

// Resolve "<project>/<session>" to a file, refusing anything outside ROOT.
function sessionFile(id) {
  const m = /^([^/\\]+)\/([^/\\]+)$/.exec(id || '');
  if (!m || m[1].startsWith('.') || m[2].startsWith('.')) return null;
  const file = path.join(ROOT, m[1], m[2] + '.jsonl');
  return file.startsWith(ROOT + path.sep) && fs.existsSync(file) ? file : null;
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/sessions') {
      return send(res, 200, listSessions().map(({ search, mtimeMs, ...rest }) => rest));
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (!q) return send(res, 200, []);
      return send(res, 200, listSessions().filter(s => s.search.includes(q)).map(s => s.id));
    }
    if (url.pathname === '/api/session') {
      const file = sessionFile(url.searchParams.get('id'));
      if (!file) return send(res, 404, { error: 'not found' });
      return send(res, 200, parseFile(file));
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Code Viewer: http://${HOST}:${PORT}`);
  console.log(`Reading sessions from ${ROOT}${fs.existsSync(ROOT) ? '' : '  (directory not found!)'}`);
});
