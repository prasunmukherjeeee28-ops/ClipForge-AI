import { useMemo, useState } from "react";
import {
  Radio,
  RadioTower,
  Flame,
  MessageSquareQuote,
  TrendingUp,
  Clock3,
  CircleDot,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { mockRadarCandidates, mockRadarTimeline, mockStreams } from "@/lib/mock-data";
import { cn, formatDuration } from "@/lib/utils";
import type { RadarMoment } from "@/lib/types";

const kindMeta: Record<RadarMoment["kind"], { icon: typeof Flame; label: string; tone: "violet" | "green" | "amber" }> = {
  hype: { icon: Flame, label: "Hype spike", tone: "violet" },
  clip_spike: { icon: TrendingUp, label: "Clip spike", tone: "amber" },
  quote: { icon: MessageSquareQuote, label: "Quote moment", tone: "green" },
};

export function LiveRadarPage() {
  const [streamId, setStreamId] = useState("str_1");
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const stream = mockStreams.find((s) => s.id === streamId) ?? mockStreams[0];
  const timeline = useMemo(
    () => mockRadarTimeline.filter((m) => m.streamId === streamId),
    [streamId]
  );
  const candidates = mockRadarCandidates.filter((m) => m.streamId === streamId);
  const maxIntensity = 100;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Live Clip Radar</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Monitors authorized streams for clip-worthy moments in real time.
          </p>
        </div>
        <Badge tone={stream.status === "live" ? "green" : "zinc"}>
          <CircleDot className={cn("h-3 w-3", stream.status === "live" && "animate-pulse text-emerald-400")} />
          {stream.status === "live" ? "Monitoring live" : "Offline"}
        </Badge>
      </div>

      {/* Stream selector */}
      <div className="grid gap-3 md:grid-cols-3">
        {mockStreams.map((s) => (
          <button
            key={s.id}
            onClick={() => setStreamId(s.id)}
            className={cn(
              "glass glass-hover rounded-xl px-4 py-3.5 text-left transition-all duration-200",
              s.id === streamId && "ring-1 ring-violet-550/40"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                <Radio className="h-4 w-4 text-violet-350" />
                {s.name}
              </span>
              <Badge tone={s.status === "live" ? "green" : "zinc"}>{s.status}</Badge>
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">
              {s.status === "live"
                ? `${s.viewers.toLocaleString()} viewers · up ${formatDuration(s.uptimeSec)}`
                : "Last seen 2 days ago"}
            </p>
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Highlight timeline */}
        <Card className="xl:col-span-2">
          <CardHeader
            title="Highlight timeline"
            description="Signal intensity over the monitored session"
            action={<RadioTower className="h-4 w-4 text-violet-350/70" />}
          />
          <div className="px-5 pb-5">
            <div className="flex h-40 items-end gap-[3px]">
              {timeline.map((m) => {
                const h = 8 + (m.intensity / maxIntensity) * 92;
                const strong = m.intensity > 78 && m.title;
                return (
                  <div
                    key={m.id}
                    title={`${formatDuration(m.atSec)} · intensity ${m.intensity}${m.title ? ` · ${m.title}` : ""}`}
                    className={cn(
                      "group relative flex-1 rounded-t-sm transition-all duration-200",
                      strong ? "bg-violet-450" : "bg-white/[0.12] hover:bg-white/25",
                      saved.has(m.id) && strong && "bg-emerald-400"
                    )}
                    style={{ height: `${h}%` }}
                  >
                    {strong ? (
                      <span className="absolute -top-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-full rounded-full bg-violet-350 opacity-0 transition-opacity group-hover:opacity-100" />
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between font-mono text-[11px] text-zinc-600">
              <span>0:00</span>
              <span>{formatDuration(timeline.length * 180)}</span>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-violet-450" /> Strong candidate</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-emerald-400" /> Saved</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-white/20" /> Background activity</span>
            </div>
          </div>
        </Card>

        {/* Candidate clips */}
        <Card className="h-fit">
          <CardHeader title="Candidate clips" description={`${candidates.length} strong moments detected`} />
          <ul className="space-y-2.5 px-5 pb-5">
            {candidates.length === 0 ? (
              <p className="text-[13px] text-zinc-500">
                No strong candidates yet — the radar keeps listening.
              </p>
            ) : (
              candidates.map((m) => {
                const meta = kindMeta[m.kind];
                const Icon = meta.icon;
                const isSaved = saved.has(m.id);
                return (
                  <li
                    key={m.id}
                    className="glass flex items-start gap-3 rounded-xl px-3.5 py-3"
                  >
                    <span className="glass mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                      <Icon className="h-4 w-4 text-violet-350" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-[13px] font-medium text-zinc-200">{m.title}</p>
                        <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                          <Clock3 className="mr-1 inline h-3 w-3" />
                          {formatDuration(m.atSec)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        <span className="font-mono text-[11px] text-zinc-500">
                          intensity {m.intensity}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant={isSaved ? "secondary" : "ghost"}
                        className="mt-2 h-7 px-2.5 text-xs"
                        onClick={() =>
                          setSaved((prev) => {
                            const next = new Set(prev);
                            if (next.has(m.id)) next.delete(m.id);
                            else next.add(m.id);
                            return next;
                          })
                        }
                      >
                        {isSaved ? "Saved to library" : "Save as clip"}
                      </Button>
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </Card>
      </div>
    </div>
  );
}
