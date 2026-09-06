/**
 * Shared roll/probability formatting for player-facing result screens.
 *
 * Extracted from the capture screen so every surface that shows "here is the
 * chance, here is the number the server rolled against it" reads identically.
 * A second, subtly different probability format would make two screens
 * describing the *same* RNG contract look like two different systems, so this
 * module — not each presenter — owns the convention:
 *
 *   • a probability is shown as a percentage, one decimal only when it needs
 *     one (0.65 → "65%", 0.525 → "52.5%")
 *   • a roll is shown as the same unit value scaled to 0–100 with one decimal
 *     (0.412 → "41.2"), so "roll below the chance" is readable at a glance
 *
 * Nothing here knows about embeds — the callers assemble the lines.
 */

/** 0.21 → "21%", 0.525 → "52.5%". Every chance line in the bot uses this. */
export function formatChancePercent(chance: number): string {
  const pct = Math.round(chance * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * The [0, 1) unit value an attempt actually rolled, in human-friendly 0–100
 * form with a single decimal place (0.734 → "73.4"). This is the *same* number
 * the server compared against the chance — the attempt succeeds when this roll
 * lands within it.
 */
export function formatRoll(roll: number): string {
  return (roll * 100).toFixed(1);
}

/**
 * A signed percentage-point modifier for a breakdown line: 0.15 → "+15%",
 * −0.075 → "−7.5%". Uses a true minus sign to match the rest of the UI.
 */
export function formatModifierPercent(delta: number): string {
  const pct = Math.round(Math.abs(delta) * 1000) / 10;
  const magnitude = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${delta < 0 ? '−' : '+'}${magnitude}%`;
}
