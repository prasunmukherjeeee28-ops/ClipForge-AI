import { HashRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { SessionGate } from "@/components/auth/session-gate";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { UploadPage } from "@/features/upload/upload-page";
import { LibraryPage } from "@/features/library/library-page";
import { EditorPage } from "@/features/editor/editor-page";
import { LiveRadarPage } from "@/features/live-radar/live-radar-page";
import { SettingsPage } from "@/features/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { Compass } from "lucide-react";

function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <span className="glass flex h-12 w-12 items-center justify-center rounded-xl">
        <Compass className="h-5 w-5 text-violet-350" />
      </span>
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">This screen doesn’t exist</h1>
        <p className="mt-1 text-sm text-zinc-500">The route you opened isn’t part of ClipForge AI yet.</p>
      </div>
      <Link to="/">
        <Button variant="secondary">Back to dashboard</Button>
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route
          element={
            <SessionGate>
              <AppShell />
            </SessionGate>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="editor" element={<EditorPage />} />
          <Route path="live-radar" element={<LiveRadarPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
