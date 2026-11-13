import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Upload,
  Scissors,
  Clock3,
  HardDrive,
  ArrowRight,
  FolderOpen,
  Loader2,
  CheckCircle2,
  Activity as ActivityIcon,
  FileVideo,
  RefreshCw,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/empty-state";
import { getClips, getJobs, type ClipRecord, type JobRecord } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/utils";

const stageMeta: Record<string, { icon: typeof Loader2; tone: "violet" | "green" | "amber" | "zinc" }> = {
  queued: { icon: Clock3, tone: "zinc" },
  claimed: { icon: Loader2, tone: "amber" },
  downloading_source: { icon: FileVideo, tone: "violet" },
  validating_media: { icon: FileVideo, tone: "violet" },
  extracting_audio: { icon: ActivityIcon, tone: "violet" },
  transcribing_audio: { icon: FileVideo, tone: "violet" },
  analyzing_moments: { icon: ActivityIcon, tone: "violet" },
  persisting_moments: { icon: Scissors, tone: "violet" },
  rendering_clips: { icon: Loader2, tone: "amber" },
  completed: { icon: CheckCircle2, tone: "green" },
  failed: { icon: CheckCircle2, tone: "zinc" },
};

const statusTone: Record<JobRecord["status"], "violet" | "green" | "amber" | "zinc" | "red"> = {
  review: "violet",
  completed: "green",
  processing: "amber",
  queued: "zinc",
  failed: "red",
  cancelled: "zinc",
};

function stageLabel(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\\b\\w/g, (letter) => letter.toUpperCase());
}

function sourceLabel(job: JobRecord): string {
  if (job.title?.trim()) return job.title;
  try {
    return new URL(job.sourceUrl).hostname.replace(/^www\\./, "");
  } catch {
    return job.sourcePlatform === "twitch" ? "Twitch source" : "YouTube source";
  }
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Recently"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function DashboardPage() {
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [nextClips, nextJobs] = await Promise.all([getClips(), getJobs()]);
      setClips(nextClips);
      setJobs(nextJobs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your dashboard.");
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

  const recentClips = useMemo(
    () => [...clips].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 4),
    [clips],
  );
  const recentJobs = useMemo(
    () => [...jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 4),
    [jobs],
  );
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "processing").length;
  const storageBytes = clips.reduce((total, clip) => total + clip.sizeBytes, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Your ClipForge workspace</h1>
          <p className="mt-1 text-sm text-zinc-500">Your private clips and processing jobs, updated automatically.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Link to="/upload">
            <Button><Upload className="h-4 w-4" /> New upload</Button>
          </Link>
        </div>
      </div>

      {error ? <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">{error}</p> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Clips generated", value: String(clips.length), icon: Scissors, detail: "In your private library" },
          { label: "Active jobs", value: String(activeJobs), icon: ActivityIcon, detail: "Queued or processing" },
          { label: "Clip storage", value: formatBytes(storageBytes), icon: HardDrive, detail: "Stored exports only" },
          { label: "Jobs submitted", value: String(jobs.length), icon: Clock3, detail: "Most recent 50" },
        ].map(({ label, value, icon: Icon, detail }) => (
          <Card key={label} className="glass-hover px-5 py-4">
            <div className="flex items-center justify-between">
              <p className="text-[13px] text-zinc-500">{label}</p>
              <Icon className="h-4 w-4 text-violet-350/80" />
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">{loading ? "—" : value}</p>
            <p className="mt-1 text-xs text-zinc-600">{detail}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader
              title="Recent jobs"
              description="Source processing status from your account"
              action={<Link to="/library"><Button variant="ghost" size="sm">View library <ArrowRight className="h-3.5 w-3.5" /></Button></Link>}
            />
            {recentJobs.length ? (
              <ul className="divide-y divide-white/[0.05] px-2 pb-2">
                {recentJobs.map((job) => {
                  const meta = stageMeta[job.stage] ?? stageMeta[job.status] ?? stageMeta.queued;
                  const Icon = meta.icon;
                  const active = job.status === "processing" || job.status === "queued";
                  return (
                    <li key={job.id} className="flex items-center gap-3 rounded-lg px-3 py-3">
                      <span className="glass flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                        <Icon className={`h-4 w-4 text-violet-350 ${active && job.status === "processing" ? "animate-spin [animation-duration:2.5s]" : ""}`} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-200">{sourceLabel(job)}</p>
                        <p className="mt-0.5 text-xs text-zinc-500">{stageLabel(job.stage)} · {dateLabel(job.createdAt)}</p>
                        {active ? <Progress className="mt-2" value={Math.max(0, Math.min(100, job.progress))} /> : null}
                        {job.errorCode ? <p className="mt-1 text-xs text-red-300">Processing issue: {job.errorCode}</p> : null}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Badge tone={statusTone[job.status]}>{job.status}</Badge>
                        {active ? <span className="font-mono text-[11px] text-zinc-500">{job.progress}%</span> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState className="mx-5 mb-5" icon={FileVideo} title={loading ? "Loading jobs…" : "No jobs yet"} description="Your submitted source videos and their processing progress will appear here." action={<Link to="/upload"><Button size="sm" variant="secondary">Upload a source</Button></Link>} />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent clips"
              description="Finished exports ready to preview and download"
              action={<Link to="/library"><Button variant="ghost" size="sm">All clips <ArrowRight className="h-3.5 w-3.5" /></Button></Link>}
            />
            {recentClips.length ? (
              <div className="grid grid-cols-2 gap-3 px-5 pb-5 md:grid-cols-4">
                {recentClips.map((clip) => (
                  <Link key={clip.id} to="/library" className="group space-y-2">
                    <div className="relative flex aspect-[9/16] items-center justify-center overflow-hidden rounded-lg border border-white/[0.08] bg-black">
                      <PlayIcon />
                      <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white">{formatDuration(clip.durationSeconds)}</span>
                    </div>
                    <p className="line-clamp-2 text-xs leading-snug text-zinc-400 group-hover:text-zinc-200">{clip.title}</p>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState className="mx-5 mb-5" icon={Scissors} title={loading ? "Loading clips…" : "No clips yet"} description="Upload an authorized source video and generated clips will appear here when ready." action={<Link to="/upload"><Button size="sm" variant="secondary">Upload your first video</Button></Link>} />
            )}
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Processing activity" description="Live status from your jobs" />
          <ul className="space-y-4 px-5 pb-5">
            {recentJobs.filter((job) => job.status === "processing" || job.status === "queued").map((job) => {
              const meta = stageMeta[job.stage] ?? stageMeta.queued;
              const Icon = meta.icon;
              return (
                <li key={job.id} className="flex gap-3">
                  <span className="glass mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                    <Icon className={`h-4 w-4 text-violet-350 ${job.status === "processing" ? "animate-spin [animation-duration:2.5s]" : ""}`} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-zinc-200">{stageLabel(job.stage)}</p>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">{sourceLabel(job)}</p>
                    <Progress className="mt-2" value={Math.max(0, Math.min(100, job.progress))} />
                  </div>
                </li>
              );
            })}
            {!activeJobs && !loading ? <li className="py-4 text-center text-xs text-zinc-500">No jobs currently processing.</li> : null}
          </ul>
          <div className="border-t hairline px-5 py-3">
            <Link to="/live-radar"><Button variant="ghost" size="sm" className="w-full"><FolderOpen className="h-4 w-4" /> Open Live Radar</Button></Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

function PlayIcon() {
  return <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-zinc-200"><Scissors className="h-4 w-4" /></span>;
}
