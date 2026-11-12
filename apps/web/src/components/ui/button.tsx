import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "icon";

const variants: Record<Variant, string> = {
  primary:
    "bg-violet-550 text-white hover:bg-violet-450 active:bg-violet-550/90 shadow-[0_8px_24px_-8px_rgba(124,99,238,0.5)]",
  secondary:
    "glass text-zinc-200 hover:bg-white/[0.08] hover:border-white/[0.14]",
  ghost: "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]",
  danger:
    "bg-red-500/10 text-red-300 border border-red-500/25 hover:bg-red-500/15",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9.5 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
  icon: "h-9 w-9",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium",
        "transition-all duration-200 ease-smooth select-none",
        "disabled:pointer-events-none disabled:opacity-45 active:scale-[0.98]",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = "Button";
