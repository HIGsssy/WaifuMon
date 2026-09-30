/**
 * What the choice/outcome/follow-up editors need from the page around them,
 * without threading it through every layer of props.
 *
 * The default value is inert — no encounters to pick, no follow-up creation —
 * so a `ChoiceEditor` rendered on its own (tests, a future embed) still works.
 */
import { createContext, useContext } from 'react';

import type { NameLookups } from './describe';
import type { EntityOption } from './EntitySelect';
import type { OutcomeBranch } from './followUps';

export interface EncounterSummary {
  id: number | null;
  name: string;
  lifecycle: string;
  /** "chain-only", "Hunt", "Hunt + Travel" … */
  appears: string;
  /** Distinct encounters (other than the one being edited) that already link here. */
  linkedFrom: string[];
}

export interface AuthoringContextValue {
  names: NameLookups;
  /** Encounters a follow-up may continue to (never the one being edited). */
  encounterOptions: EntityOption[];
  encounterSummary: (slug: string) => EncounterSummary | null;
  /** Null when follow-up creation is unavailable here. */
  createFollowUp: ((choiceIndex: number, branch: OutcomeBranch, name: string) => void) | null;
  /** Why creating a follow-up is blocked right now, if it is. */
  createFollowUpBlocked: string | null;
  creatingFollowUp: boolean;
}

export const AuthoringContext = createContext<AuthoringContextValue>({
  names: {},
  encounterOptions: [],
  encounterSummary: () => null,
  createFollowUp: null,
  createFollowUpBlocked: null,
  creatingFollowUp: false,
});

export const useAuthoring = () => useContext(AuthoringContext);
