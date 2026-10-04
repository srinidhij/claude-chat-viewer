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
  for (const e of entries) {
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
  const s = count || title
    ? { id: `${project}/${name.replace(/\.jsonl$/, '')}`, project, title: title || '(untitled)', ts: ts || mtimeMs, count, cwd, model,
        mtimeMs, search: (title + '\n' + texts.join('\n')).toLowerCase() }
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
