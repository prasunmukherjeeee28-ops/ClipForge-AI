import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CloudUpload,
  FileVideo,
  X,
  CheckCircle2,
  Scissors,
  Sparkles,
  Subtitles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn, formatBytes } from "@/lib/utils";

type Phase = "idle" | "uploading" | "ready" | "analyzing";

const ACCEPTED = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];

export function UploadPage() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const [detectMoments, setDetectMoments] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [vertical, setVertical] = useState(true);
  const [reviewScores, setReviewScores] = useState(true);
  const [language, setLanguage] = useState("auto");

  const pickFile = useCallback((f: File | undefined | null) => {
    setError(null);
    if (!f) return;
    if (!ACCEPTED.includes(f.type)) {
      setError("Unsupported format. Use MP4, MOV, WebM or MKV.");
      return;
    }
    if (f.size > 10 * 1024 * 1024 * 1024) {
      setError("File exceeds the 10 GB upload limit.");
      return;
    }
    setFile(f);
    setProgress(0);
    setPhase("uploading");
  }, []);

  // Simulated upload progress — the real uploader will POST to /api/uploads
  // and stream real progress from the signed upload.
  useEffect(() => {
    if (phase !== "uploading") return;
    const t = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(t);
          setPhase("ready");
          return 100;
        }
        return Math.min(100, p + Math.random() * 14);
      });
    }, 220);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (phase !== "analyzing") return;
    const t = setTimeout(() => navigate("/library"), 1400);
    return () => clearTimeout(t);
  }, [phase, navigate]);

  const reset = () => {
    setFile(null);
    setPreviewUrl(null);
    setProgress(0);
    setPhase("idle");
    setError(null);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Upload a source</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Add a video you own or are authorized to process. ClipForge AI will propose the moments
          worth clipping.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Left: dropzone / preview */}
        <div className="space-y-4 lg:col-span-3">
          {!file ? (
            <button
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files?.[0]);
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
                MP4, MOV, WebM, MKV · up to 10 GB · stored in private R2
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
                  {phase === "ready" || phase === "analyzing" ? (
                    <Badge tone="green">
                      <CheckCircle2 className="h-3 w-3" /> Uploaded
                    </Badge>
                  ) : (
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={reset} aria-label="Remove file">
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                {phase === "uploading" ? (
                  <div>
                    <div className="mb-1.5 flex justify-between text-xs text-zinc-500">
                      <span>Uploading…</span>
                      <span className="font-mono">{Math.floor(progress)}%</span>
                    </div>
                    <Progress value={progress} />
                  </div>
                ) : null}

                {phase === "analyzing" ? (
                  <div className="flex items-center gap-2 text-[13px] text-violet-350">
                    <Sparkles className="h-4 w-4 animate-pulse" />
                    Analysis started — heading to your clip library…
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
            onChange={(e) => pickFile(e.target.files?.[0])}
            aria-hidden
          />
        </div>

        {/* Right: analysis settings */}
        <Card className="h-fit lg:col-span-2">
          <CardHeader title="Analysis settings" description="What the AI pipeline should do" />
          <div className="space-y-1 px-3 pb-5">
            {[
              {
                icon: Scissors,
                label: "Detect moments",
                desc: "Find highlight candidates from transcript + audiovisual cues",
                value: detectMoments,
                set: setDetectMoments,
              },
              {
                icon: Subtitles,
                label: "Auto captions",
                desc: "Transcribe and burn in synced captions",
                value: captions,
                set: setCaptions,
              },
              {
                icon: Sparkles,
                label: "Review scores",
                desc: "Hook / context / payoff estimates per candidate",
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
                <Switch checked={value} onCheckedChange={set} label={label} />
              </div>
            ))}

            <div className="mt-2 border-t hairline px-2 pt-3">
              <label className="text-xs font-medium text-zinc-500" htmlFor="aspect">
                Export framing
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2" id="aspect" role="radiogroup" aria-label="Export framing">
                {[
                  { v: "horizontal", label: "16:9 landscape", on: !vertical },
                  { v: "vertical", label: "9:16 vertical", on: vertical },
                ].map(({ v, label, on }) => (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={on}
                    onClick={() => setVertical(v === "vertical")}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-[13px] transition-all duration-200",
                      on
                        ? "border-violet-550/50 bg-violet-550/10 text-zinc-100"
                        : "hairline text-zinc-500 hover:text-zinc-300"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="mt-3 block text-xs font-medium text-zinc-500" htmlFor="lang">
                Transcript language
              </label>
              <select
                id="lang"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="mt-1.5 h-9 w-full rounded-lg glass px-3 text-sm text-zinc-200 [&>option]:bg-ink-800"
              >
                <option value="auto">Auto-detect</option>
                <option value="en">English</option>
                <option value="hi">Hindi</option>
                <option value="es">Spanish</option>
              </select>
            </div>

            <div className="px-2 pt-4">
              <Button
                className="w-full"
                size="lg"
                disabled={!file || phase !== "ready"}
                onClick={() => setPhase("analyzing")}
              >
                <Scissors className="h-4 w-4" />
                Start clipping
              </Button>
              <p className="mt-2 text-center text-[11px] leading-relaxed text-zinc-600">
                Creates a queued job (POST /api/jobs) and enqueues the processor.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
