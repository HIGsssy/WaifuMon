import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';

import { getAuthSession, logout as logoutRequest, selectAuthGuild } from '@/api/auth';
import { IDENTITY_POLICY } from '@/api/cachePolicy';
import { SessionContext } from './SessionContext';
import type { PortalSession, PortalSessionPayload, SessionState } from './types';

function toSession(payload: PortalSessionPayload | undefined): PortalSession | null {
  if (!payload?.authenticated || !payload.playerId || !payload.selectedGuild || !payload.discordUser) {
    return null;
  }
  return {
    playerId: payload.playerId,
    guildDbId: payload.selectedGuild.guildDbId,
    displayName: payload.discordUser.displayName,
    avatarUrl: payload.discordUser.avatarUrl,
    discordUserId: payload.discordUser.id,
    discordGuildId: payload.selectedGuild.discordGuildId,
    permissions: payload.permissions ?? [],
  };
}

export function OAuthSessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['auth', 'session'],
    queryFn: ({ signal }) => getAuthSession(signal),
    ...IDENTITY_POLICY,
  });

  const value = useMemo<SessionState>(() => {
    const session = toSession(query.data);
    const unresolved =
      query.data?.authenticated === false ||
      query.data?.needsGuildSelection === true ||
      query.data?.noProfile === true;

    return {
      status: session ? 'ready' : query.isPending && !query.isError ? 'loading' : unresolved ? 'unresolved' : 'unresolved',
      session,
      error: query.error,
      configuredPlayerId: undefined,
      eligibleGuilds: query.data?.eligibleGuilds,
      noProfile: query.data?.noProfile,
      retry: () => void query.refetch(),
      logout: async () => {
        await logoutRequest();
        queryClient.setQueryData(['auth', 'session'], { authenticated: false });
      },
      selectGuild: async (discordGuildId) => {
        const next = await selectAuthGuild(discordGuildId);
        queryClient.setQueryData(['auth', 'session'], next);
      },
    };
  }, [query, queryClient]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
