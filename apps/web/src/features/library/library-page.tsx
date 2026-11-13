import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Download, RefreshCw, Scissors, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import {
  cancelClipRender,
  getClipDownloadUrl,
  getClips,
  retryClipRender,
  type UserClip,
} from "@/lib/api";
import { formatDuration } from "@/lib/utils";

function statusTone(status: UserClip["status"]): "green" | "amber" | "red" | "zinc" {
  if (status === "ready") return "green";
  if (status === "failed") return "red";
  if (status === "rendering") return "amber";
  return "zinc";
}

export function LibraryPage() {
  const [clips, setClips] = useState<UserClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setClips(await getClips());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your private clip library.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (clipId: string) => {
    setBusyId(clipId);
    setError(null);
    try {
      await cancelClipRender(clipId);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel this render.");
    } finally {
      setBusyId(null);
    }
  };

  const retry = async (clipId: string) => {
    setBusyId(clipId);
    setError(null);
    try {
      await retryClipRender(clipId);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not retry this render.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Clip library</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Your private rendered MP4s and active render jobs. Only this account can access these files.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void load(true)} disabled={refreshing || loading}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>
      ) : null}

      {loading ? (
        <Card className="p-10 text-center text-sm text-zinc-500">Loading your private clips…</Card>
      ) : clips.length === 0 ? (
        <EmptyState
          icon={Scissors}
          title="Your clip library is empty"
          description="Upload an authorized source, review its detected moments, and render the candidates you select."
          action={<Link to="/upload"><Button size="sm" variant="secondary">Upload a source</Button></Link>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {clips.map((clip) => (
            <Card key={clip.id} className="overflow-hidden">
              <div className="relative flex aspect-video items-center justify-center bg-black">
                <div className="flex flex-col items-center gap-2 text-zinc-600">
                  <Scissors className="h-7 w-7" />
                  <span className="text-[11px]">MP4 · {clip.aspectRatio}</span>
                </div>
                <Badge tone={statusTone(clip.status)} className="absolute right-3 top-3">{clip.status}</Badge>
              </div>
              <div className="space-y-3 p-4">
                <div>
                  <h2 className="line-clamp-2 text-sm font-semibold text-zinc-100">{clip.title}</h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    {clip.durationSeconds ? formatDuration(clip.durationSeconds) : "Duration pending"}
                    {" · "}{clip.outputSizeBytes ? `${(clip.outputSizeBytes / (1024 * 1024)).toFixed(1)} MB` : "Output pending"}
                  </p>
                  {clip.description ? (
                    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-zinc-500">{clip.description}</p>
                  ) : null}
                </div>

                {(clip.status === "queued" || clip.status === "rendering") ? (
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-zinc-500">
                      <span>{clip.status === "queued" ? "Waiting for processor" : "Rendering / uploading"}</span>
                      <span className="font-mono">{clip.progress}%</span>
                    </div>
                    <Progress value={clip.progress} />
                  </div>
                ) : null}

                {clip.errorCode ? (
                  <p className="text-xs text-red-300">Render error: {clip.errorCode}</p>
                ) : null}

                <div className="flex flex-wrap justify-end gap-2 border-t hairline pt-3">
                  {(clip.status === "queued" || clip.status === "rendering") ? (
                    <Button size="sm" variant="danger" disabled={busyId === clip.id} onClick={() => void cancel(clip.id)}>
                      <X className="h-4 w-4" /> Cancel
                    </Button>
                  ) : null}
                  {clip.status === "failed" ? (
                    <Button size="sm" variant="secondary" disabled={busyId === clip.id} onClick={() => void retry(clip.id)}>
                      <RefreshCw className="h-4 w-4" /> Retry
                    </Button>
                  ) : null}
                  {clip.status === "ready" ? (
                    <a href={getClipDownloadUrl(clip.id)} className="inline-flex">
                      <Button size="sm"><Download className="h-4 w-4" /> Download MP4</Button>
                    </a>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
