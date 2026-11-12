import { Play, Pause, Volume2, Maximize2 } from "lucide-react";
import { cn, formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Player chrome around a solid-black media area. Real playback and frame
 * previews will be connected when authenticated media URLs are available.
 */
export function VideoMonitor({
  playing,
  onTogglePlay,
  currentSec,
  totalSec,
  vertical,
  onSeek,
  className,
}: {
  hue: number;
  playing: boolean;
  onTogglePlay: () => void;
  currentSec: number;
  totalSec: number;
  vertical?: boolean;
  onSeek?: (sec: number) => void;
  subtitle?: string;
  className?: string;
}) {
  const pct = totalSec > 0 ? (currentSec / totalSec) * 100 : 0;

  return (
    <div className={cn("glass overflow-hidden rounded-xl shadow-glass", className)}>
      <div className="flex items-center justify-between border-b hairline px-4 py-2.5">
        <span className="font-mono text-[11px] tracking-wider text-zinc-500 uppercase">
          Preview {vertical ? "· 9:16 vertical" : "· 16:9"}
        </span>
        <span className="font-mono text-[11px] text-zinc-500">
          {formatDuration(currentSec)} / {formatDuration(totalSec)}
        </span>
      </div>

      <div
        aria-label="Video preview unavailable"
        className={cn(
          "relative mx-auto my-5 overflow-hidden rounded-lg bg-black",
          vertical ? "aspect-[9/16] h-[380px] max-w-full" : "aspect-video w-[calc(100%-2rem)]"
        )}
      />

      <div className="border-t hairline px-4 py-3">
        <input
          type="range"
          min={0}
          max={totalSec}
          step={0.1}
          value={currentSec}
          aria-label="Seek preview"
          onChange={(e) => onSeek?.(Number(e.target.value))}
          className="w-full accent-violet-450"
          style={{
            background: `linear-gradient(to right, rgba(154,134,245,0.6) ${pct}%, rgba(255,255,255,0.08) ${pct}%)`,
          }}
        />
        <div className="mt-2.5 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onTogglePlay}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {playing ? "Pause" : "Play"}
          </Button>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Volume">
              <Volume2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Fullscreen">
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
