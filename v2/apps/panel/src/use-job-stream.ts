import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { JobDetail, JobState } from './api.js';

export type JobStreamStatus = 'connecting' | 'live' | 'reconnecting';

interface JobStateMessage {
  jobId: string;
  leagueId: string;
  state: JobState;
  from: JobState | null;
}

function parseJobState(value: string): JobStateMessage | null {
  try {
    const parsed = JSON.parse(value) as Partial<JobStateMessage>;
    if (
      typeof parsed.jobId !== 'string' ||
      typeof parsed.leagueId !== 'string' ||
      typeof parsed.state !== 'string'
    ) {
      return null;
    }
    return parsed as JobStateMessage;
  } catch {
    return null;
  }
}

/** Subscribes to one league's job transitions; EventSource owns reconnects. */
export function useJobStream(leagueId: string | null): JobStreamStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<JobStreamStatus>('connecting');

  useEffect(() => {
    if (!leagueId) return;
    let active = true;
    setStatus('connecting');
    const source = new EventSource(`/api/v1/stream?leagueId=${encodeURIComponent(leagueId)}`);

    const invalidateJobs = (jobId?: string) => {
      void queryClient.invalidateQueries({ queryKey: ['jobs', leagueId] });
      void queryClient.invalidateQueries({ queryKey: jobId ? ['job', jobId] : ['job'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    };

    source.onopen = () => {
      if (!active) return;
      setStatus('live');
      // Close the fetch/subscribe gap: anything that transitioned before the
      // listener was ready is refetched once, not discovered by polling.
      invalidateJobs();
    };
    source.onerror = () => {
      if (active) setStatus('reconnecting');
    };
    source.addEventListener('job.state', (event) => {
      if (!active) return;
      const message = parseJobState((event as MessageEvent<string>).data);
      if (!message || message.leagueId !== leagueId) return;

      // Paint the new state immediately, then refetch the complete journal
      // and server-computed decisions for that state.
      queryClient.setQueryData<JobDetail | undefined>(['job', message.jobId], (current) =>
        current ? { ...current, job: { ...current.job, state: message.state } } : current,
      );
      invalidateJobs(message.jobId);
    });

    return () => {
      active = false;
      source.close();
    };
  }, [leagueId, queryClient]);

  return status;
}
