import { Menu, Plus, Search, Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function Topbar({ onOpenMobile }: { onOpenMobile: () => void }) {
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b hairline bg-ink-950/70 px-4 backdrop-blur-xl lg:px-6">
      <button
        className="text-zinc-400 hover:text-zinc-100 lg:hidden"
        onClick={onOpenMobile}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="relative max-w-md flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
        <Input
          placeholder="Search clips, projects, moments…"
          className="pl-9"
          aria-label="Search"
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate("/library");
          }}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="Notifications"
          onClick={() => alert("No new notifications — processing is on track.")}
        >
          <Bell className="h-4 w-4" />
        </Button>
        <Button onClick={() => navigate("/upload")}>
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New upload</span>
          <span className="sm:hidden">Upload</span>
        </Button>
      </div>
    </header>
  );
}
