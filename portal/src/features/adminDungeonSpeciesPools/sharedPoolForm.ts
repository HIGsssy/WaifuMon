import { keyFromName } from '@/features/adminDungeons/dungeonModel';

// Mirrors DungeonKeySchema. Keep the backend authoritative at creation/import.
export const POOL_KEY_MAX_LENGTH = 64;
export function validPoolKey(key: string): boolean {
  return key.length <= POOL_KEY_MAX_LENGTH && /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key);
}
export function poolKeyFromName(name: string): string {
  return keyFromName(name.normalize('NFKD').replace(/\p{M}/gu, '')) || 'pool';
}
export function availablePoolKey(name: string, taken: ReadonlySet<string>): string {
  const base = poolKeyFromName(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate =
      base.slice(0, POOL_KEY_MAX_LENGTH - suffix.length).replace(/_+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
