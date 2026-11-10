import { useState } from 'react';
import { CheckCircle, Loader2, Settings2 } from 'lucide-react';
import { Callout } from '@/components/settings/Callout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfig } from '@/contexts/ConfigContext';
import type { AppConfig } from '@/contexts/config';

const emptyCrosswatch = { url: '', token: '', viewers: {} };
type CrosswatchSettings = NonNullable<AppConfig['crosswatch']>;

export function CrosswatchSettingsDialog() {
  const { auth, config, setConfig } = useConfig();
  const connection = config.crosswatch ?? emptyCrosswatch;
  const onChange = (crosswatch: CrosswatchSettings) => setConfig((previous) => ({ ...previous, crosswatch }));
  const [viewerId, setViewerId] = useState('');
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{
    connection: CrosswatchSettings;
    error?: string;
    viewers?: { id: string; status: string }[];
  }>();
  const viewers = [
    { id: '', name: 'Main viewer' },
    ...(config.jellyfinUsers ?? []),
  ];
  const checkConnection = async () => {
    if (!auth.userUUID) return;
    setChecking(true);
    setCheck(undefined);
    try {
      const response = await fetch(`/api/config/crosswatch/check/${encodeURIComponent(auth.userUUID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: auth.password,
          crosswatch: connection,
          viewerIds: viewers.slice(1).map(({ id }) => id),
        }),
        signal: AbortSignal.timeout(35_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not check CrossWatch.');
      setCheck({ connection, viewers: data.viewers });
    } catch (error) {
      setCheck({ connection, error: error instanceof Error ? error.message : 'Could not check CrossWatch.' });
    } finally {
      setChecking(false);
    }
  };
  const currentCheck = check?.connection === connection ? check : undefined;
  const viewer = viewers.find(({ id }) => id === viewerId) ?? viewers[0];
  const mapping = connection.viewers?.[viewer.id];
  const viewerResult = currentCheck?.viewers?.find(({ id }) => id === viewer.id);
  const trackerIds = viewers.map(({ id }) => connection.viewers?.[id]?.instance?.trim().toLowerCase()).filter(Boolean);
  const hasDuplicateTracker = new Set(trackerIds).size !== trackerIds.length;
  const setMapping = (id: string, field: 'profile' | 'instance' | 'removalPair', value: string) => {
    onChange({
      ...connection,
      viewers: {
        ...connection.viewers,
        [id]: { profile: '', instance: '', ...connection.viewers?.[id], [field]: value },
      },
    });
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9" title="CrossWatch settings" aria-label="CrossWatch settings">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>CrossWatch Watch Tracking</DialogTitle>
          <DialogDescription>Connect your server and choose where each viewer’s playback is tracked.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {([['movie', 'Movie'], ['series', 'TV Show']] as const).map(([type, label]) => {
            const id = `crosswatch-${type}-watch-tracking`;
            return (
              <div key={type} className="flex items-center justify-between gap-4 rounded-lg border border-white/[0.08] p-3">
                <div className="min-w-0">
                  <Label htmlFor={id} className="font-medium">Sync {label} Watch History</Label>
                  <p className="text-sm text-muted-foreground">Send {type === 'movie' ? 'movie' : 'TV show'} playback to CrossWatch.</p>
                </div>
                <Switch id={id} className="shrink-0" checked={config.crosswatchMediaTypes?.[type] !== false}
                  onCheckedChange={(checked) => setConfig((previous) => ({
                    ...previous,
                    crosswatchMediaTypes: { ...previous.crosswatchMediaTypes, [type]: checked },
                  }))} />
              </div>
            );
          })}
        </div>

        <div className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-semibold">Connection</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="crosswatch-url">Server URL</Label>
              <Input id="crosswatch-url" type="url" placeholder="https://crosswatch.example.com"
                value={connection.url} onChange={(event) => onChange({ ...connection, url: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crosswatch-token">API token</Label>
              <Input id="crosswatch-token" type="password" autoComplete="off"
                value={connection.token} onChange={(event) => onChange({ ...connection, token: event.target.value })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button type="button" variant="outline" size="sm" onClick={checkConnection}
              disabled={checking || !auth.userUUID || !connection.url?.trim() || !connection.token?.trim()}>
              {checking ? <Loader2 className="animate-spin" aria-hidden="true" />
                : <CheckCircle className="text-muted-foreground" aria-hidden="true" />}
              {checking ? 'Testing connection…' : 'Test connection'}
            </Button>
            {currentCheck?.viewers && (
              <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle className="size-4 text-green-500" aria-hidden="true" />
                Connected to CrossWatch
              </span>
            )}
          </div>
          {currentCheck?.error && <p role="alert" className="text-xs text-destructive">{currentCheck.error}</p>}
          {!auth.userUUID && (
            <p className="text-xs text-muted-foreground">Save and sign in to test the connection.</p>
          )}
        </div>

        <div className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-semibold">Viewer mapping</h3>
          {viewers.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="crosswatch-viewer">Viewer</Label>
              <Select value={`viewer:${viewer.id}`} onValueChange={(value) => setViewerId(value.slice('viewer:'.length))}>
                <SelectTrigger id="crosswatch-viewer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {viewers.map(({ id, name }) => (
                    <SelectItem key={id} value={`viewer:${id}`}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Use the local tracker assigned to the CrossWatch profile. Give each viewer a distinct tracker.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="crosswatch-profile">Profile ID</Label>
              <Input id="crosswatch-profile" value={mapping?.profile ?? ''}
                onChange={(event) => setMapping(viewer.id, 'profile', event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crosswatch-instance">Local tracker ID</Label>
              <Input id="crosswatch-instance" value={mapping?.instance ?? ''}
                onChange={(event) => setMapping(viewer.id, 'instance', event.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="crosswatch-removal-pair">Removal pair ID <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="crosswatch-removal-pair" value={mapping?.removalPair ?? ''} aria-describedby="crosswatch-removal-help"
              onChange={(event) => setMapping(viewer.id, 'removalPair', event.target.value)} />
            <p id="crosswatch-removal-help" className="text-xs text-muted-foreground">Syncs Jellyfin’s Mark as unwatched action to CrossWatch.</p>
          </div>
          {viewerResult && <p role="status" className="text-sm text-muted-foreground">{viewerResult.status}</p>}
        </div>

        {hasDuplicateTracker && (
          <div role="alert"><Callout variant="warn">Viewers sharing a local tracker ID will be skipped. Enter a different ID for each viewer.</Callout></div>
        )}
        <p className="text-xs text-muted-foreground">Use Save on the setup page to keep your changes.</p>
        <DialogFooter>
          <DialogClose asChild><Button type="button">Done</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
