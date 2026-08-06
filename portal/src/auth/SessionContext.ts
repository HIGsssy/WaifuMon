/**
 * The session context object, split from the provider so `useSession` can be a
 * plain hook module and Fast Refresh keeps working on the provider file.
 */
import { createContext } from 'react';

import type { SessionState } from './types';

export const SessionContext = createContext<SessionState | null>(null);
