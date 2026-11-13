import { Menu, Plus, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/components/auth/session-gate";

export function Topbar({ onOpenMobile }: { onOpenMobile: () => void }) {
  const navigate = useNavigate();
  const user = useCurrentUser();

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b hairline bg-ink-950/70 px-4 backdrop-blur-xl lg:px-6">
      <button
        className="text-zinc-400 hover:text-zinc-100 lg:hidden"
        onClick={onOpenMobile}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="ml-auto flex min-w-0 items-center gap-3">
        <div className="hidden min-w-0 items-center gap-2 sm:flex" title={user.email}>
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-300" />
          <span className="max-w-52 truncate text-xs text-zinc-500">{user.email}</span>
        </div>
        <Button onClick={() => navigate("/upload")}>
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New upload</span>
          <span className="sm:hidden">Upload</span>
        </Button>
      </div>
    </header>
  );
}
