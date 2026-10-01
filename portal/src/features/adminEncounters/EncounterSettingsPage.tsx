/**
 * World Encounters — Settings: the global runtime tuning (hunt/travel chance,
 * expiry, Force Trigger), moved off the encounter list so finding an encounter
 * no longer starts below a settings form.
 *
 * The "how pacing works" card states what the engine actually does, including
 * what it does *not* have: there is no global World Encounter cooldown.
 */
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/PageHeader';
import { GlobalEncounterSettingsPanel } from './GlobalEncounterSettingsPanel';

export function EncounterSettingsPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="World Encounter Settings"
        description="Global tuning that applies to every encounter. Changing it needs the publish permission."
      />
      <GlobalEncounterSettingsPanel />
      <Card className="space-y-2 p-4 text-sm" data-testid="pacing-explainer">
        <h2 className="text-sm font-semibold uppercase text-ink-muted">How pacing works</h2>
        <ul className="list-disc space-y-1 pl-5 text-ink-muted">
          <li>
            Each hunt and each completed travel rolls the chance above. If it passes, one eligible
            encounter is drawn by weight × rarity.
          </li>
          <li>
            There is <strong>no global World Encounter cooldown</strong>. The only global limit is
            that a player with an encounter still open cannot get another until it is answered or
            expires.
          </li>
          <li>
            Each encounter has its own <strong>repeat cooldown</strong>, set in its editor: after a
            player resolves it, that encounter leaves their random pool for that long.
          </li>
          <li>
            Chain follow-ups skip the chance roll and their own repeat cooldown: when a choice
            continues to another encounter, it opens immediately — but only if that encounter is
            Active. A draft or disabled follow-up does not open, and the chain ends there.
          </li>
        </ul>
      </Card>
    </div>
  );
}
