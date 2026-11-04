import { createHash } from "crypto";
import {
  collectWatchedRows,
  isWatched,
  rowKind,
  titleKeys,
  viewerKey,
  watchedIndex,
} from "./history";
import {
  buildProfile,
  diversify,
  discovery,
  rank,
  type MediaType,
  type Profile,
  type Title,
} from "./watchly-ranking";

export const WATCHLY_ROWS = [
  ["top", "Top Picks for You"],
  ["watched", "Because You Watched"],
  ["loved", "Because You Loved"],
  ["genres", "Favorite Genre 1"],
  ["genres-2", "Favorite Genre 2"],
  ["genres-3", "Favorite Genre 3"],
  ["themes", "Favorite Theme 1"],
  ["themes-2", "Favorite Theme 2"],
  ["themes-3", "Favorite Theme 3"],
  ["creators", "From Your Favorite Creators"],
  ["positive", "Based on What You Loved/Liked"],
] as const;
export type Pool = "movie" | "series" | "anime" | "anime-movie" | "anime-series";
export interface Selection {
  rows: Record<string, any[]>;
  names: Record<string, string>;
  builtAt: string;
}
const active = new Map<string, Promise<Selection>>();

async function batches<T, U>(
  values: T[],
  fn: (value: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  for (let i = 0; i < values.length; i += 6)
    results.push(...(await Promise.all(values.slice(i, i + 6).map(fn))));
  return results;
}

function title(data: any): Title | undefined {
  if (!data?.id || !(data.title || data.name)) return;
  const keywords = data.keywords?.keywords ?? data.keywords?.results ?? [];
  const genres = data.genres ?? [];
  return {
    id: data.id,
    name: data.title || data.name,
    imdb: data.imdb_id || data.external_ids?.imdb_id,
    adult: data.adult,
    year:
      Number(
        String(data.release_date || data.first_air_date || "").slice(0, 4),
      ) || undefined,
    releaseDate: data.release_date || data.first_air_date,
    genres: genres.map((g: any) => String(g.id)),
    genreNames: Object.fromEntries(genres.map((g: any) => [g.id, g.name])),
    keywords: keywords.map((k: any) => String(k.id)),
    keywordNames: Object.fromEntries(keywords.map((k: any) => [k.id, k.name])),
    cast: (data.credits?.cast ?? []).slice(0, 10).map((p: any) => String(p.id)),
    directors: [...(data.created_by ?? []), ...(data.credits?.crew ?? [])]
      .filter((p: any) => !p.job || p.job === "Director")
      .map((p: any) => String(p.id)),
    countries:
      data.origin_country ||
      (data.production_countries ?? []).map((c: any) => c.iso_3166_1),
    language: data.original_language,
    runtime: data.runtime || data.episode_run_time?.[0],
    votes: Number(data.vote_count) || 0,
    rating: Number(data.vote_average) || 0,
    popularity: Number(data.popularity) || 0,
  };
}

function preferred(profile: Profile, axis: keyof Profile): string[] {
  return [...profile[axis]]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3)
    .map(([id]) => id);
}

export function selectionKey(config: any, uuid: string, pool: Pool) {
  const { resolveSources }: any = require("./history");
  const settings = JSON.stringify([
    config.recommendations,
    resolveSources(config).choice,
    config.apiKeys?.simklTokenId,
    config.apiKeys?.mdblist,
  ]);
  return (
    "recommendations:watchly:v1:" +
    viewerKey(config, uuid) +
    ":" +
    (pool === "anime" ? "anime-combined" : pool) +
    ":" +
    createHash("sha256").update(settings).digest("hex")
  );
}

export async function selection(
  config: any,
  uuid: string,
  pool: Pool,
): Promise<Selection> {
  const {
    cacheWrapGlobal,
    readGlobalCache,
    writeGlobalCache,
  }: any = require("../../lib/getCache");
  const { refreshTtl }: any = require("./provider");
  const key = selectionKey(config, uuid, pool);
  let pending = active.get(key);
  if (!pending) {
    pending = cacheWrapGlobal(
      key,
      async () => {
        try {
          const snapshot = await build(config, uuid, pool);
          await writeGlobalCache(key + ":last-good", snapshot, 7 * 86400);
          return snapshot;
        } catch (error) {
          const previous = await readGlobalCache(key + ":last-good");
          if (previous) return previous;
          throw error;
        }
      },
      Math.min(86400, refreshTtl(config)),
      {
        sourceList: true,
        resultClassifier: (result: Selection) => ({
          type: "SUCCESS",
          ttl:
            Date.now() - Date.parse(result.builtAt) > refreshTtl(config) * 1000
              ? 60
              : null,
        }),
      },
    ).finally(() => active.delete(key));
    active.set(key, pending);
  }
  return pending;
}

async function build(
  config: any,
  uuid: string,
  pool: Pool,
): Promise<Selection> {
  if (pool === "anime") {
    const movies = await selection(config, uuid, "anime-movie");
    const series = await selection(config, uuid, "anime-series");
    return {
      rows: { top: [...(movies.rows.top ?? []), ...(series.rows.top ?? [])] },
      names: { top: "Anime For You" },
      builtAt: new Date().toISOString(),
    };
  }
  const tmdb: any = require("../../lib/getTmdb");
  const anime = pool.startsWith("anime-");
  const type: MediaType = pool.endsWith("movie") ? "movie" : "series";
  const space: "movie" | "tv" = type === "movie" ? "movie" : "tv";
  const detail = async (id: number) =>
    title(
      await (type === "movie" ? tmdb.movieInfo : tmdb.tvInfo)(
        {
          id,
          append_to_response: "credits,keywords,external_ids",
        },
        config,
      ),
    );
  const settings = config.recommendations ?? {};
  const threshold =
    discovery[settings.discovery_style as keyof typeof discovery] ??
    discovery.balanced;
  const history = (await collectWatchedRows(config, uuid))
    .filter(
      (row) =>
        isWatched(row) &&
        (anime ? rowKind(row) === "anime" : rowKind(row) === type) &&
        (!row.tmdbType || row.tmdbType === space),
    )
    .sort((a, b) =>
      String(b.watchedAt || "").localeCompare(String(a.watchedAt || "")),
    );
  const sample = [
    ...new Map(
      [
        ...history.slice(0, 60),
        ...[...history]
          .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
          .slice(0, 60),
        ...history,
      ].map((row) => [row.key, row]),
    ).values(),
  ].slice(0, 160);
  const enriched = (
    await batches(sample, async (row) => {
      let id = row.tmdbId;
      if (!id && row.imdbId) {
        const found = await tmdb.find(
          { id: row.imdbId, external_source: "imdb_id" },
          config,
        );
        id = (type === "movie" ? found?.movie_results : found?.tv_results)?.[0]
          ?.id;
      }
      const item = id ? await detail(id) : undefined;
      return item
        ? {
            title: item,
            history: {
              imdb: row.imdbId || "",
              rating: row.rating,
              watchedAt: Number.isFinite(Date.parse(row.watchedAt ?? ""))
                ? Date.parse(row.watchedAt!)
                : undefined,
              plays: 1,
            },
          }
        : undefined;
    })
  ).filter(Boolean);
  const profile = buildProfile(enriched, type, Date.now());
  const day = Math.floor(Date.now() / 86400000);
  const recent = enriched.slice(0, 3)[day % Math.min(3, enriched.length)]
    ?.title;
  const lovedTitles = enriched
    .filter((item) => (item.history.rating ?? 0) >= 9)
    .slice(0, 3);
  const loved = lovedTitles[day % lovedTitles.length]?.title;
  const genres = preferred(profile, "genres");
  const themes = preferred(profile, "keywords");
  const date = type === "movie" ? "primary_release_date" : "first_air_date";
  const excluded: string[] =
    (type === "movie"
      ? settings.excluded_movie_genres
      : settings.excluded_series_genres) ?? [];
  const params: Record<string, string> = {
    include_adult: "false",
    sort_by: "popularity.desc",
    "vote_average.gte": String(threshold.rating),
    "vote_count.gte": String(threshold.min),
    [date + ".lte"]: settings.to_year
      ? settings.to_year + "-12-31"
      : new Date().toISOString().slice(0, 10),
  };
  if ("max" in threshold) params["vote_count.lte"] = String(threshold.max);
  if (settings.from_year) params[date + ".gte"] = settings.from_year + "-01-01";
  if (excluded.length) params.without_genres = excluded.join(",");
  if (settings.excluded_keywords?.length)
    params.without_keywords = settings.excluded_keywords.join(",");
  if (anime) {
    params.with_genres = "16";
    params.with_original_language = "ja";
  }
  const pools = new Map<string, any[]>();
  const names: Record<string, string> = Object.fromEntries(WATCHLY_ROWS);
  const discover = async (row: string, filter: Record<string, string>) => {
    const replies = await batches([1, 2, 3], (page) =>
      (type === "movie" ? tmdb.discoverMovie : tmdb.discoverTv)(
        { ...params, ...filter, page },
        config,
      ),
    );
    pools.set(
      row,
      replies.flatMap((reply: any) => reply?.results ?? []),
    );
  };
  await discover("top", {});
  if (!anime) {
    for (const [ids, prefix, field] of [
      [genres, "genres", "with_genres"],
      [themes, "themes", "with_keywords"],
    ] as const) {
      await batches(ids, async (id) => {
        const index = ids.indexOf(id);
        const row = prefix + (index ? "-" + (index + 1) : "");
        await discover(row, { [field]: id });
        const seed = enriched.find(
          (item) =>
            (prefix === "genres"
              ? item.title.genreNames
              : item.title.keywordNames)?.[id],
        );
        names[row] =
          (prefix === "genres"
            ? seed?.title.genreNames
            : seed?.title.keywordNames)?.[id] || names[row];
      });
    }
    await batches(
      [
        ["watched", recent],
        ["loved", loved],
      ] as const,
      async ([row, seed]) => {
        if (!seed) return;
        names[row] =
          "Because you " +
          (row === "watched" ? "watched " : "loved ") +
          seed.name;
        const replies = await batches([1, 2, 3], (page) =>
          (type === "movie"
            ? tmdb.movieRecommendations
            : tmdb.tvRecommendations)({ id: seed.id, page }, config),
        );
        const direct = replies.flatMap((reply: any) => reply?.results ?? []);
        pools.set(row, direct);
        if (seed.genres.length) {
          await discover(row, { with_genres: seed.genres.join("|") });
          pools.set(row, [...direct, ...pools.get(row)!]);
        }
      },
    );
    const creators = [
      ...preferred(profile, "directors"),
      ...preferred(profile, "cast"),
    ];
    if (creators.length && type === "movie")
      await discover("creators", { with_people: creators.join("|") });
    if (creators.length && type === "series") {
      const credits = await batches(creators, (id) =>
        tmdb.personTvCredits({ id }, config),
      );
      pools.set(
        "creators",
        credits.flatMap((reply: any) => [
          ...(reply?.cast ?? []),
          ...(reply?.crew ?? []),
        ]),
      );
    }
    const favorites = enriched
      .filter((item) => (item.history.rating ?? 0) >= 7)
      .slice(0, 8);
    const favoritesReplies = await batches(favorites, (item) =>
      (type === "movie" ? tmdb.movieRecommendations : tmdb.tvRecommendations)(
        { id: item.title.id },
        config,
      ),
    );
    pools.set(
      "positive",
      favoritesReplies.flatMap((reply: any) => reply?.results ?? []),
    );
  }
  if (anime) {
    await batches(themes.slice(0, 2), (id) =>
      discover("_theme-" + id, { with_keywords: id }),
    );
  } else {
    const country = preferred(profile, "countries")[0];
    const language = preferred(profile, "languages")[0];
    if (country) await discover("_country", { with_origin_country: country });
    if (language)
      await discover("_language", { with_original_language: language });
  }
  pools.set("top", [...pools.values()].flat());
  for (const key of pools.keys()) {
    if (key.startsWith("_")) pools.delete(key);
  }
  const ids = [
    ...new Set(
      [...pools.values()].flatMap((entries) =>
        entries.map((item) => Number(item.id)),
      ),
    ),
  ];
  const titles = new Map(
    await batches(ids, async (id) => [id, await detail(id)] as const),
  );
  const known = await watchedIndex(config, uuid);
  const rows: Record<string, any[]> = {};
  for (const [row, candidates] of pools) {
    const unique = [...new Set(candidates.map((item) => Number(item.id)))];
    const eligible = unique
      .map((id) => titles.get(id))
      .filter(
        (item) =>
          item &&
          !item.adult &&
          item.votes >= threshold.min &&
          item.rating >= threshold.rating &&
          (!("max" in threshold) || item.votes <= Number(threshold.max)) &&
          (!settings.from_year || item.year >= settings.from_year) &&
          (!item.releaseDate || item.releaseDate <= params[date + ".lte"]) &&
          !item.genres.some((id) => excluded.includes(id)) &&
          !item.keywords.some((id) =>
            settings.excluded_keywords?.includes(id),
          ) &&
          (anime
            ? item.genres.includes("16") &&
              (item.language === "ja" || item.countries.includes("JP"))
            : !(
                item.genres.includes("16") &&
                (item.language === "ja" || item.countries.includes("JP"))
              )) &&
          !titleKeys({
            kind: type,
            tmdbType: space,
            tmdbId: item.id,
            imdbId: item.imdb,
            title: item.name,
            year: item.year,
          }).some((key) => known.keys.has(key)),
      );
    const ranked = rank(eligible, profile, type).map(({ title }) => title);
    rows[row] = diversify(ranked, 48).map((item, index) => ({
      tmdbId: item.id,
      tmdbType: space,
      imdbId: item.imdb,
      title: item.name,
      year: item.year,
      kind: type,
      votes: item.votes,
      score: item.rating,
      fit: 100 - index,
    }));
  }
  const result = { rows, names, builtAt: new Date().toISOString() };
  await require("./refresh").bumpRowStamp(viewerKey(config, uuid));
  return result;
}
