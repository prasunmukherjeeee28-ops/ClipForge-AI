import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className={cn("relative", className)}>
    <select
      ref={ref}
      className={cn(
        "h-9.5 w-full appearance-none rounded-lg glass pl-3.5 pr-9 text-sm text-zinc-200",
        "transition-colors duration-200 focus:border-violet-550/50 [&>option]:bg-ink-800"
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
  </div>
));
Select.displayName = "Select";
