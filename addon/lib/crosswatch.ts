import { noteTrackerCall } from '../utils/trackerCalls';

interface Target {
  instance: string;
  profile: string;
  removalPair?: string;
}

export function crosswatchTarget(config: any, userUUID?: string, profile?: string): Target | undefined {
  if (config?.crosswatchWatchTracking !== true || !userUUID ||
      !process.env.CROSSWATCH_URL || !process.env.CROSSWATCH_TOKEN) return;
  const key = `${userUUID}:${profile ?? config.jellyfinProfileId ?? ''}`;
  try {
    const mappings = JSON.parse(process.env.CROSSWATCH_VIEWERS || '{}');
    if (!Object.hasOwn(mappings, key)) return;
    const target = mappings[key];
    if (typeof target?.instance !== 'string' || !/^[a-z0-9_-]+$/i.test(target.instance) ||
        typeof target.profile !== 'string' || !target.profile.trim()) return;
    // A local tracker belongs to exactly one AIOM viewer.
    if (Object.values(mappings).filter((other: any) => String(other?.instance ?? '').toLowerCase() === target.instance.toLowerCase()).length !== 1) return;
    return { instance: target.instance, profile: target.profile,
      removalPair: typeof target.removalPair === 'string' && target.removalPair ? target.removalPair : undefined };
  } catch {
    return;
  }
}

async function request(path: string, payload?: unknown): Promise<any> {
  const url = new URL(path, process.env.CROSSWATCH_URL);
  let res: Response;
  try {
    res = await fetch(url, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${process.env.CROSSWATCH_TOKEN}`, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    noteTrackerCall(url.href, 0);
    throw new Error('CrossWatch did not respond');
  }
  const data: any = await res.json().catch(() => null);
  const ok = res.ok && data && data.ok !== false && (payload === undefined || data.ok === true)
    && !data.unresolved && !(Array.isArray(data.errors) ? data.errors.length : data.errors);
  // A successful HTTP response can still contain a rejected operation.
  noteTrackerCall(url.href, ok ? res.status : res.ok ? 422 : res.status === 409 ? 503 : res.status, undefined, res.headers.get('retry-after'));
  if (!ok) throw new Error(`CrossWatch rejected the operation (HTTP ${res.status})`);
  return data;
}

export async function crosswatchHistory(target: Target, kind: 'history' | 'ratings' = 'history'): Promise<any[]> {
  // The profile dashboard requires a browser session. The editor supports a server API token.
  const query = new URLSearchParams({ kind, provider: 'CROSSWATCH', provider_instance: target.instance });
  const data = await request(`/api/editor?${query}`);
  if (String(data.provider).toUpperCase() !== 'CROSSWATCH' || data.provider_instance !== target.instance ||
      !data.items || typeof data.items !== 'object' || Array.isArray(data.items)) {
    throw new Error('CrossWatch returned an unexpected history scope');
  }
  return Object.values(data.items);
}

export async function crosswatchProgress(target: Target): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({ provider: 'crosswatch', instance_id: target.instance,
      user_profile: target.profile, page: String(page), page_size: '100', force_refresh: 'true' });
    const data = await request(`/api/playback_progress/items?${query}`);
    rows.push(...(data.items ?? []).filter((row: any) =>
      String(row.provider).toLowerCase() === 'crosswatch' && row.instance_id === target.instance));
    if (rows.length >= Number(data.total) || (data.items ?? []).length < 100) break;
  }
  return rows;
}

async function media(id: string, config: any): Promise<Record<string, unknown> | undefined> {
  const { parseMediaId, resolveSeriesIds } = require('./subtitleHandler');
  const parsed = parseMediaId(id);
  if (!parsed) return;
  if (parsed.type === 'movie') {
    if (!['tmdb', 'imdb', 'tvdb'].includes(parsed.provider)) return;
    return { type: 'movie', ids: { [parsed.provider]: parsed.id } };
  }
  const episode = await resolveSeriesIds(parsed, config);
  if (!episode || !Number.isInteger(episode.season) || !Number.isInteger(episode.episode)) return;
  return { type: 'episode', ids: episode.ids, show_ids: episode.ids, season: episode.season, episode: episode.episode };
}

export async function deliverCrosswatch(op: string, payload: any, config: any, userUUID: string): Promise<void> {
  const target = crosswatchTarget(config, userUUID);
  if (!target) return;
  const item = await media(payload.id, config);
  if (!item) throw new Error('CrossWatch could not identify the playback item');
  if ((op === 'credit' || op === 'scrobble') && payload.metaId) {
    const { cachedMeta } = require('../utils/recommendations/localHistory');
    const episodic = item.type === 'episode';
    const meta = await cachedMeta(config, userUUID, episodic ? 'series' : 'movie', payload.metaId).catch(() => null);
    if (typeof meta?.name === 'string' && meta.name.trim()) item[episodic ? 'series_title' : 'title'] = meta.name;
  }
  const provider = { provider: 'CROSSWATCH', instance: target.instance };
  const scope = { provider: 'crosswatch', instance_id: target.instance, record: { provider_metadata: { progress_item: item } } };
  if (op === 'credit') {
    await request('/api/editor/send', {
      kind: 'history', providers: [provider], items: [{ ...item, watched_at: new Date(payload.at).toISOString() }],
    });
  } else if (op === 'scrobble') {
    await request('/api/playback_progress/actions/update_progress', {
      ...scope,
      record: {
        can_update_progress: true,
        provider_metadata: { progress_item: { ...item, duration_ms: payload.durationMs } },
      },
      progress_percent: payload.positionMs * 100 / payload.durationMs,
    });
  } else if (op === 'clearResume') {
    await request('/api/playback_progress/actions/remove', scope);
  } else if (op === 'unwatch' && target.removalPair) {
    const selection = { kind: 'history', items: [item], pair_id: target.removalPair,
      source_provider: 'CROSSWATCH', source_instance: target.instance };
    const preview = await request('/api/editor/send/preview', selection);
    if (!preview.preview_id || !preview.providers?.some((ref: any) => ref.provider === 'CROSSWATCH' && ref.instance === target.instance)) {
      throw new Error('CrossWatch has no matching history baseline for this viewer');
    }
    await request('/api/editor/send', {
      ...selection, operation: 'remove', confirmed: true, preview_id: preview.preview_id, providers: [provider],
    });
  }
}
