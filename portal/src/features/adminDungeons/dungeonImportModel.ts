import type { DungeonImportDecisions, DungeonImportPlan } from '@/api/adminDungeons';

export const IMPORT_BODY_LIMIT = 2 * 1024 * 1024;
export const requestBytes = (body: unknown) =>
  new TextEncoder().encode(JSON.stringify(body)).byteLength;
export const draftOperation = (plan: DungeonImportPlan): DungeonImportDecisions['dungeon'] =>
  plan.target?.status === 'new'
    ? 'create'
    : plan.target?.status === 'identical'
      ? 'unchanged'
      : 'replace';

/** Interpret server issue codes only; content validation remains on the server. */
export function importBlockers(plan: DungeonImportPlan, decisions: DungeonImportDecisions) {
  return plan.issues.filter((issue) => {
    if (issue.severity !== 'error') return false;
    if (!plan.validPackage) return true;
    if (issue.code === 'enemy_missing') {
      return plan.enemies
        .filter((e) => e.status === 'missing' || e.status === 'missing_bundled')
        .some(
          (e) =>
            decisions.enemies[e.key] !== 'create' &&
            !(decisions.enemies[e.key] === 'leave_missing' && decisions.allowMissingDependencies),
        );
    }
    return !(
      decisions.allowMissingDependencies &&
      ['reward_table_missing', 'region_missing', 'currency_missing'].includes(issue.code)
    );
  });
}
export function decisionsComplete(plan: DungeonImportPlan, decisions: DungeonImportDecisions) {
  return plan.enemies.every(
    (e) =>
      e.status === 'identical' ||
      (e.status === 'different' || e.status === 'existing_unverified'
        ? decisions.enemies[e.key] === 'use_existing'
        : (e.status === 'missing_bundled' && decisions.enemies[e.key] === 'create') ||
          (decisions.enemies[e.key] === 'leave_missing' && decisions.allowMissingDependencies)),
  );
}
export function packageInformation(pkg: unknown) {
  const obj = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : {};
  const dungeon =
    obj.dungeon && typeof obj.dungeon === 'object' ? (obj.dungeon as Record<string, unknown>) : {};
  const show = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : 'Unknown';
  return {
    name: show(dungeon.name),
    key: show(dungeon.key),
    version: show(obj.schemaVersion),
    format: show(obj.format),
  };
}
