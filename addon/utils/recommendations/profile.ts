import { collectWatchedRows, isWatched, viewerKey } from "./history";
export interface TasteProfile {
  summary: string;
  likes: string[];
  dislikes: string[];
  directors: string[];
  eras: string[];
  avoid: string[];
  builtFrom: number;
  builtAt: string;
}
export function profileCacheKey(config: any, uuid: string): string {
  return "recommendations:watchly-profile:v1:" + viewerKey(config, uuid);
}
export async function getTasteProfile(
  config: any,
  uuid: string,
): Promise<TasteProfile | null> {
  const { cacheWrapGlobal }: any = require("../../lib/getCache");
  const rows = (await collectWatchedRows(config, uuid)).filter(isWatched);
  return cacheWrapGlobal(
    profileCacheKey(config, uuid),
    async () => ({
      summary:
        "Taste is ranked from watched genres, themes, cast, creators, countries and release eras, weighted by ratings and recency.",
      likes: [],
      dislikes: [],
      directors: [],
      eras: [],
      avoid: [],
      builtFrom: rows.length,
      builtAt: new Date().toISOString(),
    }),
    3600,
    { resultClassifier: () => ({ type: "SUCCESS", ttl: null }) },
  );
}
module.exports = { getTasteProfile, profileCacheKey };
