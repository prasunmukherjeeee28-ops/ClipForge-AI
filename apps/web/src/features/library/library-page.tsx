import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Browser } from "@capacitor/browser";
import { isNativePlatform } from "@/lib/platform";
import {
  LayoutGrid,
  List,
  Search,
  Download,
  Scissors,
  Play,
  RefreshCw,
  Loader2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  cancelSourceJob,
  getClipDownloadUrl,
  getClipPreviewUrl,
  createClipMediaUrls,
  getClips,
  getJobs,
  type ClipRecord,
  type JobRecord,
} from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/utils";

type View = "grid" | "list";
type Filter = "all" | "recent";

const statusTone: Record<JobRecord["status"], "violet" | "green" | "amber" | "zinc" | "red"> = {
  queued: "zinc",
  processing: "amber",
  review: "violet",
  completed: "green",
  failed: "red",
  cancelled: "zinc",
};

function stageLabel(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\\b\\w/g, (letter) => letter.toUpperCase());
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function ClipCard({
  clip,
  view,
  onPreview,
  onDownload,
}: {
  clip: ClipRecord;
  view: View;
  onPreview: (clip: ClipRecord) => void;
  onDownload: (clip: ClipRecord) => void;
}) {
  const downloadUrl = getClipDownloadUrl(clip.id);
  const download = isNativePlatform() ? (
    <Button size="sm" variant="secondary" onClick={() => onDownload(clip)}>
      <Download className="h-4 w-4" /> Download
    </Button>
  ) : (
    <a
      href={downloadUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`Download ${clip.title}`}
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-xs font-medium text-zinc-200 transition hover:bg-white/[0.1]"
    >
      <Download className="h-4 w-4" /> Download
    </a>
  );

  if (view === "list") {
    return (
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => onPreview(clip)}
          aria-label={`Preview ${clip.title}`}
          className="relative flex aspect-[9/16] w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black text-zinc-300"
        >
          <Play className="h-5 w-5" />
          <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 font-mono text-[10px]">{formatDuration(clip.durationSeconds)}</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-100">{clip.title}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {formatDuration(clip.durationSeconds)} · 9:16 · {formatBytes(clip.sizeBytes)}
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">{formatCreatedAt(clip.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="green">Ready</Badge>
          <Button size="sm" variant="ghost" onClick={() => onPreview(clip)}>
            <Play className="h-4 w-4" /> Preview
          </Button>
          {download}
        </div>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden p-3">
      <button
        type="button"
        onClick={() => onPreview(clip)}
        aria-label={`Preview ${clip.title}`}
        className="group relative flex aspect-[9/16] w-full items-center justify-center overflow-hidden rounded-lg border border-white/[0.08] bg-black text-zinc-300"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/60 transition group-hover:scale-105 group-hover:bg-violet-550/30">
          <Play className="ml-0.5 h-5 w-5" />
        </span>
        <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white">
          {formatDuration(clip.durationSeconds)}
        </span>
      </button>
      <div className="space-y-2 pt-3">
        <p className="line-clamp-2 min-h-10 text-[13px] font-medium leading-snug text-zinc-100">{clip.title}</p>
        <div className="flex items-center gap-2">
          <Badge tone="green">Ready</Badge>
          <span className="text-[11px] text-zinc-500">9:16 · {formatBytes(clip.sizeBytes)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => onPreview(clip)}>
            <Play className="h-4 w-4" /> Preview
          </Button>
          {download}
        </div>
      </div>
    </Card>
  );
}

export function LibraryPage() {
  const [view, setView] = useState<View>("grid");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewClip, setPreviewClip] = useState<ClipRecord | null>(null);
  const [previewMedia, setPreviewMedia] = useState<{ previewUrl: string; downloadUrl: string } | null>(null);
  const [cancellingJob, setCancellingJob] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [nextClips, nextJobs] = await Promise.all([getClips(), getJobs()]);
      setClips(nextClips);
      setJobs(nextJobs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your private library.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(true), 15000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const filteredClips = useMemo(() => {
    const sorted = [...clips].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return sorted.filter((clip) => {
      if (query && !clip.title.toLowerCase().includes(query.toLowerCase())) return false;
      if (filter === "recent" && Date.now() - Date.parse(clip.createdAt) > 7 * 24 * 60 * 60 * 1000) return false;
      return true;
    });
  }, [clips, query, filter]);

  const handlePreview = async (clip: ClipRecord) => {
    try {
      const media = isNativePlatform()
        ? await createClipMediaUrls(clip.id)
        : { previewUrl: getClipPreviewUrl(clip.id), downloadUrl: getClipDownloadUrl(clip.id) };
      setPreviewMedia({ previewUrl: media.previewUrl, downloadUrl: media.downloadUrl });
      setPreviewClip(clip);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare this clip preview.");
    }
  };

  const handleDownload = async (clip: ClipRecord) => {
    try {
      if (isNativePlatform()) {
        const media = await createClipMediaUrls(clip.id);
        await Browser.open({ url: media.downloadUrl });
      } else {
        window.open(getClipDownloadUrl(clip.id), "_blank", "noopener,noreferrer");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare this download.");
    }
  };

  const activeJobs = jobs
    .filter((job) => job.status === "queued" || job.status === "processing")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const handleCancel = async (jobId: string) => {
    setCancellingJob(jobId);
    try {
      await cancelSourceJob(jobId);
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel this job.");
    } finally {
      setCancellingJob(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Clip library</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {clips.length} finished clips in your private library
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon" onClick={() => setView("grid")} aria-label="Grid view" aria-pressed={view === "grid"}>
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button variant={view === "list" ? "secondary" : "ghost"} size="icon" onClick={() => setView("list")} aria-label="List view" aria-pressed={view === "list"}>
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/[0.08] px-4 py-3 text-[13px] text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><XCircle className="h-4 w-4" /></button>
        </div>
      ) : null}

      {activeJobs.length > 0 ? (
        <Card>
          <CardHeader title="Jobs in progress" description="Your uploads are processed in the background" />
          <div className="divide-y divide-white/[0.06] px-4 pb-2">
            {activeJobs.map((job) => (
              <div key={job.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-200">{job.title || job.sourceUrl}</span>
                  <Badge tone={statusTone[job.status]}>{job.status}</Badge>
                  <span className="font-mono text-xs text-zinc-500">{Math.max(0, Math.min(100, job.progress))}%</span>
                </div>
                <Progress value={Math.max(0, Math.min(100, job.progress))} />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-zinc-500">{stageLabel(job.stage)}</span>
                  <Button size="sm" variant="ghost" disabled={cancellingJob === job.id} onClick={() => void handleCancel(job.id)}>
                    {cancellingJob === job.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                    Cancel job
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clips…" aria-label="Search clips" className="h-9 w-full rounded-lg glass pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-550/50" />
        </div>
        <Select value={filter} onChange={(event) => setFilter(event.target.value as Filter)} aria-label="Filter clips" className="w-40">
          <option value="all">All clips</option>
          <option value="recent">Last 7 days</option>
        </Select>
      </Card>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your private clips…
        </div>
      ) : filteredClips.length === 0 ? (
        <EmptyState
          icon={Scissors}
          title={clips.length === 0 ? "Your library is empty" : "No clips match your search"}
          description={clips.length === 0 ? "Upload an authorized source video. ClipForge will generate finished vertical clips here when processing completes." : "Try another search or clear the date filter."}
          action={<Link to="/upload"><Button size="sm" variant="secondary">Upload a video</Button></Link>}
        />
      ) : view === "grid" ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {filteredClips.map((clip) => <ClipCard key={clip.id} clip={clip} view="grid" onPreview={(clip) => { void handlePreview(clip); }} onDownload={(clip) => { void handleDownload(clip); }} />)}
        </div>
      ) : (
        <Card className="divide-y divide-white/[0.05]">
          {filteredClips.map((clip) => <ClipCard key={clip.id} clip={clip} view="list" onPreview={(item) => { void handlePreview(item); }} onDownload={(item) => { void handleDownload(item); }} />)}
        </Card>
      )}

      <Dialog open={!!previewClip} onOpenChange={(open) => { if (!open) { setPreviewClip(null); setPreviewMedia(null); } }} title={previewClip?.title ?? "Clip preview"} className="max-w-3xl">
        {previewClip ? (
          <div className="space-y-3">
            <video
              key={previewClip.id}
              src={previewMedia?.previewUrl ?? getClipPreviewUrl(previewClip.id)}
              controls
              playsInline
              preload="metadata"
              className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg bg-black"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
              <span>{formatDuration(previewClip.durationSeconds)} · 9:16 · {formatBytes(previewClip.sizeBytes)}</span>
              <a href={previewMedia?.downloadUrl ?? getClipDownloadUrl(previewClip.id)} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-550 px-3 text-xs font-semibold text-white transition hover:bg-violet-450">
                <Download className="h-4 w-4" /> Download MP4
              </a>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
