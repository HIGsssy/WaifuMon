import { ITEM_CATEGORIES } from '../../db/schema';
import type { ItemContent } from '../../modules/content/schemas';
import { boolField, esc, layout, numberField, selectField, textField, textareaField } from './html';

export interface ItemRow {
  item: ItemContent;
  references: string[];
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
<td>${i.purchasable ? `${i.buyPrice} WB` : '<span class="muted">not sold</span>'}</td>
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
<thead><tr><th></th><th>Name</th><th>Category</th><th>Capture</th><th>Shop</th><th>Referenced by</th><th>State</th><th></th></tr></thead>
<tbody>${body}</tbody></table></div>`,
  });
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
    dailyStockLimit: null,
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
  <div class="row">
    <div>${numberField('captureModifier', 'Capture modifier', i.captureModifier, {
      hint: '> 0, blank = not a charm',
      step: '0.05',
    })}</div>
    <div>${numberField('buyPrice', 'Buy price', i.buyPrice, {
      hint: 'required when purchasable',
      step: '1',
    })}</div>
    <div>${numberField('dailyStockLimit', 'Daily stock limit', i.dailyStockLimit, {
      hint: 'blank = unlimited',
      step: '1',
    })}</div>
  </div>
  ${textareaField('description', 'Description', i.description, { rows: 3 })}
  ${boolField('purchasable', 'Purchasable in the shop', i.purchasable)}
  ${boolField('isGuaranteedCapture', 'Guarantees capture (never purchasable)', i.isGuaranteedCapture)}
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
