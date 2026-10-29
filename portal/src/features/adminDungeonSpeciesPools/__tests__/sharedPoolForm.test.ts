import { describe, expect, it } from 'vitest';
import { availablePoolKey, poolKeyFromName, validPoolKey } from '../sharedPoolForm';

describe('shared pool identifiers', () => {
  it.each([
    ['Wild WaifuMon!', 'wild_waifumon'],
    ['  Café / Angels — 2  ', 'cafe_angels_2'],
    ['___One---Two___', 'one_two'],
    ['💕', 'pool'],
  ])('generates a backend-valid identifier from %s', (name, expected) => {
    expect(poolKeyFromName(name)).toBe(expected);
    expect(validPoolKey(poolKeyFromName(name))).toBe(true);
  });
  it('offers the first available suffix, retaining the 64-character bound', () => {
    expect(availablePoolKey('Wild', new Set(['wild', 'wild_2', 'wild_4']))).toBe('wild_3');
    const base = poolKeyFromName('a'.repeat(200));
    expect(base).toHaveLength(64);
    const alternative = availablePoolKey(base, new Set([base]));
    expect(alternative).toHaveLength(64);
    expect(alternative.endsWith('_2')).toBe(true);
    expect(validPoolKey(alternative)).toBe(true);
  });
  it.each(['', 'Uppercase', 'a__b', '_a', 'a_', 'a-b', 'a'.repeat(65)])(
    'rejects invalid manual identifier %s',
    (key) => {
      expect(validPoolKey(key)).toBe(false);
    },
  );
});
