import { apiClient } from './client';
import type { PortalSessionPayload } from '@/auth/types';

export async function getAuthSession(signal?: AbortSignal): Promise<PortalSessionPayload> {
  const response = await apiClient.get<PortalSessionPayload>('/auth/session', signal ? { signal } : {});
  return response.data;
}

export async function selectAuthGuild(discordGuildId: string): Promise<PortalSessionPayload> {
  const response = await apiClient.post<PortalSessionPayload>('/auth/guild', { discordGuildId });
  return response.data;
}

export async function logout(): Promise<void> {
  await apiClient.post('/auth/logout', {});
}
