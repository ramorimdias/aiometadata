import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TmdbKeywordPicker } from "@/components/settings/TmdbKeywordPicker";
import { useConfig } from "@/contexts/ConfigContext";
import type { AppConfig, CatalogConfig } from "@/contexts/config";

const ROWS = [
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
const GENRES: [string, string][] = [
  ["28", "Action"],
  ["12", "Adventure"],
  ["16", "Animation"],
  ["35", "Comedy"],
  ["80", "Crime"],
  ["99", "Documentary"],
  ["18", "Drama"],
  ["10751", "Family"],
  ["14", "Fantasy"],
  ["36", "History"],
  ["27", "Horror"],
  ["10402", "Music"],
  ["9648", "Mystery"],
  ["10749", "Romance"],
  ["878", "Science Fiction"],
  ["53", "Thriller"],
  ["10752", "War"],
  ["37", "Western"],
];
const TV_GENRES: [string, string][] = GENRES.filter(
  ([id]) =>
    ![
      "28",
      "12",
      "14",
      "36",
      "27",
      "10402",
      "10749",
      "878",
      "53",
      "10752",
    ].includes(id),
).concat([
  ["10759", "Action & Adventure"],
  ["10762", "Kids"],
  ["10763", "News"],
  ["10764", "Reality"],
  ["10765", "Sci-Fi & Fantasy"],
  ["10766", "Soap"],
  ["10767", "Talk"],
  ["10768", "War & Politics"],
]);
function catalogId(type: string, row: string) {
  return row === "top"
    ? "recommendations." + (type === "movie" ? "movies" : "series")
    : "recommendations." + type + "." + row;
}
export function RecommendationsIntegration({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { config, setConfig, auth } = useConfig();
  const [viewer, setViewer] = useState("");
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [working, setWorking] = useState<string>();
  const [message, setMessage] = useState("");
  const settings = config.recommendations ?? {};
  const patch = (fields: Partial<NonNullable<AppConfig["recommendations"]>>) =>
    setConfig((prev) => ({
      ...prev,
      recommendations: { ...prev.recommendations, ...fields },
    }));
  useEffect(() => {
    if (!isOpen || !auth.userUUID) return;
    const controller = new AbortController();
    fetch(
      "/api/recommendations/status?userUUID=" +
        encodeURIComponent(auth.userUUID),
      {
        headers: auth.password
          ? { "x-config-password": auth.password }
          : undefined,
        signal: controller.signal,
      },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setProfiles(data.profiles ?? []);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [isOpen, auth.userUUID, auth.password]);
  useEffect(() => {
    if (!working || !auth.userUUID) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(
          "/api/recommendations/jobs?userUUID=" +
            encodeURIComponent(auth.userUUID!) +
            (viewer ? "&profile=" + encodeURIComponent(viewer) : ""),
          {
            headers: auth.password
              ? { "x-config-password": auth.password }
              : undefined,
          },
        );
        if (!response.ok) return;
        const data = await response.json();
        const ids: string[] = JSON.parse(working);
        const jobs = ids.map((id) =>
          data.jobs?.find((entry: any) => entry.catalogId === id),
        );
        if (cancelled || jobs.some((job) => !job)) return;
        const failed = jobs.find((job) => job.stage === "error");
        const complete = jobs.every(
          (job) => job.stage === "done" || job.stage === "error",
        );
        setMessage(
          failed?.error ||
            (complete
              ? jobs.reduce((count, job) => count + job.picks, 0) +
                " picks ready across your enabled pools."
              : "Refreshing " +
                jobs.filter((job) => job.stage !== "done").length +
                " pools�"),
        );
        if (complete) setWorking(undefined);
      } catch {
        /* A transient polling error leaves the current job visible. */
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [working, viewer, auth.userUUID, auth.password]);
  const toggle = (
    id: string,
    name: string,
    type: CatalogConfig["type"],
    enabled: boolean,
  ) =>
    setConfig((prev) => ({
      ...prev,
      catalogs: prev.catalogs.some((c) => c.id === id)
        ? prev.catalogs.map((c) => (c.id === id ? { ...c, enabled } : c))
        : [
            ...prev.catalogs,
            {
              id,
              name,
              type,
              enabled,
              showInHome: true,
              source: "recommendations",
            } as CatalogConfig,
          ],
    }));
  const generate = async () => {
    if (!auth.userUUID) return;
    const pools = new Map<string, string>();
    for (const catalog of config.catalogs) {
      if (!catalog.enabled || !catalog.id.startsWith("recommendations."))
        continue;
      const pool = catalog.id.startsWith("recommendations.anime")
        ? catalog.id
        : catalog.type;
      if (!pools.has(pool)) pools.set(pool, catalog.id);
    }
    const ids = [...pools.values()];
    if (!ids.length) {
      toast.info("Enable at least one recommendation row first.");
      return;
    }
    setWorking(JSON.stringify(ids));
    setMessage("Starting refresh…");
    try {
      for (const id of ids) {
        const response = await fetch("/api/recommendations/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userUUID: auth.userUUID,
            password: auth.password,
            catalogId: id,
            recommendations: settings,
            profile: viewer,
            force: true,
          }),
        });
        if (!response.ok)
          throw new Error(
            "Could not start refresh. Sign in to your saved configuration.",
          );
      }
    } catch (error) {
      setWorking(undefined);
      toast.error(String(error));
    }
  };
  const source = viewer
    ? (settings.profiles?.[viewer]?.sources ?? "same")
    : (settings.sources ?? "both");
  const sourceChange = (value: string) => {
    if (viewer)
      patch({
        profiles: {
          ...settings.profiles,
          [viewer]: { sources: value as "same" },
        },
      });
    else patch({ sources: value as "both" });
  };
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Personalized recommendations</DialogTitle>
          <DialogDescription>
            Watchly-style recommendations from watch history, ratings and TMDB.
            Save your configuration to publish changes.
          </DialogDescription>
        </DialogHeader>
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-semibold">History for each viewer</h3>
          <Label htmlFor="recommendation-viewer">Viewer</Label>
          <select
            id="recommendation-viewer"
            value={viewer}
            disabled={!!working}
            onChange={(e) => setViewer(e.target.value)}
            className="w-full rounded-md border bg-background p-2"
          >
            <option value="">Main profile</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Label htmlFor="recommendation-source">History source</Label>
          <select
            id="recommendation-source"
            value={source}
            onChange={(e) => sourceChange(e.target.value)}
            className="w-full rounded-md border bg-background p-2"
          >
            {viewer && (
              <option value="same">Use the main source preference</option>
            )}
            <option value="both">All connected sources</option>
            <option value="simkl">Simkl</option>
            <option value="mdblist">MDBList</option>
            <option value="local">Jellyfin history</option>
          </select>
          <p className="text-sm text-muted-foreground">
            Each viewer uses their own linked history. Manage their tracker
            connections in Jellyfin profiles.
          </p>
          <Button
            disabled={!!working || !auth.userUUID}
            onClick={() => void generate()}
          >
            Refresh recommendations
          </Button>
          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}
        </section>
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-semibold">Recommendation rows</h3>
          <p className="text-sm text-muted-foreground">
            Row switches are shared by this configuration. Titles and picks are
            personalized for each viewer.
          </p>
          {config.catalogs.some(
            (catalog) => catalog.id === "recommendations.anime",
          ) && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">
                Anime For You (combined legacy row)
              </span>
              <Switch
                aria-label="Combined anime row"
                checked={
                  config.catalogs.find(
                    (catalog) => catalog.id === "recommendations.anime",
                  )?.enabled === true
                }
                onCheckedChange={(enabled) =>
                  toggle(
                    "recommendations.anime",
                    "Anime For You",
                    "anime",
                    enabled,
                  )
                }
              />
            </div>
          )}
          <div className="grid grid-cols-[1fr_4rem_4rem] gap-3 text-sm">
            <span>Catalog</span>
            <span>Movies</span>
            <span>Series</span>
            {[...ROWS, ["anime", "Top Picks for You (Anime)"]].map(
              ([row, name]) => (
                <div key={row} className="contents">
                  <span>{name}</span>
                  {(["movie", "series"] as const).map((type) => {
                    const id =
                      row === "anime"
                        ? "recommendations.anime-" +
                          (type === "movie" ? "movies" : "series")
                        : catalogId(type, row);
                    const enabled =
                      config.catalogs.find((c) => c.id === id)?.enabled ===
                      true;
                    return (
                      <Switch
                        key={id}
                        aria-label={name + " " + type}
                        checked={enabled}
                        onCheckedChange={(value) =>
                          toggle(id, name, type, value)
                        }
                      />
                    );
                  })}
                </div>
              ),
            )}
          </div>
        </section>
        <section className="space-y-4 rounded-xl border p-4">
          <h3 className="font-semibold">
            Discovery preferences for all viewers
          </h3>
          <Label htmlFor="recommendation-style">Discovery style</Label>
          <select
            id="recommendation-style"
            value={settings.discovery_style ?? "balanced"}
            onChange={(e) =>
              patch({ discovery_style: e.target.value as "balanced" })
            }
            className="w-full rounded-md border bg-background p-2"
          >
            <option value="mainstream">Mainstream</option>
            <option value="balanced">Balanced</option>
            <option value="gems">Hidden gems</option>
            <option value="all">All</option>
          </select>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="recommendation-from">Earliest year</Label>
              <Input
                id="recommendation-from"
                type="number"
                min={1870}
                max={new Date().getFullYear()}
                value={settings.from_year ?? ""}
                onChange={(e) =>
                  patch({
                    from_year: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
              />
            </div>
            <div>
              <Label htmlFor="recommendation-to">Latest year</Label>
              <Input
                id="recommendation-to"
                type="number"
                min={settings.from_year ?? 1870}
                placeholder="Now"
                value={settings.to_year ?? ""}
                onChange={(e) =>
                  patch({
                    to_year: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
              />
            </div>
          </div>
          <Label htmlFor="recommendation-refresh">
            Refresh interval in hours
          </Label>
          <Input
            id="recommendation-refresh"
            type="number"
            min={1}
            max={24}
            value={settings.refresh_hours ?? 6}
            onChange={(e) =>
              patch({
                refresh_hours: Math.max(
                  1,
                  Math.min(24, Number(e.target.value) || 6),
                ),
              })
            }
          />
          <p className="text-sm text-muted-foreground">
            Watched and loved seeds rotate daily. Catalog names follow the
            current selection.
          </p>
          {(
            [
              ["excluded_movie_genres", "Exclude movie genres", GENRES],
              ["excluded_series_genres", "Exclude series genres", TV_GENRES],
            ] as const
          ).map(([field, label, genres]) => (
            <fieldset key={field} className="space-y-2">
              <legend className="text-sm font-medium">{label}</legend>
              <div className="flex flex-wrap gap-2">
                {genres.map(([id, name]) => {
                  const selected = settings[field]?.includes(id) ?? false;
                  return (
                    <Button
                      key={id}
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      aria-pressed={selected}
                      onClick={() =>
                        patch({
                          [field]: selected
                            ? settings[field]!.filter((value) => value !== id)
                            : [...(settings[field] ?? []), id],
                        })
                      }
                    >
                      {name}
                    </Button>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <p className="text-sm text-muted-foreground">
            Excluding Animation also excludes Anime Top Picks for that media
            type.
          </p>
          <Label>Excluded keywords</Label>
          <TmdbKeywordPicker
            value={settings.excluded_keywords ?? []}
            onChange={(value) => patch({ excluded_keywords: value })}
          />
        </section>
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}
