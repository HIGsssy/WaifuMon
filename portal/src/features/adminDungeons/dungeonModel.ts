import type { DungeonDefinition } from '@/api/adminDungeons';
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '');
}

export function starterDungeon(
  key: string,
  name: string,
  availableRegions: string[],
): DungeonDefinition {
  return {
    key,
    name,
    description: '',
    availableRegions,
    entranceRoomId: 'entrance',
    artwork: null,
    background: null,
    settings: { progressionCurrency: null, defeatCurrencyRetentionBasisPoints: 0 },
    flags: [],
    rooms: [{ id: 'entrance', name: 'Entrance', extraction: true, actions: [] }],
    connections: [],
  };
}
