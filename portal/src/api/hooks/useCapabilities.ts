/**
 * Which optional backend features are available (plan §13).
 *
 * Deployment-wide and effectively static — the answer changes only when the
 * operator restarts the API with a different flag — so it is cached like
 * content rather than like player state.
 *
 * The hook never surfaces an error state to callers. A capability the Portal
 * could not confirm is one it does not offer, which degrades to "the feature is
 * simply not there" — the same experience as the feature being switched off,
 * and the right outcome either way.
 */
import { useQuery } from '@tanstack/react-query';

import { CONTENT_POLICY } from '../cachePolicy';
import { getCapabilities, NO_CAPABILITIES } from '../capabilities';
import { queryKeys } from '../queryKeys';
import type { PlatformCapabilities } from '../types';

export function usePlatformCapabilities(): PlatformCapabilities {
  const query = useQuery({
    queryKey: queryKeys.capabilities(),
    queryFn: ({ signal }) => getCapabilities(signal),
    ...CONTENT_POLICY,
  });

  // Also the value while the first request is in flight, so nothing flashes a
  // card control on and then off again.
  return query.data ?? NO_CAPABILITIES;
}
