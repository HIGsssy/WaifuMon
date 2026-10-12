import { createContext } from 'react';
import type { EventIssueTarget } from './dungeonText';

/**
 * Opens an event or a random pool in its side sheet, and the sandbox, from
 * anywhere inside the dungeon workspace. Null where there is no host.
 */
export interface EventEditorHost {
  open: (target: EventIssueTarget) => void;
  /** Play the draft as it stands, through the real engine. Nothing is granted or stored. */
  play: () => void;
}
export const EventEditorContext = createContext<EventEditorHost | null>(null);
