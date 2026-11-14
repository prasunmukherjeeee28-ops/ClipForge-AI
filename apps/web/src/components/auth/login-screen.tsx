import { useState } from "react";
import { Clapperboard, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startMobileSignIn } from "@/lib/mobile-auth";

export function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setLoading(true);
    setError("");
    try {
      await startMobileSignIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google sign-in could not be started.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-ambient flex min-h-100dvh items-center justify-center px-5 py-10">
      <section className="w-full max-w-md overflow-hidden rounded-3xl border border-white/[0.09] bg-zinc-950/85 p-7 shadow-2xl shadow-violet-950/20">
        <div className="mb-8 flex items-center gap-3">
          <span className="glass flex h-12 w-12 items-center justify-center rounded-2xl border-violet-400/20 bg-violet-400/[0.08]">
            <Clapperboard className="h-6 w-6 text-violet-300" />
          </span>
          <div>
            <p className="text-lg font-semibold tracking-tight text-zinc-100">
              ClipForge <span className="text-violet-300">AI</span>
            </p>
            <p className="text-xs text-zinc-500">Private creator workspace</p>
          </div>
        </div>

        <div className="mb-7">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-300/80">Your private studio</p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Sign in to ClipForge</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Continue with the Google account linked to your private workspace.
          </p>
        </div>

        <Button className="h-12 w-full justify-center rounded-xl text-sm" onClick={() => void signIn()} disabled={loading}>
          {loading ? (
            <><LoaderCircle className="h-4 w-4 animate-spin" /> Opening secure Google sign-in…</>
          ) : (
            <>
              <svg aria-hidden="true" viewBox="0 0 48 48" className="h-5 w-5">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.05 13.22l7.98 6.19C11.97 13.72 17.49 9.5 24 9.5Z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.76 7.18l7.73 6C44.42 37.99 46.98 31.9 46.98 24.55Z" />
                <path fill="#FBBC05" d="M10.03 28.59A14.4 14.4 0 0 1 9.25 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.88.93 7.55 2.57 10.78l7.46-6.19Z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.14 1.45-4.88 2.3-8.18 2.3-6.52 0-12.04-4.22-14-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
              </svg>
              Continue with Google
            </>
          )}
        </Button>

        {error ? (
          <p role="alert" className="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.08] px-3 py-2.5 text-xs leading-relaxed text-red-300">
            {error}
          </p>
        ) : null}

        <div className="mt-7 flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3.5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
          <p className="text-xs leading-relaxed text-zinc-500">
            Access is limited to two invited Google accounts. Your videos, clips and job history stay separate from the other account.
          </p>
        </div>
      </section>
    </main>
  );
}
