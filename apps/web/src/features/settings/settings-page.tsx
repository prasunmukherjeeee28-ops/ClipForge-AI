import { useCallback, useEffect, useState } from "react";
import { HardDrive, ShieldCheck, UserRound, RefreshCw, Video, Scissors } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  getClips,
  getCurrentUser,
  getSourceAssets,
  type CurrentUser,
  type UserClip,
  type UserSourceAsset,
} from "@/lib/api";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function SettingsPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [assets, setAssets] = useState<UserSourceAsset[]>([]);
  const [clips, setClips] = useState<UserClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [nextUser, nextAssets, nextClips] = await Promise.all([
        getCurrentUser(),
        getSourceAssets(),
        getClips(),
      ]);
      setUser(nextUser);
      setAssets(nextAssets);
      setClips(nextClips);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load account settings.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sourceBytes = assets.reduce((total, asset) => total + asset.sizeBytes, 0);
  const outputBytes = clips.reduce((total, clip) => total + (clip.outputSizeBytes ?? 0), 0);
  const sourceQuota = 8 * 1024 * 1024 * 1024;
  const readyAssets = assets.filter((asset) => asset.status === "ready").length;
  const readyClips = clips.filter((clip) => clip.status === "ready").length;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Account & workspace</h1>
          <p className="mt-1 text-sm text-zinc-500">Live account identity, privacy model and storage usage.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void load(true)} disabled={refreshing || loading}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error ? <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p> : null}

      <Card>
        <CardHeader title="Authenticated account" description="Verified through Cloudflare Access" />
        <div className="flex items-start gap-3 border-t hairline px-5 py-4">
          <span className="glass flex h-10 w-10 items-center justify-center rounded-lg"><UserRound className="h-5 w-5 text-violet-350" /></span>
          <div className="min-w-0 flex-1">
            {loading ? <p className="text-sm text-zinc-500">Loading account…</p> : (
              <>
                <p className="break-all text-sm font-medium text-zinc-100">{user?.email ?? "Account unavailable"}</p>
                <p className="mt-1 break-all font-mono text-[11px] text-zinc-600">Account ID: {user?.id ?? "—"}</p>
              </>
            )}
          </div>
          <Badge tone={user ? "green" : "zinc"}>{user ? "Authenticated" : "—"}</Badge>
        </div>
      </Card>

      <Card>
        <CardHeader title="Privacy and ownership" description="How this private two-account workspace is isolated" />
        <div className="space-y-3 px-5 pb-5">
          {[
            ["Separate libraries", "Each account sees only its own jobs, candidates, source files and rendered clips."],
            ["Private media storage", "Source files and rendered MP4s are stored in private R2 objects; downloads require the owning account."],
            ["No social login integration", "ClipForge does not connect to Instagram or publish on your behalf. Download and post from your own account."],
          ].map(([title, description]) => (
            <div key={title} className="flex gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-350" />
              <div><p className="text-[13px] font-medium text-zinc-200">{title}</p><p className="mt-1 text-xs leading-relaxed text-zinc-500">{description}</p></div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Storage usage" description="Current usage reported by your private account records" />
        <div className="space-y-5 border-t hairline px-5 py-4">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-zinc-300"><Video className="h-4 w-4 text-violet-350" /> Source assets</span>
              <span className="font-mono text-xs text-zinc-500">{loading ? "—" : `${formatBytes(sourceBytes)} / 8 GB`}</span>
            </div>
            <Progress value={Math.min(100, (sourceBytes / sourceQuota) * 100)} />
            <p className="mt-1 text-[11px] text-zinc-600">{readyAssets} ready source files · {assets.length} total records</p>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-zinc-300"><Scissors className="h-4 w-4 text-violet-350" /> Rendered MP4s</span>
              <span className="font-mono text-xs text-zinc-500">{loading ? "—" : formatBytes(outputBytes)}</span>
            </div>
            <p className="text-[11px] text-zinc-600">{readyClips} ready clips · {clips.length} total clip records</p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Processing defaults" description="Applied per render job; no global preferences are stored yet" />
        <div className="space-y-3 px-5 pb-5">
          <div className="flex items-center justify-between gap-3 text-sm"><span className="text-zinc-400">Default export</span><Badge tone="violet">9:16 vertical MP4</Badge></div>
          <div className="flex items-center justify-between gap-3 text-sm"><span className="text-zinc-400">Default resolution</span><span className="font-mono text-xs text-zinc-300">1080 × 1920</span></div>
          <div className="flex items-center justify-between gap-3 text-sm"><span className="text-zinc-400">Captions</span><span className="text-xs text-zinc-300">On by default · per render adjustable</span></div>
          <div className="flex items-center justify-between gap-3 text-sm"><span className="text-zinc-400">Moment scoring</span><span className="text-xs text-zinc-300">Local heuristic, human review required</span></div>
        </div>
      </Card>
    </div>
  );
}
