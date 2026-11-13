import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Check, Clock3, RefreshCw, Scissors, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import {
  getJobCandidates,
  getJobStatus,
  queueCandidateRender,
  reviewJobCandidate,
  type JobCandidate,
  type JobStatusSnapshot,
} from "@/lib/api";
import { formatTimecode } from "@/lib/utils";

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function CandidateReviewPage() {
  const { jobId = "" } = useParams();
  const [job, setJob] = useState<JobStatusSnapshot | null>(null);
  const [candidates, setCandidates] = useState<JobCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [renderingId, setRenderingId] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!jobId) return;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [jobResult, candidateResult] = await Promise.all([
        getJobStatus(jobId),
        getJobCandidates(jobId),
      ]);
      setJob(jobResult);
      setCandidates(candidateResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this job's candidates.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const renderCandidate = async (candidateId: string) => {
    setRenderingId(candidateId);
    setError(null);
    try {
      const clip = await queueCandidateRender(candidateId, {
        captions: true,
        resolution: "1080x1920",
      });
      await load(true);
      window.alert(
        clip.status === "ready"
          ? "This candidate already has a finished MP4. Open your clip library to download it."
          : "Clip render queued. Track progress and download the MP4 from your private clip library.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not queue this candidate for rendering.");
    } finally {
      setRenderingId(null);
    }
  };

  const changeReview = async (
    candidateId: string,
    reviewStatus: "selected" | "rejected" | "pending",
  ) => {
    setSavingId(candidateId);
    setError(null);
    try {
      await reviewJobCandidate(candidateId, reviewStatus);
      setCandidates((current) => current.map((item) =>
        item.id === candidateId ? { ...item, reviewStatus } : item
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the review decision.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/library">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /> Library</Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-zinc-100">Detected moments</h1>
          <p className="truncate text-xs text-zinc-500">Job {jobId.slice(0, 8)}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void load(true)} disabled={refreshing || loading}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {job ? (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-zinc-200">Processing status</p>
              <p className="mt-1 text-xs text-zinc-500">{job.stage.replace(/_/g, " ")}</p>
            </div>
            <Badge tone={job.status === "failed" ? "red" : job.status === "review" ? "green" : "violet"}>
              {job.status}
            </Badge>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Progress value={job.progress} className="flex-1"/>
            <span className="w-10 text-right font-mono text-xs text-zinc-400">{job.progress}%</span>
          </div>
          {job.errorCode ? <p className="mt-2 text-xs text-red-300">Processing error: {job.errorCode}</p> : null}
        </Card>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>
      ) : null}

      {loading ? (
        <Card className="p-8 text-center text-sm text-zinc-500">Loading private candidate results…</Card>
      ) : candidates.length === 0 ? (
        <EmptyState
          icon={Clock3}
          title={job?.stage === "moments_detected" ? "No candidates passed the scoring threshold" : "No candidates yet"}
          description={job?.stage === "moments_detected"
            ? "The detector completed but did not find windows that met its initial heuristic threshold."
            : "Candidate results will appear here after the processor finishes media validation, transcription and moment analysis."}
          action={<Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing}>Check again</Button>}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-400">{candidates.length} candidate windows · heuristic estimates</p>
            <p className="text-xs text-zinc-600">Review before rendering</p>
          </div>
          {candidates.map((candidate, index) => (
            <Card key={candidate.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-100">Candidate {index + 1}</span>
                    <Badge tone={candidate.reviewStatus === "selected" ? "green" : candidate.reviewStatus === "rejected" ? "red" : "zinc"}>
                      {candidate.reviewStatus}
                    </Badge>
                    <Badge tone="violet">Score {Math.round(candidate.score ?? 0)}/100</Badge>
                  </div>
                  <p className="mt-1 font-mono text-xs text-zinc-500">
                    {formatTimecode(candidate.startSeconds)} – {formatTimecode(candidate.endSeconds)}
                    {" · "}{Math.round(candidate.endSeconds - candidate.startSeconds)} sec
                  </p>
                </div>
                <span className="text-[11px] uppercase tracking-wide text-zinc-600">{candidate.category}</span>
              </div>

              {candidate.transcriptExcerpt ? (
                <blockquote className="mt-3 border-l-2 border-violet-500/40 pl-3 text-sm leading-relaxed text-zinc-300">
                  {candidate.transcriptExcerpt}
                </blockquote>
              ) : null}
              {candidate.rationale ? <p className="mt-2 text-xs text-zinc-500">{candidate.rationale}</p> : null}

              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
                {[
                  ["Acoustic", candidate.signals.acousticSalience],
                  ["Speech", candidate.signals.transcriptVelocity],
                  ["Narrative", candidate.signals.narrativeArc],
                  ["Novelty", candidate.signals.novelty],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                      <span>{label}</span><span>{percent(Number(value))}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                      <div className="h-full rounded-full bg-violet-450" style={{ width: percent(Number(value)) }} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={savingId === candidate.id} onClick={() => void changeReview(candidate.id, "pending")}>
                  Reset
                </Button>
                <Button size="sm" variant="danger" disabled={savingId === candidate.id} onClick={() => void changeReview(candidate.id, "rejected")}>
                  <X className="h-4 w-4" /> Reject
                </Button>
                <Button size="sm" variant="secondary" disabled={savingId === candidate.id} onClick={() => void changeReview(candidate.id, "selected")}>
                  <Check className="h-4 w-4" /> Keep candidate
                </Button>
                {candidate.reviewStatus === "selected" ? (
                  <Button size="sm" disabled={renderingId === candidate.id} onClick={() => void renderCandidate(candidate.id)}>
                    <Scissors className="h-4 w-4" /> {renderingId === candidate.id ? "Queuing…" : "Render MP4"}
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
