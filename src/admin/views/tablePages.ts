import type { RawContent } from '../../modules/content/adminContentService';
import { esc, jsonField, layout, numberField } from './html';

interface Section {
  key: string;
  title: string;
  blurb: string;
  /** Rendered diagnostics: computed totals and warnings for this block. */
  notes?: string;
}

function weightTable(
  rows: { label: string; weight: number; extra?: string }[],
  caption: string,
): string {
  const total = rows.reduce((a, r) => a + r.weight, 0);
  const cells = rows
    .map(
      (r) => `<tr><td class="mono">${esc(r.label)}</td><td>${r.weight}</td>
<td>${total > 0 ? `${((r.weight / total) * 100).toFixed(2)}%` : '—'}</td>
<td class="muted">${r.extra ?? ''}</td></tr>`,
    )
    .join('');
  const totalNote =
    total > 0
      ? `<b>${total}</b>`
      : '<b style="color:var(--err)">0 — nothing can roll from this table</b>';
  return `<table><caption style="text-align:left;color:var(--muted);padding:6px 0">${esc(caption)} · total weight ${totalNote}</caption>
<thead><tr><th>Entry</th><th>Weight</th><th>Share</th><th></th></tr></thead><tbody>${cells}</tbody></table>`;
}

function huntNotes(raw: RawContent): string {
  const t = raw.tables;
  const enabledItems = new Set(raw.items.filter((i) => i.enabled).map((i) => i.slug));
  const knownItems = new Set(raw.items.map((i) => i.slug));
  const itemNote = (slug: string): string =>
    !knownItems.has(slug)
      ? '<span style="color:var(--err)">unknown item slug</span>'
      : !enabledItems.has(slug)
        ? '<span style="color:var(--warn)">item disabled</span>'
        : '';

  return `${weightTable(
    t.hunt.resultTable.map((r) => ({ label: r.kind, weight: r.weight })),
    'Hunt result table',
  )}
${weightTable(
  t.hunt.rarityTable.map((r) => {
    const enabled = raw.species.filter((s) => s.rarity === r.rarity && s.enabled).length;
    return {
      label: r.rarity,
      weight: r.weight,
      extra:
        r.weight > 0 && enabled === 0
          ? '<span style="color:var(--warn)">0 enabled species in this bucket</span>'
          : `${enabled} enabled species`,
    };
  }),
  'Rarity table',
)}
${weightTable(
  t.hunt.itemFind.sub.map((s) => ({
    label: `${s.slug} (${s.minQty}–${s.maxQty})`,
    weight: s.weight,
    extra: itemNote(s.slug),
  })),
  'Item find',
)}
${weightTable(
  t.hunt.rareItemFind.sub.map((s) => ({
    label: `${s.slug} (${s.minQty}–${s.maxQty})`,
    weight: s.weight,
    extra: itemNote(s.slug),
  })),
  'Rare item find',
)}
<p class="muted">WaifuBux find ${t.hunt.waifubuxFind.min}–${t.hunt.waifubuxFind.max} · Essence find ${t.hunt.essenceFind.min}–${t.hunt.essenceFind.max} · ${t.hunt.flavor.length} flavor lines</p>`;
}

function affinityNotes(raw: RawContent): string {
  const cfg = raw.tables.buddyAffinity;
  const edges = Object.entries(cfg.wheel);
  const wheel =
    edges.length === 0
      ? '<p class="muted">Wheel is empty — every matchup resolves neutral and no bonus is ever applied.</p>'
      : `<table><thead><tr><th>Buddy affinity</th><th>beats</th></tr></thead><tbody>${edges
          .map(([from, to]) => `<tr><td class="mono">${esc(from)}</td><td class="mono">${esc(to)}</td></tr>`)
          .join('')}</tbody></table>`;
  const bonuses = Object.entries(cfg.strongBonusByRarity)
    .map(
      ([rarity, value]) =>
        `<tr><td class="mono">${esc(rarity)}</td><td>+${value}</td><td>−${
          cfg.weakPenaltyByRarity[rarity as keyof typeof cfg.weakPenaltyByRarity]
        }</td></tr>`,
    )
    .join('');
  return `${wheel}
<p class="muted">Neutral styles: ${cfg.neutralStyles.map((s) => `<span class="badge">${esc(s)}</span>`).join(' ')}</p>
<table><thead><tr><th>Rarity</th><th>Strong bonus</th><th>Weak penalty</th></tr></thead><tbody>${bonuses}</tbody></table>`;
}

function questNotes(raw: RawContent): string {
  const q = raw.tables.dailyQuests;
  const total = q.pool.reduce((a, e) => a + e.weight, 0);
  return `<p class="muted">${q.enabled ? 'Enabled' : 'Disabled'} · ${q.questsPerDay}/day · pool of ${
    q.pool.length
  } (total weight ${total})${
    q.enabled && q.pool.length < q.questsPerDay
      ? ' <span style="color:var(--warn)">pool smaller than questsPerDay</span>'
      : ''
  }. Per-quest editing lives on the <a href="/admin/quests">Quests</a> page.</p>`;
}

export function tablesPage(raw: RawContent): string {
  const t = raw.tables as unknown as Record<string, unknown>;

  const sections: Section[] = [
    {
      key: 'hunt',
      title: 'Hunt — result, rarity and find tables',
      blurb: 'Weighted result table, rarity buckets, item/rare-item finds, currency ranges, flavor lines.',
      notes: huntNotes(raw),
    },
    {
      key: 'capture',
      title: 'Capture',
      blurb: 'Base capture rate per rarity, clamp bounds, announcement thresholds.',
    },
    {
      key: 'buddyAffinity',
      title: 'Buddy affinity',
      blurb: 'Matchup wheel, neutral styles and the rarity-scaled bonus/penalty.',
      notes: affinityNotes(raw),
    },
    {
      key: 'energy',
      title: 'Energy & care mode',
      blurb: 'Base max energy plus the Care Mode tick config.',
    },
    { key: 'inventory', title: 'Inventory', blurb: 'Capture-item soft capacity.' },
    { key: 'dailyPackage', title: 'Daily package', blurb: 'WaifuBux and items granted per daily claim.' },
    { key: 'duplicate', title: 'Duplicates & release', blurb: 'Essence values by rarity, release fraction, prompt timeout.' },
    { key: 'progression', title: 'Player progression', blurb: 'Level curve, XP awards, level-40 rarity shift, daily bonus items, prestige titles.' },
    { key: 'waifuProgression', title: 'Waifumon progression', blurb: 'Per-copy level curve, buddy hunt rewards, Essence investment.' },
    {
      key: 'dailyQuests',
      title: 'Daily quests',
      blurb: 'Enable flag, quests per day, all-complete bonus and the full pool.',
      notes: questNotes(raw),
    },
    { key: 'uiFlavor', title: 'UI flavor', blurb: 'Main-menu flavor line pool.' },
    { key: 'uiSplash', title: 'Splash screen', blurb: 'Daily launch splash: title, body lines, optional image path, button label.' },
    { key: 'session', title: 'Session', blurb: 'Inactivity timeout before a stale board is retired.' },
  ];

  const rendered = sections
    .map((s) => {
      const value = t[s.key];
      return `<details class="card" ${s.key === 'hunt' ? 'open' : ''}>
<summary>${esc(s.title)} <span class="muted mono">${esc(s.key)}</span></summary>
<p class="muted">${s.blurb}</p>
${s.notes ?? ''}
<form data-post="/admin/tables" data-wrap='{"section":${JSON.stringify(s.key)},"value":__VALUE__}'>
  ${jsonField('__root', 'JSON', value, { rows: 14, hint: 'validated against the Zod schema before anything is written' })}
  <div class="actions"><button class="primary" type="submit">Save section</button></div>
</form>
</details>`;
    })
    .join('');

  return layout({
    title: 'Tables & rates',
    active: '/admin/tables',
    body: `<h1>Tables &amp; rates</h1>
<p class="sub">Each block is one top-level key of <span class="mono">tables.json</span>. Saving validates the whole file plus every cross-file reference, backs up the original, and writes atomically — a rejected edit changes nothing on disk.</p>

<div class="card">
  <h2 style="margin-top:0">Quick edit</h2>
  <form data-post="/admin/tables" data-wrap='{"section":"session","value":__VALUE__}'>
    ${numberField('inactiveTimeoutMinutes', 'Session inactivity timeout (minutes)', raw.tables.session.inactiveTimeoutMinutes, { step: '1' })}
    <div class="actions"><button class="primary" type="submit">Save session</button></div>
  </form>
</div>

${rendered}`,
  });
}
