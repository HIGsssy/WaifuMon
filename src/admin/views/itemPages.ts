import { ITEM_CATEGORIES, ITEM_EFFECT_TYPES, PRICE_CURRENCIES } from '../../db/schema';
import {
  MAX_ITEM_CAPTURE_BONUS,
  type CaptureBonusEffect,
  type ItemContent,
  type RestoreEnergyEffect,
} from '../../modules/content/schemas';
import { boolField, esc, layout, numberField, selectField, textField, textareaField } from './html';

export interface ItemRow {
  item: ItemContent;
  references: string[];
}

/** "40 Essence" / "25 WB" — shop column in the list. */
function priceLabel(i: ItemContent): string {
  if (!i.purchasable || i.buyPrice == null) return '<span class="muted">not sold</span>';
  return `${i.buyPrice} ${i.priceCurrency === 'essence' ? 'Essence' : 'WB'}`;
}

/** Compact effect summary for the list row. */
function effectLabel(i: ItemContent): string {
  if (i.effectType == null) return '<span class="muted">—</span>';
  const cfg = i.effectConfig;
  const detail =
    i.effectType === 'capture_bonus_charges' && cfg && 'captureBonus' in cfg
      ? ` <span class="muted">+${(cfg as CaptureBonusEffect).captureBonus} × ${(cfg as CaptureBonusEffect).charges}</span>`
      : '';
  return `<span class="badge">${esc(i.effectType)}</span>${detail}`;
}

export function itemListPage(rows: ItemRow[]): string {
  const body = rows
    .map(
      ({ item: i, references }) => `<tr>
<td>${esc(i.emoji ?? '')}</td>
<td><a href="/admin/items/${encodeURIComponent(i.slug)}">${esc(i.name)}</a><br>
<span class="muted mono">${esc(i.slug)}</span></td>
<td><span class="badge">${esc(i.category)}</span></td>
<td>${i.captureModifier == null ? '<span class="muted">—</span>' : `×${esc(i.captureModifier)}`}${
        i.isGuaranteedCapture ? ' <span class="badge">guaranteed</span>' : ''
      }</td>
<td>${effectLabel(i)}</td>
<td>${priceLabel(i)}</td>
<td class="muted">${
        references.length === 0
          ? '<span class="muted">none</span>'
          : references.map((r) => `<span class="badge">${esc(r)}</span>`).join(' ')
      }</td>
<td><span class="badge ${i.enabled ? 'on' : 'off'}">${i.enabled ? 'enabled' : 'disabled'}</span></td>
<td>
  <a class="btn small" href="/admin/items/${encodeURIComponent(i.slug)}">Edit</a>
  <button class="small" data-action="/admin/items/${encodeURIComponent(i.slug)}/toggle-enabled">${
    i.enabled ? 'Disable' : 'Enable'
  }</button>
</td>
</tr>`,
    )
    .join('');

  return layout({
    title: 'Items',
    active: '/admin/items',
    body: `<div class="section-head"><h1>Items</h1><a class="btn" href="/admin/items/new">New item</a></div>
<p class="sub">${rows.length} items. "Referenced by" lists every table that points at the slug — those references block a rename, and items are never deleted from the panel (disable instead).</p>
<div class="card"><table>
<thead><tr><th></th><th>Name</th><th>Category</th><th>Capture</th><th>Effect</th><th>Shop</th><th>Referenced by</th><th>State</th><th></th></tr></thead>
<tbody>${body}</tbody></table></div>`,
  });
}

/**
 * Effect fields are typed rather than raw JSON. All of them are rendered, and
 * a small script shows only the block that matches the selected `effectType`;
 * the POST handler drops the fields that don't belong to the chosen type
 * before validation, so a hidden leftover value can never leak into the file.
 */
function effectFields(i: ItemContent): string {
  const restore = (i.effectType === 'restore_energy_full'
    ? i.effectConfig
    : null) as RestoreEnergyEffect | null;
  const capture = (i.effectType === 'capture_bonus_charges'
    ? i.effectConfig
    : null) as CaptureBonusEffect | null;

  return `<h2>Active effect</h2>
<p class="muted">Set an effect type to make the item usable from the player's inventory screen. Config is validated against the effect type — capture-only fields are rejected on a <span class="mono">restore_energy_full</span> item and vice versa.</p>
<div class="row">
  <div>${selectField('effectType', 'Effect type', i.effectType ?? '', ['', ...ITEM_EFFECT_TYPES], {
    hint: 'blank = not usable',
  })}</div>
</div>
<div data-effect-block="restore_energy_full">
  ${boolField('effectConfig.restoreToMax', 'Restore to computed max energy (required)', restore?.restoreToMax ?? true)}
  ${boolField('effectConfig.exitCareMode', 'Also leave Care Mode when used', restore?.exitCareMode ?? true)}
</div>
<div data-effect-block="capture_bonus_charges">
  <div class="row">
    <div>${numberField('effectConfig.captureBonus', 'Capture bonus', capture?.captureBonus ?? 0.03, {
      hint: `flat, 0–${MAX_ITEM_CAPTURE_BONUS} (0.03 = +3%)`,
      step: '0.005',
    })}</div>
    <div>${numberField('effectConfig.charges', 'Charges', capture?.charges ?? 5, {
      hint: 'positive integer — capture attempts covered',
      step: '1',
    })}</div>
    <div>${selectField(
      'effectConfig.refreshBehavior',
      'Re-use behavior',
      capture?.refreshBehavior ?? 'refresh',
      ['refresh', 'ignore'],
      { hint: 'refresh = reset charges (never stacks)' },
    )}</div>
  </div>
</div>
<script>(function(){
  var sel = document.getElementById('f_effectType');
  if (!sel) return;
  function sync(){
    var v = sel.value;
    document.querySelectorAll('[data-effect-block]').forEach(function(el){
      var active = el.dataset.effectBlock === v;
      el.style.display = active ? '' : 'none';
      // Disabling is what actually keeps the inactive block out of the POST
      // body — collect() skips disabled inputs.
      el.querySelectorAll('[data-field]').forEach(function(f){ f.disabled = !active; });
    });
  }
  sel.addEventListener('change', sync);
  sync();
})();</script>`;
}

export function itemFormPage(item: ItemContent | null, references: string[]): string {
  const isNew = item == null;
  const i: ItemContent = item ?? {
    slug: '',
    name: '',
    category: 'capture',
    captureModifier: null,
    isGuaranteedCapture: false,
    purchasable: false,
    buyPrice: null,
    priceCurrency: 'waifubux',
    dailyStockLimit: null,
    effectType: null,
    effectConfig: null,
    description: '',
    emoji: null,
    enabled: true,
  };
  const action = isNew ? '/admin/items' : `/admin/items/${encodeURIComponent(i.slug)}`;
  const refWarning =
    references.length > 0
      ? `<div class="card" style="border-color:var(--warn)">
<b style="color:var(--warn)">Referenced by ${references.length} config location${references.length === 1 ? '' : 's'}</b>
<ul class="issues">${references.map((r) => `<li class="mono">${esc(r)}</li>`).join('')}</ul>
<p class="muted" style="margin-bottom:0">Renaming the slug is blocked while these exist. Disable the item instead of removing it.</p></div>`
      : '';

  return layout({
    title: isNew ? 'New item' : i.name,
    active: '/admin/items',
    body: `<div class="section-head"><h1>${isNew ? 'New item' : esc(i.name)}</h1>
<a class="btn" href="/admin/items">Back to list</a></div>
${refWarning}
<form class="card" data-post="${action}">
  <div class="row">
    <div>${textField('slug', 'Slug', i.slug, { hint: 'lowercase_snake_case' })}</div>
    <div>${textField('name', 'Name', i.name)}</div>
    <div>${selectField('category', 'Category', i.category, ITEM_CATEGORIES)}</div>
    <div>${textField('emoji', 'Emoji', i.emoji, { type: 'nulltext', hint: 'blank = none' })}</div>
  </div>
  <h2>Shop</h2>
  <div class="row">
    <div>${numberField('buyPrice', 'Buy price', i.buyPrice, {
      hint: 'required when purchasable; positive integer',
      step: '1',
    })}</div>
    <div>${selectField('priceCurrency', 'Price currency', i.priceCurrency, PRICE_CURRENCIES, {
      hint: 'which balance the purchase spends',
    })}</div>
    <div>${numberField('dailyStockLimit', 'Daily stock limit', i.dailyStockLimit, {
      hint: 'reserved — no purchase-limit system yet',
      step: '1',
    })}</div>
  </div>
  ${boolField('purchasable', 'Purchasable in the shop', i.purchasable)}
  <h2>Capture</h2>
  <div class="row">
    <div>${numberField('captureModifier', 'Capture modifier', i.captureModifier, {
      hint: '> 0, blank = not a charm',
      step: '0.05',
    })}</div>
  </div>
  ${boolField('isGuaranteedCapture', 'Guarantees capture (never purchasable)', i.isGuaranteedCapture)}
  ${effectFields(i)}
  <h2>Presentation</h2>
  ${textareaField('description', 'Description', i.description, { rows: 3 })}
  ${boolField('enabled', 'Enabled', i.enabled)}
  <div class="actions">
    <button class="primary" type="submit">Save</button>
    ${
      isNew
        ? ''
        : `<button type="button" class="alt" data-action="${action}/toggle-enabled">${
            i.enabled ? 'Disable' : 'Enable'
          }</button>`
    }
  </div>
</form>`,
  });
}
