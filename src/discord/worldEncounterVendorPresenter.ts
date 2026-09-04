/**
 * World-encounter vendor presenter — the ephemeral Discord UI for a
 * {@link WorldEncounterVendorService.getForEncounter} snapshot.
 *
 * Every purchase button carries the vendor's `activeEncounterId` and the
 * item slug in its custom id; the button handler asks the service for
 * canonical state and rejects stale/out-of-stock clicks server-side. The
 * UI merely lists the current stock; it is not the security boundary.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { SessionPayload } from './ephemeralSession';
import { buildCustomId } from './types';
import type { VendorInstance } from '../modules/worldEncounters/vendorService';

const BUTTONS_PER_ROW = 5;

function currencyLabel(c: 'waifubux' | 'essence'): string {
  return c === 'essence' ? '✨' : '💰';
}

export function buildVendorPresent(
  vendor: VendorInstance,
  statusLine?: string,
): SessionPayload {
  const embed = new EmbedBuilder()
    .setTitle(`🛒 ${vendor.name}`)
    .setColor(0x8b6ff0)
    .setDescription(vendor.description || '*(no description)*');

  const stockLines = vendor.stock
    .map(
      (s) =>
        `${s.itemSlug} — ${s.price}${currencyLabel(s.currency)}${
          s.remaining <= 0 ? ' *(sold out)*' : s.remaining < s.quantity ? ` (${s.remaining} left)` : ''
        }`,
    )
    .join('\n');
  embed.addFields({ name: 'On offer', value: stockLines || '*(nothing on offer)*' });
  if (statusLine) embed.addFields({ name: 'Last purchase', value: statusLine });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const available = vendor.stock.filter((s) => s.remaining > 0);
  for (let i = 0; i < available.length; i += BUTTONS_PER_ROW) {
    const chunk = available.slice(i, i + BUTTONS_PER_ROW);
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const entry of chunk) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildCustomId('encv', 'buy', String(vendor.activeEncounterId), entry.itemSlug),
          )
          .setLabel(`Buy ${entry.itemSlug} (${entry.price}${currencyLabel(entry.currency)})`)
          .setStyle(ButtonStyle.Success),
      );
    }
    rows.push(row);
  }

  return { embeds: [embed], components: rows };
}
