import { Link } from "react-router-dom";
import {
  Upload,
  Scissors,
  Clock3,
  HardDrive,
  ArrowRight,
  FolderOpen,
  Loader2,
  CheckCircle2,
  Activity as ActivityIcon,
  FileVideo,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/empty-state";
import { Thumbnail } from "@/components/video/thumbnail";
import { mockActivity, mockClips, mockProjects } from "@/lib/mock-data";
import { formatDuration, cn } from "@/lib/utils";
import type { JobStage } from "@/lib/types";
export type { JobStage };

const stageMeta: Record<string, { icon: typeof Loader2; tone: "violet" | "green" | "amber" | "zinc" }> = {
  uploading: { icon: Upload, tone: "amber" },
  transcribing: { icon: FileVideo, tone: "violet" },
  analyzing: { icon: ActivityIcon, tone: "violet" },
  finding_moments: { icon: Scissors, tone: "violet" },
  rendering: { icon: Loader2, tone: "amber" },
  done: { icon: CheckCircle2, tone: "green" },
  info: { icon: CheckCircle2, tone: "zinc" },
};

const statusTone: Record<string, "violet" | "green" | "amber" | "zinc" | "red"> = {
  review: "violet",
  completed: "green",
  processing: "amber",
  queued: "zinc",
  failed: "red",
};

export function DashboardPage() {
  const recentClips = mockClips.slice(0, 4);
  const recentProjects = mockProjects.slice(0, 3);

  return (
    <div className="space-y-6">
      {/* Hero strip */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            Good evening, Piyush
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            One job is finding moments, one clip is rendering.{" "}
            <span className="text-zinc-400">Everything else is reviewed and ready.</span>
          </p>
        </div>
        <Button onClick={() => (window.location.href = "/upload")}>
          <Upload className="h-4 w-4" />
          Quick upload
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Clips forged", value: "23", icon: Scissors, delta: "+4 this week" },
          { label: "Processing time saved", value: "9.2h", icon: Clock3, delta: "vs. manual editing" },
          { label: "Storage used", value: "18.4 GB", icon: HardDrive, delta: "of 100 GB" },
          { label: "Avg. review score", value: "79", icon: CheckCircle2, delta: "top clip: 91" },
        ].map(({ label, value, icon: Icon, delta }) => (
          <Card key={label} className="glass-hover px-5 py-4">
            <div className="flex items-center justify-between">
              <p className="text-[13px] text-zinc-500">{label}</p>
              <Icon className="h-4 w-4 text-violet-350/80" />
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">{value}</p>
            <p className="mt-1 text-xs text-zinc-600">{delta}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader
              title="Recent projects"
              description="Sources you uploaded and their analysis status"
              action={
                <Link to="/library">
                  <Button variant="ghost" size="sm">
                    View library <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              }
            />
            <ul className="divide-y divide-white/[0.05] px-2 pb-2">
              {recentProjects.map((p) => (
                <li key={p.id}>
                  <Link
                    to="/library"
                    className="flex items-center gap-4 rounded-lg px-3 py-3 transition-colors duration-200 hover:bg-white/[0.04]"
                  >
                    <Thumbnail hue={p.thumbHue} className="w-24 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-200">{p.title}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {formatDuration(p.sourceDurationSec)} source ·{" "}
                        {p.clipCount > 0 ? `${p.clipCount} clips` : "analysis running"}
                      </p>
                    </div>
                    <Badge tone={statusTone[p.status] ?? "zinc"}>{p.status}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Recent clips"
              description="Latest exports ready for review or download"
              action={
                <Link to="/library">
                  <Button variant="ghost" size="sm">
                    All clips <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              }
            />
            {recentClips.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 px-5 pb-5 md:grid-cols-4">
                {recentClips.map((c) => (
                  <Link key={c.id} to="/editor" className="group space-y-2">
                    <Thumbnail hue={c.thumbHue} durationSec={c.durationSec} aspect={c.aspect === "9:16" ? "vertical" : "video"} captions={c.captions} />
                    <p className="line-clamp-2 text-xs leading-snug text-zinc-400 group-hover:text-zinc-200">
                      {c.title}
                    </p>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                className="mx-5 mb-5"
                icon={Scissors}
                title="No clips yet"
                description="Upload a source video and ClipForge AI will propose the moments worth cutting."
                action={
                  <Link to="/upload">
                    <Button size="sm" variant="secondary">
                      Upload your first video
                    </Button>
                  </Link>
                }
              />
            )}
          </Card>
        </div>

        {/* Right column: processing activity */}
        <Card className="h-fit">
          <CardHeader title="Processing activity" description="Live queue status (mock feed)" />
          <ul className="space-y-4 px-5 pb-5">
            {mockActivity.map((a) => {
              const meta = stageMeta[a.stage];
              const Icon = meta.icon;
              const active = a.progress > 0 && a.progress < 100;
              return (
                <li key={a.id} className="flex gap-3">
                  <span className="glass mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                    <Icon className={cn("h-4 w-4 text-violet-350", active && "animate-spin [animation-duration:2.5s]")} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[13px] font-medium text-zinc-200">{a.label}</p>
                      <span className="shrink-0 text-[11px] text-zinc-600">{a.time}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">{a.detail}</p>
                    {a.progress < 100 ? (
                      <Progress className="mt-2" value={a.progress} />
                    ) : (
                      <Badge tone="green" className="mt-2">
                        <CheckCircle2 className="h-3 w-3" /> Done
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="border-t hairline px-5 py-3">
            <Link to="/live-radar">
              <Button variant="ghost" size="sm" className="w-full">
                <FolderOpen className="h-4 w-4" /> Open Live Radar
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
