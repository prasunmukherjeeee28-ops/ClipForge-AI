import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CloudUpload,
  FileVideo,
  X,
  CheckCircle2,
  Scissors,
  Sparkles,
  Subtitles,
  Link2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn, formatBytes } from "@/lib/utils";
import {
  attachSourceAsset,
  cancelSourceJob,
  completeSourceAsset,
  createSourceAsset,
  createSourceJob,
  deleteSourceAsset,
  getSourceAsset,
  uploadSourcePart,
} from "@/lib/api";

type Phase = "idle" | "uploading" | "submitted";
type UploadSession = {
  jobId?: string;
  assetId?: string;
  sourceUrl: string;
  filename: string;
  sizeBytes: number;
};

const ACCEPTED = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

function isSupportedSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    const youtube = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host);
    const twitch = ["twitch.tv", "www.twitch.tv", "m.twitch.tv"].includes(host);
    return youtube || twitch;
  } catch {
    return false;
  }
}

export function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<UploadSession | null>(null);
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);

  const [captions, setCaptions] = useState(true);
  const [vertical, setVertical] = useState(true);
  const [reviewScores, setReviewScores] = useState(true);

  const pickFile = useCallback((picked: File | undefined | null) => {
    setError(null);
    if (!picked) return;
    if (!ACCEPTED.includes(picked.type)) {
      setError("Unsupported format. Use MP4, MOV, WebM or MKV.");
      return;
    }
    if (picked.size < 1 || picked.size > MAX_FILE_BYTES) {
      setError("Source files must be between 1 byte and 2 GiB.");
      return;
    }
    setFile(picked);
    setProgress(0);
    setPhase("idle");
    setSession(null);
    setSubmittedJobId(null);
  }, []);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const reset = useCallback(() => {
    const current = session;
    if (current && phase !== "submitted") {
      void (async () => {
        if (current.jobId) {
          await cancelSourceJob(current.jobId).catch(() => undefined);
        }
        if (current.assetId) {
          await deleteSourceAsset(current.assetId).catch(() => undefined);
        }
      })();
    }
    setFile(null);
    setSourceUrl("");
    setProgress(0);
    setPhase("idle");
    setError(null);
    setSession(null);
    setSubmittedJobId(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [session, phase]);

  const startUpload = useCallback(async () => {
    if (!file) {
      setError("Choose the authorized source video file first.");
      return;
    }
    const normalizedUrl = sourceUrl.trim();
    if (!isSupportedSourceUrl(normalizedUrl)) {
      setError("Enter a supported HTTPS YouTube video or Twitch VOD URL.");
      return;
    }
    if (session && (
      session.sourceUrl !== normalizedUrl ||
      session.filename !== file.name ||
      session.sizeBytes !== file.size
    )) {
      setError("This upload session belongs to a different source or file. Discard it before starting another.");
      return;
    }

    setError(null);
    setPhase("uploading");
    try {
      let active = session;

      if (!active?.jobId) {
        const job = await createSourceJob(normalizedUrl, {
          captions,
          vertical,
          reviewScores,
        });
        active = {
          jobId: job.id,
          sourceUrl: normalizedUrl,
          filename: file.name,
          sizeBytes: file.size,
        };
        setSession(active);
      }

      if (!active.assetId) {
        const asset = await createSourceAsset(file);
        active = { ...active, assetId: asset.id };
        setSession(active);
      }

      if (!active || !active.jobId || !active.assetId) {
        throw new Error("The source upload session could not be initialized.");
      }
      const jobId = active.jobId;
      const assetId = active.assetId;

      const assetState = await getSourceAsset(assetId);
      if (assetState.asset.status === "failed" || assetState.asset.status === "deleting") {
        throw new Error("This source upload is no longer available. Discard it and start again.");
      }

      if (assetState.asset.status !== "ready") {
        const uploadInfo = await getSourceAsset(assetId);
        const uploaded = new Set(uploadInfo.uploadedParts.map((part) => part.partNumber));
        let uploadedBytes = uploadInfo.uploadedParts.reduce((sum, part) => sum + part.sizeBytes, 0);
        setProgress(Math.min(99, (uploadedBytes / file.size) * 100));

        for (let partNumber = 1; partNumber <= Math.ceil(file.size / (8 * 1024 * 1024)); partNumber++) {
          if (uploaded.has(partNumber)) continue;
          const start = (partNumber - 1) * 8 * 1024 * 1024;
          const end = Math.min(file.size, start + 8 * 1024 * 1024);
          const chunk = file.slice(start, end);
          await uploadSourcePart(assetId, partNumber, chunk);
          uploadedBytes += chunk.size;
          setProgress(Math.min(99, (uploadedBytes / file.size) * 100));
        }

        await completeSourceAsset(assetId);
      }

      await attachSourceAsset(jobId, assetId);
      setProgress(100);
      setSubmittedJobId(jobId);
      setPhase("submitted");
      setError(null);
    } catch (cause) {
      setPhase("idle");
      setError(cause instanceof Error ? cause.message : "The source upload could not be completed. Retry to resume missing parts.");
    }
  }, [file, sourceUrl, session, captions, vertical, reviewScores]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Upload a source</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Link the YouTube or Twitch VOD, then upload an original/export file you own or are authorized to process.
        </p>
      </div>

      <Card className="p-4">
        <label className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200" htmlFor="source-url">
          <Link2 className="h-4 w-4 text-violet-350" />
          Source video URL
        </label>
        <input
          id="source-url"
          type="url"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          disabled={!!session || phase === "uploading" || phase === "submitted"}
          placeholder="https://www.youtube.com/watch?v=... or https://www.twitch.tv/videos/..."
          className="h-11 w-full rounded-lg border border-white/[0.10] bg-black/20 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-450/60 disabled:opacity-60"
          autoComplete="url"
          spellCheck={false}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          {!file ? (
            <button
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                pickFile(event.dataTransfer.files?.[0]);
              }}
              className={cn(
                "glass flex w-full flex-col items-center justify-center gap-3 rounded-xl border-dashed px-6 py-16 text-center transition-all duration-200 ease-smooth",
                dragging
                  ? "border-violet-450/60 bg-violet-550/[0.06] scale-[1.005]"
                  : "border-white/[0.12] hover:border-white/[0.2]"
              )}
              aria-label="Choose or drop a video file"
            >
              <span className="glass flex h-12 w-12 items-center justify-center rounded-xl">
                <CloudUpload className="h-5 w-5 text-violet-350" />
              </span>
              <span className="text-sm font-medium text-zinc-200">
                Drag your video here, or <span className="text-violet-350">browse files</span>
              </span>
              <span className="text-xs text-zinc-600">
                MP4, MOV, WebM, MKV · up to 2 GiB · private resumable upload
              </span>
            </button>
          ) : (
            <Card className="overflow-hidden">
              {previewUrl ? (
                <video
                  src={previewUrl}
                  controls
                  className="aspect-video w-full bg-black object-contain"
                />
              ) : null}
              <div className="space-y-3 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="glass flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                      <FileVideo className="h-4 w-4 text-violet-350" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-200">{file.name}</p>
                      <p className="text-xs text-zinc-500">{formatBytes(file.size)}</p>
                    </div>
                  </div>
                  {phase === "submitted" ? (
                    <Badge tone="green">
                      <CheckCircle2 className="h-3 w-3" /> Source attached
                    </Badge>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={reset}
                      disabled={phase === "uploading"}
                      aria-label="Remove source file"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                {phase === "uploading" ? (
                  <div>
                    <div className="mb-1.5 flex justify-between text-xs text-zinc-500">
                      <span>Uploading source parts…</span>
                      <span className="font-mono">{Math.floor(progress)}%</span>
                    </div>
                    <Progress value={progress} />
                  </div>
                ) : null}

                {phase === "submitted" ? (
                  <div className="space-y-1 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-300">
                      <CheckCircle2 className="h-4 w-4" />
                      Private source file attached to your job
                    </div>
                    <p className="text-xs leading-relaxed text-zinc-400">
                      Job {submittedJobId?.slice(0, 8)} is queued. Track processing progress here and find finished clips in your private library.
                    </p>
                    <Link to="/library" className="inline-flex pt-1 text-xs font-medium text-violet-300 hover:text-violet-200">View job progress and clips →</Link>
                  </div>
                ) : null}
              </div>
            </Card>
          )}

          {error ? (
            <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">
              {error}
            </p>
          ) : null}

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(",")}
            className="hidden"
            onChange={(event) => pickFile(event.target.files?.[0])}
            aria-hidden
          />

          <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-350" />
              <p className="text-xs leading-relaxed text-zinc-500">
                Upload only an original/export or provider-approved video file you have permission to process. A public YouTube or Twitch link is metadata, not permission to download its video.
              </p>
            </div>
          </div>

          {session && phase !== "submitted" ? (
            <p className="text-xs text-zinc-500">
              Upload session saved in this screen. Retry resumes parts already confirmed by the API; keep this page open until the upload finishes.
            </p>
          ) : null}
        </div>

        <Card className="h-fit lg:col-span-2">
          <CardHeader title="Clip preferences" description="Saved with the source job" />
          <div className="space-y-1 px-3 pb-5">
            {[
              {
                icon: Subtitles,
                label: "Auto captions",
                desc: "Request synced captions when transcription is available",
                value: captions,
                set: setCaptions,
              },
              {
                icon: Sparkles,
                label: "Review scores",
                desc: "Request hook / context / payoff estimates",
                value: reviewScores,
                set: setReviewScores,
              },
            ].map(({ icon: Icon, label, desc, value, set }) => (
              <div key={label} className="flex items-center gap-3 rounded-lg px-2 py-2.5">
                <span className="glass flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                  <Icon className="h-4 w-4 text-violet-350" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-zinc-200">{label}</p>
                  <p className="text-xs leading-snug text-zinc-500">{desc}</p>
                </div>
                <Switch checked={value} onCheckedChange={set} label={label} disabled={!!session || phase !== "idle"} />
              </div>
            ))}

            <div className="mt-2 border-t hairline px-2 pt-3">
              <label className="text-xs font-medium text-zinc-500" htmlFor="aspect">
                Export framing
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2" id="aspect" role="radiogroup" aria-label="Export framing">
                {[
                  { value: false, label: "16:9 landscape" },
                  { value: true, label: "9:16 vertical" },
                ].map(({ value, label }) => (
                  <button
                    key={label}
                    role="radio"
                    aria-checked={vertical === value}
                    disabled={!!session || phase !== "idle"}
                    onClick={() => setVertical(value)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-[13px] transition-all duration-200 disabled:opacity-60",
                      vertical === value
                        ? "border-violet-550/50 bg-violet-550/10 text-zinc-100"
                        : "hairline text-zinc-500 hover:text-zinc-300"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-2 pt-4">
              <Button
                className="w-full"
                size="lg"
                disabled={!file || !sourceUrl.trim() || phase === "uploading" || phase === "submitted"}
                onClick={() => void startUpload()}
              >
                <Scissors className="h-4 w-4" />
                {session ? "Resume source upload" : "Upload & prepare source"}
              </Button>
              <p className="mt-2 text-center text-[11px] leading-relaxed text-zinc-600">
                Stores your authorized file privately and queues VOD metadata verification.
              </p>
              {phase === "submitted" ? (
                <Button className="mt-3 w-full" variant="secondary" onClick={reset}>
                  Upload another source
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
