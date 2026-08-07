/**
 * Developer-login controls — dev builds only.
 *
 * Throws outside `DevLoginSessionProvider`, which in practice means "you called
 * this from a component that a production build can reach". That is a bug worth
 * failing loudly on rather than degrading quietly, because the whole point of
 * the seam is that production never renders any of it.
 */
import { useContext } from 'react';

import { DevAuthContext, type DevAuthState } from './DevAuthContext';

export function useDevAuth(): DevAuthState {
  const state = useContext(DevAuthContext);
  if (!state) {
    throw new Error(
      'useDevAuth must be used inside DevLoginSessionProvider — it exists in dev builds only.',
    );
  }
  return state;
}
