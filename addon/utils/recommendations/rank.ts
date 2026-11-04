import type { TasteProfile } from "./profile";
import { selection, selectionKey, type Pool } from "./watchly";
export type RecommendKind = "movie" | "series" | "anime" | "all";
export function picksKey(
  config: any,
  uuid: string,
  kind: RecommendKind,
): string {
  return selectionKey(
    config,
    uuid,
    kind === "anime" ? "anime" : kind === "all" ? "movie" : kind,
  );
}
export async function recommend(
  config: any,
  uuid: string,
  _profile: TasteProfile,
  kind: RecommendKind,
): Promise<any[]> {
  const pool: Pool =
    kind === "anime" ? "anime" : kind === "all" ? "movie" : kind;
  return (await selection(config, uuid, pool)).rows.top ?? [];
}
module.exports = { recommend, picksKey };
