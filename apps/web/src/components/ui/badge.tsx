import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const tones = {
  violet: "bg-violet-550/15 text-violet-350 border-violet-550/25",
  green: "bg-emerald-400/10 text-emerald-300 border-emerald-400/20",
  amber: "bg-amber-400/10 text-amber-300 border-amber-400/20",
  red: "bg-red-400/10 text-red-300 border-red-400/20",
  zinc: "bg-white/[0.05] text-zinc-400 border-white/[0.08]",
} as const;

export function Badge({
  tone = "zinc",
  className,
  children,
}: {
  tone?: keyof typeof tones;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-wide",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
