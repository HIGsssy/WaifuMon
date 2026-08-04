/**
 * GameEventBus semantics.
 *
 * The contract that matters: subscribers are strictly downstream. A broken
 * one must not silence its peers and must not surface to the gameplay call
 * site — that is the whole reason emissions happen post-commit.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildGameEvent,
  createGameEventBus,
  emitGameEvents,
  EVENT_META,
  gameEvent,
  type GameEvent,
  type GameEventKind,
  type GameEventSource,
} from '../../src/modules/events/gameEvents';
import { silentLogger } from '../helpers/testDb';

const SOURCE: GameEventSource = {
  guildId: 'g-1',
  guildDbId: 1,
  playerId: 7,
  playerName: 'Whistler',
  playerMention: '<@u-1>',
  channelId: 'c-1',
};

function bus() {
  return createGameEventBus({ logger: silentLogger() });
}

describe('buildGameEvent', () => {
  it('mints a unique eventId and stamps occurredAt, kind, scope and visibility', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const a = buildGameEvent(gameEvent('PLAYER_LEVEL_UP', { level: 3, rewardLabels: [] }), SOURCE, at);
    const b = buildGameEvent(gameEvent('PLAYER_LEVEL_UP', { level: 4, rewardLabels: [] }), SOURCE, at);

    expect(a.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.occurredAt).toEqual(at);
    expect(a.kind).toBe('PLAYER_LEVEL_UP');
    expect(a.scope).toBe('player-visible');
    expect(a.visibility).toBe('major');
    expect(a.playerName).toBe('Whistler');
    expect(a.guildId).toBe('g-1');
  });

  it('honors a per-event visibility override without changing scope', () => {
    const event = buildGameEvent(
      gameEvent(
        'PLAYER_CAPTURE_SUCCESS',
        { speciesName: 'Luna', rarity: 'UR', isDuplicate: false, waifuId: 12 },
        'major',
      ),
      SOURCE,
    );
    expect(event.visibility).toBe('major');
    expect(event.scope).toBe('player-visible');
    // Default for the kind is 'normal' — the override is what moved it.
    expect(EVENT_META.PLAYER_CAPTURE_SUCCESS.visibility).toBe('normal');
  });

  it('marks the internal-only kinds as internal scope', () => {
    const internal: GameEventKind[] = [
      'CARE_TICK_APPLIED',
      'CARE_BUDDY_CHANGED',
      'ENERGY_REGENERATED',
      'PLAYER_RETURNED_FROM_INACTIVITY',
      'TRAINER_PROFILE_REFRESH_REQUESTED',
    ];
    for (const kind of internal) {
      expect(EVENT_META[kind].scope, kind).toBe('internal');
    }
  });
});

describe('createGameEventBus', () => {
  it('delivers every event to every subscriber', async () => {
    const b = bus();
    const a1: GameEvent[] = [];
    const a2: GameEvent[] = [];
    b.subscribe((e) => void a1.push(e));
    b.subscribe((e) => void a2.push(e));
    expect(b.subscriberCount).toBe(2);

    await b.emit(buildGameEvent(gameEvent('PLAYER_STARTED_HUNT', { location: 'the Docks' }), SOURCE));

    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(1);
    expect(a1[0]!.kind).toBe('PLAYER_STARTED_HUNT');
  });

  it('isolates a throwing subscriber — peers still receive, emit still resolves', async () => {
    const b = bus();
    const good: GameEvent[] = [];
    b.subscribe(() => {
      throw new Error('boom');
    });
    b.subscribe((e) => void good.push(e));
    b.subscribe(async () => {
      throw new Error('async boom');
    });

    await expect(
      b.emit(buildGameEvent(gameEvent('PLAYER_FOUND_ESSENCE', { amount: 5, balanceAfter: 5 }), SOURCE)),
    ).resolves.toBeUndefined();
    expect(good).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const b = bus();
    const seen: GameEvent[] = [];
    const handler = (e: GameEvent): void => void seen.push(e);
    b.subscribe(handler);
    await b.emit(buildGameEvent(gameEvent('PLAYER_LEVEL_UP', { level: 2, rewardLabels: [] }), SOURCE));
    b.unsubscribe(handler);
    await b.emit(buildGameEvent(gameEvent('PLAYER_LEVEL_UP', { level: 3, rewardLabels: [] }), SOURCE));

    expect(seen).toHaveLength(1);
    expect(b.subscriberCount).toBe(0);
  });

  it('is not disturbed by a subscriber that subscribes during dispatch', async () => {
    const b = bus();
    const late = vi.fn();
    b.subscribe(() => {
      b.subscribe(late);
    });
    await b.emit(buildGameEvent(gameEvent('PLAYER_LEVEL_UP', { level: 2, rewardLabels: [] }), SOURCE));
    // The late subscriber joined mid-dispatch; it only sees the next event.
    expect(late).not.toHaveBeenCalled();
    await b.emit(buildGameEvent(gameEvent('PLAYER_LEVEL_UP', { level: 3, rewardLabels: [] }), SOURCE));
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('emitGameEvents', () => {
  it('emits descriptors in order with one shared timestamp', async () => {
    const b = bus();
    const seen: GameEvent[] = [];
    b.subscribe((e) => void seen.push(e));
    const at = new Date('2026-02-02T12:00:00.000Z');

    await emitGameEvents(
      b,
      SOURCE,
      [
        gameEvent('PLAYER_COMPLETED_HUNT', { location: 'the Grove', reason: 'inactivity' }),
        gameEvent('PLAYER_STARTED_HUNT', { location: 'the Docks' }),
      ],
      at,
    );

    expect(seen.map((e) => e.kind)).toEqual(['PLAYER_COMPLETED_HUNT', 'PLAYER_STARTED_HUNT']);
    expect(seen.every((e) => e.occurredAt === at)).toBe(true);
  });

  it('resolves even when every subscriber fails', async () => {
    const b = bus();
    b.subscribe(() => {
      throw new Error('nope');
    });
    await expect(
      emitGameEvents(b, SOURCE, [gameEvent('AWAKENING', { waifuId: 1, buddyName: 'Luna' })]),
    ).resolves.toBeUndefined();
  });
});
