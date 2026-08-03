import { AFFINITIES, CONTENT_RATINGS, RARITIES } from '../../db/schema';
import type { SpeciesContent } from '../../modules/content/schemas';
import {
  boolField,
  esc,
  layout,
  numberField,
  selectField,
  textField,
  textareaField,
} from './html';

export interface SpeciesListFilters {
  q: string;
  rarity: string;
  affinity: string;
  enabled: string;
  sort: string;
}

export interface SpeciesListRow {
  species: SpeciesContent;
  file: string;
}

const RARITY_ORDER = new Map(RARITIES.map((r, i) => [r as string, i]));

export function filterAndSortSpecies(
  rows: SpeciesListRow[],
  f: SpeciesListFilters,
): SpeciesListRow[] {
  const q = f.q.trim().toLowerCase();
  const filtered = rows.filter(({ species: s }) => {
    if (q) {
      const haystack = [s.slug, s.name, s.archetype, ...s.tags].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (f.rarity && s.rarity !== f.rarity) return false;
    if (f.affinity && s.affinity !== f.affinity) return false;
    if (f.enabled === 'enabled' && !s.enabled) return false;
    if (f.enabled === 'disabled' && s.enabled) return false;
    return true;
  });
  const cmp: Record<string, (a: SpeciesListRow, b: SpeciesListRow) => number> = {
    slug: (a, b) => a.species.slug.localeCompare(b.species.slug),
    name: (a, b) => a.species.name.localeCompare(b.species.name),
    rarity: (a, b) =>
      (RARITY_ORDER.get(b.species.rarity) ?? 0) - (RARITY_ORDER.get(a.species.rarity) ?? 0) ||
      a.species.name.localeCompare(b.species.name),
  };
  return filtered.sort(cmp[f.sort] ?? cmp.rarity!);
}

function option(value: string, label: string, current: string): string {
  return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
}

export function speciesListPage(rows: SpeciesListRow[], f: SpeciesListFilters): string {
  const body = rows
    .map(({ species: s, file }) => {
      const preview = `/admin/assets/${s.imagePath
        .split('/')
        .map((p) => encodeURIComponent(p))
        .join('/')}`;
      return `<tr>
<td><img class="thumb" src="${esc(preview)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></td>
<td><a href="/admin/species/${encodeURIComponent(s.slug)}">${esc(s.name)}</a><br>
<span class="muted mono">${esc(s.slug)}</span></td>
<td><span class="badge">${esc(s.rarity)}</span></td>
<td>${esc(s.archetype)}</td>
<td>${esc(s.affinity)}</td>
<td class="muted">${esc(s.tags.join(', '))}</td>
<td class="muted mono">${esc(file)}</td>
<td><span class="badge ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'enabled' : 'disabled'}</span></td>
<td>
  <a class="btn small" href="/admin/species/${encodeURIComponent(s.slug)}">Edit</a>
  <button class="small" data-action="/admin/species/${encodeURIComponent(s.slug)}/toggle-enabled">${
    s.enabled ? 'Disable' : 'Enable'
  }</button>
</td>
</tr>`;
    })
    .join('');

  return layout({
    title: 'Species',
    active: '/admin/species',
    body: `<div class="section-head"><h1>Species</h1>
<a class="btn" href="/admin/species/new">New species</a></div>
<p class="sub">${rows.length} shown. Search matches slug, name, archetype and tags.</p>

<form class="filters" method="get" action="/admin/species">
  <div><label>Search</label><input name="q" value="${esc(f.q)}" placeholder="slug, name, archetype, tag"></div>
  <div><label>Rarity</label><select name="rarity">${option('', 'any', f.rarity)}${RARITIES.map((r) =>
    option(r, r, f.rarity),
  ).join('')}</select></div>
  <div><label>Affinity</label><select name="affinity">${option('', 'any', f.affinity)}${AFFINITIES.map(
    (a) => option(a, a, f.affinity),
  ).join('')}</select></div>
  <div><label>State</label><select name="enabled">${option('', 'any', f.enabled)}${option(
    'enabled',
    'enabled',
    f.enabled,
  )}${option('disabled', 'disabled', f.enabled)}</select></div>
  <div><label>Sort</label><select name="sort">${option('rarity', 'rarity', f.sort)}${option(
    'name',
    'name',
    f.sort,
  )}${option('slug', 'slug', f.sort)}</select></div>
  <div><button class="primary" type="submit">Apply</button>
  <a class="btn" href="/admin/species">Reset</a></div>
</form>

<div class="card"><table>
<thead><tr><th>Art</th><th>Name</th><th>Rarity</th><th>Archetype</th><th>Affinity</th><th>Tags</th><th>File</th><th>State</th><th></th></tr></thead>
<tbody>${body || '<tr><td colspan="9" class="muted">No species match these filters.</td></tr>'}</tbody>
</table></div>`,
  });
}

export function speciesFormPage(
  species: SpeciesContent | null,
  opts: { file?: string; speciesFiles: string[]; defaultFile: string },
): string {
  const isNew = species == null;
  const s: SpeciesContent = species ?? {
    slug: '',
    name: '',
    rarity: 'N',
    archetype: '',
    baseCaptureRate: null,
    description: '',
    tags: [],
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: '',
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
  };
  const action = isNew ? '/admin/species' : `/admin/species/${encodeURIComponent(s.slug)}`;
  const fileChoices = Array.from(new Set([...opts.speciesFiles, opts.defaultFile]));

  const preview = s.imagePath
    ? `<div class="card"><h2 style="margin-top:0">Art preview</h2>
<img src="/admin/assets/${s.imagePath
        .split('/')
        .map((p) => encodeURIComponent(p))
        .join('/')}" alt="" style="max-width:260px;border-radius:10px"
 onerror="this.insertAdjacentHTML('afterend','<p class=&quot;muted&quot;>No file at this path yet — the species is auto-disabled at load until the art exists.</p>');this.remove()">
<p class="muted mono">${esc(s.imagePath)}</p></div>`
    : '';

  return layout({
    title: isNew ? 'New species' : s.name,
    active: '/admin/species',
    body: `<div class="section-head"><h1>${isNew ? 'New species' : esc(s.name)}</h1>
<a class="btn" href="/admin/species">Back to list</a></div>
<p class="sub">${
      isNew
        ? 'Saved into the chosen species JSON file. Slug must be unique across every file.'
        : `Editing <span class="mono">${esc(s.slug)}</span>${opts.file ? ` in <span class="mono">${esc(opts.file)}</span>` : ''}.`
    }</p>

<form class="card" data-post="${action}">
  <div class="row">
    <div>${textField('slug', 'Slug', s.slug, { hint: 'lowercase_snake_case' })}</div>
    <div>${textField('name', 'Name', s.name)}</div>
  </div>
  <div class="row">
    <div>${selectField('rarity', 'Rarity', s.rarity, RARITIES)}</div>
    <div>${textField('archetype', 'Archetype', s.archetype, { hint: 'what she is' })}</div>
    <div>${selectField('affinity', 'Affinity', s.affinity, AFFINITIES, { hint: 'buddy matchup' })}</div>
    <div>${selectField('contentRating', 'Content rating', s.contentRating, CONTENT_RATINGS)}</div>
  </div>
  <div class="row">
    <div>${numberField('baseCaptureRate', 'Base capture rate', s.baseCaptureRate, {
      hint: '0 < x ≤ 1, blank = rarity default',
      step: '0.001',
    })}</div>
    <div>${numberField('perSpeciesWeight', 'Per-species weight', s.perSpeciesWeight, {
      hint: 'positive integer',
      step: '1',
    })}</div>
    <div>${textField('eventKey', 'Event key', s.eventKey, {
      type: 'nulltext',
      hint: 'blank = none',
    })}</div>
  </div>
  ${textField('imagePath', 'Image path', s.imagePath, {
    hint: 'relative to ASSETS_DIR, e.g. waifumon/my_slug/standard.png',
  })}
  ${textareaField('description', 'Description', s.description, { rows: 3 })}
  ${textareaField('tags', 'Tags', s.tags.join(', '), {
    type: 'list',
    rows: 2,
    hint: 'comma or newline separated',
  })}
  ${boolField('enabled', 'Enabled', s.enabled)}
  ${
    isNew
      ? `<label for="f_file">Species file</label>
<select id="f_file" data-field="__file">${fileChoices
          .map(
            (f) =>
              `<option value="${esc(f)}"${f === opts.defaultFile ? ' selected' : ''}>${esc(f)}</option>`,
          )
          .join('')}</select>`
      : ''
  }
  <div class="actions">
    <button class="primary" type="submit">Save</button>
    ${
      isNew
        ? ''
        : `<button type="button" class="alt" data-action="${action}/toggle-enabled">${
            s.enabled ? 'Disable' : 'Enable'
          }</button>`
    }
  </div>
</form>
${preview}
<p class="muted">Image upload is not part of this milestone — drop the PNG under <span class="mono">ASSETS_DIR</span> yourself, then point <span class="mono">imagePath</span> at it.</p>`,
  });
}
