const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const root = path.resolve(__dirname, "../dist/server");
const stub = (file, exports) => {
  require.cache[require.resolve(path.join(root, file))] = {
    id: file,
    filename: file,
    loaded: true,
    exports,
  };
};
const snapshots = new Map();
const cacheTtls = new Map();
let force = false;
let fail = false;
stub("lib/getCache.js", {
  cacheWrapGlobal: async (key, build, ttl) => {
    cacheTtls.set(key, ttl);
    if (!force && snapshots.has(key)) return snapshots.get(key);
    const value = await build();
    snapshots.set(key, value);
    return value;
  },
  readGlobalCache: async (key) => snapshots.get(key),
  writeGlobalCache: async (key, value) => snapshots.set(key, value),
});
stub("utils/recommendations/refresh.js", {
  bumpRowStamp: async () => undefined,
});
stub("utils/recommendations/provider.js", {
  refreshTtl: (config) => (config.recommendations?.refresh_hours ?? 6) * 3600,
  resolveProvider: (config) => config.testProvider,
});
const histories = {
  alice: [
    {
      key: "tt1",
      imdbId: "tt1",
      tmdbId: 1,
      title: "Alice seed",
      kind: "movie",
      tmdbType: "movie",
      status: "completed",
      rating: 10,
      watchedAt: new Date().toISOString(),
    },
  ],
  bob: [
    {
      key: "tt2",
      imdbId: "tt2",
      tmdbId: 2,
      title: "Bob seed",
      kind: "movie",
      tmdbType: "movie",
      status: "completed",
      rating: 10,
      watchedAt: new Date().toISOString(),
    },
  ],
};
stub("utils/recommendations/history.js", {
  collectWatchedRows: async (config) => histories[config.profile] ?? [],
  isWatched: (row) => row.status !== "plantowatch",
  rowKind: (row) => row.kind,
  viewerKey: (config, uuid) => uuid + "#" + config.profile,
  watchedIndex: async (config) => ({
    keys: new Set(
      (histories[config.profile] ?? []).map((row) => "imdb:" + row.imdbId),
    ),
  }),
  resolveSources: () => ({ choice: "simkl" }),
  titleKeys: (item) => ["imdb:" + item.imdbId],
});
const detail = (id, anime = false) => ({
  id,
  title: id === 1 ? "Alice seed" : id === 2 ? "Bob seed" : "Pick " + id,
  imdb_id: "tt" + id,
  vote_count: 3000,
  vote_average: 8,
  popularity: 100,
  release_date: "2020-01-01",
  genres: [{ id: anime ? 16 : 18, name: anime ? "Animation" : "Drama" }],
  original_language: anime ? "ja" : "en",
  origin_country: [anime ? "JP" : "US"],
  keywords: { keywords: [{ id: 20, name: "Friendship" }] },
  credits: { cast: [], crew: [] },
});
const animeIds = new Set([100, 101, 102]);
stub("lib/getTmdb.js", {
  movieInfo: async ({ id }) => {
    if (fail) throw new Error("TMDB unavailable");
    return detail(id, animeIds.has(id));
  },
  tvInfo: async ({ id }) => detail(id, animeIds.has(id)),
  movieRecommendations: async () => ({
    results: [1, 2, 3, 4].map((id) => detail(id)),
  }),
  tvRecommendations: async () => ({ results: [] }),
  discoverMovie: async (params) => ({
    results: (params.with_genres === "16" ? [100, 101, 102] : [1, 2, 3, 4]).map(
      (id) => detail(id, animeIds.has(id)),
    ),
  }),
  discoverTv: async () => ({
    results: [100, 101, 102].map((id) => detail(id, true)),
  }),
});
const { selection, selectionKey } = require(
  path.join(root, "utils/recommendations/watchly.js"),
);

test("Watchly rows preserve viewer isolation, dynamic seed names, watched exclusion and anime fallback", async () => {
  const config = (profile) => ({ profile, recommendations: {} });
  const a = await selection(config("alice"), "same-owner", "movie");
  const b = await selection(config("bob"), "same-owner", "movie");
  assert.equal(a.names.watched, "Because you watched Alice seed");
  assert.equal(b.names.watched, "Because you watched Bob seed");
  assert.equal(a.names.genres, "Drama");
  assert.equal(a.names.themes, "Friendship");
  assert.ok(a.rows.top.every((pick) => pick.imdbId !== "tt1"));
  assert.ok(b.rows.top.every((pick) => pick.imdbId !== "tt2"));
  assert.ok(a.rows.top.length > 0);
  assert.notEqual(
    selectionKey(config("alice"), "same-owner", "movie"),
    selectionKey(config("bob"), "same-owner", "movie"),
  );
  const anime = await selection(
    config("new-user"),
    "same-owner",
    "anime-movie",
  );
  assert.equal(anime.rows.top.length, 3);
  const combined = await selection(config("new-user"), "same-owner", "anime");
  assert.equal(combined.names.top, "Anime For You");
  assert.ok(combined.rows.top.some((pick) => pick.kind === "movie"));
  assert.ok(combined.rows.top.some((pick) => pick.kind === "series"));
  assert.ok(combined.rows.top.every((pick) => animeIds.has(pick.tmdbId)));
  const excluded = await selection(
    { profile: "new-user", recommendations: { excluded_movie_genres: ["16"] } },
    "same-owner",
    "anime-movie",
  );
  assert.equal(excluded.rows.top.length, 0);
  const years = await selection(
    { profile: "alice", recommendations: { from_year: 2025 } },
    "same-owner",
    "movie",
  );
  assert.equal(years.rows.top.length, 0);
  const keywords = await selection(
    { profile: "alice", recommendations: { excluded_keywords: ["20"] } },
    "same-owner",
    "movie",
  );
  assert.equal(keywords.rows.top.length, 0);
  fail = true;
  force = true;
  assert.deepEqual(await selection(config("alice"), "same-owner", "movie"), a);
});

const fixture = require("../addon/utils/recommendations/fixtures/watchly.json");
const ranking = require(
  path.join(root, "utils/recommendations/watchly-ranking.js"),
);
test("ranking reproduces the Watchly reference fixture", () => {
  const profile = ranking.buildProfile(
    fixture.history.map((history, index) => ({
      history,
      title: fixture.titles[index],
    })),
    "movie",
    fixture.now,
  );
  const ranked = ranking.rank(fixture.candidates, profile, "movie");
  assert.deepEqual(
    ranked.map(({ title }) => title.id),
    fixture.order,
  );
  for (const result of ranked)
    assert.ok(
      Math.abs(
        result.score - fixture.scores[fixture.candidates.indexOf(result.title)],
      ) < 1e-9,
    );
});
test("watched rotates every twelve hours while loved keeps its daily rotation", async (t) => {
  fail = false;
  force = true;
  histories.rotation = [histories.alice[0], histories.bob[0]];
  let now = 20000 * 86400000;
  t.mock.method(Date, "now", () => now);
  const config = {
    profile: "rotation",
    recommendations: { refresh_hours: 24 },
  };
  const { selectionKey } = require(
    path.join(root, "utils/recommendations/watchly.js"),
  );
  const key = selectionKey(config, "rotation-owner", "movie");
  const first = await selection(config, "rotation-owner", "movie");
  assert.equal(cacheTtls.get(key), 43200);
  now += 43200000 - 1000;
  const beforeBoundary = await selection(config, "rotation-owner", "movie");
  assert.equal(beforeBoundary.names.watched, first.names.watched);
  assert.equal(cacheTtls.get(key), 1);
  now += 1000;
  const next = await selection(config, "rotation-owner", "movie");
  assert.notEqual(first.names.watched, next.names.watched);
  assert.equal(first.names.loved, next.names.loved);
  now += 43200000;
  const tomorrow = await selection(config, "rotation-owner", "movie");
  assert.notEqual(first.names.loved, tomorrow.names.loved);
});

test("watched rotates across ten latest completed titles and excludes other states", async (t) => {
  fail = false;
  force = true;
  const day = 21000 * 86400000;
  let now = day;
  t.mock.method(Date, "now", () => now);
  const make = (id, status, age) => ({
    key: "tt" + id,
    imdbId: "tt" + id,
    tmdbId: id,
    title: "Pick " + id,
    kind: "movie",
    tmdbType: "movie",
    status,
    watchedAt: new Date(day - age * 86400000).toISOString(),
  });
  histories.tenCompleted = [
    ...Array.from({ length: 12 }, (_, i) =>
      make(10 + i, "completed", i + 1),
    ).reverse(),
    ...["watching", "hold", "dropped", "plantowatch"].map((status, i) =>
      make(40 + i, status, 0),
    ),
  ];
  const config = { profile: "tenCompleted", recommendations: {} };
  const names = [];
  for (let i = 0; i < 10; i++) {
    now = day + i * 43200000;
    const result = await selection(config, "completed-owner", "movie");
    names.push(result.names.watched);
  }
  assert.equal(new Set(names).size, 10);
  assert.deepEqual(
    new Set(names),
    new Set(
      Array.from(
        { length: 10 },
        (_, i) => "Because you watched Pick " + (10 + i),
      ),
    ),
  );
  now = day + 10 * 43200000;
  assert.equal(
    (await selection(config, "completed-owner", "movie")).names.watched,
    names[0],
  );
  histories.noCompleted = [make(50, "watching", 0), make(51, "dropped", 1)];
  const empty = await selection(
    { profile: "noCompleted", recommendations: {} },
    "completed-owner",
    "movie",
  );
  assert.equal(empty.names.watched, "Because You Watched");
  assert.equal(empty.rows.watched, undefined);
  histories.oneCompleted = [make(60, "completed", 2), make(61, "watching", 0)];
  assert.equal(
    (
      await selection(
        { profile: "oneCompleted", recommendations: {} },
        "completed-owner",
        "movie",
      )
    ).names.watched,
    "Because you watched Pick 60",
  );
});

test("AI naming uses the configured model, caches labels and only renames genre and theme shelves", async () => {
  force = false;
  let calls = 0;
  stub("utils/gemini-client.js", {
    generateContent: async (options) => {
      calls++;
      assert.equal(options.model, "configured-model");
      assert.equal(options.useGrounding, false);
      assert.equal(options.maxTokens, 2048);
      const input = JSON.parse(options.prompt);
      assert.ok(
        input.rows.every((row) => /^(genres|themes)(-[23])?$/.test(row.id)),
      );
      return {
        text: JSON.stringify({
          genres: "Drama",
          themes: "Based on Books",
          watched: "Invented viewing",
          top: "Invented top heading",
          creators: "Invented creator heading",
          positive: "Invented rating heading",
          "genres-2": "Action",
          "themes-3": "Book Adaptations",
        }),
      };
    },
  });
  const { nameCatalogs, parseCatalogNames } = require(
    path.join(root, "utils/recommendations/names.js"),
  );
  const config = {
    profile: "naming",
    recommendations: { ai_names: true },
    testProvider: {
      provider: "gemini",
      apiKey: "test-key",
      model: "configured-model",
      clientPath: "../gemini-client",
    },
  };
  const defaults = {
    genres: "Drama",
    themes: "based on novel or book",
    watched: "Because you watched Alice seed",
    top: "Top Picks for You",
    creators: "From Your Favorite Creators",
    positive: "Based on What You Loved/Liked",
    "genres-2": "Drama",
    "themes-3": "novel",
  };
  const rows = {
    genres: [{ title: "Drama example" }],
    themes: [{ title: "Book adaptation" }],
    watched: [{ title: "Seed pick" }],
    top: [{ title: "Top pick" }],
    creators: [{ title: "Creator pick" }],
    positive: [{ title: "Rated pick" }],
    "genres-2": [{ title: "Drama pick" }],
    "themes-3": [{ title: "Book pick" }],
  };
  const named = await nameCatalogs(config, "owner", "series", defaults, rows);
  assert.equal(named.genres, "Drama");
  assert.equal(named.themes, "Based on Books");
  assert.equal(named.watched, defaults.watched);
  for (const id of ["top", "creators", "positive"])
    assert.equal(named[id], defaults[id]);
  assert.equal(named["genres-2"], "Action");
  assert.equal(named["themes-3"], "Book Adaptations");
  assert.deepEqual(
    await nameCatalogs(
      config,
      "owner",
      "anime-movie",
      { top: "Top Picks for You (Anime)" },
      { top: [{ title: "Anime pick" }] },
    ),
    { top: "Top Picks for You (Anime)" },
  );
  assert.deepEqual(
    await nameCatalogs(config, "owner", "series", defaults, rows),
    named,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    parseCatalogNames('{"genres":"<b>Drama</b>","themes":"Favorite Theme 1"}', [
      { id: "genres", topic: "Drama", titles: [] },
      { id: "themes", topic: "Novel", titles: [] },
    ]),
    {},
  );
  assert.deepEqual(
    await nameCatalogs(
      { ...config, recommendations: { ai_names: false } },
      "owner",
      "series",
      defaults,
      rows,
    ),
    defaults,
  );
  assert.equal(calls, 1);
  stub("utils/gemini-client.js", {
    generateContent: async () => {
      throw new Error("Provider unavailable");
    },
  });
  assert.deepEqual(
    await nameCatalogs(
      { ...config, language: "fr-FR" },
      "owner",
      "series",
      defaults,
      rows,
    ),
    defaults,
  );
});

test("saving catalogs preserves omitted AI naming and respects explicit disabling", () => {
  const { preserveAiNaming } = require(
    path.join(root, "utils/recommendations/settings.js"),
  );
  const previous = { recommendations: { ai_names: true } };
  const saved = preserveAiNaming(
    {
      catalogs: [{ id: "recommendations.series.themes-2", enabled: true }],
      recommendations: { refresh_hours: 12 },
    },
    previous,
  );
  assert.equal(saved.recommendations.ai_names, true);
  assert.equal(saved.recommendations.refresh_hours, 12);
  assert.equal(saved.catalogs[0].enabled, true);
  assert.equal(
    preserveAiNaming({ recommendations: { ai_names: false } }, previous)
      .recommendations.ai_names,
    false,
  );
  assert.equal(preserveAiNaming({}, previous).recommendations.ai_names, true);
  assert.equal(preserveAiNaming({}, {}).recommendations, undefined);
  assert.equal(
    preserveAiNaming(
      { recommendations: { ai_names: true } },
      { recommendations: { ai_names: false } },
    ).recommendations.ai_names,
    true,
  );
});

test("anime watched catalogs use completed anime seeds, keep media types and publish dynamic names", async () => {
  fail = false;
  force = true;
  histories.animeMovie = [
    {
      ...histories.alice[0],
      key: "tt100",
      imdbId: "tt100",
      tmdbId: 100,
      kind: "anime",
      status: "completed",
    },
    {
      ...histories.bob[0],
      key: "tt101",
      imdbId: "tt101",
      tmdbId: 101,
      kind: "anime",
      status: "watching",
    },
    histories.alice[0],
  ];
  histories.animeSeries = histories.animeMovie.map((x) => ({
    ...x,
    tmdbType: "tv",
  }));
  const { RECOMMENDATION_CATALOGS, recommendationName } = require(
    path.join(root, "utils/recommendations/catalog.js"),
  );
  for (const [profile, pool, type, id] of [
    [
      "animeMovie",
      "anime-movie",
      "movie",
      "recommendations.anime-movies.watched",
    ],
    [
      "animeSeries",
      "anime-series",
      "series",
      "recommendations.anime-series.watched",
    ],
  ]) {
    const config = { profile, recommendations: {} };
    const entry = RECOMMENDATION_CATALOGS.find((x) => x.id === id);
    assert.equal(entry.type, type);
    assert.equal(entry.pool, pool);
    const result = await selection(config, "anime-owner", pool);
    assert.equal(result.names.watched, "Because you watched Pick 100 (Anime)");
    assert.ok(result.rows.watched.length > 0);
    assert.ok(
      result.rows.watched.every(
        (x) =>
          x.kind === type &&
          animeIds.has(x.tmdbId) &&
          x.tmdbId !== 100 &&
          x.tmdbId !== 101,
      ),
    );
    assert.equal(
      await recommendationName(id, config, "anime-owner"),
      result.names.watched,
    );
  }
  const empty = await selection(
    { profile: "new-user", recommendations: {} },
    "anime-owner",
    "anime-series",
  );
  assert.equal(empty.rows.watched, undefined);
});
