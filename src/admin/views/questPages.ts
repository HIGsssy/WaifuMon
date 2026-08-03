import { RARITIES } from '../../db/schema';
import { QUEST_DIFFICULTIES, QUEST_EVENT_TYPES } from '../../modules/content/schemas';
import type { DailyQuestsConfig, QuestPoolEntry } from '../../modules/content/schemas';
import {
  esc,
  jsonField,
  layout,
  numberField,
  selectField,
  textField,
  textareaField,
} from './html';

function rewardSummary(q: QuestPoolEntry): string {
  const parts: string[] = [];
  if (q.rewards.waifubux > 0) parts.push(`${q.rewards.waifubux} WB`);
  if (q.rewards.essence > 0) parts.push(`${q.rewards.essence} Essence`);
  for (const i of q.rewards.items) parts.push(`${i.quantity}× ${i.slug}`);
  return parts.join(' · ');
}

export function questListPage(config: DailyQuestsConfig): string {
  const totalWeight = config.pool.reduce((a, q) => a + q.weight, 0);
  const rows = config.pool
    .map(
      (q) => `<tr>
<td><a href="/admin/quests/${encodeURIComponent(q.slug)}">${esc(q.title)}</a><br>
<span class="muted mono">${esc(q.slug)}</span></td>
<td class="mono">${esc(q.type)}${q.rarityAtLeast ? ` ≥ ${esc(q.rarityAtLeast)}` : ''}</td>
<td>${q.target}</td>
<td><span class="badge">${esc(q.difficulty)}</span></td>
<td>${q.weight}${totalWeight > 0 ? ` <span class="muted">(${((q.weight / totalWeight) * 100).toFixed(1)}%)</span>` : ''}</td>
<td class="muted">${esc(rewardSummary(q))}</td>
<td>
  <a class="btn small" href="/admin/quests/${encodeURIComponent(q.slug)}">Edit</a>
  <button class="small" data-action="/admin/quests/${encodeURIComponent(q.slug)}/remove"
    data-confirm="Remove &quot;${esc(q.slug)}&quot; from the quest pool? Quests already assigned to players keep their frozen copy.">Remove</button>
</td>
</tr>`,
    )
    .join('');

  return layout({
    title: 'Quests',
    active: '/admin/quests',
    body: `<div class="section-head"><h1>Daily quests</h1><a class="btn" href="/admin/quests/new">New quest</a></div>
<p class="sub">Pool of ${config.pool.length}, total weight ${totalWeight}. Daily quests are ${
      config.enabled ? 'enabled' : '<b>disabled</b>'
    }, ${config.questsPerDay} assigned per player per day — those two settings and the all-complete bonus live in the <span class="mono">dailyQuests</span> block on <a href="/admin/tables">Tables &amp; rates</a>.</p>
<div class="card"><table>
<thead><tr><th>Quest</th><th>Type</th><th>Target</th><th>Difficulty</th><th>Weight</th><th>Rewards</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="muted">The pool is empty.</td></tr>'}</tbody>
</table></div>`,
  });
}

export function questFormPage(quest: QuestPoolEntry | null): string {
  const isNew = quest == null;
  const q: QuestPoolEntry = quest ?? {
    slug: '',
    title: '',
    description: '',
    type: 'hunt_energy_spent',
    target: 5,
    weight: 10,
    difficulty: 'easy',
    rewards: { waifubux: 50, essence: 0, items: [] },
  };
  const action = isNew ? '/admin/quests' : `/admin/quests/${encodeURIComponent(q.slug)}`;

  return layout({
    title: isNew ? 'New quest' : q.title,
    active: '/admin/quests',
    body: `<div class="section-head"><h1>${isNew ? 'New quest' : esc(q.title)}</h1>
<a class="btn" href="/admin/quests">Back to pool</a></div>
<p class="sub">Saved into <span class="mono">tables.json → dailyQuests.pool</span>. Rewards must grant at least one of WaifuBux, Essence or items, and every item slug must exist.</p>
<form class="card" data-post="${action}">
  <div class="row">
    <div>${textField('slug', 'Slug', q.slug, { hint: 'lowercase_snake_case' })}</div>
    <div>${textField('title', 'Title', q.title)}</div>
  </div>
  ${textareaField('description', 'Description', q.description, { rows: 2 })}
  <div class="row">
    <div>${selectField('type', 'Event type', q.type, QUEST_EVENT_TYPES)}</div>
    <div>${numberField('target', 'Target', q.target, { step: '1' })}</div>
    <div>${numberField('weight', 'Pool weight', q.weight, { step: '1' })}</div>
    <div>${selectField('difficulty', 'Difficulty', q.difficulty, QUEST_DIFFICULTIES)}</div>
  </div>
  ${selectField('rarityAtLeast', 'Minimum rarity', q.rarityAtLeast ?? '', ['', ...RARITIES], {
    hint: 'only for capture_success_rarity_at_least',
  })}
  <div class="row">
    <div>${numberField('rewards.waifubux', 'Reward — WaifuBux', q.rewards.waifubux, { step: '1' })}</div>
    <div>${numberField('rewards.essence', 'Reward — Essence', q.rewards.essence, { step: '1' })}</div>
  </div>
  ${jsonField('rewards.items', 'Reward — items', q.rewards.items, {
    rows: 4,
    hint: '[{"slug":"basic_charm","quantity":2}]',
  })}
  <div class="actions"><button class="primary" type="submit">Save</button></div>
</form>`,
  });
}
