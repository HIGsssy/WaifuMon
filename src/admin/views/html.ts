/**
 * Server-rendered HTML for the admin panel. No template engine and no
 * front-end framework — string builders plus one small vanilla script that
 * POSTs forms as JSON with the CSRF header.
 */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Embeds a value inside a <script> tag without letting it close the tag. */
export function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const STYLE = `
:root{color-scheme:dark;--bg:#14121a;--panel:#1e1b26;--panel2:#262232;--line:#39334a;
--text:#ece9f3;--muted:#a49cb8;--accent:#e2679a;--accent2:#8b6ff0;--ok:#4fbf87;--warn:#e0b050;--err:#e2615f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px 20px;
background:var(--panel);border-bottom:1px solid var(--line)}
header .brand{font-weight:700;letter-spacing:.04em}
header nav{display:flex;gap:14px;flex-wrap:wrap}
header nav a{color:var(--muted);font-weight:500}
header nav a.active{color:var(--text);border-bottom:2px solid var(--accent)}
header .spacer{flex:1}
main{max-width:1180px;margin:0 auto;padding:20px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:24px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.stat{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px}
.stat b{display:block;font-size:22px}
.stat span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
tr:hover td{background:var(--panel2)}
img.thumb{width:40px;height:40px;object-fit:cover;border-radius:6px;background:var(--panel2)}
.badge{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;
background:var(--panel2);border:1px solid var(--line)}
.badge.on{color:var(--ok);border-color:var(--ok)}
.badge.off{color:var(--muted)}
label{display:block;margin:12px 0 4px;font-size:12px;color:var(--muted);
text-transform:uppercase;letter-spacing:.05em}
label .hint{text-transform:none;letter-spacing:0;color:#7d7594;margin-left:6px}
input,select,textarea{width:100%;padding:8px 10px;background:var(--panel2);color:var(--text);
border:1px solid var(--line);border-radius:6px;font:inherit}
textarea{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;min-height:120px;resize:vertical}
input[type=checkbox]{width:auto}
.row{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
button,.btn{display:inline-block;padding:8px 14px;border-radius:6px;border:1px solid var(--line);
background:var(--panel2);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
button:hover,.btn:hover{border-color:var(--accent);text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#241019}
button.alt{background:var(--accent2);border-color:var(--accent2);color:#100c22}
button.small{padding:4px 9px;font-size:12px;font-weight:500}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;align-items:center}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
.filters label{margin:0 0 4px}
.filters>div{min-width:150px}
.flash{padding:10px 12px;border-radius:8px;margin-bottom:14px;display:none;white-space:pre-wrap}
.flash.show{display:block}
.flash.ok{background:rgba(79,191,135,.14);border:1px solid var(--ok);color:#b7ecd1}
.flash.err{background:rgba(226,97,95,.14);border:1px solid var(--err);color:#f4bcbb}
.flash.warn{background:rgba(224,176,80,.14);border:1px solid var(--warn);color:#f0dcae}
ul.issues{margin:6px 0 0;padding-left:20px}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.login{max-width:340px;margin:12vh auto}
details>summary{cursor:pointer;font-weight:600;padding:6px 0}
.section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
`;

const SCRIPT = String.raw`
function cookie(name){
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function setPath(obj, dotted, value){
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++){
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
function collect(scope){
  const out = {};
  scope.querySelectorAll('[data-field]').forEach(function(el){
    // Disabled inputs are excluded, matching normal form semantics. Forms with
    // mutually exclusive blocks (e.g. per-effect-type item config) disable the
    // inactive block so its values never reach the server.
    if (el.disabled) return;
    const name = el.dataset.field;
    const type = el.dataset.type || 'text';
    const raw = el.type === 'checkbox' ? '' : el.value;
    let v;
    if (type === 'bool') v = el.checked;
    else if (type === 'number') v = raw.trim() === '' ? null : Number(raw);
    else if (type === 'nulltext') v = raw.trim() === '' ? null : raw;
    else if (type === 'list') v = raw.split(/[\n,]/).map(function(s){return s.trim();}).filter(Boolean);
    else if (type === 'json'){
      try { v = JSON.parse(raw); }
      catch (e) { throw new Error(name + ': invalid JSON — ' + e.message); }
    }
    else v = raw;
    if (type === 'number' && v !== null && Number.isNaN(v)) throw new Error(name + ': not a number');
    setPath(out, name, v);
  });
  // A lone __root field means "the whole body is this value" (raw JSON editors).
  const keys = Object.keys(out);
  if (keys.length === 1 && keys[0] === '__root') return out.__root;
  return out;
}
function flash(kind, text, issues){
  const el = document.getElementById('flash');
  if (!el) return;
  el.className = 'flash show ' + kind;
  el.innerHTML = '';
  el.appendChild(document.createTextNode(text));
  if (issues && issues.length){
    const ul = document.createElement('ul');
    ul.className = 'issues';
    issues.forEach(function(i){
      const li = document.createElement('li');
      li.textContent = i;
      ul.appendChild(li);
    });
    el.appendChild(ul);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function post(url, body){
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-csrf': cookie('wm_admin_csrf') },
    body: JSON.stringify(body || {}),
    credentials: 'same-origin'
  });
  if (res.status === 401){ window.location.href = '/admin/login'; return null; }
  let data = null;
  try { data = await res.json(); } catch (e) { data = { ok: false, errors: ['Unexpected server response'] }; }
  return data;
}
function handle(data){
  if (!data) return false;
  if (data.ok){
    if (data.redirect){ window.location.href = data.redirect; return true; }
    flash(data.warnings && data.warnings.length ? 'warn' : 'ok', data.message || 'Saved.',
      (data.warnings || []).concat(data.notes || []));
    if (data.reloadPage) window.setTimeout(function(){ window.location.reload(); }, 700);
    return true;
  }
  flash('err', data.message || 'Validation failed — nothing was written.', data.errors || []);
  return false;
}
document.addEventListener('submit', async function(ev){
  const form = ev.target.closest('form[data-post]');
  if (!form) return;
  ev.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  let body;
  try { body = collect(form); }
  catch (e) { flash('err', String(e.message || e)); return; }
  if (form.dataset.wrap){
    const payload = JSON.stringify(body === undefined ? null : body);
    body = JSON.parse(form.dataset.wrap.replace('__VALUE__', function(){ return payload; }));
  }
  if (btn) btn.disabled = true;
  try { handle(await post(form.dataset.post, body)); }
  finally { if (btn) btn.disabled = false; }
});
document.addEventListener('click', async function(ev){
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  ev.preventDefault();
  if (btn.dataset.confirm && !window.confirm(btn.dataset.confirm)) return;
  btn.disabled = true;
  try {
    const data = await post(btn.dataset.action, btn.dataset.body ? JSON.parse(btn.dataset.body) : {});
    if (data && data.ok && !data.redirect && btn.dataset.refresh !== 'false'){
      handle(data);
      window.setTimeout(function(){ window.location.reload(); }, 500);
    } else { handle(data); }
  } finally { btn.disabled = false; }
});
`;

export interface NavItem {
  href: string;
  label: string;
}

export const NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/species', label: 'Species' },
  { href: '/admin/items', label: 'Items' },
  { href: '/admin/tables', label: 'Tables & Rates' },
  { href: '/admin/quests', label: 'Quests' },
];

export interface LayoutOptions {
  title: string;
  active?: string;
  body: string;
  /** Chrome-less pages (login) drop the nav bar. */
  bare?: boolean;
}

export function layout(opts: LayoutOptions): string {
  const nav = opts.bare
    ? ''
    : `<header>
  <span class="brand">WAIFUMON<span class="muted"> · admin</span></span>
  <nav>${NAV.map(
    (n) =>
      `<a href="${n.href}"${n.href === opts.active ? ' class="active"' : ''}>${esc(n.label)}</a>`,
  ).join('')}</nav>
  <span class="spacer"></span>
  <button class="small" data-action="/admin/logout" data-refresh="false">Log out</button>
</header>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(opts.title)} — Waifumon Admin</title>
<style>${STYLE}</style>
</head><body>
${nav}
<main>
<div id="flash" class="flash"></div>
${opts.body}
</main>
<script>${SCRIPT}</script>
</body></html>`;
}

// ── form controls ────────────────────────────────────────────────────────────

type FieldType = 'text' | 'number' | 'bool' | 'nulltext' | 'list' | 'json';

interface FieldOpts {
  hint?: string;
  placeholder?: string;
  step?: string;
  rows?: number;
  required?: boolean;
  readonly?: boolean;
}

function labelFor(name: string, label: string, opts: FieldOpts = {}): string {
  const hint = opts.hint ? ` <span class="hint">${esc(opts.hint)}</span>` : '';
  return `<label for="f_${esc(name)}">${esc(label)}${hint}</label>`;
}

export function textField(
  name: string,
  label: string,
  value: unknown,
  opts: FieldOpts & { type?: FieldType } = {},
): string {
  const attrs = [
    `id="f_${esc(name)}"`,
    `data-field="${esc(name)}"`,
    `data-type="${esc(opts.type ?? 'text')}"`,
    `value="${esc(value ?? '')}"`,
    opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : '',
    opts.readonly ? 'readonly' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${labelFor(name, label, opts)}<input ${attrs}>`;
}

export function numberField(
  name: string,
  label: string,
  value: unknown,
  opts: FieldOpts = {},
): string {
  const attrs = [
    `id="f_${esc(name)}"`,
    `data-field="${esc(name)}"`,
    'data-type="number"',
    'type="number"',
    `step="${esc(opts.step ?? 'any')}"`,
    `value="${value == null ? '' : esc(value)}"`,
    opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${labelFor(name, label, opts)}<input ${attrs}>`;
}

export function selectField(
  name: string,
  label: string,
  value: unknown,
  options: readonly string[],
  opts: FieldOpts = {},
): string {
  const items = options
    .map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`)
    .join('');
  return `${labelFor(name, label, opts)}<select id="f_${esc(name)}" data-field="${esc(name)}">${items}</select>`;
}

export function boolField(name: string, label: string, value: boolean): string {
  return `<label for="f_${esc(name)}">${esc(label)}</label>
<input type="checkbox" id="f_${esc(name)}" data-field="${esc(name)}" data-type="bool"${value ? ' checked' : ''}>`;
}

export function textareaField(
  name: string,
  label: string,
  value: string,
  opts: FieldOpts & { type?: FieldType } = {},
): string {
  return `${labelFor(name, label, opts)}<textarea id="f_${esc(name)}" data-field="${esc(name)}" data-type="${esc(
    opts.type ?? 'text',
  )}" rows="${opts.rows ?? 6}">${esc(value)}</textarea>`;
}

export function jsonField(
  name: string,
  label: string,
  value: unknown,
  opts: FieldOpts = {},
): string {
  return textareaField(name, label, JSON.stringify(value, null, 2), { ...opts, type: 'json' });
}
