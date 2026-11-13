import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";
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
  const [session, setSession] = useState<
    | { status: "loading" }
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
          setSession({
            status: "error",
            statusCode: 403,
            message: "This account is not on ClipForge's two-account allowlist. Ask the workspace owner to verify the two approved email addresses.",
          });
        } else if (error instanceof ApiRequestError && error.status === 503) {
          setSession({
            status: "error",
            statusCode: 503,
            message: "The API is not configured yet. Cloudflare Access must have a team domain, application audience, and exactly two allowed email addresses.",
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
            ClipForge does not provide public sign-up. Access is limited to the two identities configured by the owner.
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
