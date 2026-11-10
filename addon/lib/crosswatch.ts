import { request as httpsRequest } from 'node:https';
import { resolveStrictPublicConnection } from './posterCache/upstream';
import { noteCrosswatchCall } from '../utils/trackerCalls';

interface Connection {
  url: string;
  token: string;
  trusted: boolean;
}

interface Target extends Connection {
  instance: string;
  profile: string;
  removalPair?: string;
}

function connectionOf(config: any): Connection | undefined {
  if (config?.crosswatchWatchTracking !== true) return;
  if (config.crosswatch === undefined) {
    const { CROSSWATCH_URL: url, CROSSWATCH_TOKEN: token } = process.env;
    if (url && token) return { url, token, trusted: true };
    return;
  }

  const { url, token } = config.crosswatch ?? {};
  if (typeof url !== 'string' || typeof token !== 'string' ||
      !/^[!-~]{1,4096}$/.test(token.trim())) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.search || parsed.hash || parsed.port) return;
    return { url: parsed.href.replace(/\/+$/, ''), token: token.trim(), trusted: false };
  } catch {
    return;
  }
}

export function crosswatchTarget(config: any, userUUID?: string, profile?: string): Target | undefined {
  const connection = connectionOf(config);
  if (!connection || !userUUID) return;
  const viewer = profile ?? config.jellyfinProfileId ?? '';
  try {
    const mappings = connection.trusted
      ? JSON.parse(process.env.CROSSWATCH_VIEWERS || '{}')
      : config.crosswatch.viewers;
    const key = connection.trusted ? `${userUUID}:${viewer}` : viewer;
    const viewerIds = new Set(['', ...(Array.isArray(config.jellyfinUsers)
      ? config.jellyfinUsers.map((user: any) => user?.id) : [])]);
    if (!mappings || !Object.hasOwn(mappings, key) || (!connection.trusted && !viewerIds.has(key))) return;
    const target = mappings[key];
    const instance = typeof target?.instance === 'string' ? target.instance.trim() : '';
    const profileId = typeof target?.profile === 'string' ? target.profile.trim() : '';
    if (!/^[a-z0-9_-]+$/i.test(instance) || !profileId) return;
    // A local tracker belongs to exactly one AIOM viewer in this connection.
    if (Object.entries(mappings).filter(([id, other]: [string, any]) =>
      (connection.trusted || viewerIds.has(id)) &&
      String(other?.instance ?? '').trim().toLowerCase() === instance.toLowerCase()).length !== 1) return;
    return { ...connection, instance, profile: profileId,
      removalPair: typeof target.removalPair === 'string' ? target.removalPair.trim() || undefined : undefined };
  } catch {
    return;
  }
}

export function hasCrosswatchConnection(config: any): boolean {
  return Boolean(connectionOf(config) && (config.crosswatch?.viewers || process.env.CROSSWATCH_VIEWERS));
}

async function requestPublic(url: URL, headers: Record<string, string>, body?: string) {
  const signal = AbortSignal.timeout(12_000);
  const { httpsAgent, httpAgent } = await resolveStrictPublicConnection(url.href);
  try {
    return await new Promise<{ status: number; retryAfter?: string; data: any }>((resolve, reject) => {
      const req = httpsRequest(url, {
        agent: httpsAgent, signal, headers, method: body === undefined ? 'GET' : 'POST',
      }, (res) => {
        const status = res.statusCode ?? 0;
        const retryAfter = res.headers['retry-after'];
        if (status < 200 || status >= 300) {
          res.destroy();
          resolve({ status, retryAfter, data: null });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('error', reject);
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) {
            req.destroy(new Error('CrossWatch response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve({ status, retryAfter, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            resolve({ status, retryAfter, data: null });
          }
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  } finally {
    httpsAgent.destroy();
    httpAgent.destroy();
  }
}

async function request(target: Connection, path: string, payload?: unknown): Promise<any> {
  const url = target.trusted ? new URL(path, target.url) : new URL(target.url + path);
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers = { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' };
  let result;
  try {
    if (target.trusted) {
      const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', headers, body, redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      result = { status: res.status, retryAfter: res.headers.get('retry-after'), data: await res.json().catch(() => null) };
    } else {
      result = await requestPublic(url, headers, body);
    }
  } catch {
    noteCrosswatchCall(0);
    throw new Error('CrossWatch did not respond');
  }
  const { status, retryAfter, data } = result;
  const httpOk = status >= 200 && status < 300;
  const ok = httpOk && data && data.ok !== false && (payload === undefined || data.ok === true)
    && !data.unresolved && !(Array.isArray(data.errors) ? data.errors.length : data.errors);
  noteCrosswatchCall(ok ? status : httpOk ? 422 : status === 409 ? 503 : status, retryAfter);
  if (!ok) throw new Error(`CrossWatch rejected the operation (HTTP ${status})`);
  return data;
}

export async function checkCrosswatch(config: any, userUUID: string) {
  const connection = connectionOf(config);
  if (!connection || connection.trusted) {
    throw new Error('Enter a public HTTPS CrossWatch URL and API token.');
  }

  const profiles = await request(connection, '/api/user-profiles');
  if (!Array.isArray(profiles.items)) throw new Error('CrossWatch returned an unexpected profile list.');
  const viewers = ['', ...config.jellyfinUsers.map((user: { id: string }) => user.id)];
  const targets = viewers.map((id) => ({ id, target: crosswatchTarget(config, userUUID, id) }));
  const pairs = targets.some(({ target }) => target?.removalPair)
    ? await request(connection, '/api/pairs').catch(() => null)
    : [];
  return targets.map(({ id, target }) => {
    const mapping = config.crosswatch.viewers?.[id];
    if (!mapping?.profile && !mapping?.instance && !mapping?.removalPair) return { id, status: 'Not linked' };
    if (!target) return { id, status: 'Enter a profile ID and a unique local tracker ID.' };
    const profile = profiles.items.find((row: any) => row.id === target.profile);
    if (!profile) return { id, status: 'Profile ID was not found or is unavailable to this token.' };
    const instances = Object.entries(profile.instances ?? {}).find(([provider]) => provider.toUpperCase() === 'CROSSWATCH')?.[1];
    if (!Array.isArray(instances) || !instances.includes(target.instance)) {
      return { id, status: 'This local tracker is not assigned to the selected profile.' };
    }
    if (!target.removalPair) return { id, status: 'Profile and tracker verified. Removal is off.' };
    if (!Array.isArray(pairs)) return { id, status: 'Profile and tracker verified. The token could not read sync pairs.' };
    const pair = pairs.find((row: any) => row.id === target.removalPair);
    const hasTracker = ['source', 'target'].some((side) =>
      pair?.[side] === 'CROSSWATCH' && pair?.[`${side}_instance`] === target.instance);
    if (!hasTracker || pair.profile_id !== target.profile) {
      return { id, status: 'Removal pair does not match this profile and tracker.' };
    }
    if (pair.enabled === false || pair.features?.history?.enable !== true || pair.features.history.remove !== true) {
      return { id, status: 'Removal pair needs an enabled History → Remove setting.' };
    }
    return { id, status: 'Profile, tracker and removal pair verified.' };
  });
}

export async function crosswatchHistory(target: Target, kind: 'history' | 'ratings' = 'history'): Promise<any[]> {
  // The profile dashboard requires a browser session. The editor supports a server API token.
  const query = new URLSearchParams({ kind, provider: 'CROSSWATCH', provider_instance: target.instance });
  const data = await request(target, `/api/editor?${query}`);
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
    const data = await request(target, `/api/playback_progress/items?${query}`);
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

export function shouldTrackCrosswatchMedia(config: any, id: string): boolean {
  const { parseMediaId } = require('./subtitleHandler');
  const parsed = parseMediaId(id);
  return !!parsed && config.crosswatchMediaTypes?.[parsed.type] !== false;
}

export async function deliverCrosswatch(op: string, payload: any, config: any, userUUID: string): Promise<void> {
  const target = crosswatchTarget(config, userUUID);
  if (!target || !shouldTrackCrosswatchMedia(config, payload.id)) return;
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
    await request(target, '/api/editor/send', {
      kind: 'history', providers: [provider], items: [{ ...item, watched_at: new Date(payload.at).toISOString() }],
    });
  } else if (op === 'scrobble') {
    await request(target, '/api/playback_progress/actions/update_progress', {
      ...scope,
      record: {
        can_update_progress: true,
        provider_metadata: { progress_item: { ...item, duration_ms: payload.durationMs } },
      },
      progress_percent: payload.positionMs * 100 / payload.durationMs,
    });
  } else if (op === 'clearResume') {
    await request(target, '/api/playback_progress/actions/remove', scope);
  } else if (op === 'unwatch' && target.removalPair) {
    const selection = { kind: 'history', items: [item], pair_id: target.removalPair,
      source_provider: 'CROSSWATCH', source_instance: target.instance };
    const preview = await request(target, '/api/editor/send/preview', selection);
    if (!preview.preview_id || !preview.providers?.some((ref: any) => ref.provider === 'CROSSWATCH' && ref.instance === target.instance)) {
      throw new Error('CrossWatch has no matching history baseline for this viewer');
    }
    await request(target, '/api/editor/send', {
      ...selection, operation: 'remove', confirmed: true, preview_id: preview.preview_id, providers: [provider],
    });
  }
}
