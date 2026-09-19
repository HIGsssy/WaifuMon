/**
 * `/guide` — player-facing guidance grounded in live content and engine rules.
 *
 * Volatile tuning is read from the content API. Stable rules are explained in
 * prose without duplicating raw content tables.
 */
import {
  Backpack,
  BookOpen,
  Coins,
  Compass,
  Crown,
  Gift,
  HelpCircle,
  Map,
  PackageCheck,
  Sparkles,
  Swords,
  Trophy,
  UserRound,
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
import { captureItemEffect, temporaryCaptureEffect } from '@/content/items';
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

function BulletList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-muted">{children}</ul>;
}

const AFFINITIES: ReadonlyArray<{ key: string; blurb: string }> = [
  { key: 'dominant', blurb: 'Confident and inclined to take the lead.' },
  { key: 'submissive', blurb: 'Comfortable following someone else’s direction.' },
  { key: 'caregiver', blurb: 'Protective, supportive and attentive.' },
  { key: 'primal', blurb: 'Instinctive, forceful and unpredictable.' },
  { key: 'switch', blurb: 'Adaptable and neutral in normal capture matchups.' },
];

const FAQ: ReadonlyArray<{ question: string; answer: string }> = [
  {
    question: 'Can I play from this website?',
    answer:
      'The Portal is a companion for browsing your game information. Player actions such as hunting, capturing, buying and travel happen through the WaifuMon bot in Discord.',
  },
  {
    question: 'Why can I not favorite or rename anything here?',
    answer:
      'Player collection changes still happen through Discord. Return to the Portal afterward to see the updated result.',
  },
  {
    question: 'My collection looks out of date.',
    answer:
      'The Portal refreshes when you return to the tab. If a recent Discord action is not visible, reload the page.',
  },
  {
    question: 'Why did an Encyclopedia entry become hidden again?',
    answer:
      'The Encyclopedia reveals species you currently own. Releasing or converting your final active copy hides the owned details again.',
  },
];

export function GuidePage() {
  const tables = useContentTables();
  const items = useContentItems();

  const encounterExpiry = readNumber(tables.data, 'hunt', 'encounterExpirySeconds');
  const huntCooldown = readNumber(tables.data, 'hunt', 'cooldownSeconds');
  const baseMaxEnergy = readNumber(tables.data, 'energy', 'baseMax');
  const careInterval = readNumber(tables.data, 'energy', 'careMode', 'intervalMinutes');
  const careEnergyPerTick = readNumber(tables.data, 'energy', 'careMode', 'energyPerTick');
  const careRecoveryCap = readNumber(tables.data, 'energy', 'careMode', 'recoveryCap');
  const careXpPerTick = readNumber(tables.data, 'energy', 'careMode', 'waifuXpPerTick');
  const careAffectionPerTick = readNumber(tables.data, 'energy', 'careMode', 'affectionPerTick');
  const baseCaptureRates = readNumberRecord(tables.data, 'capture', 'baseRatesByRarity');

  const captureItems = (items.data ?? [])
    .map((item) => ({
      item,
      effect: captureItemEffect(item) ?? temporaryCaptureEffect(item),
    }))
    .filter(
      (entry): entry is typeof entry & { effect: string } =>
        entry.item.enabled && entry.effect !== null,
    )
    .sort((a, b) => a.item.name.localeCompare(b.item.name));

  return (
    <>
      <PageHeader
        title="Game Guide"
        description="How to hunt, capture, travel and build your Waifumon collection."
      />

      <div className="space-y-4">
        <Section
          icon={BookOpen}
          title="Welcome to WaifuMon"
          lead="WaifuMon is a collection game played through the Discord bot. Hunt for new Waifumon, choose a Buddy, travel to new regions, and strengthen both your Trainer and individual companions."
        >
          <p className="max-w-prose text-sm text-ink-muted">
            The Portal is your companion for browsing collections, profiles, achievements, rankings,
            shops and game information. Player actions that change the game happen in Discord.
          </p>
        </Section>

        <Section
          icon={Compass}
          title="Hunting"
          lead="A hunt spends 1 Hunt Energy and grants Trainer XP. Your active Buddy also gains XP and Affection. A hunt may reveal a Waifumon, but it can instead award an item, WaifuBux, Essence or a world-flavor result."
          link={{ to: '/collection', label: 'View your active collection' }}
        >
          <BulletList>
            <li>You can have only one active Waifumon encounter at a time.</li>
            <li>Your current region determines which species a normal hunt can select.</li>
            <li>Rarity is rolled separately from the species selection.</li>
            {encounterExpiry !== null && (
              <li>
                A normal encounter waits for about{' '}
                <strong className="text-ink">{Math.round(encounterExpiry / 60)} minutes</strong>{' '}
                before expiring.
              </li>
            )}
            {huntCooldown !== null && (
              <li>
                Hunts have a <strong className="text-ink">{huntCooldown}-second cooldown</strong>.
              </li>
            )}
          </BulletList>
        </Section>

        <Section
          icon={Swords}
          title="Capturing Waifumon"
          lead="A normal Waifumon encounter allows up to three capture attempts. Every attempt consumes the capture item you commit, whether it succeeds or fails."
        >
          <BulletList>
            <li>Charms multiply the base capture chance.</li>
            <li>Restraints add a flat bonus and may work only on listed rarities.</li>
            <li>Consumables can grant a temporary bonus for a limited number of attempts.</li>
            <li>A favorable Buddy affinity matchup adds a flat bonus.</li>
            <li>A matching capture-focused Buddy Bonus can improve the assembled chance.</li>
            <li>
              Guaranteed-capture items bypass ordinary chance and do not spend a temporary buff
              charge.
            </li>
          </BulletList>

          {baseCaptureRates && (
            <ScrollableRegion label="Base capture chance table" className="mt-5">
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
          )}
        </Section>

        <Section
          icon={Sparkles}
          title="Capture items"
          lead="Capture gear is consumed when you commit it to an attempt. Check whether an item multiplies the base chance, adds percentage points, is restricted by rarity, or guarantees the capture. Temporary buffs are used separately."
          link={{ to: '/shop', label: 'Browse all regional shop catalogues' }}
        >
          {captureItems.length > 0 ? (
            <ScrollableRegion label="Capture item effects table">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead className="text-xs tracking-wide text-ink-muted uppercase">
                  <tr>
                    <th className="pb-2 font-medium">Item</th>
                    <th className="pb-2 font-medium">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {captureItems.map(({ item, effect }) => (
                    <tr key={item.slug} className="border-t border-border">
                      <td className="py-2 text-ink">
                        <span aria-hidden="true">{item.emoji} </span>
                        {item.name}
                      </td>
                      <td className="py-2 text-ink-muted">{effect}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollableRegion>
          ) : (
            <p className="text-sm text-ink-subtle">Capture-item details are loading.</p>
          )}
        </Section>

        <Section
          icon={Sparkles}
          title="Affinities"
          lead="Every Waifumon has an affinity. Your Buddy has a favorable capture matchup when her affinity points to the encountered Waifumon in this cycle: Dominant → Submissive → Caregiver → Primal → Dominant. Switch is neutral."
        >
          <dl className="space-y-2.5 text-sm">
            {AFFINITIES.map((affinity) => (
              <div key={affinity.key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="w-28 shrink-0 font-medium text-ink">{titleCase(affinity.key)}</dt>
                <dd className="text-ink-muted">{affinity.blurb}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 max-w-prose text-sm text-ink-muted">
            A favorable matchup improves capture chance according to your Buddy’s rarity.
            Unfavorable matchups currently carry no capture penalty. Bosses use a different affinity
            cycle shown in their announcements.
          </p>
        </Section>

        <Section
          icon={Zap}
          title="Hunt Energy and Care Mode"
          lead="Hunt Energy powers hunting and travel. It does not regenerate passively: recover it through the daily package, Care Mode or Energy-restoring consumables."
          link={{ to: '/buddy', label: 'View your Buddy and Care state' }}
        >
          <BulletList>
            {baseMaxEnergy !== null && (
              <li>
                New Trainers begin with room for{' '}
                <strong className="text-ink">{baseMaxEnergy} Energy</strong>; level rewards can
                increase that capacity.
              </li>
            )}
            {careInterval !== null && (
              <li>
                A base Care interval completes every{' '}
                <strong className="text-ink">{careInterval} minutes</strong>.
              </li>
            )}
            {careEnergyPerTick !== null &&
              careXpPerTick !== null &&
              careAffectionPerTick !== null && (
                <li>
                  Each base interval grants{' '}
                  <strong className="text-ink">{careEnergyPerTick} Energy</strong> to you,{' '}
                  <strong className="text-ink">{careXpPerTick} XP</strong> and{' '}
                  <strong className="text-ink">{careAffectionPerTick} Affection</strong> to the Care
                  target.
                </li>
              )}
            {careRecoveryCap !== null && (
              <li>
                Base Care recovery fills Energy up to{' '}
                <strong className="text-ink">{careRecoveryCap}</strong>; valid XP and Affection
                ticks can continue after that ceiling.
              </li>
            )}
            <li>The Care target does not have to be your active Buddy.</li>
            <li>
              Hunting, claiming the daily package and wake-up Energy items apply completed ticks and
              end Care Mode.
            </li>
            <li>Travel is blocked while Care Mode is active.</li>
          </BulletList>
        </Section>

        <Section
          icon={UserRound}
          title="Progression, Buddies and appearances"
          lead="Your Trainer and every owned Waifumon have separate progression. Trainer levels unlock account-wide benefits; each captured copy keeps her own level, XP, Affection, Seductive Power, nickname, Favorite state and appearance progress."
          link={{ to: '/buddy', label: 'Inspect your active Buddy' }}
        >
          <BulletList>
            <li>
              Your Buddy gains XP and Affection from hunts and supplies capture-affinity matchups.
            </li>
            <li>
              Species-authored Buddy Bonuses can affect hunting, capture, Care, rewards, bosses and
              world checks.
            </li>
            <li>Essence can be invested directly into an owned Waifumon for XP.</li>
            <li>
              Additional appearances unlock from the individual copy’s authored level requirements.
            </li>
            <li>Appearances are cosmetic and do not change gameplay values.</li>
            <li>There is currently no separate evolution system.</li>
          </BulletList>
        </Section>

        <Section
          icon={Gift}
          title="Affection and gifts"
          lead="Affection belongs to an individual Waifumon. It grows through Buddy hunts, Care Mode, affection items, encounter effects and qualifying Buddy Bonuses."
        >
          <BulletList>
            <li>The daily claim checks only your active Buddy for an affection gift.</li>
            <li>Gift progress and guarantee counters belong to that specific copy.</li>
            <li>Switching Buddies does not transfer progress.</li>
            <li>
              An unclaimed gift does not expire and remains waiting if inventory capacity blocks the
              claim.
            </li>
          </BulletList>
        </Section>

        <Section
          icon={PackageCheck}
          title="Duplicates and release"
          lead="Capturing a species you already own creates a separate copy. Copies are not merged; each keeps her own progression and customization."
          link={{ to: '/collection', label: 'Manage your active collection' }}
        >
          <BulletList>
            <li>
              A duplicate can be converted to Essence while you retain another active copy of that
              species.
            </li>
            <li>An eligible copy can be released even if she is your final copy of the species.</li>
            <li>
              The active Buddy and Favorites are protected from ordinary release or conversion.
            </li>
            <li>
              Released copies stop counting as currently owned, but lifetime capture history
              remains.
            </li>
          </BulletList>
        </Section>

        <Section
          icon={Backpack}
          title="Currency, items and daily systems"
          lead="WaifuBux is the everyday currency; Essence is the rarer progression currency. Capture items are committed to attempts, while consumables can restore Energy, grant Affection or create temporary capture bonuses."
          link={{ to: '/inventory', label: 'View your inventory' }}
        >
          <BulletList>
            <li>
              The daily package refills Energy, grants standard rewards and Trainer XP, applies Care
              ticks and ends Care Mode.
            </li>
            <li>Eligible Buddies can prepare an affection gift during the daily claim.</li>
            <li>
              Daily Quests track their named objectives, but completed rewards must be claimed
              separately before reset.
            </li>
            <li>Claiming every assigned quest awards the all-complete bonus.</li>
            <li>
              Regional shops carry different stock; the Portal Shop shows their combined catalogue.
            </li>
          </BulletList>
        </Section>

        <Section
          icon={Map}
          title="Travel and World Encounters"
          lead="You begin in the home region. Other destinations require the appropriate Trainer level and may require a pass or route purchase. Once unlocked, route access is permanent; each journey costs 1 Energy."
        >
          <BulletList>
            <li>
              Travel is blocked by an active Waifumon encounter, Care Mode, insufficient Energy or a
              locked route.
            </li>
            <li>Your current region changes normal hunt pools and regional shop availability.</li>
            <li>World Encounters can appear during eligible hunts or after travel.</li>
            <li>
              They may offer choices, Buddy requirements, Seductive Power checks, vendors, rewards,
              chains or a follow-up Waifumon encounter.
            </li>
            <li>
              The game shows a choice’s success chance before you commit when a check is required.
            </li>
          </BulletList>
        </Section>

        <Section
          icon={Crown}
          title="Boss Encounters"
          lead="Boss Encounters are guild-wide scouting events. During the response window, you can commit your active Buddy after reviewing her Seductive Power, affinity matchup and estimated result."
        >
          <BulletList>
            <li>
              Joining snapshots the Buddy and relevant values; switching later does not change that
              commitment.
            </li>
            <li>
              Performance uses Seductive Power, a performance roll and applicable affinity or
              response bonuses.
            </li>
            <li>Rewards arrive when the boss resolves, not when you join.</li>
          </BulletList>
        </Section>

        <Section
          icon={Trophy}
          title="Achievements and leaderboards"
          lead="Achievements recognize long-term progress. Leaderboards rank players within the selected Discord server by Trainer XP, currently owned species, lifetime captures, current Buddy Affection and lifetime high-rarity captures."
          link={{ to: '/achievements', label: 'View your achievements' }}
        >
          <BulletList>
            <li>Earned achievements remain unlocked even if the live value later falls.</li>
            <li>
              Distinct-species progress and collection rankings count species currently owned.
            </li>
            <li>Lifetime capture rankings include copies later released.</li>
            <li>
              Hunt achievements count resolved Waifumon encounters rather than every Hunt command.
            </li>
          </BulletList>
          <Link
            to="/leaderboards"
            className="mt-3 inline-block text-sm text-accent underline-offset-4 hover:underline"
          >
            View server leaderboards →
          </Link>
        </Section>

        <Section icon={Coins} title="Quick tips" lead="A few habits make early progress smoother.">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-muted">
            <li>Set a Buddy early so hunts build her XP and Affection.</li>
            <li>Check affinity and rarity restrictions before spending premium capture gear.</li>
            <li>Enter Care Mode before stepping away.</li>
            <li>Complete and claim Daily Quests separately.</li>
            <li>Favorite valuable copies to protect them from ordinary release.</li>
            <li>Travel for different hunt pools and regional shop stock.</li>
            <li>Claim pending affection gifts so your Buddy can work toward another.</li>
          </ol>
        </Section>

        <Section icon={HelpCircle} title="Questions" lead="Common Portal questions.">
          <dl className="space-y-4">
            {FAQ.map((item) => (
              <div key={item.question}>
                <dt className="font-medium text-ink">{item.question}</dt>
                <dd className="mt-1 max-w-prose text-sm text-ink-muted">{item.answer}</dd>
              </div>
            ))}
          </dl>
          <Badge variant="outline" className="mt-4">
            Gameplay actions happen in Discord
          </Badge>
        </Section>
      </div>
    </>
  );
}
