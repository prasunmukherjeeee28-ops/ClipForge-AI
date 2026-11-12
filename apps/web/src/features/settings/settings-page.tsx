import { useState } from "react";
import { User, Palette, Download, Sparkles, HardDrive, Camera } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

function SettingRow({
  icon: Icon,
  label,
  desc,
  control,
}: {
  icon: typeof User;
  label: string;
  desc: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <span className="glass flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
        <Icon className="h-4 w-4 text-violet-350" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{desc}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function SettingsPage() {
  const [name, setName] = useState("Piyush");
  const [theme, setTheme] = useState("dark");
  const [defaultFormat, setDefaultFormat] = useState("9:16 vertical");
  const [defaultCaptions, setDefaultCaptions] = useState(true);
  const [autoScores, setAutoScores] = useState(true);
  const [sensitivity, setSensitivity] = useState("balanced");
  const [profanity, setProfanity] = useState(true);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Settings</h1>
        <p className="mt-1 text-sm text-zinc-500">Your profile, preferences and storage.</p>
      </div>

      {/* Account */}
      <Card>
        <CardHeader title="Account profile" description="Identity used for private workspace access" />
        <div className="flex items-center gap-4 border-t hairline px-5 py-4">
          <div className="glass relative flex h-14 w-14 items-center justify-center rounded-full">
            <Camera className="h-5 w-5 text-zinc-500" />
          </div>
          <div>
            <Button size="sm" variant="secondary" onClick={() => alert("Avatar upload connects to authenticated media delivery (mock).")}>
              Change avatar
            </Button>
            <p className="mt-1.5 text-[11px] text-zinc-600">Stored in private object storage, served via short-lived URLs.</p>
          </div>
        </div>
        <div className="border-t hairline px-5 py-4">
          <label className="text-xs font-medium text-zinc-500" htmlFor="name">Display name</label>
          <Input id="name" className="mt-1.5 max-w-sm" value={name} onChange={(e) => setName(e.target.value)} />
          <p className="mt-1.5 text-[11px] text-zinc-600">Signed in as piyush@clipforge.local · workspace: trusted-group</p>
        </div>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader title="Appearance" description="Interface theme (Liquid Glass is the default)" />
        <div className="divide-y divide-white/[0.05]">
          <SettingRow
            icon={Palette}
            label="Theme"
            desc="Dark is tuned for long editing sessions."
            control={
              <Select className="w-36" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme">
                <option value="dark">Dark (Liquid Glass)</option>
                <option value="darker">Pure black</option>
              </Select>
            }
          />
        </div>
      </Card>

      {/* Export preferences */}
      <Card>
        <CardHeader title="Export preferences" description="Defaults applied to every new render job" />
        <div className="divide-y divide-white/[0.05]">
          <SettingRow
            icon={Download}
            label="Default format"
            desc="Aspect ratio preset for clip exports."
            control={
              <Select className="w-40" value={defaultFormat} onChange={(e) => setDefaultFormat(e.target.value)} aria-label="Default format">
                <option>9:16 vertical</option>
                <option>16:9 landscape</option>
                <option>1:1 square</option>
              </Select>
            }
          />
          <SettingRow
            icon={Download}
            label="Burn captions by default"
            desc="Sync styled subtitles into exported MP4s."
            control={<Switch checked={defaultCaptions} onCheckedChange={setDefaultCaptions} label="Burn captions by default" />}
          />
        </div>
      </Card>

      {/* AI preferences */}
      <Card>
        <CardHeader title="AI preferences" description="Moment detection behaviour — scores are estimates" />
        <div className="divide-y divide-white/[0.05]">
          <SettingRow
            icon={Sparkles}
            label="Detection sensitivity"
            desc="Strict finds fewer, sharper moments. Loose casts a wider net."
            control={
              <Select className="w-32" value={sensitivity} onChange={(e) => setSensitivity(e.target.value)} aria-label="Detection sensitivity">
                <option value="strict">Strict</option>
                <option value="balanced">Balanced</option>
                <option value="loose">Loose</option>
              </Select>
            }
          />
          <SettingRow
            icon={Sparkles}
            label="Show review scores"
            desc="Hook / context / payoff estimates on candidates."
            control={<Switch checked={autoScores} onCheckedChange={setAutoScores} label="Show review scores" />}
          />
          <SettingRow
            icon={Sparkles}
            label="Exclude profanity spikes"
            desc="Filter hype spikes that are mostly profanity."
            control={<Switch checked={profanity} onCheckedChange={setProfanity} label="Exclude profanity spikes" />}
          />
        </div>
      </Card>

      {/* Storage */}
      <Card>
        <CardHeader title="Storage" description="Private R2 usage across sources and exports" />
        <div className="space-y-4 border-t hairline px-5 py-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[13px]">
              <span className="flex items-center gap-2 text-zinc-300">
                <HardDrive className="h-4 w-4 text-violet-350" /> 18.4 GB of 100 GB
              </span>
              <span className="font-mono text-xs text-zinc-500">18%</span>
            </div>
            <Progress value={18} />
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              { label: "Source videos", value: "12.1 GB" },
              { label: "Exports", value: "5.9 GB" },
              { label: "Trash", value: "0.4 GB" },
            ].map((s) => (
              <div key={s.label} className="glass rounded-lg px-3 py-2.5">
                <p className="text-sm font-semibold text-zinc-100">{s.value}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">{s.label}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <Badge tone="green">Retention: 90 days</Badge>
            <Button size="sm" variant="secondary" onClick={() => alert("Retention policy enforcement runs server-side (mock).")}>
              Manage retention
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex justify-end pb-4">
        <Button onClick={() => alert("Preferences saved locally — they will persist to the account API once auth ships.")}>
          Save preferences
        </Button>
      </div>
    </div>
  );
}
