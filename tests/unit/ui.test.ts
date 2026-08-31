/**
 * UI helpers — respondScreen chooses update() vs reply() based on interaction
 * kind; withBackRow appends a Back button.
 *
 * Also covers `buildTrainerProfileView`, the pure Care Mode dashboard
 * renderer (phase 3): its MVP fields and its reserved dashboard slots.
 */
import { describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, MessageFlags } from 'discord.js';
import {
  backButton,
  isStaleInteractionError,
  respondScreen,
  withBackRow,
} from '../../src/discord/ui';
import {
  buildTrainerProfileView,
  formatCountdown,
  type TrainerProfileInput,
} from '../../src/discord/trainerProfile';
import { renderCareStatusLines } from '../../src/discord/commands/waifumon';
import type { CareState } from '../../src/modules/care/careService';

function fakeButtonInteraction(overrides: Partial<Record<string, unknown>> = {}) {
  const state = { replied: false, deferred: false };
  return {
    ...state,
    isButton: () => true,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    ...overrides,
  } as unknown as import('discord.js').ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };
}

function fakeCommandInteraction() {
  return {
    replied: false,
    deferred: false,
    isButton: () => false,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  } as unknown as import('discord.js').ChatInputCommandInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };
}

describe('respondScreen', () => {
  it('updates the same ephemeral message when invoked from a button', async () => {
    const btn = fakeButtonInteraction();
    await respondScreen(btn, { content: 'hi', components: [] });
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.reply).not.toHaveBeenCalled();
    expect(btn.editReply).not.toHaveBeenCalled();
  });

  it('uses editReply if the button interaction is already deferred', async () => {
    const btn = fakeButtonInteraction({ deferred: true });
    await respondScreen(btn, { content: 'later', components: [] });
    expect(btn.editReply).toHaveBeenCalledOnce();
    expect(btn.update).not.toHaveBeenCalled();
  });

  it('replies with the Ephemeral flag for slash commands', async () => {
    const cmd = fakeCommandInteraction();
    await respondScreen(cmd, { content: 'first' });
    expect(cmd.reply).toHaveBeenCalledOnce();
    const payload = cmd.reply.mock.calls[0]![0] as { flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('normalizes missing fields to empty defaults so files/components are cleared', async () => {
    const btn = fakeButtonInteraction();
    await respondScreen(btn, { embeds: [{ toJSON: () => ({}) } as never] });
    const payload = btn.update.mock.calls[0]![0] as {
      files: unknown[];
      components: unknown[];
      content: string;
    };
    expect(payload.files).toEqual([]);
    expect(payload.components).toEqual([]);
    expect(payload.content).toBe('');
  });
});

describe('withBackRow / backButton', () => {
  it('backButton uses the menu:back custom id', () => {
    const b = backButton().toJSON() as { custom_id?: string };
    expect(b.custom_id).toBe('wm|v1|menu|back');
  });

  it('withBackRow appends a single trailing row containing the Back button', () => {
    const rows = withBackRow();
    expect(rows).toHaveLength(1);
    const last = rows[rows.length - 1]!.toJSON() as { components: Array<{ custom_id: string }> };
    expect(last.components).toHaveLength(1);
    expect(last.components[0]?.custom_id).toBe('wm|v1|menu|back');
  });
});

describe('isStaleInteractionError', () => {
  it('matches Discord 10008/10062/40060 codes', () => {
    for (const code of [10008, 10062, 40060]) {
      const err = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
      Object.assign(err, { code, message: 'x' });
      expect(isStaleInteractionError(err)).toBe(true);
    }
  });

  it('does not match arbitrary errors', () => {
    expect(isStaleInteractionError(new Error('nope'))).toBe(false);
    expect(isStaleInteractionError('string')).toBe(false);
    expect(isStaleInteractionError(null)).toBe(false);
  });

  it('does not match non-stale Discord errors', () => {
    const err = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
    Object.assign(err, { code: 50013, message: 'Missing Permissions' });
    expect(isStaleInteractionError(err)).toBe(false);
  });
});

// ───────────────────────── Trainer Profile view (phase 3) ─────────────────────────

function careState(overrides: Partial<CareState> = {}): CareState {
  const target = {
    waifu: {
      id: 7,
      nickname: null,
      level: 4,
      affection: 12,
      baseSp: 122,
    },
    species: { name: 'Luna', rarity: 'SR', affinity: 'dominant' },
  } as unknown as CareState['target'];
  return {
    active: true,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    lastTickAt: new Date('2026-01-01T00:00:00Z'),
    nextTickAt: new Date(Date.now() + 90_000),
    target,
    pendingTicks: 0,
    intervalMinutes: 30,
    energyPerTick: 1,
    waifuXpPerTick: 2,
    affectionPerTick: 1,
    recoveryCap: 20,
    effectiveEnergyCap: 20,
    currentEnergy: 12,
    maxEnergy: 25,
    enabled: true,
    ...overrides,
  } as CareState;
}

function profileInput(overrides: Partial<TrainerProfileInput> = {}): TrainerProfileInput {
  return {
    playerName: 'Whistler',
    player: {
      id: 1,
      level: 12,
      xp: 900,
      createdAt: new Date('2026-01-05T00:00:00Z'),
    } as unknown as TrainerProfileInput['player'],
    currencies: { huntEnergy: 12, waifubux: 100, essence: 5 },
    careState: careState(),
    collectionProgress: { owned: 9, distinctSpecies: 7, totalSpecies: 28 },
    maxEnergy: 25,
    prestigeTitle: null,
    ...overrides,
  };
}

function fieldsOf(view: { embeds: { toJSON: () => { fields?: { name: string; value: string }[] } }[] }) {
  const json = view.embeds[0]!.toJSON();
  return new Map((json.fields ?? []).map((f) => [f.name, f.value]));
}

describe('formatCountdown', () => {
  it('renders mm:ss and floors at zero', () => {
    expect(formatCountdown(90_000)).toBe('01:30');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5_000)).toBe('00:00');
    expect(formatCountdown(3_600_000)).toBe('60:00');
  });
});

describe('buildTrainerProfileView', () => {
  it('renders the MVP fields for an active Care Mode session', () => {
    const view = buildTrainerProfileView(profileInput());
    const json = view.embeds[0]!.toJSON();
    const fields = fieldsOf(view);

    expect(json.title).toBe("🌸 Whistler's Trainer Profile");
    // `toDateString()` is local-time, so derive the expectation the same way
    // rather than hard-coding a date that shifts with the runner's timezone.
    expect(json.footer?.text).toBe(
      `Trainer since ${new Date('2026-01-05T00:00:00Z').toDateString()}`,
    );
    expect(fields.get('👤 Trainer')).toContain('Level **12**');
    expect(fields.get('👤 Trainer')).toContain('⚡ Hunt Energy **12 / 25**');
    expect(fields.get('⭐ Buddy')).toContain('**Luna**');
    expect(fields.get('⭐ Buddy')).toContain('SR · Lv 4');
    expect(fields.get('⭐ Buddy')).toContain('💗 12 affection');
    expect(fields.get('🎒 Collection')).toBe('7 / 28 unique species (25 %)');
    expect(fields.get('💗 Activity')).toContain('Currently caring for **Luna**');
    expect(fields.get('💗 Activity')).toContain('Next tick in **01:30**');
    expect(fields.get('💗 Activity')).toContain('Per tick: +1 ⚡ · +2 XP · +1 affection');
  });

  it('is informational only — no components', () => {
    expect(buildTrainerProfileView(profileInput())).not.toHaveProperty('components');
  });

  it('prefers the nickname over the species name, keeping the species as context', () => {
    const state = careState();
    (state.target!.waifu as { nickname: string | null }).nickname = 'Moonpie';
    const fields = fieldsOf(buildTrainerProfileView(profileInput({ careState: state })));
    expect(fields.get('⭐ Buddy')).toContain('**Moonpie** (Luna)');
    expect(fields.get('💗 Activity')).toContain('Currently caring for **Moonpie**');
  });

  it('appends the prestige title when the player has one', () => {
    const fields = fieldsOf(
      buildTrainerProfileView(profileInput({ prestigeTitle: 'Prestige Hunter' })),
    );
    expect(fields.get('👤 Trainer')).toContain('*Prestige Hunter*');
  });

  it('warns when energy has hit the Care Mode cap', () => {
    const fields = fieldsOf(
      buildTrainerProfileView(
        profileInput({ careState: careState({ currentEnergy: 20, effectiveEnergyCap: 20 }) }),
      ),
    );
    expect(fields.get('💗 Activity')).toContain('Energy at the Care Mode cap (**20**)');
  });

  it('handles a zero-species content set without dividing by zero', () => {
    const fields = fieldsOf(
      buildTrainerProfileView(
        profileInput({ collectionProgress: { owned: 0, distinctSpecies: 0, totalSpecies: 0 } }),
      ),
    );
    expect(fields.get('🎒 Collection')).toBe('0 / 0 unique species (0 %)');
  });

  it('skips every reserved dashboard slot when no dashboard data is supplied', () => {
    const fields = fieldsOf(buildTrainerProfileView(profileInput()));
    expect(fields.get('👤 Trainer')).not.toContain('XP to Lv');
    expect(fields.get('👤 Trainer')).not.toContain('🗺️');
    expect(fields.has('📅 Today')).toBe(false);
    expect(fields.get('💗 Activity')).not.toContain('📜');
  });

  it('renders a reserved slot as soon as it is wired, without moving the others', () => {
    const fields = fieldsOf(
      buildTrainerProfileView(
        profileInput({
          dashboard: {
            currentRegion: 'the Velvet Grove',
            todaySummary: {
              hunts: 4,
              caught: 2,
              escaped: 1,
              srPlus: 1,
              levelUps: 0,
              caughtNames: [],
              escapedNames: [],
              notableFinds: [],
              buddyXp: 0,
              buddyAffection: 0,
            },
            currentDailyObjective: 'Spend 5 Hunt Energy (3/5)',
            nextLevelProgress: {
              level: 12,
              xpIntoLevel: 40,
              xpToNext: 150,
              atMaxLevel: false,
            } as never,
          },
        }),
      ),
    );
    expect(fields.get('👤 Trainer')).toContain('40 / 150 XP to Lv 13');
    expect(fields.get('👤 Trainer')).toContain('🗺️ the Velvet Grove');
    expect(fields.get('📅 Today')).toBe(
      '🏹 4 hunts · 💖 2 caught · 💨 1 escaped · ✨ 1 SR+ · ⬆️ 0 level-ups',
    );
    expect(fields.get('💗 Activity')).toContain('📜 Spend 5 Hunt Energy (3/5)');
    // The four MVP blocks are still present and in order; the Today recap
    // sits at the bottom as its own field.
    expect([...fields.keys()]).toEqual([
      '👤 Trainer',
      '⭐ Buddy',
      '🎒 Collection',
      '💗 Activity',
      '📅 Today',
    ]);
  });

  it('renders the Today field with zeros on a fresh, empty day', () => {
    const fields = fieldsOf(
      buildTrainerProfileView(
        profileInput({
          dashboard: {
            todaySummary: {
              hunts: 0,
              caught: 0,
              escaped: 0,
              srPlus: 0,
              levelUps: 0,
              caughtNames: [],
              escapedNames: [],
              notableFinds: [],
              buddyXp: 0,
              buddyAffection: 0,
            },
          },
        }),
      ),
    );
    expect(fields.get('📅 Today')).toBe(
      '🏹 0 hunts · 💖 0 caught · 💨 0 escaped · ✨ 0 SR+ · ⬆️ 0 level-ups',
    );
  });
});

// ─────────────────────────── main-menu Care Mode status ───────────────────────────

describe('renderCareStatusLines — main menu keeps a clear care status', () => {
  it('spells out cared-for buddy, energy, next tick and per-tick gains when Care Mode is active', () => {
    const state: CareState = {
      active: true,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      lastTickAt: new Date('2026-01-01T00:00:00Z'),
      nextTickAt: new Date('2026-01-01T00:30:00Z'),
      target: {
        waifu: { id: 1, nickname: 'Nova', level: 3, affection: 4, baseSp: 100 },
        species: { name: 'Luna', rarity: 'SR', affinity: 'dominant' },
      } as unknown as CareState['target'],
      pendingTicks: 0,
      intervalMinutes: 30,
      energyPerTick: 1,
      waifuXpPerTick: 2,
      affectionPerTick: 1,
      recoveryCap: 20,
      effectiveEnergyCap: 20,
      currentEnergy: 8,
      maxEnergy: 25,
      enabled: true,
    };
    const lines = renderCareStatusLines(state);
    const text = lines.join('\n');
    // Buddy line names the nickname AND the species so both are legible.
    expect(text).toContain('Nova');
    expect(text).toContain('Luna');
    // Energy and next-tick countdown live on a single line.
    expect(text).toContain('8/25');
    expect(text).toMatch(/next tick/);
    // Per-tick gains are itemised.
    expect(text).toContain('+1 Energy');
    expect(text).toContain('+2 XP');
    expect(text).toContain('+1 Affection');
  });

  it('still gives an inactive player a non-empty, energy-focused status', () => {
    const state: CareState = {
      active: false,
      startedAt: null as unknown as Date,
      lastTickAt: null as unknown as Date,
      nextTickAt: null,
      target: null,
      pendingTicks: 0,
      intervalMinutes: 30,
      energyPerTick: 1,
      waifuXpPerTick: 2,
      affectionPerTick: 1,
      recoveryCap: 20,
      effectiveEnergyCap: 20,
      currentEnergy: 5,
      maxEnergy: 25,
      enabled: true,
    };
    const lines = renderCareStatusLines(state);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('5');
  });
});
