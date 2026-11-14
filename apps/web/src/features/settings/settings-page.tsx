import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { useCurrentUser } from "@/components/auth/session-gate";
import { LockKeyhole, ShieldCheck, HardDrive, Film, Captions, BrainCircuit, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/components/auth/session-gate";
import { isNativePlatform } from "@/lib/platform";

function InfoRow({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof LockKeyhole;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <span className="glass mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
        <Icon className="h-4 w-4 text-violet-350" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{description}</p>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const user = useCurrentUser();
  const signOut = useSignOut();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Workspace settings</h1>
        <p className="mt-1 text-sm text-zinc-500">Your authenticated identity and the privacy rules protecting this workspace.</p>
      </div>

      <Card>
        <CardHeader title="Signed-in account" description="Verified by the ClipForge API using Cloudflare Access on web and a secure mobile session on Android" />
        <div className="flex flex-col gap-3 border-t hairline px-5 py-5 sm:flex-row sm:items-center">
          <span className="glass flex h-12 w-12 items-center justify-center rounded-full">
            <ShieldCheck className="h-5 w-5 text-emerald-300" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-all text-sm font-medium text-zinc-100">{user.email}</p>
            <p className="mt-1 text-xs text-zinc-600">Account ID · {user.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="green">Authenticated</Badge>
            {isNativePlatform() ? (
              <Button size="sm" variant="ghost" onClick={() => void signOut()}>
                <LogOut className="h-4 w-4" /> Sign out
              </Button>
            ) : null}
          </div>
        </div>
        <div className="border-t hairline px-5 py-4 text-xs leading-relaxed text-zinc-500">
          ClipForge has no public registration. The API accepts exactly two owner-configured email identities; only your own account's jobs, uploads and clips are returned.
        </div>
      </Card>

      <Card>
        <CardHeader title="Privacy and isolation" description="Workspace-level safeguards" />
        <div className="divide-y divide-white/[0.05]">
          <InfoRow
            icon={LockKeyhole}
            title="Separate private libraries"
            description="Every job, source asset, moment and finished clip is queried using the verified account ID. Another account cannot access your resources by guessing an ID."
          />
          <InfoRow
            icon={HardDrive}
            title="Private media storage"
            description="Source uploads and rendered clips are designed for a private R2 bucket. The bucket must stay private; the API streams media only after checking ownership."
          />
          <InfoRow
            icon={ShieldCheck}
            title="Two-account access"
            description="Cloudflare Access and the API allowlist must both be configured for exactly the two intended email addresses. There is no shared library or public customer account."
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Processing defaults" description="Current VOD workflow capabilities" />
        <div className="divide-y divide-white/[0.05]">
          <InfoRow
            icon={Film}
            title="Vertical exports"
            description="The processor renders finished 9:16 MP4 clips. Generated clips are stored separately in your private library."
          />
          <InfoRow
            icon={Captions}
            title="Burned-in subtitles"
            description="Transcription and subtitle rendering run in the processor. Subtitle appearance and timeline editing are not yet configurable from this screen."
          />
          <InfoRow
            icon={BrainCircuit}
            title="Moment analysis"
            description="Local audio and transcript signals are the baseline. Optional Gemini refinement can be enabled server-side; API keys never belong in the browser."
          />
        </div>
      </Card>

      <p className="px-1 text-xs leading-relaxed text-zinc-600">
        Storage usage and preference controls will appear here only when the API exposes real persisted values. This screen does not display sample quotas or pretend that unsaved settings have been stored.
      </p>
    </div>
  );
}
