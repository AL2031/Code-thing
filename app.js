const $ = s => document.querySelector(s), ARCH = 'openai/gpt-oss-120b', QW = 'qwen/qwen3.8-27b';
let files = JSON.parse(localStorage.ide || 'null') || { 'index.html': '<h1>Hello</h1>\n<script src="script.js"></script>', 'script.js': 'console.log("hello")' };
let tabs = [Object.keys(files)[0]], cur = tabs[0], ed, mod = {}, pend = {}, rv, dd;
const save = () => localStorage.ide = JSON.stringify(files);
const lang = p => ({ js: 'javascript', html: 'html', css: 'css', json: 'json', py: 'python', md: 'markdown', ts: 'typescript', sh: 'shell' })[p.split('.').pop()] || 'plaintext';

function log(t) { const o = $('#out'); o.textContent += t + '\n'; o.scrollTop = 1e9 }
function say(t, c = '') { const d = document.createElement('div'); d.className = 'm ' + c; d.textContent = t; $('#msgs').append(d); $('#msgs').scrollTop = 1e9 }

function tree() {
  $('#tree').innerHTML = '';
  Object.keys(files).sort().forEach(p => {
    const d = document.createElement('div'), s = document.createElement('span');
    s.textContent = p; d.className = p == cur ? 'on' : ''; d.append(s);
    if (p in pend) { const m = document.createElement('em'); m.textContent = 'M'; d.append(m) }
    d.onclick = () => p in pend ? review(p) : show(p);
    d.oncontextmenu = e => {
      e.preventDefault();
      if (!confirm('Delete ' + p + '?')) return;
      delete files[p]; tabs = tabs.filter(t => t !== p); mod[p]?.dispose(); delete mod[p]; save();
      show(tabs[0] || Object.keys(files)[0]);
    };
    $('#tree').append(d);
  });
}

function show(p) {
  if (!p || !ed) return;
  cur = p; if (!tabs.includes(p)) tabs.push(p);
  mod[p] ??= monaco.editor.createModel(files[p], lang(p));
  ed.setModel(mod[p]); $('#lg').textContent = lang(p);
  $('#tabs').innerHTML = '';
  tabs.forEach(t => {
    const d = document.createElement('div'), s = document.createElement('span'), x = document.createElement('i');
    d.className = 'tab' + (t == cur ? ' on' : ''); s.textContent = t; x.className = 'codicon codicon-close';
    x.onclick = e => { e.stopPropagation(); tabs = tabs.filter(k => k !== t); show(tabs.includes(cur) ? cur : tabs[0] || Object.keys(files)[0]) };
    d.onclick = () => show(t); d.append(s, x); $('#tabs').append(d);
  });
  tree();
}

$('#new').onclick = () => { const p = prompt('File name (e.g. src/app.js)'); if (p && !files[p]) { files[p] = ''; save(); show(p) } };

require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs' } });
require(['vs/editor/editor.main'], () => {
  ed = monaco.editor.create($('#editor'), { theme: 'vs-dark', automaticLayout: true, fontSize: 14, fontFamily: 'Consolas, "Courier New", monospace' });
  ed.onDidChangeModelContent(() => { files[cur] = ed.getValue(); save() });
  ed.onDidChangeCursorPosition(e => $('#pos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`);
  show(cur);
});

/* ---------- AI agents ---------- */
async function llm(model, sys, user, json) {
  const r = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, json, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
  });
  const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
  return d.choices[0].message.content;
}
const parse = t => {
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  try { return JSON.parse(t) } catch {
    try { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) }
    catch { throw new Error(t.trim() ? 'Model returned invalid or cut-off JSON (likely hit the token limit - try a smaller request)' : 'Model returned an empty reply (reasoning may have used the whole token budget) - try again') }
  }
};
// Files the AI may edit (pending, or named in `own`) are sent in full. Others are cut and clearly marked,
// so a model can never "fix" a file by writing back a truncated copy.
const ctx = (own = []) => Object.entries({ ...files, ...pend }).map(([p, c]) => {
  const full = p in pend || own.includes(p) || c.length <= 5000;
  return `### ${p}${full ? '' : ' [TRUNCATED PREVIEW - do not return this file]'}\n${full ? c : c.slice(0, 5000)}`;
}).join('\n\n');
function apply(list) {
  for (const f of list || []) {
    const p = String(f?.path || '').replace(/^(\.?\/)+/, '').replace(/\\/g, '/');
    if (!p || p.split('/').includes('..')) continue;
    const c = typeof f.content === 'string' ? f.content : f.content != null ? JSON.stringify(f.content, null, 2) : null;
    if (c == null) continue;
    pend[p] = c;
  }
  tree();
}
const ENV = 'The project runs two ways: HTML is previewed in a browser sandbox (use plain HTML/CSS/JavaScript with classic <script src="file.js"> tags; CDN libraries from cdn.jsdelivr.net or cdnjs.cloudflare.com are fine; no build step), and any other code runs from the terminal in a real Linux cloud sandbox (node, python3, bash, npm install, pip install all work, no interactive input). Make scripts non-interactive and print their results.';
const FILES = 'Reply with JSON only: {"files":[{"path":"","content":"full file text"}]}';

async function run(req) {
  log('Architect (gpt-oss-120b): planning');
  const plan = parse(await llm(ARCH,
    ENV + ' You lead a coding team. Split the request into at most 3 independent tasks. Each file belongs to exactly one task. Put shared names, function signatures and element ids in "contract". Reply with JSON only: {"summary":"","contract":"","tasks":[{"files":["path"],"instruction":""}]}',
    `Project files:\n${ctx()}\n\nRequest: ${req}`, 1));
  const tasks = (plan.tasks || []).slice(0, 3);
  log(`Plan: ${tasks.length} task(s)`);
  const out = await Promise.all(tasks.map(async (t, i) => {
    const fl = (t.files || []).join(', ');
    log(`Coder ${i + 1} (Qwen3.8 27B): ${fl}`);
    const r = parse(await llm(QW, `${ENV} You are coder ${i + 1}. Write only your own files, complete and working. ${FILES}`,
      `Project files:\n${ctx(t.files || [])}\n\nContract:\n${plan.contract}\n\nYour files: ${fl}\nTask: ${t.instruction}\nOverall request: ${req}`, 1));
    apply(r.files); log(`Coder ${i + 1} done`); return r.files || [];
  }));
  if (out.flat().length) {
    log('Fixer (Qwen3.8 27B): reviewing');
    const r = parse(await llm(QW,
      `You review code written by a team. Fix bugs, mismatched names between files, and missing imports. Return only files that need changes ({"files":[]} if none). Never return a file marked TRUNCATED PREVIEW. ${FILES}`,
      `Contract:\n${plan.contract}\n\n${ctx()}`, 1));
    apply(r.files); log(`Fixer changed ${(r.files || []).length} file(s)`);
  }
  log('Architect (gpt-oss-120b): final check');
  const fin = parse(await llm(ARCH, 'You are the lead. Check the files against the request. Reply with JSON only: {"ok":true,"summary":"what was built, plus any problems"}', `Request: ${req}\n\n${ctx()}`, 1));
  return (fin.ok ? '' : 'Needs attention: ') + fin.summary;
}

async function send() {
  const q = $('#in').value.trim(); if (!q || $('#go').disabled) return;
  $('#in').value = ''; say(q, 'u'); $('#go').disabled = true;
  try { say(await run(q) || 'Done.'); const f = Object.keys(pend)[0]; if (f) review(f) } catch (e) { say('Error: ' + e.message); log('Error: ' + e.message) }
  $('#go').disabled = false;
}
$('#go').onclick = send;
$('#in').onkeydown = e => { if (e.key == 'Enter' && !e.shiftKey) { e.preventDefault(); send() } };
say('Describe what to build (Ctrl+P opens files, F1 commands). gpt-oss-120b plans, three Qwen coders write files in parallel, and a fourth Qwen reviews.');

/* ---------- diff review ---------- */
function review(p) {
  dd ??= monaco.editor.createDiffEditor($('#dv'), { theme: 'vs-dark', automaticLayout: true });
  const l = lang(p); rv = p;
  dd.setModel({ original: monaco.editor.createModel(files[p] ?? '', l), modified: monaco.editor.createModel(pend[p], l) });
  $('#dn').textContent = p + (p in files ? '' : ' (new file)'); $('#editor').hidden = true; $('#diff').hidden = false;
}
function decide(ok) {
  const p = rv; if (ok) { files[p] = pend[p]; mod[p]?.setValue(pend[p]); save() }
  delete pend[p]; tree();
  const n = Object.keys(pend)[0]; if (n) return review(n);
  $('#diff').hidden = true; $('#editor').hidden = false; ed.layout(); show(ok ? p : cur);
}
$('#ac').onclick = () => decide(true); $('#rj').onclick = () => decide(false);
$('#aa').onclick = () => { for (const p in pend) { files[p] = pend[p]; mod[p]?.setValue(pend[p]) } pend = {}; save(); $('#diff').hidden = true; $('#editor').hidden = false; ed.layout(); show(cur) };

/* ---------- panel: preview + terminal ---------- */
function hook() {
  const send = (l, t) => parent.postMessage({ l, t }, '*');
  const fmt = a => a.map(x => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x) } catch { return String(x) } }).join(' ');
  ['log', 'info', 'warn', 'error'].forEach(k => { const o = console[k]; console[k] = (...a) => { send(k, fmt(a)); o.apply(console, a) } });
  addEventListener('error', e => send('error', e.message + (e.lineno ? ' (line ' + e.lineno + ')' : '')));
  addEventListener('unhandledrejection', e => send('error', 'Unhandled promise: ' + (e.reason?.message || e.reason)));
  // sandboxed iframes have no real storage; give generated code an in-memory one
  for (const k of ['localStorage', 'sessionStorage']) {
    try { window[k].getItem('x') } catch {
      const m = {};
      Object.defineProperty(window, k, { value: { getItem: x => x in m ? m[x] : null, setItem: (x, v) => { m[x] = String(v) }, removeItem: x => { delete m[x] }, clear: () => { for (const x in m) delete m[x] }, key: i => Object.keys(m)[i] ?? null, get length() { return Object.keys(m).length } } });
    }
  }
}
const HOOK = `<script>(${hook})()<\/script>`;
function ptab(t) {
  document.querySelectorAll('#panel .h [data-t]').forEach(h => h.className = h.dataset.t == t ? 'on' : '');
  ['out', 'term', 'pv'].forEach(k => $('#' + k).hidden = k != t);
  $('#panel').classList.toggle('big', t == 'pv'); if (t == 'term') $('#ti').focus();
}
const get = s => files[s.replace(/^(\.?\/)+/, '')];
function preview() {
  let h = files['index.html']; if (h == null) { ptab('out'); return log('No index.html to preview') }
  h = h.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/g, (m, a, s, b) => get(s) != null ? `<script${a}${b}>${get(s).replace(/<\/script/g, '<\\/script')}<\/script>` : m)
       .replace(/<link[^>]*href=["']([^"']+\.css)["'][^>]*>/g, (m, s) => get(s) != null ? `<style>${get(s)}</style>` : m);
  $('#pv').srcdoc = /<head[^>]*>/i.test(h) ? h.replace(/<head[^>]*>/i, m => m + HOOK) : HOOK + h; ptab('pv');
}
function nodeBoot(F, main) { // tiny CommonJS shim so project files can require() each other
  const C = {}, process = { argv: ['node', main], env: {}, platform: 'browser', exit() {}, cwd: () => '/', stdout: { write: s => console.log(String(s).replace(/\n$/, '')) } };
  const req = p => {
    const k = p.replace(/^(\.?\/)+/, ''), n = [k, k + '.js', k + '/index.js'].find(x => x in F);
    if (!n) throw new Error(`Cannot find module '${p}' (only project files can be required in the browser)`);
    if (C[n]) return C[n].exports;
    const m = C[n] = { exports: {} }; new Function('require', 'module', 'exports', 'process', F[n])(req, m, m.exports, process); return m.exports;
  };
  req(main);
}
function pyBoot(F, main) { // Python via Pyodide (WebAssembly), loaded from a CDN
  const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
  s.onerror = () => console.error('Could not load Pyodide from the CDN');
  s.onload = async () => {
    try {
      console.log('Loading Python runtime (first run takes a few seconds)...');
      const py = await loadPyodide({ stdout: t => console.log(t), stderr: t => console.error(t) });
      for (const [p, c] of Object.entries(F)) { p.split('/').slice(0, -1).reduce((a, x) => { const q = a ? a + '/' + x : x; try { py.FS.mkdir(q) } catch {} return q }, ''); py.FS.writeFile(p, c) }
      await py.loadPackagesFromImports(F[main]);
      await py.runPythonAsync(F[main]);
    } catch (e) { console.error(e.message) }
  };
  document.head.append(s);
}
function runfile(name) {
  const src = files[name], F = JSON.stringify(files).replace(/</g, '\\u003c'), n = JSON.stringify(name), py = name.endsWith('.py');
  const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.hidden = true;
  const code = py ? `<script>(${pyBoot})(${F},${n})<\/script>`
    : /^\s*(import|export)\s/m.test(src) ? `<script type="module">${src.replace(/<\/script/g, '<\\/script')}<\/script>`
    : `<script>(${nodeBoot})(${F},${n})<\/script>`;
  f.srcdoc = HOOK + code; document.body.append(f); setTimeout(() => f.remove(), py ? 120000 : 15000);
}
const RUN = { py: 'python3', js: 'node', mjs: 'node', cjs: 'node', sh: 'bash', ts: 'npx -y tsx' };
function play() {
  if (/\.html?$/.test(cur)) return preview();
  ptab('out'); const x = RUN[cur.split('.').pop()];
  if (!x) return log("Don't know how to run " + cur + " (use the terminal)");
  cloud(x, [cur], log);
}
// Each /api/run call is a brand-new sandbox, so installs from an earlier command are gone. Install first, in the same command.
function prep(cmd) {
  const pre = []; let pj = {}; try { pj = JSON.parse(files['package.json'] || '{}') } catch {}
  if (/\b(node|npm|npx|tsx)\b/.test(cmd) && !/\bnpm (i|install|ci)\b/.test(cmd) && Object.keys({ ...pj.dependencies, ...pj.devDependencies }).length)
    pre.push('npm install --no-audit --no-fund --loglevel=error');
  if (/^\s*python3?\b/.test(cmd) && files['requirements.txt'] != null && !/pip3? install/.test(cmd))
    pre.push('pip install -q -r requirements.txt');
  return pre.length ? pre.join(' && ') + ' && ' + cmd : cmd;
}
async function remote(cmd, out) { // real execution: Vercel Sandbox via /api/run
  out('$ ' + cmd + '   (cloud sandbox...)');
  try {
    const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files, cmd: prep(cmd) }) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    if (d.stdout) out(d.stdout.trimEnd()); if (d.stderr) out(d.stderr.trimEnd()); out('[exit ' + d.exitCode + ']'); return true;
  } catch (e) { out('Cloud run unavailable: ' + e.message); return false }
}
async function cloud(c, a, out = tp) {
  if (await remote(c + ' ' + a.join(' '), out)) return;
  if (/^(node|python3?)$/.test(c) && files[a[0]] != null) { out('Falling back to the in-browser runner (no npm, fs or pip installs)'); runfile(a[0]) }
}
function zip(F) { // minimal store-only .zip writer, no dependencies
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const T = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xEDB88320 ^ (n >>> 1) : n >>> 1; return n >>> 0 });
  const crc = b => { let c = ~0; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0 };
  for (const [p, t] of Object.entries(F)) {
    const n = enc.encode(p), d = enc.encode(t), c = crc(d), h = new DataView(new ArrayBuffer(30)), e = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint32(14, c, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true);
    e.setUint32(0, 0x02014b50, true); e.setUint16(4, 20, true); e.setUint16(6, 20, true); e.setUint16(8, 0x800, true); e.setUint32(16, c, true); e.setUint32(20, d.length, true); e.setUint32(24, d.length, true); e.setUint16(28, n.length, true); e.setUint32(42, off, true);
    parts.push(h.buffer, n, d); cen.push(e.buffer, n); off += 30 + n.length + d.length;
  }
  const end = new DataView(new ArrayBuffer(22)), k = cen.length / 2;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, k, true); end.setUint16(10, k, true); end.setUint32(12, cen.reduce((a, x) => a + x.byteLength, 0), true); end.setUint32(16, off, true);
  return new Blob([...parts, ...cen, end.buffer], { type: 'application/zip' });
}
function dl() { const a = document.createElement('a'); a.href = URL.createObjectURL(zip(files)); a.download = 'project.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1e4) }
$('#dl').onclick = dl;
$('#play').onclick = play;
addEventListener('message', e => { if (e.data?.l) ($('#term').hidden ? log : tp)(`[${e.data.l}] ${e.data.t}`) });
document.querySelectorAll('#panel .h [data-t]').forEach(h => h.onclick = () => h.dataset.t == 'pv' ? preview() : ptab(h.dataset.t));
function tp(t) { const d = document.createElement('div'); d.textContent = t; $('#tl').append(d); $('#term').scrollTop = 1e9 }
const sh = {
  help: () => tp('ls  cat  touch  echo  clear  run (HTML preview)  download (.zip). Anything else (node, python3, npm install, pip install, bash...) runs in a cloud Linux sandbox'),
  ls: () => tp(Object.keys(files).sort().join('  ')),
  cat: a => tp(files[a[0]] ?? 'cat: no such file'),
  touch: a => { if (a[0] && files[a[0]] == null) { files[a[0]] = ''; save(); show(a[0]) } },
  echo: a => tp(a.join(' ')), clear: () => $('#tl').innerHTML = '',
  node: a => cloud('node', a), python: a => cloud('python3', a), python3: a => cloud('python3', a), run: preview, download: dl
};
$('#ti').onkeydown = e => {
  if (e.key != 'Enter') return;
  const v = e.target.value.trim(); e.target.value = ''; tp('$ ' + v);
  const [c, ...a] = v.split(/\s+/); if (c) (sh[c] || (() => remote(v, tp)))(a);
};
$('#term').onclick = () => $('#ti').focus();

/* ---------- quick open + command palette ---------- */
const tg = s => { $(s).hidden = !$(s).hidden; ed?.layout() };
const cmds = { 'File: New File': () => $('#new').click(), 'View: Toggle Sidebar': () => tg('#side'), 'View: Toggle Panel': () => tg('#panel'), 'View: Toggle AI Panel': () => tg('#chat'), 'Run: Open Preview': preview, 'Run: Run Current File': play, 'File: Download Project (.zip)': dl, 'Terminal: Focus': () => ptab('term'), 'Output: Clear': () => $('#out').textContent = '' };
function qp(cmd) {
  const box = $('#qp'), i = $('#qi'), l = $('#ql'); let sel = 0, list = [];
  const go = k => { box.hidden = true; if (k) cmd ? cmds[k]() : show(k) };
  const draw = () => {
    const v = i.value.toLowerCase(); list = Object.keys(cmd ? cmds : files).filter(k => k.toLowerCase().includes(v));
    sel = Math.min(sel, Math.max(list.length - 1, 0)); l.innerHTML = '';
    list.forEach((k, n) => { const d = document.createElement('div'); d.textContent = k; d.className = n == sel ? 'on' : ''; d.onclick = () => go(k); l.append(d) });
  };
  i.oninput = draw;
  i.onkeydown = e => {
    if (e.key == 'Escape') go(); else if (e.key == 'Enter') go(list[sel]);
    else if (e.key == 'ArrowDown') { sel = Math.min(sel + 1, list.length - 1); draw(); e.preventDefault() }
    else if (e.key == 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault() }
  };
  box.hidden = false; i.value = ''; i.focus(); draw();
}
addEventListener('keydown', e => {
  const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey;
  if (c && k == 'p') { e.preventDefault(); qp(e.shiftKey) } else if (e.key == 'F1') { e.preventDefault(); qp(1) } else if (c && k == 'b') { e.preventDefault(); tg('#side') }
}, true);
