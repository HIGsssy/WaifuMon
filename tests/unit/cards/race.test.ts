/**
 * Race resolution — the bridge between today's free-form `archetype` and the
 * closed race set the card frame needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  archetypeToRace,
  DEFAULT_RACE,
  isRaceCode,
  raceLabel,
  RACE_CODES,
  resolveRace,
} from '../../../src/modules/cards';

/** A logger stub that records the warnings the fallback path is supposed to emit. */
function warnSpy(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('RACE_CODES', () => {
  it('is exactly the seven codes the icon set ships', () => {
    expect([...RACE_CODES]).toEqual([
      'angel',
      'demon',
      'demi-human',
      'human',
      'spirit',
      'valkyrie',
      'android',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    for (const code of RACE_CODES) expect(isRaceCode(code)).toBe(true);
    for (const other of ['Angel', 'elf', '', null, undefined, 42]) {
      expect(isRaceCode(other)).toBe(false);
    }
  });

  it('labels races in upper case for the card pill', () => {
    expect(raceLabel('demi-human')).toBe('DEMI-HUMAN');
    expect(raceLabel('android')).toBe('ANDROID');
  });
});

describe('archetypeToRace', () => {
  it('maps every race code to itself', () => {
    for (const code of RACE_CODES) expect(archetypeToRace(code)).toBe(code);
  });

  it('normalises case, whitespace, underscores, and spaces', () => {
    expect(archetypeToRace('  Angel ')).toBe('angel');
    expect(archetypeToRace('DEMI_HUMAN')).toBe('demi-human');
    expect(archetypeToRace('Demi Human')).toBe('demi-human');
  });

  it('resolves the small alias set', () => {
    expect(archetypeToRace('demihuman')).toBe('demi-human');
    expect(archetypeToRace('robot')).toBe('android');
    expect(archetypeToRace('ghost')).toBe('spirit');
    expect(archetypeToRace('succubus')).toBe('demon');
  });

  it('returns null — not a default — for anything unknown or empty', () => {
    for (const input of ['librarian', '', '   ', null, undefined]) {
      expect(archetypeToRace(input)).toBeNull();
    }
  });

  it('maps every archetype in shipped content', () => {
    const dir = path.resolve(__dirname, '../../../content/species');
    const archetypes = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const entry of asEntries(parsed)) {
        if (typeof entry.archetype === 'string') archetypes.add(entry.archetype);
      }
    }

    expect(archetypes.size).toBeGreaterThan(0);
    for (const archetype of archetypes) {
      expect(archetypeToRace(archetype), `archetype "${archetype}"`).not.toBeNull();
    }
  });
});

describe('resolveRace', () => {
  it('prefers an explicit race over the archetype', () => {
    expect(resolveRace({ race: 'valkyrie', archetype: 'human' })).toBe('valkyrie');
  });

  it('falls back to the archetype when race is absent', () => {
    expect(resolveRace({ archetype: 'demon' })).toBe('demon');
    expect(resolveRace({ race: undefined, archetype: 'android' })).toBe('android');
  });

  it('falls back to the archetype and warns when the explicit race is unknown', () => {
    const logger = warnSpy();
    expect(resolveRace({ slug: 'x', race: 'elf', archetype: 'spirit' }, logger as never)).toBe(
      'spirit',
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ tag: 'card-renderer/race-fallback' });
  });

  it('falls back to human and warns when nothing resolves', () => {
    const logger = warnSpy();
    expect(resolveRace({ slug: 'mystery', archetype: 'librarian' }, logger as never)).toBe(
      DEFAULT_RACE,
    );
    expect(resolveRace({ slug: 'mystery' })).toBe('human');
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      tag: 'card-renderer/race-fallback',
      archetype: 'librarian',
    });
  });

  it('does not warn on the happy path', () => {
    const logger = warnSpy();
    resolveRace({ race: 'angel', archetype: 'angel' }, logger as never);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

function asEntries(parsed: unknown): { archetype?: unknown }[] {
  if (Array.isArray(parsed)) return parsed as { archetype?: unknown }[];
  if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) return value as { archetype?: unknown }[];
    }
  }
  return [];
}
