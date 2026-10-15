/** Reusable Phase 4D2 scenarios. All policy/content mutations stay in disposable DBs. */
import { eq } from 'drizzle-orm';
import { species } from '../../src/db/schema';
import { DungeonDefinitionSchema } from '../../src/modules/dungeons/content/dungeonDefinition';
import { dungeonRngSource } from '../../src/modules/dungeons/engine/seeds';
import { singleRoomDungeon } from './dungeonFixtures';
import type { DungeonWorld } from './dungeonWorld';

export const COMMON = 'neko_barista';
export const RARE = 'neon_kitsune';
export const LEGEND = 'prototype_zero';
export const FINITE = 'p4d2_finite_android';
export const UNLIMITED = 'p4d2_unlimited_android';
export const CHARM = 'basic_charm';
export const CONTRACT = 'mythic_contract';

export async function installExclusiveSpecies(w: DungeonWorld) {
  const [base] = await w.t.db.select().from(species).where(eq(species.slug, COMMON));
  if (!base) throw new Error('missing seeded fixture species');
  const { id: _id, ...body } = base;
  await w.t.db.insert(species).values(
    [FINITE, UNLIMITED].map((slug) => ({
      ...body,
      slug,
      name: slug,
      tags: ['dungeon_exclusive'],
      affinity: 'switch',
    })),
  );
}

export const namedEncounter = (key: string, slug = COMMON) =>
  singleRoomDungeon(
    [
      {
        id: 'meet',
        type: 'wild_encounter',
        source: { kind: 'species', species: slug },
        intro: 'An android waits.',
        capture: {},
      },
    ],
    (d) => {
      d.key = key;
      d.rooms![0]!.extraction = true;
    },
  );

export function weightedDungeon(key: string) {
  return singleRoomDungeon(
    [
      {
        id: 'meet',
        type: 'wild_encounter',
        source: { kind: 'pool', poolId: 'androids' },
        intro: 'Movement in the scrap.',
        capture: {},
      },
      {
        id: 'again',
        type: 'wild_encounter',
        source: { kind: 'pool', poolId: 'androids' },
        intro: 'Another sound.',
        capture: {},
      },
    ],
    (d) => {
      d.key = key;
      d.flags = [{ key: 'signal_on', scope: 'run' }];
      d.speciesPools = [
        {
          id: 'androids',
          name: 'Androids',
          entries: [
            { id: 'common', species: COMMON, weight: 4 },
            { id: 'rare', species: RARE, weight: 3 },
            { id: 'legend', species: LEGEND, weight: 2, when: { type: 'flag', flag: 'signal_on' } },
            { id: 'nothing', nothing: true, weight: 1, text: 'Only rust and silence.' },
          ],
        },
      ];
    },
  );
}

/** Event → weighted wild → capture rescue → boss victory → direct rescue → treasure. */
export function captureLifecycleDungeon(key: string) {
  const d = weightedDungeon(key);
  return DungeonDefinitionSchema.parse({
    ...d,
    flags: [...d.flags, { key: 'caught', scope: 'run' }, { key: 'warden_down', scope: 'run' }],
    events: [
      {
        id: 'repair',
        title: 'Repair the generator',
        text: 'Reconnect the cable.',
        choices: [
          {
            id: 'repair',
            label: 'Repair',
            outcome: {
              text: 'Power restored.',
              effects: [{ type: 'set_flag', flag: 'signal_on', value: true }],
            },
          },
          { id: 'refuse', label: 'Leave it broken', outcome: { text: 'Still dark.' } },
        ],
      },
    ],
    rooms: [
      {
        id: 'hall',
        name: 'Workshop',
        actions: [
          { id: 'repair', type: 'event', source: { kind: 'event', eventId: 'repair' } },
          {
            ...d.rooms[0]!.actions[0],
            results: {
              captured: { text: 'She trusts you.', flags: [{ flag: 'caught', value: true }] },
            },
            outcomes: { captured: { type: 'action', actionId: 'repair_rescue' } },
          },
          { id: 'decoy', type: 'reward', reward: { currency: { min: 999, max: 999 } } },
          {
            id: 'repair_rescue',
            type: 'rescue',
            mode: 'capture',
            when: { type: 'flag', flag: 'signal_on' },
            source: { kind: 'species', species: RARE },
            intro: 'The repaired android wakes.',
            capture: {},
          },
        ],
      },
      {
        id: 'boss_room',
        name: 'Warden',
        actions: [
          {
            id: 'warden',
            type: 'boss',
            waves: [{ enemy: { key: 'warden' } }],
            outcomes: { victory: { type: 'action', actionId: 'unlock' } },
          },
          { id: 'unlock', type: 'set_flag', flag: 'warden_down' },
        ],
      },
      {
        id: 'cell',
        name: 'Cell',
        extraction: true,
        actions: [
          {
            id: 'free',
            type: 'rescue',
            mode: 'direct',
            source: { kind: 'species', species: FINITE },
            intro: 'The captive steps forward.',
            when: {
              type: 'all',
              conditions: [
                { type: 'flag', flag: 'warden_down' },
                { type: 'room_completed', roomId: 'boss_room' },
              ],
            },
          },
          {
            id: 'treasure',
            type: 'reward',
            optional: true,
            reward: { currency: { min: 7, max: 7 } },
          },
        ],
      },
      { id: 'out', name: 'Exit', kind: 'exit' },
    ],
    connections: [
      { id: 'to_boss', from: 'hall', to: 'boss_room' },
      { id: 'to_cell', from: 'boss_room', to: 'cell' },
      { id: 'to_exit', from: 'cell', to: 'out' },
    ],
  });
}

export function findSeed(predicate: (seed: number) => boolean): number {
  for (let seed = 1; seed < 100_000; seed++) if (predicate(seed)) return seed;
  throw new Error('no deterministic fixture seed');
}
export const poolRoll = (seed: number, total: number, action = 'meet') =>
  dungeonRngSource(seed)
    .stream('encounter', 'hall', action, 'pool')
    .intInclusive(0, total - 1);
export const attemptRoll = (seed: number) =>
  dungeonRngSource(seed).stream('encounter', 'hall', 'meet', 'attempt', 1).next();
