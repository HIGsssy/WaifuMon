/**
 * Boss encounter copy and components — pure rendering, no database, no client.
 *
 * The preview's shape is pinned literally against the specification's example,
 * because that block is the one piece of this feature a player reads before
 * making an irreversible decision.
 */
import { describe, expect, it } from 'vitest';
import {
  bossArtworkFilename,
  buildAnnouncement,
  buildCommitPreview,
  buildCompletedAnnouncement,
  buildMyResult,
  buildResults,
  commitRow,
  currentBracketLabel,
  discordRelative,
  encounterMarker,
  matchesEncounterMarker,
  resultTitle,
} from '../../src/discord/bossPresenter';
import type {
  BossEncounterRow,
  BossParticipationRow,
} from '../../src/db/schema';
import type {
  BossCommitPreview,
} from '../../src/modules/bosses/bossEncounterService';
import type { BossContent } from '../../src/modules/content/schemas';
import { loadShippedContent } from '../helpers/fixtures';

const CONFIG = loadShippedContent().tables.bossEncounters;
const MINUTE = 60_000;
const START = new Date('2026-08-26T12:00:00.000Z');

function encounter(overrides: Partial<BossEncounterRow> = {}): BossEncounterRow {
  return {
    id: 7,
    guildId: 1,
    region: 'waifu-valley',
    bossId: 'oh_pwincess',
    bossName: 'Oh Pwincess',
    bossAffinity: 'dominant',
    bossArtwork: null,
    rewardTable: 'standard-scouting-v1',
    rewardTableVersion: 'standard-scouting-v1',
    calcVersion: 1,
    affinityVersion: 1,
    channelId: 'c-boss',
    messageId: 'm-1',
    resultsMessageId: null,
    completionEditedAt: null,
    resultsPublishedAt: null,
    resultsPageSize: null,
    status: 'scouting',
    forced: false,
    scheduledAt: START,
    scoutingStartedAt: START,
    deadlineAt: new Date(START.getTime() + 30 * MINUTE),
    resolvingAt: null,
    resolvedAt: null,
    nextSpawnAt: null,
    participantCount: 0,
    totalDamage: 0,
    resolutionReason: null,
    createdAt: START,
    ...overrides,
  } as BossEncounterRow;
}

function participation(overrides: Partial<BossParticipationRow> = {}): BossParticipationRow {
  return {
    id: 1,
    encounterId: 7,
    playerId: 1,
    discordUserId: 'u-1',
    trainerName: 'Whistler',
    waifuId: 100,
    speciesId: 5,
    speciesSlug: 'ruby_succubus',
    waifuName: 'Ruby Succubus',
    level: 24,
    baseSp: 150,
    currentSp: 200,
    rarity: 'UR',
    affinity: 'switch',
    race: 'demon',
    affection: 40,
    committedAt: START,
    responseBonus: 0.05,
    affinityBonus: 0.1,
    performancePercent: 100,
    attackCount: 10,
    totalDamage: 2001,
    xpAwarded: 15,
    rewardItems: [],
    rewardStatus: 'applied',
    resolvedAt: START,
    ...overrides,
  } as BossParticipationRow;
}

const boss: BossContent = loadShippedContent().bosses.find((b) => b.id === 'oh_pwincess')!;

/** All buttons on a payload, flattened. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buttons = (payload: any): any[] =>
  (payload.components ?? []).flatMap((row: { components?: unknown[] }) => row.components ?? []);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const embed = (payload: any) => payload.embeds[0].data;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const field = (payload: any, name: string) =>
  embed(payload).fields?.find((f: { name: string }) => f.name === name)?.value;

describe('announcement', () => {
  const payload = buildAnnouncement({
    encounter: encounter(),
    boss,
    config: CONFIG,
    participantCount: 3,
    now: START,
  });

  it('names the boss and the region it is scouting', () => {
    expect(embed(payload).title).toContain('Oh Pwincess');
    expect(embed(payload).title).toContain('Waifu Valley');
  });

  it('carries the description and the scouting text', () => {
    expect(embed(payload).description).toContain(boss.description);
    expect(embed(payload).description).toContain(boss.scoutingText);
  });

  it('states the boss affinity and the affinity that has the advantage', () => {
    expect(field(payload, 'Boss Affinity')).toBe('Dominant');
    // Dominant is beaten by Switch — the Stage 1 wheel, not the capture one.
    expect(field(payload, 'Affinity Advantage')).toBe('Switch (+10%)');
  });

  it('shows the committed trainer count', () => {
    expect(field(payload, 'Trainers Committed')).toBe('3');
  });

  it('shows the current rapid-response bracket', () => {
    expect(field(payload, 'Rapid Response')).toBe('+5% (first 10 minutes)');
  });

  it('uses a Discord timestamp for the deadline rather than rendered text', () => {
    // A rendered "in 42 minutes" would be wrong the moment the message is read.
    expect(field(payload, 'Window Closes')).toContain('<t:');
    expect(field(payload, 'Window Closes')).toContain(':R>');
  });

  it('carries exactly one Commit Buddy button, keyed to this encounter', () => {
    expect(buttons(payload)).toHaveLength(1);
    expect(buttons(payload)[0].data.custom_id).toBe('wm|v1|boss|commit|7');
    expect(buttons(payload)[0].data.label).toBe('Commit Buddy');
  });

  it('attaches no file and still renders when artwork is missing', () => {
    expect(payload.files).toHaveLength(0);
    expect(embed(payload).image).toBeUndefined();
  });

  it('attaches the artwork when the boss has some', () => {
    const withArt = buildAnnouncement({
      encounter: encounter({ bossArtwork: 'bosses/oh_pwincess_boss.webp' }),
      boss,
      config: CONFIG,
      participantCount: 0,
      now: START,
      artworkPath: '/tmp/boss.webp',
    });
    expect(withArt.files).toHaveLength(1);
    expect(embed(withArt).image.url).toBe('attachment://boss-oh_pwincess.webp');
  });

  it('renders even when the boss has been retired from content mid-window', () => {
    const orphan = buildAnnouncement({
      encounter: encounter(),
      boss: undefined,
      config: CONFIG,
      participantCount: 1,
      now: START,
    });
    expect(embed(orphan).title).toContain('Oh Pwincess');
    expect(embed(orphan).description.length).toBeGreaterThan(0);
  });

  it('suppresses every mention', () => {
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('stamps the encounter marker in the footer for reconciliation', () => {
    expect(embed(payload).footer.text).toContain('Boss Encounter #7');
    // Still readable copy first — the marker is appended, not the whole footer.
    expect(embed(payload).footer.text).toContain('10 attacks');
  });
});

// ── the completed encounter message ────────────────────────────────────────

describe('completed announcement', () => {
  const resolved = encounter({
    status: 'resolved',
    resolutionReason: 'repelled',
    participantCount: 8,
    totalDamage: 17342,
  });
  const payload = buildCompletedAnnouncement({
    encounter: resolved,
    reason: 'repelled',
    boss,
    participantCount: 8,
    totalDamage: 17342,
    totalAttacks: 80,
  });

  it('keeps the boss identity', () => {
    expect(embed(payload).title).toContain('Oh Pwincess');
    expect(field(payload, 'Boss Affinity')).toBe('Dominant');
  });

  it('keeps the artwork', () => {
    const withArt = buildCompletedAnnouncement({
      encounter: encounter({ bossArtwork: 'bosses/oh_pwincess_boss.webp' }),
      reason: 'repelled',
      boss,
      participantCount: 1,
      totalDamage: 10,
      totalAttacks: 10,
      artworkPath: '/tmp/boss.webp',
    });
    expect(withArt.files).toHaveLength(1);
    expect(embed(withArt).image.url).toBe('attachment://boss-oh_pwincess.webp');
  });

  it('replaces the scouting language with the repelled text', () => {
    expect(embed(payload).description).toContain(boss.repelledText);
    expect(embed(payload).description).not.toContain(boss.scoutingText);
  });

  it('uses the unchallenged text when nobody committed', () => {
    const empty = buildCompletedAnnouncement({
      encounter: encounter({ status: 'resolved', resolutionReason: 'unchallenged' }),
      reason: 'unchallenged',
      boss,
      participantCount: 0,
      totalDamage: 0,
      totalAttacks: 0,
    });
    expect(embed(empty).description).toContain(boss.unchallengedText);
    expect(embed(empty).description).not.toContain(boss.scoutingText);
  });

  it('says plainly that the encounter has ended', () => {
    expect(embed(payload).description).toContain('This encounter has ended');
    expect(embed(payload).footer.text).toContain('Encounter ended');
  });

  it('shows participant count, combined damage and total attacks', () => {
    expect(field(payload, 'Trainers Committed')).toBe('8');
    expect(field(payload, 'Combined Damage')).toBe('17,342');
    expect(field(payload, 'Total Attacks')).toBe('80');
  });

  it('omits damage and attacks when nobody committed', () => {
    const empty = buildCompletedAnnouncement({
      encounter: encounter({ status: 'resolved', resolutionReason: 'unchallenged' }),
      reason: 'unchallenged',
      boss,
      participantCount: 0,
      totalDamage: 0,
      totalAttacks: 0,
    });
    expect(field(empty, 'Trainers Committed')).toBe('0');
    // Zeroes would read as a failed battle rather than an absent one.
    expect(field(empty, 'Combined Damage')).toBeUndefined();
    expect(field(empty, 'Total Attacks')).toBeUndefined();
  });

  it('removes every participation component rather than disabling it', () => {
    expect(payload.components).toEqual([]);
  });

  it('carries no result controls — those belong to the results message', () => {
    expect(buttons(payload)).toHaveLength(0);
  });

  it('stamps the encounter marker for reconciliation', () => {
    expect(embed(payload).footer.text).toContain('Boss Encounter #7');
  });
});

describe('the encounter marker', () => {
  it('renders a readable, quotable id', () => {
    expect(encounterMarker(128)).toBe('Boss Encounter #128');
  });

  it('matches only its own encounter', () => {
    expect(matchesEncounterMarker('Boss Encounter #12', 12)).toBe(true);
    expect(matchesEncounterMarker('Page 1 of 2 · Boss Encounter #12', 12)).toBe(true);
    expect(matchesEncounterMarker('Boss Encounter #12', 1)).toBe(false);
    // The trap this guards: #12 must not match inside #128.
    expect(matchesEncounterMarker('Boss Encounter #128', 12)).toBe(false);
    expect(matchesEncounterMarker(null, 12)).toBe(false);
    expect(matchesEncounterMarker(undefined, 12)).toBe(false);
    expect(matchesEncounterMarker('', 12)).toBe(false);
  });
});

describe('the rapid-response bracket label tracks the clock', () => {
  it.each([
    [0, '+5% (first 10 minutes)'],
    [9, '+5% (first 10 minutes)'],
    [10, '+2% (first 20 minutes)'],
    [19, '+2% (first 20 minutes)'],
    [20, 'no bonus remaining'],
    [29, 'no bonus remaining'],
  ])('at %i minutes elapsed reads "%s"', (minutes, expected) => {
    expect(
      currentBracketLabel(encounter(), CONFIG, new Date(START.getTime() + minutes * MINUTE)),
    ).toBe(expected);
  });
});

describe('commit preview', () => {
  const preview: BossCommitPreview = {
    encounter: encounter(),
    waifuId: 100,
    waifuName: 'Ruby Succubus',
    speciesName: 'Ruby Succubus',
    level: 24,
    currentSp: 200,
    buddyAffinity: 'switch',
    bossAffinity: 'dominant',
    affinityBonus: 0.1,
    responseBonus: 0.05,
    estimate: { min: 1955, max: 2645 },
    hasDuplicates: false,
  };
  const payload = buildCommitPreview(preview);

  it('matches the specification example line for line', () => {
    expect(payload.content).toContain('**Ruby Succubus** — Level 24 — 200 SP');
    expect(payload.content).toContain('Affinity Advantage: +10%');
    expect(payload.content).toContain('Rapid Response: +5%');
    expect(payload.content).toContain('Estimated Damage: 1,955–2,645');
    expect(payload.content).toContain('Commit **Ruby Succubus** to this battle?');
  });

  it('states that rewards come only after the battle resolves', () => {
    expect(payload.content).toContain('Rewards are delivered only after the battle resolves');
  });

  it('names both affinities so the matchup is legible', () => {
    expect(payload.content).toContain('Buddy Affinity: Switch');
    expect(payload.content).toContain('Boss Affinity: Dominant');
  });

  it('offers Confirm and Cancel, and nothing else', () => {
    const labels = buttons(payload).map((b) => b.data.label);
    expect(labels).toEqual(['Confirm', 'Cancel']);
  });

  it('carries the previewed buddy id on Confirm so a swap is detectable', () => {
    expect(buttons(payload)[0].data.custom_id).toBe('wm|v1|boss|confirm|7|100');
  });

  it('omits a bonus line rather than printing +0%', () => {
    const plain = buildCommitPreview({
      ...preview,
      affinityBonus: 0,
      responseBonus: 0,
      estimate: { min: 1700, max: 2300 },
    });
    expect(plain.content).not.toContain('Affinity Advantage');
    expect(plain.content).not.toContain('Rapid Response');
    expect(plain.content).toContain('Estimated Damage: 1,700–2,300');
  });

  it('identifies the copy only when the player owns more than one', () => {
    expect(payload.content).not.toContain('Copy #');
    const ambiguous = buildCommitPreview({ ...preview, hasDuplicates: true });
    expect(ambiguous.content).toContain('Copy #100');
  });
});

describe('results', () => {
  const firstEntry = participation({ id: 1, trainerName: 'Whistler', totalDamage: 2001 });

  const payload = buildResults({
    encounter: encounter({ status: 'resolved', resolutionReason: 'repelled', totalDamage: 17342 }),
    reason: 'repelled',
    boss,
    totalParticipants: 8,
    totalDamage: 17342,
    totalAttacks: 80,
    firstOnScene: firstEntry,
  });

  it('names the boss so the message stands alone', () => {
    // A reader can meet this via a jump link, without the encounter message in
    // view above it.
    expect(embed(payload).title).toBe('Boss Results — Oh Pwincess');
  });

  it('does not repeat the outcome prose already on the message above', () => {
    expect(embed(payload).description).not.toContain(boss.repelledText);
  });

  it('stamps the encounter marker so a crashed publish can be reconciled', () => {
    expect(embed(payload).footer.text).toBe('Boss Encounter #7');
    expect(matchesEncounterMarker(embed(payload).footer.text, 7)).toBe(true);
  });

  it('summarizes participants, attacks and combined damage', () => {
    expect(embed(payload).description).toContain('**8** trainers joined the battle');
    expect(embed(payload).description).toContain('**80** attacks');
    expect(embed(payload).description).toContain('**17,342** total damage');
  });

  it('calls out First on the Scene', () => {
    expect(field(payload, 'First on the Scene')).toBe('Whistler — Ruby Succubus');
  });

  it('shows a reward-distribution note instead of a public per-participant list', () => {
    const note = field(payload, '🎁 Rewards');
    expect(note).toContain('Rewards have been distributed');
    expect(note).toContain('View My Rewards');
    // No per-participant reward detail leaks onto the public message.
    const text = JSON.stringify(embed(payload).fields);
    expect(text).not.toContain('DMG');
    expect(text).not.toContain('+15 XP');
  });

  it('offers a single View My Rewards button keyed on the encounter', () => {
    expect(buttons(payload).map((b) => b.data.label)).toEqual(['View My Rewards']);
    expect(buttons(payload)[0].data.custom_id).toBe('wm|v1|boss|mine|7');
  });

  it('carries no shared pagination controls on the public message', () => {
    const ids = buttons(payload).map((b) => b.data.custom_id as string);
    expect(ids.some((id) => id.includes('|page|'))).toBe(false);
    expect(embed(payload).footer.text).not.toContain('Page');
  });

  it('renders the unchallenged outcome with no participant controls', () => {
    const empty = buildResults({
      encounter: encounter({ status: 'resolved', resolutionReason: 'unchallenged' }),
      reason: 'unchallenged',
      boss,
      totalParticipants: 0,
      totalDamage: 0,
      totalAttacks: 0,
      firstOnScene: null,
    });
    expect(embed(empty).title).toBe('Boss Results — Oh Pwincess');
    // A zero-participant encounter still gets a results message; silence would
    // be indistinguishable from a crashed bot.
    expect(embed(empty).description).toContain('Nobody confronted **Oh Pwincess**');
    expect(embed(empty).description).toContain('No rewards were distributed');
    expect(buttons(empty)).toHaveLength(0);
  });

  it.each([
    ['repelled', 'Oh Pwincess Was Driven Away!'],
    ['unchallenged', 'Oh Pwincess Left Unchallenged'],
    ['cancelled_admin', 'Oh Pwincess Withdrew'],
    ['channel_lost', 'Oh Pwincess Slipped Away'],
  ] as const)('titles a %s outcome as "%s"', (reason, expected) => {
    expect(resultTitle(encounter(), reason)).toBe(expected);
  });
});

describe('my result', () => {
  it('reports the full record once rewards are applied', () => {
    const text = buildMyResult(encounter(), {
      participation: participation(),
      rewards: [{ slug: 'basic_charm', name: 'Basic Charm', quantity: 2 }],
      rewardBonus: null,
    });
    expect(text).toContain('dealt **2,001** damage');
    expect(text).toContain('across 10 attacks');
    expect(text).toContain('Affinity Advantage: +10%');
    expect(text).toContain('Rapid Response: +5%');
    expect(text).toContain('**+15 XP** to Ruby Succubus');
    expect(text).toContain('2× Basic Charm');
  });

  it('says rewards are still pending before resolution', () => {
    const text = buildMyResult(encounter(), {
      participation: participation({ rewardStatus: 'pending', totalDamage: null }),
      rewards: [],
      rewardBonus: null,
    });
    expect(text).toContain('is committed to');
    expect(text).toContain('Rewards are delivered when the battle resolves');
    expect(text).not.toContain('damage');
  });

  it('explains the level cap rather than printing +0 XP', () => {
    const text = buildMyResult(encounter(), {
      participation: participation({ xpAwarded: 0 }),
      rewards: [],
      rewardBonus: null,
    });
    expect(text).toContain('is at max level — no XP was gained');
  });

  it('says so plainly when the player never joined', () => {
    expect(buildMyResult(encounter(), null)).toBe(
      "You didn't earn rewards from this boss encounter.",
    );
  });
});

describe('helpers', () => {
  it('derives a safe attachment filename from the boss id', () => {
    expect(bossArtworkFilename('oh_pwincess')).toBe('boss-oh_pwincess.webp');
  });

  it('renders a Discord relative timestamp in seconds', () => {
    expect(discordRelative(new Date(1_700_000_000_000))).toBe('<t:1700000000:R>');
  });

  it('can disable the commit button once the window closes', () => {
    expect(commitRow(7, true).components[0]!.data.disabled).toBe(true);
  });
});
