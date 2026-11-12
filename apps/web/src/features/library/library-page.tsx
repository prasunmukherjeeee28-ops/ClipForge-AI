import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  LayoutGrid,
  List,
  Search,
  Download,
  Trash2,
  Scissors,
  CheckSquare,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Thumbnail } from "@/components/video/thumbnail";
import { mockClips, mockProjects } from "@/lib/mock-data";
import { cn, formatDuration } from "@/lib/utils";

type View = "grid" | "list";
type Filter = "all" | "ready" | "processing";

export function LibraryPage() {
  const [view, setView] = useState<View>("grid");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [project, setProject] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState("9:16 MP4 · captions");

  const clips = useMemo(() => {
    return mockClips.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false;
      if (project !== "all" && c.projectId !== project) return false;
      if (query && !c.title.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [query, filter, project]);

  const allSelected = clips.length > 0 && clips.every((c) => selected.has(c.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(clips.map((c) => c.id)));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Clip library</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {mockClips.length} clips across {mockProjects.length} projects
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={view === "grid" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setView("grid")}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={view === "list" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setView("list")}
            aria-label="List view"
            aria-pressed={view === "list"}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clips…"
            aria-label="Search clips"
            className="h-9 w-full rounded-lg glass pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-550/50"
          />
        </div>
        <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter by status" className="w-36">
          <option value="all">All statuses</option>
          <option value="ready">Ready</option>
          <option value="processing">Processing</option>
        </Select>
        <Select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project" className="w-52">
          <option value="all">All projects</option>
          {mockProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
        <button
          onClick={toggleAll}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-zinc-400 transition-colors hover:text-zinc-200"
        >
          {allSelected ? (
            <CheckSquare className="h-4 w-4 text-violet-350" />
          ) : (
            <Square className="h-4 w-4" />
          )}
          Select all
        </button>
      </Card>

      {/* Selection action bar */}
      {selected.size > 0 ? (
        <div className="glass-strong flex items-center gap-3 rounded-xl px-4 py-2.5">
          <span className="text-[13px] text-zinc-300">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setExportOpen(true)}>
              <Download className="h-4 w-4" /> Export
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                setSelected(new Set());
                alert("Delete requested — the retention policy applies on the backend (mock).");
              }}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              <X className="h-4 w-4" /> Clear
            </Button>
          </div>
        </div>
      ) : null}

      {/* Clips */}
      {clips.length === 0 ? (
        <EmptyState
          icon={Scissors}
          title="No clips match your filters"
          description="Try a different search, or upload a new source to generate more clips."
          action={
            <Link to="/upload">
              <Button size="sm" variant="secondary">
                Upload a video
              </Button>
            </Link>
          }
        />
      ) : view === "grid" ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {clips.map((c) => (
            <Card key={c.id} className="glass-hover group relative p-3">
              <button
                onClick={() => toggle(c.id)}
                aria-label={selected.has(c.id) ? `Deselect ${c.title}` : `Select ${c.title}`}
                className={cn(
                  "absolute left-5 top-5 z-10 rounded-md p-0.5 transition-opacity",
                  selected.has(c.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}
              >
                {selected.has(c.id) ? (
                  <CheckSquare className="h-5 w-5 text-violet-350" />
                ) : (
                  <Square className="h-5 w-5 text-white/80 drop-shadow" />
                )}
              </button>
              <Link to="/editor" className="block space-y-2.5">
                <Thumbnail
                  hue={c.thumbHue}
                  durationSec={c.durationSec}
                  aspect={c.aspect === "9:16" ? "vertical" : c.aspect === "1:1" ? "square" : "video"}
                  captions={c.captions}
                  className={selected.has(c.id) ? "opacity-70" : ""}
                />
                <div>
                  <p className="line-clamp-2 text-[13px] font-medium leading-snug text-zinc-200">
                    {c.title}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Badge tone={c.status === "ready" ? "green" : "amber"}>{c.status}</Badge>
                    <span className="text-[11px] text-zinc-600">{c.aspect}</span>
                    {c.score > 0 ? (
                      <span className="ml-auto font-mono text-[11px] text-zinc-500">
                        score {c.score}
                      </span>
                    ) : null}
                  </div>
                </div>
              </Link>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="divide-y divide-white/[0.05]">
          {clips.map((c) => (
            <div key={c.id} className="flex items-center gap-4 px-4 py-3">
              <button onClick={() => toggle(c.id)} aria-label={`Select ${c.title}`}>
                {selected.has(c.id) ? (
                  <CheckSquare className="h-5 w-5 text-violet-350" />
                ) : (
                  <Square className="h-5 w-5 text-zinc-600 hover:text-zinc-400" />
                )}
              </button>
              <Thumbnail hue={c.thumbHue} className="w-28 shrink-0" durationSec={c.durationSec} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-200">{c.title}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {formatDuration(c.durationSec)} · {c.aspect}
                  {c.captions ? " · captions" : ""}
                </p>
              </div>
              <Badge tone={c.status === "ready" ? "green" : "amber"}>{c.status}</Badge>
              {c.score > 0 ? <span className="w-16 text-right font-mono text-xs text-zinc-500">{c.score}</span> : null}
              <Link to="/editor">
                <Button size="sm" variant="secondary">
                  Open editor
                </Button>
              </Link>
            </div>
          ))}
        </Card>
      )}

      {/* Export dialog */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen} title="Export clips">
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-zinc-400">
            Exporting <span className="font-medium text-zinc-200">{selected.size} clip{selected.size === 1 ? "" : "s"}</span>{" "}
            as rendered MP4s from private storage. Render jobs are queued and retry-safe.
          </p>
          <div>
            <label className="text-xs font-medium text-zinc-500" htmlFor="fmt">
              Format preset
            </label>
            <Select id="fmt" className="mt-1.5" value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
              <option>9:16 MP4 · captions</option>
              <option>16:9 MP4 · no captions</option>
              <option>1:1 MP4 · captions</option>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setExportOpen(false);
                setSelected(new Set());
                alert(`Export queued for ${clips.filter((c) => selected.has(c.id)).length} clip(s) — ${exportFormat} (mock).`);
              }}
            >
              <Download className="h-4 w-4" /> Queue export
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
