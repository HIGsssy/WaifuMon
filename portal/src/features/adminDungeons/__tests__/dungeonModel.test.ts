import { describe, it, expect } from 'vitest';
import { keyFromName, starterDungeon } from '../dungeonModel';
describe('draft creation', () => {
  it('makes stable keys, including the shared Enemy creation helper', () => {
    expect(keyFromName('Service Tunnels!')).toBe('service_tunnels');
    expect(keyFromName('A'.repeat(80))).toHaveLength(64);
  });
  it('creates a traversal-safe empty entrance with no rewards', () => {
    const d = starterDungeon('tunnels', 'Tunnels', ['waifu-valley']);
    expect(d.entranceRoomId).toBe(d.rooms[0]!.id);
    expect(d.rooms[0]).toMatchObject({ extraction: true, actions: [] });
    expect(d.settings.progressionCurrency).toBeNull();
  });
});
