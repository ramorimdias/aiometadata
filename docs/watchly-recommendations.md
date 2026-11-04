# Watchly-style recommendations

Open Catalogs and select Recommendations to choose rows. Save the configuration to publish changes. Existing Films For You, Series For You, and combined Anime For You installs keep their catalog IDs.

The engine builds a taste profile from the selected viewer's watch history and ratings. It ranks TMDB candidates by genres, themes, cast, directors, release eras, countries, quality and recency. Rows include Top Picks, Because You Watched, Because You Loved, three genre slots, three theme slots, favorite creators and liked titles. Separate anime movie and series rows are available. The combined anime row remains available for existing installs.

Each profile uses AIOMetadata's existing history and account scoping. Tracker credentials and playback reporting use the native implementation. Recommendation discovery preferences and row switches are shared by the configuration. The viewer selector changes the history source preference and the target of a manual refresh.

Discovery settings include style, release years, excluded movie and series genres, keyword exclusions and refresh hours. Animation exclusions also apply to anime rows. New configurations use a six-hour refresh interval. Watched and loved seed titles rotate daily through up to three recent choices. The full watched index excludes titles already seen. Candidate discovery expands across pages and related genres to fill sparse rows.

Selections are cached per viewer, media pool, source and settings. Active viewers refresh before the selection expires. A failed refresh reuses the last successful selection for up to seven days. Per-title TMDB metadata uses the existing shared cache.

Dynamic names are published in the Stremio manifest under stable catalog IDs. Official AIOStreams reads these names when it fetches the manifest again. Its manifest cache can delay a changed name, and a manually assigned catalog name overrides the upstream name. The deployed official instance currently uses a five-minute manifest cache.

Run the backend build, frontend type check, focused tests and frontend build before deployment.

```sh
npm run build:backend
npx tsc -p tsconfig.app.json --noEmit
node --test scripts/test-watchly.cjs
npm run build
```

The ranking port includes Watchly's license beside its source.
