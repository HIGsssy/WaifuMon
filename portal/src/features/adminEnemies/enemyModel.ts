/**
 * Pure helpers for the enemy pages: the form an editor holds, the bounds the
 * server enforces (checked here first, so a typo never needs a round trip),
 * and the readable forms of usage and of what an edit changed.
 */
import {
  DEFAULT_SPRITE_PLACEMENT,
  SPRITE_ANCHOR_LABELS,
  type ArtworkLayerRef,
  type SpritePlacement,
} from '@/api/adminArtworkAssets';
import {
  ENEMY_KEY_MAX_LENGTH,
  ENEMY_KEY_PATTERN,
  ENEMY_MAX_TAGS,
  ENEMY_NAME_MAX_LENGTH,
  ENEMY_STAT_MAX,
  ENEMY_STAT_MIN,
  type EnemyDefinition,
  type EnemyDetail,
  type EnemyInput,
  type EnemyIssue,
  type EnemyOrigin,
  type EnemyRef,
  type EnemyReference,
  type EnemyStat,
  type EnemyVisual,
} from '@/api/adminEnemies';

export const STAT_LABELS: Record<EnemyStat, string> = { attack: 'ATK', defense: 'DEF', hp: 'HP' };
export const ENEMY_STATS: readonly EnemyStat[] = ['attack', 'defense', 'hp'];

export const enemyPath = (key: string) => `/admin/enemies/${encodeURIComponent(key)}`;

/** `ATK 55 · DEF 30 · HP 300` — an enemy's stats wherever one line has to do. */
export function statLine(enemy: Pick<EnemyRef, EnemyStat>): string {
  return ENEMY_STATS.map((s) => `${STAT_LABELS[s]} ${enemy[s]}`).join(' · ');
}

export const ORIGIN_LABELS: Record<EnemyOrigin, string> = {
  shipped: 'Shipped',
  edited: 'Edited in Portal',
  custom: 'Created in Portal',
};

/** The picture that stands for an enemy in a row: its full artwork, else its sprite. */
export function enemyThumb(visual: EnemyVisual): ArtworkLayerRef {
  return visual.artworkAssetId || visual.artworkPath
    ? { assetId: visual.artworkAssetId, artworkPath: visual.artworkPath }
    : { assetId: visual.spriteAssetId, artworkPath: visual.spriteArtworkPath };
}

export const hasSprite = (visual: EnemyVisual) =>
  visual.spriteAssetId !== null || visual.spriteArtworkPath !== null;

/** Whether `enemy` matches what was typed: its name, its key or one of its tags. */
export function matchesSearch(enemy: Pick<EnemyRef, 'key' | 'name' | 'tags'>, text: string) {
  const needle = text.trim().toLowerCase();
  if (needle === '') return true;
  return [enemy.name, enemy.key, ...enemy.tags].some((v) => v.toLowerCase().includes(needle));
}

// ── the form ────────────────────────────────────────────────────────────────

/** Stats are kept as typed, so a field can be cleared and a bad value shown rather than rounded. */
export interface EnemyForm {
  name: string;
  description: string;
  enabled: boolean;
  attack: string;
  defense: string;
  hp: string;
  tags: string[];
  artworkAssetId: string | null;
  spriteAssetId: string | null;
  /** Null is "use the default placement". */
  spritePlacement: SpritePlacement | null;
}

export const BLANK_ENEMY_FORM: EnemyForm = {
  name: '',
  description: '',
  enabled: true,
  attack: '10',
  defense: '0',
  hp: '50',
  tags: [],
  artworkAssetId: null,
  spriteAssetId: null,
  spritePlacement: null,
};

export function formOf(enemy: EnemyDetail): EnemyForm {
  return {
    name: enemy.name,
    description: enemy.description,
    enabled: enemy.enabled,
    attack: String(enemy.attack),
    defense: String(enemy.defense),
    hp: String(enemy.hp),
    tags: enemy.tags,
    artworkAssetId: enemy.artworkAssetId,
    spriteAssetId: enemy.spriteAssetId,
    spritePlacement: enemy.spritePlacement,
  };
}

/** The whole numbers a stat field accepts; anything else is an error, never a rounding. */
export function statError(stat: EnemyStat, text: string): string | null {
  const min = ENEMY_STAT_MIN[stat];
  const n = Number(text);
  return /^\d+$/.test(text.trim()) && n >= min && n <= ENEMY_STAT_MAX
    ? null
    : `${STAT_LABELS[stat]} must be a whole number from ${min} to ${ENEMY_STAT_MAX.toLocaleString('en-US')}.`;
}

export function keyError(key: string): string | null {
  if (key === '') return 'A key is required.';
  if (key.length > ENEMY_KEY_MAX_LENGTH)
    return `The key can be at most ${ENEMY_KEY_MAX_LENGTH} characters.`;
  return ENEMY_KEY_PATTERN.test(key)
    ? null
    : 'The key must be lower_snake_case — letters, digits and single underscores.';
}

/** `Fast Flyer` → `fast_flyer`, or why what was typed cannot be a tag. */
export function tagFrom(
  text: string,
  existing: readonly string[],
): { tag: string } | { error: string } | null {
  const tag = text
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (tag === '') return null;
  if (!ENEMY_KEY_PATTERN.test(tag) || tag.length > ENEMY_KEY_MAX_LENGTH)
    return { error: `“${text.trim()}” is not a tag — use lower_snake_case, like fast_flyer.` };
  if (existing.includes(tag)) return { error: `“${tag}” is already listed.` };
  if (existing.length >= ENEMY_MAX_TAGS)
    return { error: `An enemy can have at most ${ENEMY_MAX_TAGS} tags.` };
  return { tag };
}

/** Problems found before asking the server, keyed like the server's own issue paths. */
export function formErrors(form: EnemyForm): EnemyIssue[] {
  const issues: EnemyIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  if (form.name.trim() === '') add('name', 'A name is required.');
  else if (form.name.trim().length > ENEMY_NAME_MAX_LENGTH)
    add('name', `The name can be at most ${ENEMY_NAME_MAX_LENGTH} characters.`);
  for (const stat of ENEMY_STATS) {
    const problem = statError(stat, form[stat]);
    if (problem) add(stat, problem);
  }
  return issues;
}

/** What Create sends: the basics, and nothing about artwork (added in the editor). */
export function createInputOf(form: EnemyForm): EnemyInput {
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    attack: Number(form.attack),
    defense: Number(form.defense),
    hp: Number(form.hp),
    tags: form.tags,
  };
}

/** What Save sends. The shipped artwork paths are never sent, so the server keeps them. */
export function inputOf(form: EnemyForm): EnemyInput {
  return {
    ...createInputOf(form),
    description: form.description.trim(),
    artworkAssetId: form.artworkAssetId,
    spriteAssetId: form.spriteAssetId,
    spritePlacement: form.spritePlacement,
  };
}

/** The issues at `path` exactly, or beneath it (`tags` also shows `tags[2]`). */
export function issuesAt(issues: readonly EnemyIssue[], path: string): EnemyIssue[] {
  return issues.filter(
    (i) => i.path === path || i.path.startsWith(`${path}.`) || i.path.startsWith(`${path}[`),
  );
}

// ── usage ───────────────────────────────────────────────────────────────────

export interface UsageGroup {
  kind: string;
  key: string;
  /** What the content is called: its name, else its key. */
  title: string;
  /** Where to open it, when the Portal has a page for it. */
  to: string | null;
  usages: string[];
}

const KIND_LABELS: Record<string, string> = {
  dungeon_zone: 'Dungeon',
  combat_trial: 'Combat Trial',
};
export const usageKindLabel = (kind: string) => KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');

/** References grouped by the content that holds them: one line per dungeon or trial. */
export function groupReferences(references: readonly EnemyReference[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const ref of references) {
    const id = `${ref.kind}:${ref.key}`;
    const group = groups.get(id) ?? {
      kind: ref.kind,
      key: ref.key,
      title: ref.name ?? ref.key,
      to:
        ref.kind === 'dungeon_zone' ? `/admin/dungeons/zones/${encodeURIComponent(ref.key)}` : null,
      usages: [],
    };
    group.usages.push(ref.usage);
    groups.set(id, group);
  }
  return [...groups.values()];
}

// ── what an edit changed ────────────────────────────────────────────────────

export function describePlacement(placement: SpritePlacement | null): string {
  if (placement === null) return 'default';
  const { anchor, scaleBasisPoints, offsetX, offsetY } = placement;
  return `${SPRITE_ANCHOR_LABELS[anchor]}, ${Math.round(scaleBasisPoints / 100)}%, X ${offsetX}, Y ${offsetY}`;
}

export interface FieldChange {
  field: string;
  shipped: string;
  current: string;
}

/** The fields where the enemy differs from the copy Git ships, in words. */
export function shippedDiff(enemy: EnemyDetail, shipped: EnemyDefinition): FieldChange[] {
  const text = (value: string | null) => (value === null || value === '' ? 'none' : value);
  const rows: Array<[string, string, string]> = [
    ['Name', shipped.name, enemy.name],
    ['Description', text(shipped.description), text(enemy.description)],
    ['Enabled', shipped.enabled ? 'yes' : 'no', enemy.enabled ? 'yes' : 'no'],
    ['ATK', String(shipped.attack), String(enemy.attack)],
    ['DEF', String(shipped.defense), String(enemy.defense)],
    ['HP', String(shipped.hp), String(enemy.hp)],
    ['Tags', text(shipped.tags.join(', ')), text(enemy.tags.join(', '))],
    ['Shipped full artwork', text(shipped.artworkPath), text(enemy.artworkPath)],
    ['Shipped sprite', text(shipped.spriteArtworkPath), text(enemy.spriteArtworkPath)],
    [
      'Sprite placement',
      describePlacement(shipped.spritePlacement),
      describePlacement(enemy.spritePlacement),
    ],
  ];
  return rows
    .filter(([, before, after]) => before !== after)
    .map(([field, before, after]) => ({ field, shipped: before, current: after }));
}

export const placementInEffect = (placement: SpritePlacement | null) =>
  placement ?? DEFAULT_SPRITE_PLACEMENT;

export const formatUpdated = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
