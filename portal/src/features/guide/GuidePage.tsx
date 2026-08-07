/**
 * `/guide` — the Game Guide (plan §8.9).
 *
 * A player-facing companion resource, not a tuning-table dump. It reads like an
 * in-game help book: friendly prose, illustrated section headers, and links to
 * the parts of the Portal each section talks about.
 *
 * Two rules from §8.9 shape everything below:
 *
 *   - **No section exposes a raw `tables.json` dump.** Where a tuning number is
 *     genuinely useful ("hunting costs 5 energy"), it is read defensively via
 *     `readTuning` and woven into a sentence. If the key is missing or has been
 *     renamed by a balance patch, the sentence simply does not render.
 *   - **Any section may ship as placeholder prose.** Evolution does exactly
 *     that, because there is nothing to describe yet.
 *
 * The capture-modifier table is built from the *item catalogue*, not from
 * tuning — items carry their own `captureModifier`, so that table is real
 * content rather than an opaque blob.
 */
import {
  Coins,
  Compass,
  HeartHandshake,
  HelpCircle,
  Sparkles,
  Swords,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useContentItems, useContentTables } from '@/api/hooks/useContent';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ScrollableRegion } from '@/components/ui/scrollableRegion';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { formatPercent, titleCase } from '@/lib/format';
import { RARITY_ORDER } from '@/lib/rarity';
import { readNumber, readNumberRecord } from './readTuning';

function Section({
  icon: Icon,
  title,
  lead,
  children,
  link,
}: {
  icon: LucideIcon;
  title: string;
  lead: string;
  children?: ReactNode;
  link?: { to: string; label: string };
}) {
  return (
    <Card className="scroll-mt-24" id={title.toLowerCase().replace(/\s+/g, '-')}>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-accent">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xl text-ink">{title}</h2>
          <p className="mt-2 max-w-prose text-ink-muted">{lead}</p>
          {children && <div className="mt-4">{children}</div>}
          {link && (
            <Link
              to={link.to}
              className="mt-4 inline-block text-sm text-accent underline-offset-4 hover:underline"
            >
              {link.label} →
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

const AFFINITIES: ReadonlyArray<{ key: string; blurb: string }> = [
  { key: 'dominant', blurb: 'Takes the lead. Confident, and used to being obeyed.' },
  { key: 'submissive', blurb: 'Happiest following someone else’s lead.' },
  { key: 'caregiver', blurb: 'Looks after everyone else first, whether asked or not.' },
  { key: 'primal', blurb: 'Runs on instinct. Unpredictable, and proud of it.' },
  { key: 'switch', blurb: 'Comfortable either way — the neutral default.' },
];

const FAQ: ReadonlyArray<{ question: string; answer: string }> = [
  {
    question: 'Can I play from this website?',
    answer:
      'No — the Portal is a companion. Every action, from hunting to buying, happens through the Waifumon bot in Discord. This is where you come to admire the results.',
  },
  {
    question: 'Why can I not favourite or rename anything here?',
    answer:
      'The Portal is read-only by design. Keeping every change in one place means the game can never disagree with itself about what happened.',
  },
  {
    question: 'My collection looks out of date.',
    answer:
      'The Portal refreshes when you return to the tab, so alt-tabbing back from Discord after a hunt is usually enough. Failing that, reload the page.',
  },
  {
    question: 'Some artwork is missing.',
    answer:
      'A silhouette means the art has not been added for that species yet, or that you have not discovered it. Nothing is broken.',
  },
];

export function GuidePage() {
  const tables = useContentTables();
  const items = useContentItems();

  // Read defensively — a balance patch may rename or drop any of these, and
  // the paths below were checked against a live `tables.json` rather than
  // guessed. A missing key costs a sentence, never a render.
  const encounterExpiry = readNumber(tables.data, 'hunt', 'encounterExpirySeconds');
  const huntCooldown = readNumber(tables.data, 'hunt', 'cooldownSeconds');
  const baseMaxEnergy = readNumber(tables.data, 'energy', 'baseMax');
  const energyCap = readNumber(tables.data, 'progression', 'maxEnergy', 'cap');
  const careInterval = readNumber(tables.data, 'energy', 'careMode', 'intervalMinutes');
  const careEnergyPerTick = readNumber(tables.data, 'energy', 'careMode', 'energyPerTick');
  const careRecoveryCap = readNumber(tables.data, 'energy', 'careMode', 'recoveryCap');
  const careXpPerTick = readNumber(tables.data, 'energy', 'careMode', 'waifuXpPerTick');
  const baseCaptureRates = readNumberRecord(tables.data, 'capture', 'baseRatesByRarity');

  const captureItems = (items.data ?? [])
    .filter((item) => item.enabled && (item.captureModifier !== null || item.isGuaranteedCapture))
    .sort((a, b) => (a.captureModifier ?? 99) - (b.captureModifier ?? 99));

  return (
    <>
      <PageHeader
        title="Game Guide"
        description="How hunting, care, affinities and currency actually work."
      />

      <div className="space-y-4">
        <Section
          icon={Compass}
          title="Hunting"
          lead="Hunting is the heart of Waifumon. You spend energy to head out, meet a Waifumon, and try to persuade her to come home with you. Every hunt is a fresh roll — rarity is luck, and patience pays."
          link={{ to: '/collection', label: 'See what you have caught' }}
        >
          <ul className="space-y-1.5 text-sm text-ink-muted">
            <li>Each hunt costs energy, so the day has a natural rhythm to it.</li>
            {encounterExpiry !== null && (
              <li>
                An encounter waits{' '}
                <strong className="text-ink">{Math.round(encounterExpiry / 60)} minutes</strong>{' '}
                before she wanders off.
              </li>
            )}
            {huntCooldown !== null && (
              <li>
                There is a <strong className="text-ink">{huntCooldown}-second</strong> pause between
                hunts.
              </li>
            )}
            <li>Charms improve your odds — see Capture charms below.</li>
          </ul>
        </Section>

        <Section
          icon={Zap}
          title="Energy"
          lead="Energy is the clock on your hunting. It does not trickle back on its own — Care Mode is how you recover it, which is why time spent with your buddy is time well spent."
          link={{ to: '/buddy', label: 'Check your current energy' }}
        >
          <ul className="space-y-1.5 text-sm text-ink-muted">
            {baseMaxEnergy !== null && (
              <li>
                You start able to hold <strong className="text-ink">{baseMaxEnergy} energy</strong>.
              </li>
            )}
            {energyCap !== null && (
              <li>
                Levelling raises that cap, up to <strong className="text-ink">{energyCap}</strong>.
              </li>
            )}
            {careRecoveryCap !== null && (
              <li>
                Care Mode restores energy up to{' '}
                <strong className="text-ink">{careRecoveryCap}</strong> — past that, you are on your
                own.
              </li>
            )}
          </ul>
        </Section>

        {baseCaptureRates && (
          <Section
            icon={Swords}
            title="Capture odds"
            lead="Rarer Waifumon are harder to convince. These are the starting odds before charms, your buddy's affinity, or luck get involved."
          >
            <ScrollableRegion label="Base capture odds table">
              <table className="w-full min-w-[18rem] text-left text-sm">
                <thead className="text-xs tracking-wide text-ink-muted uppercase">
                  <tr>
                    <th className="pb-2 font-medium">Rarity</th>
                    <th className="pb-2 font-medium">Base chance</th>
                  </tr>
                </thead>
                <tbody>
                  {RARITY_ORDER.filter((tier) => baseCaptureRates[tier] !== undefined).map(
                    (tier) => (
                      <tr key={tier} className="border-t border-border">
                        <td className="py-2">
                          <RarityBadge rarity={tier} variant="full" />
                        </td>
                        <td className="tabular py-2 text-ink-muted">
                          {formatPercent(baseCaptureRates[tier]!)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </ScrollableRegion>
          </Section>
        )}

        <Section
          icon={Sparkles}
          title="Capture charms"
          lead="Charms tilt a capture in your favour. They are consumed whether or not she stays, so save the good ones for someone worth it."
          link={{ to: '/shop', label: 'See what the shop has' }}
        >
          {captureItems.length > 0 ? (
            <ScrollableRegion label="Capture charms table">
              <table className="w-full min-w-[22rem] text-left text-sm">
                <thead className="text-xs tracking-wide text-ink-muted uppercase">
                  <tr>
                    <th className="pb-2 font-medium">Charm</th>
                    <th className="pb-2 font-medium">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {captureItems.map((item) => (
                    <tr key={item.slug} className="border-t border-border">
                      <td className="py-2 text-ink">
                        <span aria-hidden="true">{item.emoji} </span>
                        {item.name}
                      </td>
                      <td className="py-2">
                        {item.isGuaranteedCapture ? (
                          <Badge variant="outline">Always works</Badge>
                        ) : (
                          <span className="tabular text-ink-muted">
                            ×{item.captureModifier} odds
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollableRegion>
          ) : (
            <p className="text-sm text-ink-subtle">Charm details are loading.</p>
          )}
        </Section>

        <Section
          icon={HeartHandshake}
          title="Care Mode"
          lead="Care Mode is the slow way to grow close to one Waifumon. Set her as your care target and she gains affection and experience over time while you are away — at the cost of energy you would otherwise spend hunting."
          link={{ to: '/buddy', label: 'See your buddy and care state' }}
        >
          <ul className="space-y-1.5 text-sm text-ink-muted">
            {careInterval !== null && (
              <li>
                Care ticks every <strong className="text-ink">{careInterval} minutes</strong>.
              </li>
            )}
            {careXpPerTick !== null && careEnergyPerTick !== null && (
              <li>
                Each tick is worth <strong className="text-ink">{careXpPerTick} XP</strong> to her
                and <strong className="text-ink">{careEnergyPerTick} energy</strong> back to you.
              </li>
            )}
            <li>Ticks bank up while you are away and apply when you next check in.</li>
            <li>Only one Waifumon can be cared for at a time.</li>
          </ul>
        </Section>

        <Section
          icon={Sparkles}
          title="Affinities"
          lead="Every Waifumon has an affinity — a temperament that decides how well she and your buddy get along during a capture. Pairing complementary affinities helps; clashing ones do not."
        >
          <dl className="space-y-2.5 text-sm">
            {AFFINITIES.map((affinity) => (
              <div key={affinity.key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="w-28 shrink-0 font-medium text-ink">{titleCase(affinity.key)}</dt>
                <dd className="text-ink-muted">{affinity.blurb}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section
          icon={Coins}
          title="Currency"
          lead="Three things accumulate as you play, and each buys something different."
          link={{ to: '/inventory', label: 'See what you are carrying' }}
        >
          <dl className="space-y-2.5 text-sm">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-28 shrink-0 font-medium text-ink">Energy</dt>
              <dd className="text-ink-muted">Spent hunting. Refills on its own over time.</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-28 shrink-0 font-medium text-ink">WaifuBux</dt>
              <dd className="text-ink-muted">The everyday currency. Buys charms and supplies.</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-28 shrink-0 font-medium text-ink">Essence</dt>
              <dd className="text-ink-muted">
                Rare, and slow to earn. Reserved for the things WaifuBux cannot buy.
              </dd>
            </div>
          </dl>
        </Section>

        <Section
          icon={Swords}
          title="Evolution"
          lead="Not yet. Evolution is not part of Waifumon today — there is no line to follow and nothing to trigger. When it arrives, this section will explain it."
        >
          <Badge variant="outline">Deep dive coming soon</Badge>
        </Section>

        <Section icon={HelpCircle} title="Questions" lead="The ones that come up most.">
          <dl className="space-y-4">
            {FAQ.map((item) => (
              <div key={item.question}>
                <dt className="font-medium text-ink">{item.question}</dt>
                <dd className="mt-1 max-w-prose text-sm text-ink-muted">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>
    </>
  );
}
