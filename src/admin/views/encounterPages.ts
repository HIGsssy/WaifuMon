/**
 * Admin panel views for the World Encounters feature.
 *
 * List: filterable table + row-level actions.
 * Form: general fields as regular controls; the choice tree as a validated
 *   JSON textarea (matching how `/admin/tables` treats similarly-shaped
 *   blocks). The tree is small — a few objects — and a fully bespoke
 *   drag-and-drop editor would triple this file for no functional gain.
 * Preview: renders the encounter as it would appear ephemerally in Discord,
 *   with a probe of the check math against a test buddy context.
 */
import {
  WORLD_ENCOUNTER_LIFECYCLES,
  WORLD_ENCOUNTER_RARITIES,
  WORLD_ENCOUNTER_TYPES,
} from '../../db/schema';
import { REGIONS } from '../../modules/locations/regions';
import type { LoadedEncounter } from '../../modules/worldEncounters/types';
import {
  boolField,
  esc,
  layout,
  numberField,
  selectField,
  textField,
  textareaField,
  jsonField,
} from './html';

const TYPE_LABEL: Record<string, string> = {
  decision: 'Decision',
  skill_check: 'Skill Check',
  combat: 'Combat',
  vendor: 'Vendor',
  deity: 'Deity',
  discovery: 'Discovery',
};

const RARITY_BADGE: Record<string, string> = {
  common: 'off',
  uncommon: 'on',
  rare: 'on',
  mythic: 'on',
};

/* ─────────────────────── List page ─────────────────────── */

export interface EncounterListFilters {
  q: string;
  region: string;
  source: string;
  type: string;
  rarity: string;
  lifecycle: string;
}

function sourceLabel(e: LoadedEncounter): string {
  const parts: string[] = [];
  if (e.huntEligible) parts.push('hunt');
  if (e.travelEligible) parts.push('travel');
  return parts.length > 0 ? parts.join(' + ') : '<span class="muted">none</span>';
}

function regionSummary(e: LoadedEncounter): string {
  if (e.regions.length === 0 && e.routes.length === 0) return '<span class="muted">any</span>';
  const parts: string[] = [];
  if (e.regions.length > 0) parts.push(e.regions.map((r) => `<span class="badge">${esc(r)}</span>`).join(' '));
  if (e.routes.length > 0)
    parts.push(
      e.routes
        .map((r) => `<span class="badge">${esc(r.fromRegion)}→${esc(r.toRegion)}</span>`)
        .join(' '),
    );
  return parts.join(' ');
}

export function filterEncounters(
  encounters: LoadedEncounter[],
  f: EncounterListFilters,
): LoadedEncounter[] {
  return encounters.filter((e) => {
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!e.name.toLowerCase().includes(q) && !e.slug.toLowerCase().includes(q)) return false;
    }
    if (f.region && !(e.regions.includes(f.region) || (e.regions.length === 0 && !f.region.startsWith('!')))) {
      // Encounter with no explicit region rows is "any" — matches every region filter too.
      if (e.regions.length > 0) return false;
    }
    if (f.source === 'hunt' && !e.huntEligible) return false;
    if (f.source === 'travel' && !e.travelEligible) return false;
    if (f.type && e.type !== f.type) return false;
    if (f.rarity && e.rarity !== f.rarity) return false;
    if (f.lifecycle && e.lifecycle !== f.lifecycle) return false;
    return true;
  });
}

export function encounterListPage(
  encounters: LoadedEncounter[],
  filters: EncounterListFilters,
): string {
  const rows =
    encounters
      .map(
        (e) => `<tr>
<td><a href="/admin/encounters/${e.id}">${esc(e.name)}</a><br>
<span class="muted mono">${esc(e.slug)}</span></td>
<td><span class="badge">${esc(TYPE_LABEL[e.type] ?? e.type)}</span></td>
<td><span class="badge ${RARITY_BADGE[e.rarity] ?? 'off'}">${esc(e.rarity)}</span></td>
<td>${sourceLabel(e)}</td>
<td>${regionSummary(e)}</td>
<td class="mono">${e.weight}</td>
<td><span class="badge ${e.lifecycle === 'active' ? 'on' : 'off'}">${esc(e.lifecycle)}</span></td>
<td>
  <a class="btn small" href="/admin/encounters/${e.id}">Edit</a>
  <a class="btn small" href="/admin/encounters/${e.id}/preview">Preview</a>
  <button class="small" data-action="/admin/encounters/${e.id}/toggle-enabled">${
    e.lifecycle === 'active' ? 'Disable' : 'Enable'
  }</button>
  <button class="small" data-action="/admin/encounters/${e.id}/clone">Clone</button>
</td>
</tr>`,
      )
      .join('') || '<tr><td colspan="8" class="muted">No encounters match these filters.</td></tr>';

  const filterOptions = (name: keyof EncounterListFilters, values: readonly string[]): string =>
    `<select name="${esc(name)}"><option value="">any</option>${values
      .map((v) => `<option value="${esc(v)}"${filters[name] === v ? ' selected' : ''}>${esc(v)}</option>`)
      .join('')}</select>`;

  const body = `<div class="section-head"><h1>World Encounters</h1><a class="btn" href="/admin/encounters/new">New encounter</a></div>
<p class="sub">${encounters.length} encounter${encounters.length === 1 ? '' : 's'}. Delete is disabled once an encounter has resolved history — disable it instead.</p>
<form class="card filters" method="get" action="/admin/encounters">
  <label>Search <input type="text" name="q" value="${esc(filters.q)}" placeholder="name or slug"></label>
  <label>Region ${filterOptions('region', REGIONS)}</label>
  <label>Source ${filterOptions('source', ['hunt', 'travel'])}</label>
  <label>Type ${filterOptions('type', WORLD_ENCOUNTER_TYPES)}</label>
  <label>Rarity ${filterOptions('rarity', WORLD_ENCOUNTER_RARITIES)}</label>
  <label>Lifecycle ${filterOptions('lifecycle', WORLD_ENCOUNTER_LIFECYCLES)}</label>
  <button type="submit" class="small">Apply</button>
  <a class="small btn" href="/admin/encounters">Reset</a>
</form>
<div class="card"><table>
<thead><tr><th>Name</th><th>Type</th><th>Rarity</th><th>Source</th><th>Region / Route</th><th>Weight</th><th>State</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`;

  return layout({ title: 'Encounters', active: '/admin/encounters', body });
}

/* ─────────────────────── Form page ─────────────────────── */

/**
 * Encounter authoring form.
 *
 * `encounter` is null for the "new" page — every field defaults to the
 * corresponding runtime default. On submit the client script `collect`s
 * `data-field`s under `input` and POSTs to `data-post`. The route handler
 * runs {@link parseEncounterInput}; validation errors flash inline.
 */
export function encounterFormPage(encounter: LoadedEncounter | null, itemSlugs: readonly string[]): string {
  const isNew = encounter == null;
  const title = isNew ? 'New encounter' : `Edit — ${encounter.name}`;
  const postUrl = '/admin/encounters/save';
  const heading = isNew
    ? 'New encounter'
    : `${esc(encounter.name)} <span class="muted mono">${esc(encounter.slug)}</span>`;

  const choicesJson = JSON.stringify(
    encounter
      ? encounter.choices.map((c) => ({
          label: c.label,
          emoji: c.emoji,
          requirements: c.requirements,
          check: c.check,
          successEffects: c.successEffects,
          failureEffects: c.failureEffects,
        }))
      : [],
    null,
    2,
  );

  const regionsList = encounter ? encounter.regions.join(', ') : '';
  const routesJson = JSON.stringify(encounter ? encounter.routes : [], null, 2);
  const metadataJson = JSON.stringify(encounter ? encounter.metadata : {}, null, 2);

  const body = `<div class="section-head"><h1>${heading}</h1>
<div>
  ${!isNew ? `<a class="btn small" href="/admin/encounters/${encounter.id}/preview">Preview</a>` : ''}
  <a class="btn small" href="/admin/encounters">Back</a>
</div>
</div>

<form data-post="${esc(postUrl)}" data-wrap='{"input":__VALUE__}' class="card">
  <div class="grid">
    ${textField('slug', 'Slug', encounter?.slug ?? '', { hint: 'lowercase, letters/digits/underscores', required: true })}
    ${textField('name', 'Name', encounter?.name ?? '', { required: true })}
    ${selectField('type', 'Type', encounter?.type ?? 'decision', WORLD_ENCOUNTER_TYPES)}
    ${selectField('rarity', 'Rarity', encounter?.rarity ?? 'common', WORLD_ENCOUNTER_RARITIES)}
    ${numberField('weight', 'Weight', encounter?.weight ?? 10, { step: '1' })}
    ${selectField('lifecycle', 'Lifecycle', encounter?.lifecycle ?? 'draft', WORLD_ENCOUNTER_LIFECYCLES)}
    ${boolField('huntEligible', 'Hunt eligible', encounter?.huntEligible ?? true)}
    ${boolField('travelEligible', 'Travel eligible', encounter?.travelEligible ?? false)}
    ${boolField('choicesRequired', 'Choices required', encounter?.choicesRequired ?? true)}
    ${numberField('cooldownSeconds', 'Player cooldown (seconds)', encounter?.cooldownSeconds ?? 0, { step: '1' })}
    ${textField('artworkPath', 'Artwork path (relative to assets/)', encounter?.artworkPath ?? '', { placeholder: 'encounters/bandit_ambush.png', type: 'nulltext' })}
    ${textField('chainedEncounterSlug', 'Chained encounter slug', encounter?.chainedEncounterSlug ?? '', { type: 'nulltext' })}
  </div>
  ${textareaField('description', 'Description / intro text', encounter?.description ?? '', { rows: 4 })}
  ${textField('regions', 'Regions (comma or newline separated; empty = all)', regionsList, { type: 'list', hint: `known: ${REGIONS.join(', ')}` })}
  ${jsonField('routes', 'Route restrictions (JSON: [{ "fromRegion", "toRegion" }])', encounter?.routes ?? [])}
  ${jsonField('choices', 'Choices (JSON)', encounter?.choices ?? [])}
  ${jsonField('metadata', 'Metadata (JSON, free-form)', encounter?.metadata ?? {})}
  <p class="hint">Known items for give/consume effects: ${itemSlugs
    .map((s) => `<span class="badge">${esc(s)}</span>`)
    .join(' ')}</p>
  <button type="submit">Save</button>
</form>
${
  !isNew
    ? `<div class="card">
<h2>Danger zone</h2>
<button data-action="/admin/encounters/${encounter.id}/delete" data-confirm="Delete this encounter definition? History rows will block this if any exist.">Delete</button>
</div>`
    : ''
}`;

  return layout({ title, active: '/admin/encounters', body });
}

/* ─────────────────────── Preview page ─────────────────────── */

export interface PreviewChoiceRender {
  choiceId: number;
  label: string;
  emoji: string | null;
  available: boolean;
  unavailableReason: string | null;
  chance: number;
  breakdown: {
    base: number;
    spTerm: number;
    levelTerm: number;
    affinityMod: number;
    raceMod: number;
    buddyBonusMod: number;
    baseBias: number;
  };
}

export function encounterPreviewPage(
  encounter: LoadedEncounter,
  ctx: {
    playerLevel: number;
    buddy: { level: number; affinity: string; race: string; currentSp: number } | null;
  },
  choices: PreviewChoiceRender[],
): string {
  const buddyLine = ctx.buddy
    ? `lvl ${ctx.buddy.level} · SP ${ctx.buddy.currentSp} · ${ctx.buddy.affinity} · ${ctx.buddy.race}`
    : '<span class="muted">no buddy</span>';

  const choiceRows = choices
    .map(
      (c) => `<tr>
<td>${c.emoji ? esc(c.emoji) + ' ' : ''}${esc(c.label)}</td>
<td>${c.available ? '<span class="badge on">available</span>' : `<span class="badge off">${esc(c.unavailableReason ?? '')}</span>`}</td>
<td class="mono">${(c.chance * 100).toFixed(1)}%</td>
<td class="mono muted">base ${c.breakdown.base.toFixed(2)} + sp ${c.breakdown.spTerm.toFixed(3)} + lvl ${c.breakdown.levelTerm.toFixed(3)} + aff ${c.breakdown.affinityMod.toFixed(2)} + race ${c.breakdown.raceMod.toFixed(2)} + buddy ${c.breakdown.buddyBonusMod.toFixed(3)} + bias ${c.breakdown.baseBias.toFixed(2)}</td>
</tr>`,
    )
    .join('');

  const body = `<div class="section-head"><h1>Preview — ${esc(encounter.name)}</h1>
<a class="btn small" href="/admin/encounters/${encounter.id}">Edit</a>
</div>
<div class="card">
  <p class="sub"><span class="badge">${esc(TYPE_LABEL[encounter.type] ?? encounter.type)}</span> <span class="badge ${RARITY_BADGE[encounter.rarity] ?? 'off'}">${esc(encounter.rarity)}</span></p>
  <p>${esc(encounter.description || '(no description)')}</p>
  <p class="hint">Test context — player lvl ${ctx.playerLevel}, buddy: ${buddyLine}</p>
</div>

<form class="card filters" method="get" action="/admin/encounters/${encounter.id}/preview">
  <label>Player level <input type="number" name="playerLevel" value="${ctx.playerLevel}" min="1" max="200"></label>
  ${
    ctx.buddy
      ? `<label>Buddy level <input type="number" name="buddyLevel" value="${ctx.buddy.level}" min="1" max="200"></label>
<label>Buddy SP <input type="number" name="buddySp" value="${ctx.buddy.currentSp}" min="0" max="2000"></label>
<label>Buddy affinity <input type="text" name="buddyAffinity" value="${esc(ctx.buddy.affinity)}"></label>
<label>Buddy race <input type="text" name="buddyRace" value="${esc(ctx.buddy.race)}"></label>`
      : `<label><input type="checkbox" name="withBuddy" value="1"> Add test buddy</label>`
  }
  <button type="submit" class="small">Recalculate</button>
</form>

<div class="card">
  <h2>Choices</h2>
  <table>
    <thead><tr><th>Label</th><th>Status</th><th>Success chance</th><th>Breakdown</th></tr></thead>
    <tbody>${choiceRows || '<tr><td colspan="4" class="muted">No choices defined.</td></tr>'}</tbody>
  </table>
</div>`;

  return layout({ title: `Preview — ${encounter.name}`, active: '/admin/encounters', body });
}
