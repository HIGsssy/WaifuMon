/**
 * Author assistance for the encounter editor — pure, no React.
 *
 * Two kinds of finding, kept apart on purpose:
 *
 *   - **errors** block Save. Each is something the server would refuse (or an
 *     unfinished field the schema requires), caught here so the author sees
 *     it next to the form rather than as a failed request.
 *   - **warnings** never block. The runtime accepts the configuration; it is
 *     just probably not what the author meant.
 *
 * Nothing here is stricter than the server. When the supporting data (the
 * encounter list, the vendors) has not loaded, the checks that need it are
 * skipped rather than guessed.
 */
import type { AdminVendor } from '@/api/adminVendors';
import type { Draft } from './encounterDraft';
import { unchosenSpeciesIssues, unfinishedItemIssues } from './encounterDraft';
import type { EncounterGraph } from './encounterGraph';
import { MAX_COOLDOWN_SECONDS, formatDuration } from './duration';
import { isValidSlug } from './slugs';

export interface DraftValidation {
  errors: string[];
  warnings: string[];
}

export interface ValidationContext {
  isNew: boolean;
  /** Slugs of every *other* encounter. Null until the list has loaded. */
  otherSlugs: ReadonlySet<string> | null;
  /** The chain graph with this draft in it. Null until the list has loaded. */
  graph: EncounterGraph | null;
  vendors: readonly AdminVendor[] | null;
  enabledRegions?: readonly string[] | undefined;
  itemName?: ((slug: string) => string | undefined) | undefined;
}

const CHOICE_LABEL_MAX = 80;

function each(
  d: Draft,
  fn: (effect: Record<string, unknown>, where: string, choiceIndex: number) => void,
): void {
  // Same wording as `encounterDraft`'s own effect labels, so every issue
  // about one effect names it the same way.
  d.choices.forEach((c, i) => {
    c.successEffects.forEach((e, j) => fn(e, `Choice #${i + 1}, success effect #${j + 1}`, i));
    c.failureEffects.forEach((e, j) => fn(e, `Choice #${i + 1}, failure effect #${j + 1}`, i));
  });
}

export function validateDraft(d: Draft, ctx: ValidationContext): DraftValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const itemName = (slug: string) => ctx.itemName?.(slug) ?? slug;

  /* ── Errors ── */
  if (!d.name.trim()) errors.push('Give the encounter a name.');
  if (!isValidSlug(d.slug)) {
    errors.push('The slug must be 1–64 lowercase letters, numbers or underscores (Advanced).');
  } else if (ctx.isNew && ctx.otherSlugs?.has(d.slug)) {
    errors.push(
      `Another encounter already uses the slug “${d.slug}”, and saving would replace it. ` +
        'Change the slug under Advanced.',
    );
  }
  if (!Number.isInteger(d.weight) || d.weight < 1) {
    errors.push('Weight must be a whole number of 1 or more.');
  }
  if (d.cooldownSeconds > MAX_COOLDOWN_SECONDS) {
    errors.push(`The repeat cooldown can be at most ${formatDuration(MAX_COOLDOWN_SECONDS)}.`);
  }
  if (d.choicesRequired && d.choices.length === 0) errors.push('Add at least one choice.');
  d.choices.forEach((c, i) => {
    if (!c.label.trim()) errors.push(`Choice #${i + 1} needs a label.`);
    else if (c.label.length > CHOICE_LABEL_MAX) {
      errors.push(`Choice #${i + 1}: labels can be at most ${CHOICE_LABEL_MAX} characters.`);
    }
  });
  errors.push(...unchosenSpeciesIssues(d), ...unfinishedItemIssues(d));
  each(d, (e, where) => {
    if (e.type === 'trigger_encounter') {
      if (!e.encounterSlug) errors.push(`${where}: pick the encounter to continue to.`);
      else if (e.encounterSlug === d.slug) {
        errors.push(`${where}: an encounter cannot continue to itself.`);
      }
    }
    if (e.type === 'open_vendor' && !e.vendorKey) errors.push(`${where}: pick a vendor.`);
    if (e.type === 'temp_buff' && !e.key) errors.push(`${where}: give the buff a key.`);
    if (
      e.type === 'temp_buff' &&
      (typeof e.durationSeconds !== 'number' || e.durationSeconds < 1 || e.durationSeconds > 86_400)
    ) {
      errors.push(`${where}: a buff lasts between 1 second and 1 day.`);
    }
  });
  if (d.chainedEncounterSlug && d.chainedEncounterSlug === d.slug) {
    errors.push('The “after any choice” follow-up cannot be this encounter itself.');
  }
  // Reachability only blocks an Active save — the server's rule too. A draft
  // or disabled encounter never spawns and is skipped as a follow-up, so its
  // Hunt/Travel flags are inert; a half-built chain node saves with a warning
  // and is checked again when it is activated.
  const role = ctx.graph?.roleOf(d.slug);
  if (role && !role.spawns && role.parents.length === 0) {
    if (d.lifecycle === 'active') {
      errors.push(
        'This encounter can never appear: it is not in Hunt or Travel, and no other encounter ' +
          'continues to it. Turn on Hunt or Travel, or link to it from another encounter.',
      );
    } else {
      warnings.push(
        'Nothing can reach this encounter yet: it is not in Hunt or Travel, and no other ' +
          'encounter continues to it. That is fine while it is a draft, but it cannot be ' +
          'activated until one of those is true.',
      );
    }
  }

  /* ── Warnings ── */
  if (!d.choicesRequired && d.choices.length === 0) warnings.push('This encounter has no choices.');
  if (ctx.graph) {
    for (const issue of ctx.graph.issuesFor(d.slug)) {
      if (issue.code === 'orphan' || issue.code === 'self') continue; // errors above
      warnings.push(issue.message);
    }
  }
  if (ctx.vendors) {
    const byKey = new Map(ctx.vendors.map((v) => [v.vendorKey, v]));
    each(d, (e, where) => {
      if (e.type !== 'open_vendor' || typeof e.vendorKey !== 'string' || !e.vendorKey) return;
      const vendor = byKey.get(e.vendorKey);
      if (!vendor) {
        warnings.push(
          `${where}: vendor “${e.vendorKey}” does not exist — players will be told the merchant is unavailable.`,
        );
      } else if (vendor.stock.length === 0) {
        warnings.push(`${where}: vendor “${vendor.name}” has no inventory.`);
      }
    });
  }
  each(d, (e, where, i) => {
    if (e.type !== 'consume_item' || typeof e.slug !== 'string' || !e.slug) return;
    if (d.choices[i]!.requirements.requiresItem !== e.slug) {
      warnings.push(
        `${where}: consumes ${itemName(e.slug)}, but the choice does not require the player to own it.`,
      );
    }
  });
  d.choices.forEach((c, i) => {
    if (c.check.type === 'none' && c.failureEffects.length > 0) {
      warnings.push(
        `Choice #${i + 1} is automatic (it always succeeds), so its failure effects never run.`,
      );
    }
  });
  if (d.routes.length > 0 && !d.travelEligible) {
    warnings.push('Travel routes are set, but Travel is off — the routes have no effect.');
  }
  const enabled = ctx.enabledRegions;
  if (
    enabled &&
    (d.huntEligible || d.travelEligible) &&
    d.regions.length > 0 &&
    d.regions.every((r) => !enabled.includes(r))
  ) {
    warnings.push(
      'Every region this encounter is limited to is disabled, so it cannot appear on its own until one is enabled.',
    );
  }
  return { errors, warnings };
}
