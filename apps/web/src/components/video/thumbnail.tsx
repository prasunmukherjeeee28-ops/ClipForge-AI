import { Captions } from "lucide-react";
import { cn, formatDuration } from "@/lib/utils";

/**
 * Black media placeholder used until an authenticated, real video
 * thumbnail/frame URL is available from private storage.
 */
export function Thumbnail({
  durationSec,
  aspect = "video",
  captions,
  className,
  active,
}: {
  /** Retained for compatibility with existing callers; not used for placeholders. */
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
      aria-label="Video thumbnail unavailable"
      className={cn(
        "group relative overflow-hidden rounded-lg bg-black",
        aspectCls,
        className
      )}
    >
      {captions ? (
        <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
          <Captions className="h-3 w-3" /> CC
        </div>
      ) : null}
      {typeof durationSec === "number" ? (
        <div className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200">
          {formatDuration(durationSec)}
        </div>
      ) : null}
      {active ? (
        <div className="absolute inset-0 rounded-lg ring-2 ring-violet-450" />
      ) : null}
    </div>
  );
}
