import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9.5 w-full rounded-lg glass px-3.5 text-sm text-zinc-200 placeholder:text-zinc-600",
        "transition-colors duration-200 focus:border-violet-550/50",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
