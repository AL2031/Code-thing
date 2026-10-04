const $ = s => document.querySelector(s), ARCH = 'openai/gpt-oss-120b', QW = 'qwen/qwen3.8-27b';
let files = JSON.parse(localStorage.ide || 'null') || { 'index.html': '<h1>Hello</h1>\n<script src="script.js"></script>', 'script.js': 'console.log("hello")' };
let tabs = [Object.keys(files)[0]], cur = tabs[0], ed, mod = {}, pend = {}, rv, dd;
const save = () => localStorage.ide = JSON.stringify(files);
const lang = p => ({ js: 'javascript', html: 'html', css: 'css', json: 'json', py: 'python', md: 'markdown' })[p.split('.').pop()] || 'plaintext';

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
  try { return JSON.parse(t) } catch { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) }
};
const ctx = () => Object.entries({ ...files, ...pend }).map(([p, c]) => `### ${p}\n${c.slice(0, 5000)}`).join('\n\n');
function apply(list) {
  for (const f of list || []) {
    if (!f.path || typeof f.content !== 'string') continue;
    pend[f.path] = f.content;
  }
  tree();
}
const FILES = 'Reply with JSON only: {"files":[{"path":"","content":"full file text"}]}';

async function run(req) {
  log('Architect (gpt-oss-120b): planning');
  const plan = parse(await llm(ARCH,
    'You lead a coding team. Split the request into at most 3 independent tasks. Each file belongs to exactly one task. Put shared names, function signatures and element ids in "contract". Reply with JSON only: {"summary":"","contract":"","tasks":[{"files":["path"],"instruction":""}]}',
    `Project files:\n${ctx()}\n\nRequest: ${req}`, 1));
  const tasks = (plan.tasks || []).slice(0, 3);
  log(`Plan: ${tasks.length} task(s)`);
  const out = await Promise.all(tasks.map(async (t, i) => {
    const fl = (t.files || []).join(', ');
    log(`Coder ${i + 1} (Qwen3.8 27B): ${fl}`);
    const r = parse(await llm(QW, `You are coder ${i + 1}. Write only your own files, complete and working. ${FILES}`,
      `Project files:\n${ctx()}\n\nContract:\n${plan.contract}\n\nYour files: ${fl}\nTask: ${t.instruction}\nOverall request: ${req}`, 1));
    apply(r.files); log(`Coder ${i + 1} done`); return r.files || [];
  }));
  if (out.flat().length) {
    log('Fixer (Qwen3.8 27B): reviewing');
    const r = parse(await llm(QW,
      `You review code written by a team. Fix bugs, mismatched names between files, and missing imports. Return only files that need changes ({"files":[]} if none). ${FILES}`,
      `Contract:\n${plan.contract}\n\n${ctx()}`, 1));
    apply(r.files); log(`Fixer changed ${(r.files || []).length} file(s)`);
  }
  log('Architect (gpt-oss-120b): final check');
  const fin = parse(await llm(ARCH, 'You are the lead. Check the files against the request. Reply with JSON only: {"ok":true,"summary":"what was built, plus any problems"}', `Request: ${req}\n\n${ctx()}`, 1));
  return (fin.ok ? '' : 'Needs attention: ') + fin.summary;
}

async function send() {
  const q = $('#in').value.trim(); if (!q) return;
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
const HOOK = '<script>["log","warn","error"].forEach(k=>{const o=console[k];console[k]=(...a)=>{parent.postMessage({l:k,t:a.join(" ")},"*");o(...a)}});addEventListener("error",e=>parent.postMessage({l:"error",t:e.message},"*"))<\/script>';
function ptab(t) {
  document.querySelectorAll('#panel .h [data-t]').forEach(h => h.className = h.dataset.t == t ? 'on' : '');
  ['out', 'term', 'pv'].forEach(k => $('#' + k).hidden = k != t);
  $('#panel').classList.toggle('big', t == 'pv'); if (t == 'term') $('#ti').focus();
}
function preview() {
  let h = files['index.html']; if (h == null) { ptab('out'); return log('No index.html to preview') }
  h = h.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/g, (m, a, s, b) => files[s] != null ? `<script${a}${b}>${files[s].replace(/<\/script/g, '<\\/script')}<\/script>` : m)
       .replace(/<link[^>]*href=["']([^"']+\.css)["'][^>]*>/g, (m, s) => files[s] != null ? `<style>${files[s]}</style>` : m);
  $('#pv').srcdoc = HOOK + h; ptab('pv');
}
function runjs(src) {
  const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.hidden = true;
  f.srcdoc = HOOK + '<script>' + src.replace(/<\/script/g, '<\\/script') + '<\/script>'; document.body.append(f); setTimeout(() => f.remove(), 5000);
}
addEventListener('message', e => { if (e.data?.l) ($('#term').hidden ? log : tp)(`[${e.data.l}] ${e.data.t}`) });
document.querySelectorAll('#panel .h [data-t]').forEach(h => h.onclick = () => h.dataset.t == 'pv' ? preview() : ptab(h.dataset.t));
function tp(t) { const d = document.createElement('div'); d.textContent = t; $('#tl').append(d); $('#term').scrollTop = 1e9 }
const sh = {
  help: () => tp('ls  cat <file>  touch <file>  echo  clear  node <file> (browser sandbox)  run (preview)'),
  ls: () => tp(Object.keys(files).sort().join('  ')),
  cat: a => tp(files[a[0]] ?? 'cat: no such file'),
  touch: a => { if (a[0] && files[a[0]] == null) { files[a[0]] = ''; save(); show(a[0]) } },
  echo: a => tp(a.join(' ')), clear: () => $('#tl').innerHTML = '',
  node: a => files[a[0]] != null ? runjs(files[a[0]]) : tp('node: no such file'), run: preview
};
$('#ti').onkeydown = e => {
  if (e.key != 'Enter') return;
  const v = e.target.value.trim(); e.target.value = ''; tp('$ ' + v);
  const [c, ...a] = v.split(/\s+/); if (c) (sh[c] || (() => tp(c + ': command not found')))(a);
};
$('#term').onclick = () => $('#ti').focus();

/* ---------- quick open + command palette ---------- */
const tg = s => { $(s).hidden = !$(s).hidden; ed?.layout() };
const cmds = { 'File: New File': () => $('#new').click(), 'View: Toggle Sidebar': () => tg('#side'), 'View: Toggle Panel': () => tg('#panel'), 'View: Toggle AI Panel': () => tg('#chat'), 'Run: Open Preview': preview, 'Terminal: Focus': () => ptab('term'), 'Output: Clear': () => $('#out').textContent = '' };
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
