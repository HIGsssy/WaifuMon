/**
 * Unauthenticated ops endpoints, consumed only by the diagnostics page (§23).
 *
 * These live at the **API server's root** (`/ready`, `/health`), not under
 * `/api/v1`, so they bypass the Axios instance's base URL and get their own
 * dev-server proxy entries. `/ready` answers 503 with a full report body when a
 * component is down, so a non-2xx status is still a useful answer here.
 */
import axios from 'axios';
import type { ReadinessReport } from './types';

export async function getReadiness(signal?: AbortSignal): Promise<ReadinessReport> {
  const response = await axios.get<ReadinessReport>('/ready', {
    // A "down" report is data, not a transport failure.
    validateStatus: (status) => status === 200 || status === 503,
    timeout: 5_000,
    ...(signal ? { signal } : {}),
  });
  return response.data;
}
