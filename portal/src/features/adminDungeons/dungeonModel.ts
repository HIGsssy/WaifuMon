import type { DungeonDefinition } from '@/api/adminDungeons';
import { NEW_DUNGEON_RISK } from './dungeonRiskModel';
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
    // Written out so a new dungeon's risk does not depend on the schema's defaults.
    settings: { progressionCurrency: null, ...NEW_DUNGEON_RISK },
    flags: [],
    rooms: [{ id: 'entrance', name: 'Entrance', extraction: true, actions: [] }],
    connections: [],
  };
}
