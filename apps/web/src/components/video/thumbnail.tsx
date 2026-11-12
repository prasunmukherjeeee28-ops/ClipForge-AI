import { Play, Captions } from "lucide-react";
import { cn, formatDuration } from "@/lib/utils";

/**
 * Procedural poster stand-in. The real product renders actual frame
 * thumbnails from R2 via authenticated media URLs; until the backend
 * ships we draw a deterministic violet-tinted "frame" from the clip hue.
 */
export function Thumbnail({
  hue,
  durationSec,
  aspect = "video",
  captions,
  className,
  active,
}: {
  hue: number;
  durationSec?: number;
  aspect?: "video" | "vertical" | "square";
  captions?: boolean;
  className?: string;
  active?: boolean;
}) {
  const aspectCls =
    aspect === "vertical"
      ? "aspect-[9/16]"
      : aspect === "square"
        ? "aspect-square"
        : "aspect-video";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg bg-ink-800",
        aspectCls,
        className
      )}
    >
      <div
        className="absolute inset-0 transition-transform duration-300 ease-smooth group-hover:scale-[1.03]"
        style={{
          background: `
            radial-gradient(120% 90% at 30% 20%, hsla(${hue}, 70%, 32%, 0.55), transparent 60%),
            radial-gradient(120% 100% at 75% 85%, hsla(${(hue + 40) % 360}, 65%, 22%, 0.5), transparent 65%),
            linear-gradient(160deg, hsl(${hue}, 25%, 12%), hsl(${(hue + 20) % 360}, 30%, 7%))
          `,
        }}
      />
      {/* scanline texture to feel like a paused frame */}
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, #fff 3px)",
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="glass flex h-10 w-10 items-center justify-center rounded-full opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <Play className="h-4 w-4 fill-white text-white" />
        </div>
      </div>
      {captions ? (
        <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
          <Captions className="h-3 w-3" /> CC
        </div>
      ) : null}
      {typeof durationSec === "number" ? (
        <div className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200">
          {formatDuration(durationSec)}
        </div>
      ) : null}
      {active ? (
        <div className="absolute inset-0 rounded-lg ring-2 ring-violet-450" />
      ) : null}
    </div>
  );
}
