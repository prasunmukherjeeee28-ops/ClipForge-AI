import { Link } from "react-router-dom";
import { RadioTower, Video, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function LiveRadarPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Live Clip Radar</h1>
          <Badge tone="zinc">Not enabled</Badge>
        </div>
        <p className="mt-1 text-sm text-zinc-500">Live stream capture and real-time monitoring are not available in this release.</p>
      </div>

      <Card className="p-6">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03]">
          <RadioTower className="h-5 w-5 text-zinc-400" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-100">The current processor handles uploaded VOD files</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          ClipForge can inspect supported YouTube and Twitch video metadata, but it does not monitor a live broadcast or capture its stream. This page no longer displays sample stream activity as though it were real.
        </p>
        <div className="mt-5 space-y-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <p className="text-xs leading-relaxed text-zinc-500">
              Upload an original/export or another provider-approved file you have permission to process. A public video URL alone is not permission to download platform media.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <Video className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <p className="text-xs leading-relaxed text-zinc-500">The supported path is upload → transcription and moment detection → vertical rendering → private clip library.</p>
          </div>
        </div>
        <Link to="/upload" className="mt-6 inline-flex">
          <Button>Process an existing video</Button>
        </Link>
      </Card>
    </div>
  );
}
