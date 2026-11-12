import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Download, SkipBack, SkipForward, Flame, MessageSquareQuote, Gauge, Captions } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VideoMonitor } from "@/components/video/video-monitor";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { mockCandidates } from "@/lib/mock-data";
import { cn, formatTimecode } from "@/lib/utils";

const SOURCE_DURATION = 3600;

export function EditorPage() {
  const [candidateId, setCandidateId] = useState(mockCandidates[0].id);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(mockCandidates[0].startSec);
  const [startSec, setStartSec] = useState(mockCandidates[0].startSec);
  const [endSec, setEndSec] = useState(mockCandidates[0].endSec);
  const [captions, setCaptions] = useState(true);
  const [resolution, setResolution] = useState("1080 × 1920");
  const [reframe, setReframe] = useState(true);
  const raf = useRef<number>();

  const candidate = mockCandidates.find((c) => c.id === candidateId) ?? mockCandidates[0];

  // Load candidate into the trim region
  useEffect(() => {
    setStartSec(candidate.startSec);
    setEndSec(candidate.endSec);
    setCurrentSec(candidate.startSec);
    setPlaying(false);
  }, [candidate]);

  // Simulated playback cursor (no real media behind it yet)
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setCurrentSec((s) => {
        const next = s + dt;
        if (next >= endSec) {
          setPlaying(false);
          return startSec;
        }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== undefined) cancelAnimationFrame(raf.current);
    };
  }, [playing, startSec, endSec]);

  const pct = (s: number) => (s / SOURCE_DURATION) * 100;
  const clipDuration = useMemo(() => Math.max(0, endSec - startSec), [startSec, endSec]);

  const jump = (d: number) =>
    setCurrentSec((s) => Math.min(endSec, Math.max(startSec, s + d)));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/library">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" /> Library
          </Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight text-zinc-100">
            {candidate.title}
          </h1>
          <p className="text-xs text-zinc-500">
            Q3 Product Keynote — candidate {mockCandidates.findIndex((c) => c.id === candidateId) + 1} of{" "}
            {mockCandidates.length}
          </p>
        </div>
        <Button
          onClick={() =>
            alert(
              `Render requested: ${formatTimecode(startSec)} → ${formatTimecode(endSec)} · ${resolution} · captions ${captions ? "on" : "off"} (mock — POST /api/jobs/:id/candidates/:cid/select).`
            )
          }
        >
          <Download className="h-4 w-4" /> Export clip
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Preview + timeline */}
        <div className="space-y-4 xl:col-span-2">
          <Card className="p-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
              <VideoMonitor
                hue={262}
                playing={playing}
                onTogglePlay={() => setPlaying((p) => !p)}
                currentSec={currentSec}
                totalSec={SOURCE_DURATION}
                onSeek={setCurrentSec}
                subtitle={
                  captions && currentSec >= startSec + 2 && currentSec <= endSec - 3
                    ? candidate.transcript.split("—").pop()?.trim()
                    : undefined
                }
              />
              {/* Vertical 9:16 preview */}
              <VideoMonitor
                hue={278}
                vertical
                playing={playing}
                onTogglePlay={() => setPlaying((p) => !p)}
                currentSec={currentSec}
                totalSec={SOURCE_DURATION}
                onSeek={setCurrentSec}
                subtitle={
                  captions && currentSec >= startSec + 2 && currentSec <= endSec - 3
                    ? candidate.transcript.split("—").pop()?.trim()
                    : undefined
                }
                className="hidden md:block"
              />
            </div>

            {/* Timeline */}
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-zinc-500">
                <span>Timeline</span>
                <span className="font-mono">{formatTimecode(SOURCE_DURATION)}</span>
              </div>
              <div className="relative h-16 overflow-hidden rounded-lg hairline bg-white/[0.02]">
                {/* waveform-ish activity bars */}
                <div className="absolute inset-0 flex items-end gap-[2px] px-1 pb-1 opacity-40">
                  {Array.from({ length: 120 }, (_, i) => {
                    const x = Math.sin(i * 12.9898) * 43758.5453;
                    const h = 12 + (x - Math.floor(x)) * 40;
                    const inClip = i / 120 >= pct(startSec) / 100 && i / 120 <= pct(endSec) / 100;
                    return (
                      <div
                        key={i}
                        className={cn("flex-1 rounded-sm", inClip ? "bg-violet-450/70" : "bg-white/15")}
                        style={{ height: `${h}%` }}
                      />
                    );
                  })}
                </div>
                {/* clip region */}
                <div
                  className="absolute inset-y-0 border-x-2 border-violet-450 bg-violet-550/[0.08]"
                  style={{ left: `${pct(startSec)}%`, right: `${100 - pct(endSec)}%` }}
                />
                {/* playhead */}
                <div
                  className="absolute inset-y-0 w-px bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                  style={{ left: `${pct(currentSec)}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={SOURCE_DURATION}
                  step={0.1}
                  value={currentSec}
                  aria-label="Scrub timeline"
                  onChange={(e) => setCurrentSec(Number(e.target.value))}
                  className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
                />
              </div>
            </div>

            {/* Trim controls */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="glass flex items-center gap-2 rounded-lg px-3 py-2">
                <label className="text-[11px] text-zinc-500" htmlFor="start">Start</label>
                <input
                  id="start"
                  type="number"
                  min={0}
                  max={SOURCE_DURATION}
                  value={Math.round(startSec)}
                  onChange={(e) => setStartSec(Math.min(endSec - 1, Math.max(0, Number(e.target.value))))}
                  className="w-20 bg-transparent font-mono text-sm text-zinc-200 focus:outline-none"
                />
              </div>
              <div className="glass flex items-center gap-2 rounded-lg px-3 py-2">
                <label className="text-[11px] text-zinc-500" htmlFor="end">End</label>
                <input
                  id="end"
                  type="number"
                  min={0}
                  max={SOURCE_DURATION}
                  value={Math.round(endSec)}
                  onChange={(e) => setEndSec(Math.max(startSec + 1, Math.min(SOURCE_DURATION, Number(e.target.value))))}
                  className="w-20 bg-transparent font-mono text-sm text-zinc-200 focus:outline-none"
                />
              </div>
              <Badge tone="violet" className="font-mono">
                {clipDuration.toFixed(1)}s selected
              </Badge>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => jump(-5)}>
                  <SkipBack className="h-4 w-4" /> -5s
                </Button>
                <Button variant="ghost" size="sm" onClick={() => jump(5)}>
                  +5s <SkipForward className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>

          {/* Subtitle preview */}
          <Card>
            <CardHeader
              title="Subtitle preview"
              description="Transcript segment inside the selected region"
              action={
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <Captions className="h-4 w-4" /> Captions
                  <Switch checked={captions} onCheckedChange={setCaptions} label="Toggle captions" />
                </div>
              }
            />
            <p className="px-5 pb-5 text-sm leading-relaxed text-zinc-300">
              <span className="font-mono text-xs text-zinc-600">{formatTimecode(startSec)} → </span>
              “{candidate.transcript.trim()}”
            </p>
          </Card>
        </div>

        {/* Right rail: candidates + export */}
        <div className="space-y-4">
          <Card>
            <CardHeader title="Detected moments" description="AI candidates — human review required" />
            <ul className="space-y-1 px-2 pb-3">
              {mockCandidates.map((c, i) => (
                <li key={c.id}>
                  <button
                    onClick={() => setCandidateId(c.id)}
                    className={cn(
                      "w-full rounded-lg px-3 py-2.5 text-left transition-colors duration-200",
                      c.id === candidateId
                        ? "bg-violet-550/[0.12] ring-1 ring-violet-550/30"
                        : "hover:bg-white/[0.04]"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-zinc-200">
                        {i + 1}. {c.title}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                        {c.startSec}s–{c.endSec}s
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-xs text-zinc-500">{c.reason}</p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Review scores" description="Estimates — not virality guarantees" />
            <div className="space-y-3 px-5 pb-5">
              {[
                { icon: Flame, label: "Hook", value: candidate.hookScore },
                { icon: MessageSquareQuote, label: "Context", value: candidate.contextScore },
                { icon: Gauge, label: "Payoff", value: candidate.payoffScore },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0 text-violet-350/80" />
                  <span className="w-16 text-[13px] text-zinc-400">{label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
                    <div
                      className="h-full rounded-full bg-violet-450"
                      style={{ width: `${value}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono text-xs text-zinc-400">{value}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Export settings" />
            <div className="space-y-4 px-5 pb-5">
              <div>
                <label className="text-xs font-medium text-zinc-500" htmlFor="res">Resolution</label>
                <Select id="res" className="mt-1.5" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                  <option>1080 × 1920</option>
                  <option>720 × 1280</option>
                  <option>1920 × 1080</option>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13px] text-zinc-300">Burn captions</p>
                  <p className="text-xs text-zinc-500">Styled subtitle track on export</p>
                </div>
                <Switch checked={captions} onCheckedChange={setCaptions} label="Burn captions" />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13px] text-zinc-300">Auto reframe</p>
                  <p className="text-xs text-zinc-500">Keep speaker centered in 9:16 crop</p>
                </div>
                <Switch checked={reframe} onCheckedChange={setReframe} label="Auto reframe" />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
