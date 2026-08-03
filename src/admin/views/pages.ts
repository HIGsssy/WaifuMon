import type { ContentSummary, ValidationReport } from '../../modules/content/adminContentService';
import { esc, layout, textField } from './html';

export function loginPage(next: string): string {
  return layout({
    title: 'Sign in',
    bare: true,
    body: `<div class="login">
<h1>Waifumon Admin</h1>
<p class="sub">Internal content tools. Enter the admin token.</p>
<form data-post="/admin/login">
  ${textField('token', 'Admin token', '', { placeholder: 'ADMIN_WEB_TOKEN' })}
  <input type="hidden" data-field="next" value="${esc(next)}">
  <div class="actions"><button class="primary" type="submit">Sign in</button></div>
</form>
</div>`,
  });
}

function statusBanner(report: ValidationReport): string {
  if (!report.ok) {
    return `<div class="card" style="border-color:var(--err)">
<h2 style="color:var(--err)">Validation failing</h2>
<ul class="issues">${report.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
</div>`;
  }
  const warn =
    report.warnings.length > 0
      ? `<details><summary style="color:var(--warn)">${report.warnings.length} warning${
          report.warnings.length === 1 ? '' : 's'
        }</summary><ul class="issues">${report.warnings
          .map((w) => `<li>${esc(w)}</li>`)
          .join('')}</ul></details>`
      : '<p class="muted" style="margin:0">No warnings.</p>';
  return `<div class="card"><h2 style="margin-top:0">Last validation — <span style="color:var(--ok)">passing</span></h2>${warn}</div>`;
}

export function dashboardPage(
  summary: ContentSummary,
  report: ValidationReport,
  reloadAvailable: boolean,
  contentWritable = true,
): string {
  const readOnly = contentWritable
    ? ''
    : `<div class="card" style="border-color:var(--warn)">
<b style="color:var(--warn)">Content directory is read-only</b>
<p class="muted" style="margin-bottom:0">Browsing, validation and reload still work, but every save will fail.
Under Docker this means <span class="mono">content/</span> was not bind-mounted read-write, or the container
user does not own it. See <span class="mono">docs/admin-web.md</span>.</p></div>`;

  const rarityRows = summary.byRarity
    .map(
      (r) => `<tr>
<td class="mono">${esc(r.rarity)}</td>
<td>${r.total}</td>
<td>${r.enabled}</td>
<td>${r.weight}${r.weight > 0 && r.enabled === 0 ? ' <span class="badge" style="color:var(--warn)">no enabled species</span>' : ''}</td>
</tr>`,
    )
    .join('');

  const highlights = summary.highlights
    .map((h) => `<tr><td>${esc(h.label)}</td><td class="mono">${esc(h.value)}</td></tr>`)
    .join('');

  const affinity = summary.byAffinity
    .map((a) => `<span class="badge">${esc(a.affinity)} · ${a.count}</span>`)
    .join(' ');

  const files = summary.speciesFiles
    .map((f) => `<span class="badge">${esc(f.file)} · ${f.count}</span>`)
    .join(' ');

  return layout({
    title: 'Dashboard',
    active: '/admin',
    body: `<h1>Dashboard</h1>
<p class="sub">JSON content under <span class="mono">CONTENT_DIR</span> is the source of truth. Edits here are validated and backed up before they are written.</p>

${readOnly}
${statusBanner(report)}

<div class="grid">
  <div class="stat"><b>${summary.speciesTotal}</b><span>Species</span></div>
  <div class="stat"><b>${summary.speciesEnabled}</b><span>Enabled</span></div>
  <div class="stat"><b>${summary.speciesDisabled}</b><span>Disabled</span></div>
  <div class="stat"><b>${summary.itemsTotal}</b><span>Items (${summary.itemsEnabled} enabled)</span></div>
  <div class="stat"><b>${summary.questsTotal}</b><span>Quests (${summary.questsEnabled ? 'on' : 'off'})</span></div>
</div>

<div class="card">
  <h2 style="margin-top:0">Species by rarity</h2>
  <table><thead><tr><th>Rarity</th><th>Total</th><th>Enabled</th><th>Encounter weight</th></tr></thead>
  <tbody>${rarityRows}</tbody></table>
  <h2>Affinity spread</h2>
  <div>${affinity}</div>
  <h2>Species files</h2>
  <div>${files}</div>
</div>

<div class="card">
  <h2 style="margin-top:0">Config highlights</h2>
  <table><tbody>${highlights}</tbody></table>
</div>

<div class="card">
  <h2 style="margin-top:0">Actions</h2>
  <div class="actions">
    <a class="btn" href="/admin/species">Species</a>
    <a class="btn" href="/admin/items">Items</a>
    <a class="btn" href="/admin/tables">Drop rates &amp; tables</a>
    <a class="btn" href="/admin/quests">Quests</a>
    <button data-action="/admin/validate-content" data-refresh="false">Validate content</button>
    <button class="alt" data-action="/admin/reload-content" data-refresh="false"${
      reloadAvailable ? '' : ' disabled title="No database connection"'
    }>Reload content</button>
  </div>
  <p class="muted" style="margin-bottom:0">Reload re-seeds species and items into Postgres immediately. Changes to <span class="mono">tables.json</span> tuning are picked up on the next bot restart.</p>
</div>`,
  });
}
