import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What each tracker answered while one queued write was delivered. The write
 * helpers log and swallow their failures, so the outbox reads the answers here
 * to tell a write that landed from one to try again.
 */
export interface TrackerCall {
  host: string;
  status: number;
  body?: string;
  retryAt?: number;
}

const TRACKER_HOSTS = new Set([
  'api.simkl.com',
  'api.mdblist.com',
  'publicmetadb.com',
  'api.trakt.tv',
  'graphql.anilist.co',
  'api.myanimelist.net',
]);

const store = new AsyncLocalStorage<TrackerCall[]>();

export async function recordingTrackerCalls(work: () => Promise<unknown>): Promise<{ calls: TrackerCall[]; error?: any }> {
  const calls: TrackerCall[] = [];
  try {
    await store.run(calls, work);
    return { calls };
  } catch (error: any) {
    return { calls, error };
  }
}

/** Status 0 is a request that never got an answer. */
export function noteTrackerCall(url: string, status: number, body?: string, retryAfter?: string | number | null, retryAt?: number): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (!TRACKER_HOSTS.has(host)) return;
  recordCall(host, status, body, retryAfter, retryAt);
}

export function noteCrosswatchCall(status: number, retryAfter?: string | null): void {
  recordCall('crosswatch', status, undefined, retryAfter);
}

function recordCall(host: string, status: number, body?: string, retryAfter?: string | number | null, retryAt?: number): void {
  const calls = store.getStore();
  if (!calls) return;
  const seconds = Number(retryAfter);
  calls.push({
    host,
    status,
    ...(status >= 400 && body ? { body: String(body).slice(0, 300) } : {}),
    ...(retryAt ? { retryAt } : Number.isFinite(seconds) && seconds > 0 ? { retryAt: Date.now() + seconds * 1000 } : {}),
  });
}
