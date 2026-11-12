import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("glass rounded-xl shadow-glass", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-4 pb-3", className)}>
      <div>
        <h3 className="text-[15px] font-semibold text-zinc-100">{title}</h3>
        {description ? <p className="mt-0.5 text-[13px] text-zinc-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
