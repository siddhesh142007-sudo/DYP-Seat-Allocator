import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  dbLatencyMs: number;
  uptimeSeconds: number;
  env: string;
  timestamp: string;
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthResponse>('/health'),
    refetchInterval: 30_000,
    retry: 1,
  });
}
