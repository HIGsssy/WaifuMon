import { useEffect, useState } from 'react';
import {
  validateDungeon,
  type DungeonDefinition,
  type DungeonSpeciesPoolAnalysis,
  type DungeonSpeciesScenario,
} from '@/api/adminDungeons';
export const EMPTY_SPECIES_SCENARIO: DungeonSpeciesScenario = {
  flags: [],
  completedRooms: [],
  seenSpecies: [],
  acquisitions: {},
};
/** Own request and identity guard: never updates the page's publication checklist. */
export function useSpeciesInsight(definition: DungeonDefinition, scenario: DungeonSpeciesScenario) {
  const key = JSON.stringify([definition, scenario]);
  const [answer, setAnswer] = useState<{
    key: string;
    pools: DungeonSpeciesPoolAnalysis[] | undefined;
    unreadable: boolean;
  }>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void validateDungeon(definition, controller.signal, undefined, scenario)
        .then((report) => {
          if (!controller.signal.aborted)
            setAnswer({ key, pools: report.speciesPools, unreadable: !report.definition });
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(key);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    pools: answer?.key === key && !answer.unreadable ? answer.pools : undefined,
    unreadable: answer?.key === key && answer.unreadable,
    failed: failed === key,
  };
}
