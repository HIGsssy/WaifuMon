/**
 * How the draft's events would play, asked of the server: every pool's odds
 * and every event's choices for an imagined run. The Portal works none of it
 * out itself — the answer comes from the engine's own draw and check rules.
 *
 * It is asked separately from the page's validation and kept apart from it, so
 * an answer here can never replace the checklist, and an answer about an older
 * draft or situation is never shown as current.
 */
import { useEffect, useState } from 'react';
import {
  validateDungeon,
  type DungeonDefinition,
  type DungeonEventPoolAnalysis,
  type DungeonEventPreview,
  type DungeonEventScenario,
} from '@/api/adminDungeons';

const DELAY_MS = 300;

export const EMPTY_SCENARIO: DungeonEventScenario = {
  flags: [],
  completedRooms: [],
  seenEvents: [],
  inventory: {},
  currentSp: 200,
  canTurnBack: true,
};

export interface EventInsight {
  pools: DungeonEventPoolAnalysis[] | undefined;
  previews: DungeonEventPreview[] | undefined;
  /** The answer shown is for the draft and situation as they stand now. */
  current: boolean;
  /** The server could not read the draft (a blank field), so there is nothing to show yet. */
  unreadable: boolean;
  failed: boolean;
}

export function useEventInsight(
  definition: DungeonDefinition,
  scenario: DungeonEventScenario = EMPTY_SCENARIO,
): EventInsight {
  // The whole draft: a blank anywhere in it makes it unreadable, and filling it must ask again.
  const key = JSON.stringify([definition, scenario]);
  const [answer, setAnswer] = useState<{
    key: string;
    pools: DungeonEventPoolAnalysis[] | undefined;
    previews: DungeonEventPreview[] | undefined;
    unreadable: boolean;
  } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void validateDungeon(definition, controller.signal, scenario)
        .then((report) => {
          if (controller.signal.aborted) return;
          setAnswer({
            key,
            pools: report.eventPools,
            previews: report.eventPreviews,
            unreadable: report.definition == null,
          });
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(key);
        });
    }, DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `key` is the identity of everything the answer depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = answer?.key === key;
  return {
    // An unreadable draft has no odds; the last readable answer is not passed off as its own.
    pools: answer?.unreadable ? undefined : answer?.pools,
    previews: answer?.unreadable ? undefined : answer?.previews,
    current,
    unreadable: current && answer.unreadable,
    failed: failed === key,
  };
}
