import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, getCurrentUser, type CurrentUser } from "@/lib/api";

const SessionContext = createContext<CurrentUser | null>(null);

export function useCurrentUser(): CurrentUser {
  const user = useContext(SessionContext);
  if (!user) throw new Error("useCurrentUser must be used inside SessionGate.");
  return user;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [session, setSession] = useState<
    | { status: "loading" }
    | { status: "invite" }
    | { status: "ready"; user: CurrentUser }
    | { status: "error"; message: string; statusCode?: number }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    setSession({ status: "loading" });
    getCurrentUser().then(
      (user) => {
        if (active) setSession({ status: "ready", user });
      },
      (error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          setSession({
            status: "error",
            statusCode: 401,
            message: "Cloudflare Access did not authenticate this request. Open the protected ClipForge app URL, complete sign-in, then retry.",
          });
        } else if (error instanceof ApiRequestError && error.status === 403) {
          setSession({ status: "invite" });
        } else if (error instanceof ApiRequestError && error.status === 503) {
          setSession({
            status: "error",
            statusCode: 503,
            message: "The API is not configured yet. Cloudflare Access and the two private invite codes must be configured by the workspace owner.",
          });
        } else {
          setSession({
            status: "error",
            message: error instanceof Error ? error.message : "ClipForge could not verify your account.",
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  if (session.status === "loading") {
    return (
      <div className="app-ambient flex min-h-100dvh items-center justify-center px-5">
        <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-black/30 px-5 py-4 text-sm text-zinc-300">
          <LoaderCircle className="h-4 w-4 animate-spin text-violet-350" />
          Verifying your private ClipForge account…
        </div>
      </div>
    );
  }

  async function claimAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = inviteCode.trim();
    if (code.length < 32) {
      setInviteError("Enter the complete invite code supplied by the workspace owner.");
      return;
    }
    setClaiming(true);
    setInviteError("");
    try {
      const user = await getCurrentUser(code);
      setSession({ status: "ready", user });
      setInviteCode("");
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "Account enrollment failed. Check the code and try again.");
    } finally {
      setClaiming(false);
    }
  }

  if (session.status === "invite") {
    return (
      <main className="app-ambient flex min-h-100dvh items-center justify-center px-5 py-10">
        <section className="w-full max-w-lg rounded-2xl border border-white/[0.09] bg-zinc-950/80 p-6 shadow-2xl">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-violet-400/20 bg-violet-400/[0.08]">
            <KeyRound className="h-5 w-5 text-violet-300" />
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">Claim your private account</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            This ClipForge workspace is private and has exactly two account slots. Enter your one-time invite code to link this Google account. Your clips and job history stay separate from the other account.
          </p>
          <form className="mt-6 space-y-3" onSubmit={claimAccount}>
            <label htmlFor="clipforge-invite" className="block text-xs font-medium uppercase tracking-wide text-zinc-400">One-time invite code</label>
            <input
              id="clipforge-invite"
              type="password"
              autoComplete="off"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              placeholder="Paste your private invite code"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-zinc-100 outline-none transition focus:border-violet-400/60 focus:ring-2 focus:ring-violet-400/15"
              required
            />
            {inviteError && <p role="alert" className="text-sm text-rose-300">{inviteError}</p>}
            <Button type="submit" className="w-full" disabled={claiming || inviteCode.trim().length < 32}>
              {claiming ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Claiming account…</> : "Claim private account"}
            </Button>
          </form>
          <p className="mt-4 text-xs leading-relaxed text-zinc-600">
            Invite codes are single-use. Keep yours private and do not paste it into GitHub or public messages.
          </p>
        </section>
      </main>
    );
  }

  if (session.status === "error") {
    return (
      <main className="app-ambient flex min-h-100dvh items-center justify-center px-5 py-10">
        <section className="w-full max-w-lg rounded-2xl border border-white/[0.09] bg-zinc-950/80 p-6 shadow-2xl">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-amber-400/20 bg-amber-400/[0.08]">
            <ShieldAlert className="h-5 w-5 text-amber-300" />
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">Account access unavailable</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">{session.message}</p>
          <p className="mt-4 text-xs leading-relaxed text-zinc-600">
            ClipForge is a private two-person workspace. Public registration is disabled.
          </p>
          <Button className="mt-6 w-full" onClick={() => setAttempt((value) => value + 1)}>
            Retry account verification
          </Button>
        </section>
      </main>
    );
  }

  return (
    <SessionContext.Provider value={session.user}>
      <div className="relative">
        <div className="sr-only" aria-live="polite">
          <ShieldCheck /> Signed in as {session.user.email}
        </div>
        {children}
      </div>
    </SessionContext.Provider>
  );
}
