import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Upload,
  Library,
  Scissors,
  Radar,
  Settings,
  Clapperboard,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/upload", label: "Upload", icon: Upload },
  { to: "/library", label: "Clip Library", icon: Library },
  { to: "/editor", label: "Clip Editor", icon: Scissors },
  { to: "/live-radar", label: "Live Radar", icon: Radar },
];

export function Sidebar({
  mobileOpen,
  onCloseMobile,
}: {
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  return (
    <>
      {/* Mobile scrim */}
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onCloseMobile}
          aria-hidden
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r hairline bg-ink-900/80 backdrop-blur-xl",
          "transition-transform duration-300 ease-smooth lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-16 items-center justify-between gap-2 border-b hairline px-5">
          <NavLink to="/" className="flex items-center gap-2.5" onClick={onCloseMobile}>
            <span className="glass flex h-8 w-8 items-center justify-center rounded-lg">
              <Clapperboard className="h-4 w-4 text-violet-350" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-zinc-100">
              ClipForge <span className="text-violet-350">AI</span>
            </span>
          </NavLink>
          <button
            className="text-zinc-500 hover:text-zinc-200 lg:hidden"
            onClick={onCloseMobile}
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto scroll-slim px-3 py-4" aria-label="Primary">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onCloseMobile}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-200 ease-smooth",
                  isActive
                    ? "bg-white/[0.06] text-zinc-100 shadow-[inset_2px_0_0_0_#9a86f5]"
                    : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
                )
              }
            >
              <Icon className="h-4 w-4 opacity-80 transition-transform duration-200 group-hover:scale-110" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t hairline p-3">
          <NavLink
            to="/settings"
            onClick={onCloseMobile}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-200",
                isActive ? "bg-white/[0.06] text-zinc-100" : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
              )
            }
          >
            <Settings className="h-4 w-4 opacity-80" />
            Settings
          </NavLink>
        </div>
      </aside>
    </>
  );
}
