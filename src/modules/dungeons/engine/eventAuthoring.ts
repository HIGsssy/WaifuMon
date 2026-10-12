/**
 * What an author is shown about a dungeon's events while writing them: a
 * pool's odds, and each event's choices as a player in some situation would
 * meet them. Pure, and made only of the functions a run uses —
 * `analyseEventPool`, `describeEventChoice`, `eventCheckChance` — so an editor
 * that draws from here cannot disagree with play.
 *
 * A *scenario* is an imagined run: what it remembers, which rooms it has
 * finished, which events it has already met, what the player holds and how
 * strong the Buddy is. It is never read from, or written to, a real run.
 */
import type { DungeonDefinition, DungeonEventPool } from '../content/dungeonDefinition';
import type { ConditionFacts } from './conditions';
import { EVENT_SP_NEUTRAL, EVENT_SP_SPREAD, eventCheckChance } from './eventChecks';
import { analyseEventPool, describeEventChoice, type DungeonEventChoiceView, type EventPoolAnalysis } from './events';

export interface EventAuthoringScenario {
  /** Run flags that are set. Every other flag is unset. */
  flags: string[];
  completedRooms: string[];
  /** Events the imagined run has already met, for once-per-run entries. */
  seenEvents: string[];
  /** Item slug → how many the imagined player holds. */
  inventory: Record<string, number>;
  currentSp: number;
  /** The player arrived from another room, so a choice that turns back has somewhere to go. */
  canTurnBack: boolean;
}

/** An empty run with an average Buddy who came from somewhere. */
export const defaultEventAuthoringScenario = (): EventAuthoringScenario => ({
  flags: [],
  completedRooms: [],
  seenEvents: [],
  inventory: {},
  currentSp: EVENT_SP_NEUTRAL,
  canTurnBack: true,
});

export interface EventPoolAuthoringView {
  poolId: string;
  /** Every entry in the draw: no rule applied and nothing met yet. */
  base: EventPoolAnalysis;
  /** As the scenario stands. */
  scenario: EventPoolAnalysis;
}

export interface EventChoiceAuthoringView extends DungeonEventChoiceView {
  /** Unavailable and marked to be left off the screen: a player would not see it at all. */
  hidden: boolean;
  /** A check's success chance for the weakest, an average and the strongest Buddy; null without a check. */
  chances: { weakest: number; average: number; strongest: number } | null;
}

export interface EventAuthoringPreview {
  eventId: string;
  /** Every choice in authored order, hidden ones included and marked. */
  choices: EventChoiceAuthoringView[];
}

export interface DungeonEventAuthoringView {
  eventPools: EventPoolAuthoringView[];
  eventPreviews: EventAuthoringPreview[];
}

function scenarioFacts(scenario: EventAuthoringScenario): ConditionFacts {
  return {
    flags: Object.fromEntries(scenario.flags.map((flag) => [flag, true])),
    playerFlags: {},
    rooms: Object.fromEntries(scenario.completedRooms.map((roomId) => [roomId, { visits: 1, completed: true, resumeAt: null, actions: {} }])),
  };
}

/** The pool with no entry held back by a rule, so the analysis is its authored shares alone. */
function withoutRules(pool: DungeonEventPool): DungeonEventPool {
  return { ...pool, entries: pool.entries.map(({ when: _when, ...entry }) => entry) as DungeonEventPool['entries'] };
}

export function describeEventAuthoring(
  definition: Pick<DungeonDefinition, 'events' | 'eventPools'>,
  scenario: EventAuthoringScenario = defaultEventAuthoringScenario(),
): DungeonEventAuthoringView {
  const facts = scenarioFacts(scenario);
  const seen = new Set(scenario.seenEvents);
  const nothing: ConditionFacts = { flags: {}, playerFlags: {}, rooms: {} };
  return {
    eventPools: (definition.eventPools ?? []).map((pool) => ({
      poolId: pool.id,
      base: analyseEventPool(withoutRules(pool), nothing),
      scenario: analyseEventPool(pool, facts, seen),
    })),
    eventPreviews: (definition.events ?? []).map((event) => ({
      eventId: event.id,
      choices: event.choices.map((choice) => {
        const view = describeEventChoice(choice, {
          facts,
          inventory: scenario.inventory,
          // Any room will do: the engine asks only whether there is one.
          cameFrom: scenario.canTurnBack ? 'elsewhere' : null,
          currentSp: scenario.currentSp,
        });
        return {
          ...view,
          hidden: !view.available && choice.hideWhenUnavailable === true,
          chances: choice.check
            ? {
                weakest: eventCheckChance(choice.check, EVENT_SP_NEUTRAL - EVENT_SP_SPREAD),
                average: eventCheckChance(choice.check, EVENT_SP_NEUTRAL),
                strongest: eventCheckChance(choice.check, EVENT_SP_NEUTRAL + EVENT_SP_SPREAD),
              }
            : null,
        };
      }),
    })),
  };
}
