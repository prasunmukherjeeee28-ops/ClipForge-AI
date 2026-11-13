import { Link } from "react-router-dom";
import { RadioTower, Upload, Video } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function LiveRadarPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Live Clip Radar</h1>
          <p className="mt-1 text-sm text-zinc-500">Live capture and streaming analysis are not enabled in this VOD release.</p>
        </div>
        <Badge tone="zinc">Not active</Badge>
      </div>

      <Card className="p-6">
        <div className="flex flex-col items-center py-8 text-center">
          <span className="glass flex h-14 w-14 items-center justify-center rounded-2xl">
            <RadioTower className="h-6 w-6 text-violet-350" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-zinc-100">Live monitoring is a later milestone</h2>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-zinc-500">
            The current processor handles completed VODs and authorized video exports. It does not record live streams, monitor third-party streams in real time, or claim that demo streams are active.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Link to="/upload"><Button><Upload className="h-4 w-4" /> Process a VOD</Button></Link>
            <Link to="/library"><Button variant="secondary"><Video className="h-4 w-4" /> Open clip library</Button></Link>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Planned next stage" description="After the VOD-to-MP4 path is tested against real storage and a processor host" />
        <div className="space-y-3 px-5 pb-5">
          {[
            "Authorized live-source ingestion and capture lifecycle",
            "Continuous audio/video sampling with bounded CPU and disk usage",
            "Near-real-time moment detection and short rolling buffers",
            "Owner-scoped live candidates and cancellation/recovery",
          ].map((item, index) => (
            <div key={item} className="flex items-start gap-3 text-sm text-zinc-400">
              <span className="font-mono text-xs text-violet-300">{String(index + 1).padStart(2, "0")}</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
