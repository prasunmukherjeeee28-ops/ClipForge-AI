import { Link } from "react-router-dom";
import { ArrowLeft, Captions, Film, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function EditorPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/library">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" /> Library
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Clip editor</h1>
          <p className="mt-1 text-sm text-zinc-500">Editing controls are not part of the current release.</p>
        </div>
      </div>

      <Card className="p-6">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-violet-400/20 bg-violet-400/[0.08]">
          <Scissors className="h-5 w-5 text-violet-300" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-100">ClipForge creates the finished clip automatically</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          The current workflow detects candidate moments, renders vertical MP4s and burns subtitles into the export. It does not yet provide a manual timeline, trim editor or re-export controls.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="glass flex items-start gap-3 rounded-lg p-3">
            <Film className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Finished MP4s</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">Preview and download completed clips from your private library.</p>
            </div>
          </div>
          <div className="glass flex items-start gap-3 rounded-lg p-3">
            <Captions className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Subtitles</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">Captions are rendered by the processing pipeline rather than edited here.</p>
            </div>
          </div>
        </div>
        <Link to="/library" className="mt-6 inline-flex">
          <Button>Open my clip library</Button>
        </Link>
      </Card>
    </div>
  );
}
