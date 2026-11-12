import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.09] bg-white/[0.02] px-6 py-14 text-center",
        className
      )}
    >
      <div className="glass flex h-12 w-12 items-center justify-center rounded-xl">
        <Icon className="h-5 w-5 text-violet-350" />
      </div>
      <div>
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-zinc-500">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
