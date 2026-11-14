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
import { Badge } from "@/components/ui/badge";
import { cn, formatBytes } from "@/lib/utils";
import {
  attachSourceAsset,
  cancelSourceJob,
  completeSourceAsset,
  createSourceAsset,
  createSourceJob,
  createUploadJob,
  deleteSourceAsset,
  getSourceAsset,
  uploadSourcePart,
} from "@/lib/api";

type Phase = "idle" | "uploading" | "submitted";
type InputMode = "url" | "file";
type UploadSession = {
  jobId?: string;
  assetId?: string;
  filename: string;
  sizeBytes: number;
};

const ACCEPTED = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const PART_BYTES = 8 * 1024 * 1024;

function isSupportedSourceUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
      const videoId = host === "youtu.be"
        ? (parts.length === 1 ? parts[0] : null)
        : url.pathname === "/watch"
          ? url.searchParams.get("v")
          : (["shorts", "live", "embed"].includes(parts[0] ?? "") && parts.length === 2 ? parts[1] : null);
      return !!videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId);
    }
    if (["twitch.tv", "www.twitch.tv", "m.twitch.tv"].includes(host)) {
      return parts.length === 2 && parts[0].toLowerCase() === "videos" && /^[0-9]{1,20}$/.test(parts[1]);
    }
    if (["kick.com", "www.kick.com"].includes(host)) {
      return parts.length === 3 && /^[A-Za-z0-9_-]{1,100}$/.test(parts[0]) &&
        parts[1].toLowerCase() === "videos" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[2]);
    }
    return false;
  } catch {
    return false;
  }
}

export function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<InputMode>("url");
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<UploadSession | null>(null);
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);

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
        if (current.jobId) await cancelSourceJob(current.jobId).catch(() => undefined);
        if (current.assetId) await deleteSourceAsset(current.assetId).catch(() => undefined);
      })();
    }
    setFile(null);
    setSourceUrl("");
    setRightsConfirmed(false);
    setProgress(0);
    setPhase("idle");
    setError(null);
    setSession(null);
    setSubmittedJobId(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [session, phase]);

  const startUrlJob = useCallback(async () => {
    const normalizedUrl = sourceUrl.trim();
    if (!isSupportedSourceUrl(normalizedUrl)) {
      setError("Enter one YouTube video, Twitch VOD, or Kick VOD URL.");
      return;
    }
    if (!rightsConfirmed) {
      setError("Confirm that you own this video or have permission to process it.");
      return;
    }
    setError(null);
    setPhase("uploading");
    try {
      const job = await createSourceJob(normalizedUrl, true, { captions: captionsEnabled });
      setSubmittedJobId(job.id);
      setPhase("submitted");
    } catch (cause) {
      setPhase("idle");
      setError(cause instanceof Error ? cause.message : "The video link could not be submitted.");
    }
  }, [sourceUrl, rightsConfirmed, captionsEnabled]);

  const startFileUpload = useCallback(async () => {
    if (!file) {
      setError("Choose a video file first.");
      return;
    }
    if (!rightsConfirmed) {
      setError("Confirm that you own this video or have permission to process it.");
      return;
    }
    if (session && (
      session.filename !== file.name ||
      session.sizeBytes !== file.size
    )) {
      setError("This upload session belongs to a different file. Remove it and choose the file again.");
      return;
    }

    setError(null);
    setPhase("uploading");
    try {
      let active = session;
      if (!active?.assetId) {
        const asset = await createSourceAsset(file);
        active = { assetId: asset.id, filename: file.name, sizeBytes: file.size };
        setSession(active);
      }

      if (!active.assetId) throw new Error("The private upload session could not be initialized.");
      const assetId = active.assetId;
      const assetState = await getSourceAsset(assetId);
      if (assetState.asset.status === "failed" || assetState.asset.status === "deleting") {
        throw new Error("This upload is no longer available. Remove it and start again.");
      }

      if (assetState.asset.status !== "ready") {
        const uploaded = new Set(assetState.uploadedParts.map((part) => part.partNumber));
        let uploadedBytes = assetState.uploadedParts.reduce((sum, part) => sum + part.sizeBytes, 0);
        setProgress(Math.min(99, (uploadedBytes / file.size) * 100));

        for (let partNumber = 1; partNumber <= Math.ceil(file.size / PART_BYTES); partNumber++) {
          if (uploaded.has(partNumber)) continue;
          const start = (partNumber - 1) * PART_BYTES;
          const end = Math.min(file.size, start + PART_BYTES);
          const chunk = file.slice(start, end);
          await uploadSourcePart(assetId, partNumber, chunk);
          uploadedBytes += chunk.size;
          setProgress(Math.min(99, (uploadedBytes / file.size) * 100));
        }
        await completeSourceAsset(assetId);
      }

      const job = await createUploadJob(assetId, true, { captions: captionsEnabled });
      setSession({ ...active, jobId: job.id });
      setProgress(100);
      setSubmittedJobId(job.id);
      setPhase("submitted");
    } catch (cause) {
      setPhase("idle");
      setError(cause instanceof Error ? cause.message : "The video could not be uploaded. Retry to resume confirmed parts.");
    }
  }, [file, rightsConfirmed, session, captionsEnabled]);

  const busy = phase === "uploading";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Create clips</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Start with a video link or upload a video directly. These are separate ways to create a job.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-1">
        <button
          type="button"
          onClick={() => { setMode("url"); setError(null); }}
          disabled={busy || phase === "submitted"}
          aria-pressed={mode === "url"}
          className={cn(
            "flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition",
            mode === "url" ? "bg-violet-550 text-white" : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
          )}
        >
          <Link2 className="h-4 w-4" /> Paste a link
        </button>
        <button
          type="button"
          onClick={() => { setMode("file"); setError(null); }}
          disabled={busy || phase === "submitted"}
          aria-pressed={mode === "file"}
          className={cn(
            "flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition",
            mode === "file" ? "bg-violet-550 text-white" : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
          )}
        >
          <CloudUpload className="h-4 w-4" /> Upload a video
        </button>
      </div>

      {mode === "url" ? (
        <Card className="space-y-4 p-4">
          <div>
            <label className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200" htmlFor="source-url">
              <Link2 className="h-4 w-4 text-violet-350" /> Video URL
            </label>
            <input
              id="source-url"
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              disabled={busy || phase === "submitted"}
              placeholder="https://www.youtube.com/watch?v=..."
              className="h-12 w-full rounded-lg border border-white/[0.10] bg-black/20 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-450/60 disabled:opacity-60"
              autoComplete="url"
              spellCheck={false}
            />
            <p className="mt-2 text-xs text-zinc-500">
              Supported currently: public YouTube videos, Twitch VODs and Kick VODs. Live, private, subscriber-only or age-restricted sources are not importable.
            </p>
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 text-xs leading-relaxed text-zinc-400">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(event) => setRightsConfirmed(event.target.checked)}
              disabled={busy || phase === "submitted"}
              className="mt-0.5 h-4 w-4 shrink-0 accent-violet-500"
            />
            <span>I own this video or have permission to download, process and create clips from it.</span>
          </label>
          <Button
            className="w-full"
            size="lg"
            disabled={!sourceUrl.trim() || !rightsConfirmed || busy || phase === "submitted"}
            onClick={() => void startUrlJob()}
          >
            <Scissors className="h-4 w-4" />
            {busy ? "Submitting video link…" : "Find clips from link"}
          </Button>
        </Card>
      ) : (
        <div className="space-y-4">
          {!file ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                pickFile(event.dataTransfer.files?.[0]);
              }}
              disabled={busy || phase === "submitted"}
              className={cn(
                "glass flex w-full flex-col items-center justify-center gap-3 rounded-xl border-dashed px-6 py-16 text-center transition-all duration-200 ease-smooth",
                dragging ? "border-violet-450/60 bg-violet-550/[0.06] scale-[1.005]" : "border-white/[0.12] hover:border-white/[0.2]"
              )}
              aria-label="Choose or drop a video file"
            >
              <span className="glass flex h-12 w-12 items-center justify-center rounded-xl">
                <CloudUpload className="h-5 w-5 text-violet-350" />
              </span>
              <span className="text-sm font-medium text-zinc-200">
                Drop your video here, or <span className="text-violet-350">browse files</span>
              </span>
              <span className="text-xs text-zinc-600">MP4, MOV, WebM, MKV · up to 2 GiB · private upload</span>
            </button>
          ) : (
            <Card className="overflow-hidden">
              {previewUrl ? (
                <video src={previewUrl} controls className="aspect-video w-full bg-black object-contain" />
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
                    <Badge tone="green"><CheckCircle2 className="h-3 w-3" /> Job queued</Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => { setFile(null); setSession(null); setProgress(0); setError(null); if (inputRef.current) inputRef.current.value = ""; }}
                      disabled={busy}
                      aria-label="Remove selected video"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {busy ? (
                  <div>
                    <div className="mb-1.5 flex justify-between text-xs text-zinc-500">
                      <span>{progress >= 99 ? "Finalizing private upload…" : "Uploading video parts…"}</span>
                      <span className="font-mono">{Math.floor(progress)}%</span>
                    </div>
                    <Progress value={progress} />
                  </div>
                ) : null}
              </div>
            </Card>
          )}

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(",")}
            className="hidden"
            onChange={(event) => pickFile(event.target.files?.[0])}
            aria-hidden
          />

          <label className="flex items-start gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 text-xs leading-relaxed text-zinc-400">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(event) => setRightsConfirmed(event.target.checked)}
              disabled={busy || phase === "submitted"}
              className="mt-0.5 h-4 w-4 shrink-0 accent-violet-500"
            />
            <span>I own this video or have permission to upload, process and create clips from it.</span>
          </label>

          <Button
            className="w-full"
            size="lg"
            disabled={!file || !rightsConfirmed || busy || phase === "submitted"}
            onClick={() => void startFileUpload()}
          >
            <Scissors className="h-4 w-4" />
            {busy ? "Uploading & preparing video…" : session?.assetId ? "Resume upload & find clips" : "Upload & find clips"}
          </Button>
        </div>
      )}

      {error ? (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">
          {error}
        </p>
      ) : null}

      {phase === "submitted" ? (
        <div className="space-y-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> Your video job is queued
          </div>
          <p className="text-xs leading-relaxed text-zinc-400">
            Job {submittedJobId?.slice(0, 8)} has been added to your private processing queue.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link to="/library" className="text-xs font-medium text-violet-300 hover:text-violet-200">View job progress and clips →</Link>
            <button type="button" onClick={reset} className="text-xs text-zinc-500 hover:text-zinc-300">Start another video</button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-350" />
          <p className="text-xs leading-relaxed text-zinc-500">
            Only process videos you own or are authorized to use. ClipForge does not sign into another creator's account or bypass private/subscriber-only access. For a Kick VOD you own, use Kick's creator download or provide an authorized export if the link cannot be imported.
          </p>
        </div>
      </div>

      <Card className="h-fit">
        <CardHeader title="Clip settings" description="Choose the output options for this job" />
        <div className="space-y-2 px-3 pb-5">
          <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-3 hover:bg-white/[0.03]">
            <span className="glass flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Subtitles className="h-4 w-4 text-violet-350" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-zinc-200">Burned-in captions</span>
              <span className="block text-xs leading-snug text-zinc-500">Add synchronized captions to each exported clip</span>
            </span>
            <input
              type="checkbox"
              checked={captionsEnabled}
              onChange={(event) => setCaptionsEnabled(event.target.checked)}
              disabled={busy || phase === "submitted"}
              className="h-5 w-5 shrink-0 accent-violet-500"
              aria-label="Burned-in captions"
            />
          </label>
          <div className="flex items-center gap-3 rounded-lg px-2 py-3">
            <span className="glass flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Sparkles className="h-4 w-4 text-violet-350" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-zinc-200">AI moment detection</span>
              <span className="block text-xs leading-snug text-zinc-500">Required to identify candidate highlights</span>
            </span>
            <Badge tone="zinc">Required</Badge>
          </div>
          <div className="flex items-center gap-3 rounded-lg px-2 py-3">
            <span className="glass flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Scissors className="h-4 w-4 text-violet-350" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-zinc-200">Vertical export</span>
              <span className="block text-xs leading-snug text-zinc-500">Finished clips are currently exported in 9:16</span>
            </span>
            <Badge tone="zinc">Fixed 9:16</Badge>
          </div>
        </div>
      </Card>
    </div>
  );
}
