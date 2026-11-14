import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import {
  clearMobileSessionToken,
  getApiBase,
  getMobileSessionToken,
  getSecureValue,
  isNativePlatform,
  removeSecureValue,
  setMobileSessionToken,
  setSecureValue,
} from "./platform";
import type { CurrentUser } from "./api";

const PENDING_KEY = "mobile_auth_pending";
const PENDING_CODE_KEY = "mobile_auth_code";
const AUTH_CALLBACK_PROTOCOL = "com.clipforge.app:";
const AUTH_CALLBACK_HOST = "auth";

type PendingAuth = { verifier: string; state: string };
type PendingCode = { code: string; verifier: string };

export type MobileAuthResult =
  | { status: "ready"; user: CurrentUser }
  | { status: "invite"; message: string };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function exchangeCode(pending: PendingCode, inviteCode?: string): Promise<MobileAuthResult> {
  const response = await fetch(getApiBase() + "/mobile/v1/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: pending.code,
      verifier: pending.verifier,
      ...(inviteCode ? { inviteCode: inviteCode.trim() } : {}),
    }),
  });
  const raw = await response.text();
  let payload: {
    token?: string;
    user?: CurrentUser;
    error?: { code?: string; message?: string };
  } | null = null;
  try {
    payload = raw ? JSON.parse(raw) as typeof payload : null;
  } catch {
    throw new Error("ClipForge returned an unreadable response during sign-in.");
  }

  if (!response.ok) {
    if (response.status === 403 && payload?.error?.code === "invite_required") {
      return { status: "invite", message: payload.error.message ?? "Enter your private invite code to claim this account." };
    }
    throw new Error(payload?.error?.message ?? "Sign-in failed (" + response.status + ").");
  }

  if (!payload?.token || !payload.user?.id || !payload.user.email) {
    throw new Error("ClipForge did not return a complete authenticated session.");
  }
  await setMobileSessionToken(payload.token);
  await removeSecureValue(PENDING_KEY);
  await removeSecureValue(PENDING_CODE_KEY);
  return { status: "ready", user: payload.user };
}

export async function startMobileSignIn(): Promise<void> {
  if (!isNativePlatform()) throw new Error("Native Google sign-in is only available in the Android app.");
  const verifier = randomVerifier();
  const state = randomVerifier();
  const challenge = await sha256Base64Url(verifier);
  await setSecureValue(PENDING_KEY, JSON.stringify({ verifier, state } satisfies PendingAuth));

  const authorizeUrl = new URL(getApiBase() + "/mobile-auth/authorize");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("state", state);
  await Browser.open({ url: authorizeUrl.toString(), presentationStyle: "fullscreen" });
}

export async function handleMobileAuthCallback(url: string): Promise<MobileAuthResult | null> {
  if (!isNativePlatform()) return null;
  const callback = new URL(url);
  if (callback.protocol !== AUTH_CALLBACK_PROTOCOL || callback.hostname !== AUTH_CALLBACK_HOST) return null;

  const code = callback.searchParams.get("code") ?? "";
  const returnedState = callback.searchParams.get("state") ?? "";
  if (!code || code.length > 128) throw new Error("The Google sign-in callback did not contain a valid authorization code.");

  const pendingRaw = await getSecureValue(PENDING_KEY);
  if (!pendingRaw) throw new Error("The sign-in request expired. Please start Google sign-in again.");
  const pending = JSON.parse(pendingRaw) as PendingAuth;
  if (!pending.verifier || !pending.state || returnedState !== pending.state) {
    throw new Error("The sign-in response could not be verified. Please try again.");
  }

  const codeState: PendingCode = { code, verifier: pending.verifier };
  await setSecureValue(PENDING_CODE_KEY, JSON.stringify(codeState));
  await Browser.close().catch(() => undefined);
  return exchangeCode(codeState);
}

export async function submitMobileInvite(inviteCode: string): Promise<MobileAuthResult> {
  const pendingRaw = await getSecureValue(PENDING_CODE_KEY);
  if (!pendingRaw) throw new Error("Your sign-in request expired. Start Google sign-in again.");
  const pending = JSON.parse(pendingRaw) as PendingCode;
  return exchangeCode(pending, inviteCode);
}

export async function restoreMobileSession(): Promise<CurrentUser | null> {
  const token = await getMobileSessionToken();
  if (!token) return null;
  const response = await fetch(getApiBase() + "/mobile/v1/api/me", {
    headers: { Authorization: "Bearer " + token },
  });
  const raw = await response.text();
  let payload: { user?: CurrentUser; error?: { message?: string } } | null = null;
  try {
    payload = raw ? JSON.parse(raw) as typeof payload : null;
  } catch {
    throw new Error("ClipForge returned an unreadable account response.");
  }
  if (response.status === 401) {
    await clearMobileSessionToken();
    return null;
  }
  if (!response.ok || !payload?.user?.id || !payload.user.email) {
    throw new Error(payload?.error?.message ?? "Your ClipForge account could not be verified.");
  }
  return payload.user;
}

export async function signOutMobile(): Promise<void> {
  const token = await getMobileSessionToken();
  try {
    if (token) {
      await fetch(getApiBase() + "/mobile/v1/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
    }
  } finally {
    await clearMobileSessionToken();
    await removeSecureValue(PENDING_KEY);
    await removeSecureValue(PENDING_CODE_KEY);
  }
}

export async function listenForMobileAuth(
  callback: (url: string) => void,
): Promise<() => void> {
  if (!isNativePlatform()) return () => undefined;
  const listener = await App.addListener("appUrlOpen", ({ url }) => callback(url));
  return () => { void listener.remove(); };
}

export async function getInitialMobileUrl(): Promise<string | null> {
  if (!isNativePlatform()) return null;
  const result = await App.getLaunchUrl();
  return result?.url ?? null;
}
