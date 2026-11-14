import { Capacitor } from "@capacitor/core";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";

const DEFAULT_API_BASE = "https://clipforge-api.prasunmukherjeeee28.workers.dev";
const TOKEN_KEY = "mobile_session_token";
const STORAGE_PREFIX = "clipforge-ai";

let secureStorageReady: Promise<void> | undefined;

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function getApiBase(): string {
  const configured = (import.meta.env.VITE_CLIPFORGE_API_BASE_URL ?? "").replace(/\/+$/, "");
  return isNativePlatform() ? configured || DEFAULT_API_BASE : configured;
}

async function prepareSecureStorage(): Promise<void> {
  if (!secureStorageReady) {
    secureStorageReady = SecureStorage.setKeyPrefix(STORAGE_PREFIX);
  }
  await secureStorageReady;
}

export async function getMobileSessionToken(): Promise<string | null> {
  if (!isNativePlatform()) return null;
  await prepareSecureStorage();
  return SecureStorage.getItem(TOKEN_KEY);
}

export async function setMobileSessionToken(token: string): Promise<void> {
  if (!isNativePlatform()) throw new Error("Mobile session storage is only available in the native app.");
  await prepareSecureStorage();
  await SecureStorage.setItem(TOKEN_KEY, token);
}

export async function clearMobileSessionToken(): Promise<void> {
  if (!isNativePlatform()) return;
  await prepareSecureStorage();
  await SecureStorage.removeItem(TOKEN_KEY);
}

export async function getSecureValue(key: string): Promise<string | null> {
  if (!isNativePlatform()) return null;
  await prepareSecureStorage();
  return SecureStorage.getItem(key);
}

export async function setSecureValue(key: string, value: string): Promise<void> {
  if (!isNativePlatform()) throw new Error("Secure storage is only available in the native app.");
  await prepareSecureStorage();
  await SecureStorage.setItem(key, value);
}

export async function removeSecureValue(key: string): Promise<void> {
  if (!isNativePlatform()) return;
  await prepareSecureStorage();
  await SecureStorage.removeItem(key);
}
