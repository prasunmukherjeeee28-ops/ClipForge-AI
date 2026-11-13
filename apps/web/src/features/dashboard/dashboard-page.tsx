import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  Clock3,
  Download,
  HardDrive,
  Scissors,
  Upload,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/empty-state";
import { getClips, getJobs, getClipDownloadUrl, type UserClip, type UserJob } from "@/lib/api";
import { formatDuration } from "@/lib/utils";

function jobTone(status: UserJob["status"]): "green" | "amber" | "red" | "zinc" | "violet" {
  if (status === "review" || status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "processing") return "amber";
  return "zinc";
}

export function DashboardPage() {
  const [jobs, setJobs] = useState<UserJob[]>([]);
  const [clips, setClips] = useState<UserClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextJobs, nextClips] = await Promise.all([getJobs(), getClips()]);
      setJobs(nextJobs);
      setClips(nextClips);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your private workspace.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "processing").length;
  const readyClips = clips.filter((clip) => clip.status === "ready").length;
  const failed = jobs.filter((job) => job.status === "failed").length +
    clips.filter((clip) => clip.status === "failed").length;
  const storageBytes = clips.reduce((sum, clip) => sum + (clip.outputSizeBytes ?? 0), 0);
  const recentJobs = jobs.slice(0, 5);
  const recentClips = clips.slice(0, 4);

  const stats = [
    { label: "Source jobs", value: String(jobs.length), detail: `${activeJobs} active`, icon: Activity },
    { label: "Rendered clips", value: String(clips.length), detail: `${readyClips} ready to download`, icon: Scissors },
    { label: "Output storage", value: storageBytes >= 1024 * 1024 * 1024 ? `${(storageBytes / (1024 * 1024 * 1024)).toFixed(2)} GB` : `${(storageBytes / (1024 * 1024)).toFixed(1)} MB`, detail: "Your private exports", icon: HardDrive },
    { label: "Needs attention", value: String(failed), detail: "Failed jobs or renders", icon: AlertCircle },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">ClipForge AI</h1>
          <p className="mt-1 text-sm text-zinc-500">Your private source jobs, detected moments and rendered clips.</p>
        </div>
        <Link to="/upload">
          <Button><Upload className="h-4 w-4" /> Upload source</Button>
        </Link>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(({ label, value, detail, icon: Icon }) => (
          <Card key={label} className="glass-hover px-4 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] text-zinc-500">{label}</p>
              <Icon className="h-4 w-4 text-violet-350/80" />
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">{value}</p>
            <p className="mt-1 text-xs text-zinc-600">{detail}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Recent source jobs" description="Real processing status from your account" action={<Button size="sm" variant="ghost" onClick={() => void load()}>Refresh</Button>} />
            {loading ? (
              <p className="px-5 pb-5 text-sm text-zinc-500">Loading jobs…</p>
            ) : recentJobs.length === 0 ? (
              <EmptyState className="mx-5 mb-5" icon={Upload} title="No source jobs yet" description="Upload an authorized video export to start the transcription and highlight detection pipeline." action={<Link to="/upload"><Button size="sm" variant="secondary">Upload your first source</Button></Link>} />
            ) : (
              <ul className="divide-y divide-white/[0.05] px-2 pb-2">
                {recentJobs.map((job) => (
                  <li key={job.id}>
                    <Link to={`/jobs/${job.id}/candidates`} className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-white/[0.04]">
                      <span className="glass flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"><Clock3 className="h-4 w-4 text-violet-350" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-200">{job.title || `${job.sourcePlatform.toUpperCase()} source · ${job.id.slice(0, 8)}`}</p>
                        <p className="mt-0.5 truncate text-xs text-zinc-500">{job.stage.replace(/_/g, " ")} · {job.sourceDurationSeconds ? formatDuration(job.sourceDurationSeconds) : "duration pending"}</p>
                        {(job.status === "queued" || job.status === "processing") ? <Progress className="mt-2" value={job.progress} /> : null}
                      </div>
                      <Badge tone={jobTone(job.status)}>{job.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Recent rendered clips" description="Your finished MP4 exports" action={<Link to="/library"><Button size="sm" variant="ghost">Open library</Button></Link>} />
            {recentClips.length === 0 ? (
              <EmptyState className="mx-5 mb-5" icon={Scissors} title="No rendered clips yet" description="Select a detected candidate and choose Render MP4 to create an export." />
            ) : (
              <div className="grid grid-cols-2 gap-3 px-5 pb-5 md:grid-cols-4">
                {recentClips.map((clip) => (
                  <div key={clip.id} className="space-y-2">
                    <div className="flex aspect-[9/16] max-h-44 items-center justify-center rounded-lg bg-black">
                      <Scissors className="h-5 w-5 text-zinc-700" />
                    </div>
                    <p className="line-clamp-2 text-xs text-zinc-300">{clip.title}</p>
                    <Badge tone={jobTone(clip.status === "ready" ? "completed" : clip.status === "failed" ? "failed" : clip.status === "rendering" ? "processing" : "queued")}>{clip.status}</Badge>
                    {clip.status === "ready" ? <Button size="sm" variant="secondary" className="w-full" onClick={() => window.location.assign(getClipDownloadUrl(clip.id))}><Download className="h-3.5 w-3.5" /> Download</Button> : null}
                    {clip.status === "rendering" || clip.status === "queued" ? <Progress value={clip.progress} /> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Pipeline" description="Current VOD workflow" />
          <div className="space-y-3 px-5 pb-5">
            {[
              ["1", "Authorized source upload", "Private, resumable R2 input"],
              ["2", "Transcription", "Local speech-to-text with timestamps"],
              ["3", "Moment detection", "Ranked candidate windows"],
              ["4", "Human review", "Keep or reject candidates"],
              ["5", "Vertical rendering", "9:16 MP4 with optional subtitles"],
              ["6", "Private download", "Owner-scoped MP4 export"],
            ].map(([number, title, description]) => (
              <div key={number} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-xs font-mono text-violet-300">{number}</span>
                <div><p className="text-[13px] font-medium text-zinc-200">{title}</p><p className="text-xs text-zinc-500">{description}</p></div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
